/**
 * Fait passer les produits du site à l'activité.
 *
 * Avant : chaque site portait sa propre fiche. Deux « Mangue » sur deux
 * boutiques étaient deux objets sans lien — impossible de dire combien il
 * en était entré et sorti sur l'ensemble de la maison, et un transfert
 * entre elles n'avait rien à rapprocher.
 *
 * Après : une fiche par produit pour toute l'activité, et une détention par
 * site qui porte le stock, le coût moyen, le prix et le seuil.
 *
 * Le rapprochement se fait sur la désignation, normalisée — c'est le seul
 * indice disponible dans l'existant. C'est précisément pourquoi le nom ne
 * doit plus servir à lier ensuite : ici on le fait une fois, sous les yeux
 * de quelqu'un qui peut vérifier, pas à chaque transfert.
 */
import {
  collection, getDocs, doc, addDoc, updateDoc, deleteDoc, writeBatch,
  query, where, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

/** Deux écritures d'un même nom ne doivent pas faire deux produits. */
function normaliser(nom: string): string {
  return (nom ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

export interface LigneFusion {
  cle: string;
  designation: string;
  /** Les fiches actuelles qui deviendront une seule. */
  fiches: { id: string; siteId: string; stock: number; designation: string }[];
}

export interface BilanMigration {
  produitsAvant: number;
  produitsApres: number;
  detentionsCreees: number;
  mouvementsReliés: number;
  fusions: LigneFusion[];
}

/**
 * Ce que la migration ferait, sans rien écrire.
 *
 * On regarde avant d'agir : une fusion réunit des fiches qui portent chacune
 * leur histoire, et se tromper de rapprochement mélangerait deux
 * marchandises.
 */
export async function simulerMigration(): Promise<BilanMigration> {
  const snap = await getDocs(collection(db, 'produits'));
  const groupes = new Map<string, LigneFusion>();

  for (const d of snap.docs) {
    const p = d.data() as any;
    /* Déjà migré : plus de siteId, rien à faire. */
    if (!p.siteId) continue;
    const cle = normaliser(p.designation ?? p.nom ?? '');
    if (!cle) continue;
    const g: LigneFusion = groupes.get(cle) ?? {
      cle, designation: p.designation ?? p.nom ?? '—', fiches: [],
    };
    g.fiches.push({
      id: d.id, siteId: p.siteId,
      stock: p.stock ?? 0,
      designation: p.designation ?? p.nom ?? '—',
    });
    groupes.set(cle, g);
  }

  const fusions = [...groupes.values()];
  return {
    produitsAvant: snap.docs.filter(d => !!(d.data() as any).siteId).length,
    produitsApres: fusions.length,
    detentionsCreees: fusions.reduce((n, f) => n + f.fiches.length, 0),
    mouvementsReliés: 0,
    fusions: fusions.filter(f => f.fiches.length > 1),
  };
}

/**
 * Exécute la migration.
 *
 * Pour chaque groupe : la première fiche devient le produit de l'activité,
 * les autres lui cèdent leur place. Chaque fiche d'origine devient une
 * détention, avec son stock intact. Les mouvements, lignes de vente et
 * lignes d'achat qui désignaient une fiche absorbée sont réaiguillés vers
 * la fiche retenue — sans quoi leur produit deviendrait introuvable.
 */
export async function migrerProduits(params: {
  userId: string;
  activiteId?: string | null;
}): Promise<BilanMigration> {
  const bilan = await simulerMigration();
  const snap = await getDocs(collection(db, 'produits'));

  const groupes = new Map<string, { id: string; data: any }[]>();
  for (const d of snap.docs) {
    const p = d.data() as any;
    if (!p.siteId) continue;
    const cle = normaliser(p.designation ?? p.nom ?? '');
    if (!cle) continue;
    groupes.set(cle, [...(groupes.get(cle) ?? []), { id: d.id, data: p }]);
  }

  let detentions = 0;
  let reliés = 0;

  for (const fiches of groupes.values()) {
    /* La fiche retenue : celle qui porte le plus de stock, donc la plus
       susceptible d'être la « vraie ». À égalité, la première. */
    const retenue = [...fiches].sort((a, b) => (b.data.stock ?? 0) - (a.data.stock ?? 0))[0];
    const absorbées = fiches.filter(f => f.id !== retenue.id);

    /* Le produit ne garde que ce qui décrit la marchandise. */
    await updateDoc(doc(db, 'produits', retenue.id), {
      siteId: null,
      activiteId: params.activiteId ?? null,
      designation: retenue.data.designation ?? retenue.data.nom ?? '—',
      /* Les déclinaisons restent, sans leur stock : il descend au site. */
      variantes: (retenue.data.variantes ?? []).map((v: any) => ({
        cle: v.cle, selection: v.selection, codeBarre: v.codeBarre ?? null,
      })),
      /* Ces champs vivent désormais dans la détention. */
      stock: null, coutMoyen: null, prixVente: null, seuilAlerte: null,
    });

    /* Chaque fiche d'origine devient la détention de son site. */
    for (const f of fiches) {
      const existante = await getDocs(query(
        collection(db, 'produits_site'),
        where('siteId', '==', f.data.siteId),
        where('produitId', '==', retenue.id)));
      if (!existante.empty) continue;

      await addDoc(collection(db, 'produits_site'), {
        produitId: retenue.id,
        siteId: f.data.siteId,
        userId: params.userId,
        stock: f.data.stock ?? 0,
        coutMoyen: f.data.coutMoyen ?? 0,
        prixVente: f.data.prixVente ?? 0,
        seuilAlerte: f.data.seuilAlerte ?? null,
        variantes: (f.data.variantes ?? []).map((v: any) => ({
          cle: v.cle,
          stock: v.stock ?? 0,
          coutMoyen: v.coutMoyen ?? 0,
          prixVente: v.prixVente ?? null,
        })),
        createdAt: serverTimestamp(),
      });
      detentions++;
    }

    /* Ce qui désignait une fiche absorbée doit désigner la retenue : sinon
       son produit devient introuvable, et son histoire illisible. */
    for (const abs of absorbées) {
      for (const nom of ['mouvements', 'lignes_vente', 'lignes_achat']) {
        const refs = await getDocs(query(
          collection(db, nom), where('produitId', '==', abs.id)));
        for (let i = 0; i < refs.docs.length; i += 400) {
          const batch = writeBatch(db);
          for (const r of refs.docs.slice(i, i + 400)) {
            batch.update(r.ref, { produitId: retenue.id });
            reliés++;
          }
          await batch.commit();
        }
      }
      await deleteDoc(doc(db, 'produits', abs.id));
    }
  }

  return { ...bilan, detentionsCreees: detentions, mouvementsReliés: reliés };
}
