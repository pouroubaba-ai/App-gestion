import {
  collection, doc, getDoc, getDocs, query, where,
  writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { ouvrirDetention } from './produits-site';
import { coutMoyenApresEntree } from './mouvements';
import { enregistrerVersement } from './versements-collection';
import type { RoleTiers } from './soldes';

/**
 * Enregistrer un retour de marchandise.
 *
 * Un retour est un mouvement à part entière, jamais un champ porté par la
 * ligne qu'il annule : il a sa date, sa quantité et son auteur, et une même
 * ligne peut en recevoir plusieurs. On le retrouve par son motif et le lien
 * vers son origine.
 *
 * Trois choses se produisent ensemble, et c'est pour cela qu'elles vivent
 * dans la même fonction :
 *
 *  - la marchandise revient — le stock bouge, dans le sens inverse ;
 *  - le mouvement de retour s'écrit, rattaché à sa ligne d'origine ;
 *  - l'argent se règle — ce qui n'était pas payé cesse d'être dû, ce qui
 *    l'était se rembourse.
 *
 * Les séparer laisserait passer un retour sans que le stock bouge, ou une
 * marchandise rendue sans que le client cesse de la devoir.
 */

export interface LigneRetour {
  /** le mouvement d'origine, celui que ce retour annule en partie */
  mouvementId: string;
  quantite: number;
}

export interface RetourEnregistre {
  quantite: number;
  valeur: number;
  /** ce qui a cessé d'être dû */
  deduitDuDu: number;
  /** ce qui a été rendu en argent */
  rembourse: number;
}

/**
 * Ce qu'un retour fait de l'argent.
 *
 * Un retour ne rembourse que ce qui avait été payé. Tant que la marchandise
 * n'était pas réglée, le rendre éteint simplement la dette — personne ne
 * sort d'argent. C'est seulement au-delà du non-payé qu'un remboursement a
 * lieu.
 */
export function partageRetour(valeurRetour: number, resteDu: number) {
  const deduitDuDu = Math.min(valeurRetour, Math.max(0, resteDu));
  return { deduitDuDu, rembourse: Math.max(0, valeurRetour - deduitDuDu) };
}

export async function enregistrerRetour(params: {
  siteId: string;
  userId: string;
  partenaireId: string;
  partenaireNom?: string | null;
  role: RoleTiers;
  lignes: LigneRetour[];
  date: string;
  /** ce que le tiers doit encore, pour savoir quoi rembourser */
  resteDu: number;
  /** le dossier concerné, quand le retour porte sur un seul */
  achatId?: string | null;
  venteId?: string | null;
  reference?: string | null;
  par?: string | null;
  /* Qui a reçu la marchandise rendue. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /* L'admin de l'activité : il n'a pas de rôle de site, on le reconnaît
     à son identifiant quand la caisse cherche qui agit. */
  adminUid?: string | null;
}): Promise<RetourEnregistre> {
  const lignes = params.lignes.filter(l => l.quantite > 0);
  if (lignes.length === 0) throw new Error('Aucune quantité à retourner.');

  const batch = writeBatch(db);
  let quantiteTotale = 0;
  let valeurTotale = 0;

  for (const l of lignes) {
    const snap = await getDoc(doc(db, 'mouvements', l.mouvementId));
    if (!snap.exists()) throw new Error('Mouvement introuvable.');
    const m = snap.data() as any;

    /* On ne rend jamais plus qu'il n'est sorti : les retours déjà passés sur
       cette ligne comptent dans ce qui reste rendable. */
    const dejaRendu = await quantiteDejaRendue(l.mouvementId);
    const rendable = (m.quantite ?? 0) - dejaRendu;
    if (l.quantite > rendable) {
      throw new Error(
        `Retour supérieur à ce qui reste : ${l.quantite} demandé, ${rendable} possible.`);
    }

    /* Le retour se valorise au prix de l'opération d'origine : rendre une
       pièce vendue 6 500 vaut 6 500, quel que soit le prix du jour. */
    const prix = params.role === 'client' ? (m.prixVente ?? 0) : (m.cout ?? 0);
    quantiteTotale += l.quantite;
    valeurTotale += l.quantite * prix;

    /* Le sens s'inverse : ce qui était sorti rentre, ce qui était entré
       ressort. Le coût moyen ne se repondère qu'à l'entrée. */
    const sens = m.sens === 'sortie' ? 'entree' : 'sortie';
    await appliquerAuStock(batch, {
      siteId: params.siteId, userId: params.userId,
      produitId: m.produitId,
      varianteCle: m.varianteCle ?? null,
      sens,
      quantiteUnites: (m.quantiteUnites ?? m.quantite) * (l.quantite / (m.quantite || 1)),
      cout: m.cout ?? 0,
    });

    batch.set(doc(collection(db, 'mouvements')), {
      siteId: params.siteId,
      userId: params.userId,
      produitId: m.produitId ?? null,
      varianteCle: m.varianteCle ?? null,
      sens,
      motif: 'retour',
      /* la ligne que ce retour annule : c'est par lui qu'on la retrouve */
      mouvementOrigineId: l.mouvementId,
      date: params.date,
      produit: m.produit ?? null,
      unite: m.unite ?? null,
      emballage: m.emballage ?? null,
      emballageContenu: m.emballageContenu ?? 1,
      quantite: l.quantite,
      quantiteUnites: (m.quantiteUnites ?? m.quantite) * (l.quantite / (m.quantite || 1)),
      cout: m.cout ?? 0,
      prixVente: m.prixVente ?? 0,
      valeurUnitaire: prix,
      valeurTotale: l.quantite * prix,
      role: params.role,
      type: m.type ?? null,
      partenaireId: params.partenaireId,
      partenaireNom: params.partenaireNom ?? null,
      achatId: m.achatId ?? null,
      venteId: m.venteId ?? null,
      documentId: m.documentId ?? null,
      reference: m.reference ?? null,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      createdAt: serverTimestamp(),
    });
  }

  /* Le document du retour : l'historique des entrées et sorties doit le
     voir comme il voit un achat ou une vente. */
  batch.set(doc(collection(db, 'documents')), {
    reference: params.reference ?? null,
    siteId: params.siteId,
    sens: params.role === 'client' ? 'entree' : 'sortie',
    motif: 'retour',
    achatId: params.achatId ?? null,
    venteId: params.venteId ?? null,
    partenaireId: params.partenaireId,
    partenaireNom: params.partenaireNom ?? null,
    date: params.date,
    valeur: valeurTotale,
    lignes: lignes.length,
    userId: params.userId,
    par: params.par ?? null,
    utilisateurNom: params.utilisateurNom ?? null,
    utilisateurFonction: params.utilisateurFonction ?? null,
    createdAt: serverTimestamp(),
  });

  await batch.commit();

  /* L'argent se règle après coup : ce qui n'était pas payé cesse d'être dû
     sans qu'un centime bouge, le reste se rembourse par la caisse. */
  const { deduitDuDu, rembourse } = partageRetour(valeurTotale, params.resteDu);
  if (rembourse > 0) {
    await enregistrerVersement({
      adminUid: params.adminUid ?? null,
      siteId: params.siteId,
      userId: params.userId,
      date: params.date,
      montant: rembourse,
      /* rendre de l'argent à un client le fait sortir ; un fournisseur qui
         nous rembourse le fait entrer */
      sens: params.role === 'client' ? 'sortie' : 'entree',
      motif: 'remboursement',
      partenaireId: params.partenaireId,
      partenaireNom: params.partenaireNom ?? null,
      role: params.role,
      achatId: params.achatId ?? null,
      venteId: params.venteId ?? null,
      reference: params.reference ?? null,
      par: params.par ?? params.userId,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
    });
  }

  return { quantite: quantiteTotale, valeur: valeurTotale, deduitDuDu, rembourse };
}

/** Ce qui a déjà été rendu sur une ligne, pour ne jamais dépasser. */
export async function quantiteDejaRendue(mouvementId: string): Promise<number> {
  const snap = await getDocs(query(
    collection(db, 'mouvements'),
    where('mouvementOrigineId', '==', mouvementId),
    where('motif', '==', 'retour')));
  return snap.docs.reduce((n, d) => n + (d.data().quantite ?? 0), 0);
}

/** Remet la marchandise dans le stock du produit, dans le sens du retour. */
async function appliquerAuStock(
  batch: ReturnType<typeof writeBatch>,
  p: {
    siteId: string; userId: string;
    produitId: string; varianteCle: string | null;
    sens: 'entree' | 'sortie'; quantiteUnites: number; cout: number;
  },
) {
  if (!p.produitId || p.quantiteUnites <= 0) return;

  /* La marchandise revient dans le rayon du site qui la reprend : le stock
     appartient à la détention, jamais au produit commun. */
  const detentionId = await ouvrirDetention({
    produitId: p.produitId, siteId: p.siteId, userId: p.userId,
  });
  const ref = doc(db, 'produits_site', detentionId);
  const detention = ((await getDoc(ref)).data() ?? {}) as any;

  const variantes: any[] = detention.variantes ?? [];
  const variante = p.varianteCle
    ? variantes.find(v => v.cle === p.varianteCle)
    : undefined;

  const stockAvant = variante ? variante.stock : (detention.stock ?? 0);
  const coutAvant = variante ? variante.coutMoyen : (detention.coutMoyen ?? 0);
  const delta = p.sens === 'entree' ? p.quantiteUnites : -p.quantiteUnites;

  /* Une entrée repondère le coût moyen, une sortie le laisse intact : c'est
     la même règle que pour un achat, un retour n'y échappe pas. */
  const nouveauCout = p.sens === 'entree'
    ? coutMoyenApresEntree(stockAvant, coutAvant, p.quantiteUnites, p.cout)
    : coutAvant;

  if (p.varianteCle) {
    const connue = variantes.some(v => v.cle === p.varianteCle);
    const maj = connue
      ? variantes.map(v => v.cle === p.varianteCle
          ? { ...v, stock: (v.stock ?? 0) + delta, coutMoyen: nouveauCout }
          : v)
      : [...variantes, {
          cle: p.varianteCle, stock: stockAvant + delta, coutMoyen: nouveauCout,
        }];
    batch.update(ref, {
      variantes: maj,
      stock: maj.reduce((n: number, v: any) => n + (v.stock ?? 0), 0),
    });
  } else {
    batch.update(ref, {
      stock: stockAvant + delta,
      coutMoyen: nouveauCout,
    });
  }
}
