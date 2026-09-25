import {
  collection, query, where, getDocs, writeBatch, doc, getDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import { valeurRecue, valeurVente } from './flux-marchandise';

/**
 * Rapatrier ce qui a été écrit avant la fusion des collections.
 *
 * Les mouvements vivaient dans `mouvements_stock` et `mouvements`, écrits
 * deux fois pour le même geste. Depuis la fusion, une seule écriture existe
 * — mais les lignes antérieures sont restées où elles étaient, invisibles
 * des vues qui ne lisent plus que `mouvements`.
 *
 * Cette reprise les recopie en complétant ce qui leur manque : le rôle et le
 * type se déduisent du sens et du dossier, le prix de vente se lit sur la
 * ligne du document d'origine. Elle ne supprime rien : en cas d'erreur,
 * l'ancien reste lisible.
 *
 * À lancer une fois, depuis un écran d'administration ou la console.
 */

export interface ResultatReprise {
  luesStock: number;
  ecrites: number;
  ignorees: number;
  details: string[];
}

/** Ce qu'un mouvement de stock devient dans la collection fusionnée. */
function convertir(m: any, dossier: any | null) {
  const role: 'client' | 'fournisseur' =
    m.role ?? (m.sens === 'entree' ? 'fournisseur' : 'client');
  const type: 'achat' | 'vente' =
    m.type ?? (role === 'fournisseur' ? 'achat' : 'vente');

  /* Le prix de vente ne vivait que sur la ligne du dossier : sans lui, la
     marge d'une vente reprise serait nulle. */
  const ligne = dossier?.lignes?.find((l: any) => l.produitId === m.produitId);
  const prixVente = m.prixVente ?? ligne?.prixVente ?? 0;
  const cout = m.cout ?? (m.sens === 'entree' ? m.valeurUnitaire : ligne?.valeurUnitaire) ?? 0;

  return {
    siteId: m.siteId,
    userId: m.userId ?? null,
    produitId: m.produitId ?? null,
    varianteCle: m.varianteCle ?? null,
    sens: m.sens,
    motif: m.motif ?? type,
    mouvementOrigineId: null,
    date: m.date,
    produit: m.produit ?? ligne?.designation ?? null,
    unite: m.unite ?? ligne?.unite ?? null,
    emballage: m.emballage ?? null,
    emballageContenu: m.emballageContenu ?? 1,
    quantite: m.quantite ?? 0,
    quantiteUnites: m.quantiteUnites ?? m.quantite ?? 0,
    valeurUnitaire: m.valeurUnitaire ?? 0,
    valeurTotale: m.valeurTotale ?? 0,
    cout,
    prixVente,
    role,
    type,
    partenaireId: m.partenaireId ?? null,
    partenaireNom: m.partenaireNom ?? null,
    siteLieId: m.siteLieId ?? null,
    documentId: m.documentId ?? null,
    achatId: type === 'achat' ? (m.achatId ?? m.documentId ?? null) : null,
    venteId: type === 'vente' ? (m.venteId ?? m.documentId ?? null) : null,
    reference: m.reference ?? dossier?.reference ?? null,
    createdAt: m.createdAt ?? null,
    /* La trace de la reprise : si elle a mal tourné, on sait quoi reprendre
       sans toucher à ce qui a été écrit normalement. */
    repriseDepuis: 'mouvements_stock',
  };
}

export async function reprendreMouvements(siteId: string): Promise<ResultatReprise> {
  const details: string[] = [];

  /* Sans filtre de site : une ligne mal rattachée resterait invisible, et
     c'est précisément celle qu'une reprise doit rattraper. Le tri se fait
     après, sur ce qui est réellement lu. */
  const [stockSnap, dejaSnap, achSnap, venSnap] = await Promise.all([
    getDocs(collection(db, 'mouvements_stock')),
    getDocs(query(collection(db, 'mouvements'), where('siteId', '==', siteId))),
    getDocs(query(collection(db, 'achats'), where('siteId', '==', siteId))),
    getDocs(query(collection(db, 'ventes'), where('siteId', '==', siteId))),
  ]);

  /* Une reprise lancée deux fois ne doit pas doubler les lignes : on
     reconnaît celles déjà reprises à leur origine. */
  const dejaReprises = new Set(
    dejaSnap.docs
      .map(d => d.data())
      .filter(x => x.repriseDepuis === 'mouvements_stock')
      .map(x => `${x.documentId}|${x.produitId}|${x.date}|${x.quantite}`));

  const dossiers = new Map<string, any>([
    ...achSnap.docs.map(d => [d.id, d.data()] as const),
    ...venSnap.docs.map(d => [d.id, d.data()] as const),
  ]);

  let ecrites = 0, ignorees = 0;
  let batch = writeBatch(db);
  let dansLot = 0;

  for (const d of stockSnap.docs) {
    const m = d.data();
    if (m.siteId !== siteId) { ignorees++; continue; }
    const cle = `${m.documentId}|${m.produitId}|${m.date}|${m.quantite}`;
    if (dejaReprises.has(cle)) { ignorees++; continue; }

    const converti = convertir(m, dossiers.get(m.documentId) ?? null);
    batch.set(doc(collection(db, 'mouvements')), converti);
    ecrites++;
    dansLot++;

    /* Firestore n'accepte que 500 écritures par lot. */
    if (dansLot >= 450) {
      await batch.commit();
      batch = writeBatch(db);
      dansLot = 0;
    }
  }

  if (dansLot > 0) await batch.commit();

  details.push(`${stockSnap.size} ligne(s) dans l'ancienne collection.`);
  details.push(`${ecrites} reprise(s), ${ignorees} déjà présente(s).`);

  return { luesStock: stockSnap.size, ecrites, ignorees, details };
}

/**
 * Recalcule `avanceVersee` d'un dossier depuis les versements enregistrés.
 *
 * Le total du dossier est le seul chiffre recopié ; s'il a divergé — une
 * écriture passée à moitié, une reprise — cette fonction le remet d'aplomb
 * sans qu'on ait à toucher aux versements eux-mêmes.
 */
export async function recalculerAvances(siteId: string): Promise<number> {
  const [vSnap, achSnap, venSnap] = await Promise.all([
    getDocs(query(collection(db, 'versements'), where('siteId', '==', siteId))),
    getDocs(query(collection(db, 'achats'), where('siteId', '==', siteId))),
    getDocs(query(collection(db, 'ventes'), where('siteId', '==', siteId))),
  ]);

  const parDossier = new Map<string, number>();
  for (const d of vSnap.docs) {
    const v = d.data();
    const cle = v.achatId ?? v.venteId;
    if (!cle) continue;
    const signe = v.motif === 'remboursement' ? -1 : 1;
    parDossier.set(cle, (parDossier.get(cle) ?? 0) + signe * (v.montant ?? 0));
  }

  const batch = writeBatch(db);
  let corriges = 0;
  for (const [col, snap] of [['achats', achSnap], ['ventes', venSnap]] as const) {
    for (const d of snap.docs) {
      const attendu = Math.max(0, parDossier.get(d.id) ?? 0);
      if ((d.data().avanceVersee ?? 0) !== attendu) {
        batch.update(doc(db, col, d.id), { avanceVersee: attendu });
        corriges++;
      }
    }
  }
  if (corriges > 0) await batch.commit();
  return corriges;
}

/**
 * Reconstruire les mouvements manquants depuis les dossiers conclus.
 *
 * Certaines confirmations ont fait monter le stock sans écrire de ligne de
 * mouvement : le fait matériel a eu lieu, sa trace non. Aucune reprise ne
 * peut copier ce qui n'a jamais été écrit — mais le dossier, lui, porte
 * tout ce qu'il faut pour le reconstituer.
 *
 * On ne reconstruit que ce qui manque : un dossier dont les lignes sont déjà
 * présentes est laissé tel quel.
 */
export async function reconstruireMouvements(siteId: string): Promise<ResultatReprise> {
  const [movSnap, achSnap, venSnap] = await Promise.all([
    getDocs(query(collection(db, 'mouvements'), where('siteId', '==', siteId))),
    getDocs(query(collection(db, 'achats'), where('siteId', '==', siteId))),
    getDocs(query(collection(db, 'ventes'), where('siteId', '==', siteId))),
  ]);

  /* Un dossier dont une ligne existe déjà a été écrit normalement. */
  const dossiersCouverts = new Set(
    movSnap.docs.map(d => d.data()).map(m => m.achatId ?? m.venteId ?? m.documentId));

  let ecrites = 0, ignorees = 0;
  const batch = writeBatch(db);

  for (const [snap, role] of [[achSnap, 'fournisseur'], [venSnap, 'client']] as const) {
    for (const d of snap.docs) {
      const x = d.data() as any;
      const conclu = role === 'fournisseur' ? x.etat === 'confirme' : x.etat === 'livre';
      if (!conclu) { ignorees++; continue; }
      if (dossiersCouverts.has(d.id)) { ignorees++; continue; }

      const date = role === 'fournisseur'
        ? (x.dateConfirmation ?? x.dateReception ?? x.dateCommande)
        : (x.dateLivraison ?? x.dateCommande);

      for (const l of (x.lignes ?? [])) {
        const qte = l.quantiteRecue ?? l.quantiteDemandee ?? 0;
        if (qte <= 0) continue;
        const prix = role === 'client' ? (l.prixVente ?? 0) : (l.valeurUnitaire ?? 0);

        batch.set(doc(collection(db, 'mouvements')), {
          siteId,
          userId: x.userId ?? null,
          produitId: l.produitId ?? null,
          varianteCle: l.varianteCle ?? null,
          sens: role === 'fournisseur' ? 'entree' : 'sortie',
          motif: role === 'fournisseur' ? 'achat' : 'vente',
          mouvementOrigineId: null,
          date,
          produit: l.designation + (l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''),
          unite: l.unite ?? 'unité',
          emballage: l.emballage ?? null,
          emballageContenu: 1,
          quantite: qte,
          quantiteUnites: qte,
          valeurUnitaire: prix,
          valeurTotale: qte * prix,
          cout: l.valeurUnitaire ?? 0,
          prixVente: l.prixVente ?? 0,
          role,
          type: role === 'fournisseur' ? 'achat' : 'vente',
          partenaireId: (role === 'fournisseur' ? x.fournisseurId : x.clientId) ?? null,
          partenaireNom: (role === 'fournisseur' ? x.fournisseurNom : x.clientNom) ?? null,
          documentId: d.id,
          achatId: role === 'fournisseur' ? d.id : null,
          venteId: role === 'client' ? d.id : null,
          reference: x.reference ?? null,
          createdAt: null,
          /* La trace : ces lignes viennent du dossier, pas d'une écriture
             au moment du geste. Elles ne racontent pas l'heure exacte. */
          repriseDepuis: 'dossier',
        });
        ecrites++;
      }
    }
  }

  if (ecrites > 0) await batch.commit();
  return {
    luesStock: achSnap.size + venSnap.size,
    ecrites,
    ignorees,
    details: [`${ecrites} ligne(s) reconstruite(s) depuis ${achSnap.size + venSnap.size} dossier(s).`],
  };
}

/* ═════════════════════ REMISE À ZÉRO ═════════════════════ */

/**
 * Les collections d'opérations d'un site.
 *
 * Le site, ses partenaires, ses produits et ses employés n'en font pas
 * partie : on veut rejouer des opérations sur une base déjà montée, pas
 * tout ressaisir à chaque essai.
 */
const COLLECTIONS_OPERATIONS = [
  'achats', 'ventes', 'transferts',
  'mouvements', 'mouvements_stock', 'documents',
  'versements', 'recouvrement_versements', 'recouvrement_journal',
  'mouvements_caisse', 'compteurs_caisse',
] as const;

export interface CompteOperations {
  parCollection: Record<string, number>;
  total: number;
}

/** Ce qu'un vidage effacerait, sans rien toucher. */
export async function compterOperations(siteId: string): Promise<CompteOperations> {
  const parCollection: Record<string, number> = {};
  let total = 0;

  await Promise.all(COLLECTIONS_OPERATIONS.map(async col => {
    try {
      const snap = await getDocs(query(collection(db, col), where('siteId', '==', siteId)));
      if (snap.size > 0) { parCollection[col] = snap.size; total += snap.size; }
    } catch {
      /* Une collection absente n'est pas une erreur : elle n'a rien à vider. */
    }
  }));

  return { parCollection, total };
}

/**
 * Efface les opérations d'un site. Sans retour possible.
 *
 * Les soldes se recalculent depuis les dossiers ; les effacer suffit donc à
 * remettre dettes, créances et stock à plat, sauf le stock des produits qui
 * vit sur eux et doit être remis à zéro à part.
 */
export async function viderOperations(params: {
  siteId: string;
  /** remettre aussi le stock et le coût moyen des produits à zéro */
  remettreStock: boolean;
}): Promise<{ supprimes: number; produitsRemis: number }> {
  const { siteId } = params;
  let supprimes = 0;

  for (const col of COLLECTIONS_OPERATIONS) {
    let snap;
    try {
      snap = await getDocs(query(collection(db, col), where('siteId', '==', siteId)));
    } catch { continue; }

    let batch = writeBatch(db);
    let dansLot = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      supprimes++;
      /* Firestore n'accepte que 500 écritures par lot. */
      if (++dansLot >= 450) { await batch.commit(); batch = writeBatch(db); dansLot = 0; }
    }
    if (dansLot > 0) await batch.commit();
  }

  /* Le stock ne se déduit pas des mouvements : il vit sur le produit, et
     survivrait à leur suppression. */
  let produitsRemis = 0;
  if (params.remettreStock) {
    const prod = await getDocs(query(collection(db, 'produits'), where('siteId', '==', siteId)));
    let batch = writeBatch(db);
    let dansLot = 0;
    for (const d of prod.docs) {
      const p = d.data();
      batch.update(d.ref, {
        stock: 0, coutMoyen: 0,
        ...(Array.isArray(p.variantes)
          ? { variantes: p.variantes.map((v: any) => ({ ...v, stock: 0, coutMoyen: 0 })) }
          : {}),
      });
      produitsRemis++;
      if (++dansLot >= 450) { await batch.commit(); batch = writeBatch(db); dansLot = 0; }
    }
    if (dansLot > 0) await batch.commit();
  }

  return { supprimes, produitsRemis };
}

/* ═══════════════════════ VALEURS DES SORTIES ═══════════════════════ */

export interface CorrectionValeur {
  id: string;
  produit: string;
  emballage: string | null;
  quantite: number;
  valeurAvant: number;
  valeurApres: number;
  coutAvant: number;
  coutApres: number;
}

/**
 * Remet d'aplomb les mouvements écrits avant que l'emballage soit pris en
 * compte dans les valeurs.
 *
 * Deux fautes, la même racine : le prix et la quantité se disaient dans
 * l'emballage vendu, le total et le coût dans l'unité de base. Un carton de
 * vingt-huit vendu 84 000 était facturé 84 000 × 28, et son coût affiché
 * était celui d'une pièce — la ligne opposait un carton à une pièce.
 *
 * On recalcule sur ce que la ligne porte déjà : `valeurTotale` sur la
 * quantité vendue, `cout` remonté de l'unité de base à l'emballage. Aucun
 * mouvement sans emballage n'est touché : chez eux les deux mesures
 * coïncident, et rien n'a jamais divergé.
 *
 * `simuler` rend la liste sans rien écrire.
 */
export async function corrigerValeursEmballage(
  siteId: string, simuler = true,
): Promise<CorrectionValeur[]> {
  const snap = await getDocs(query(
    collection(db, 'mouvements'), where('siteId', '==', siteId)));

  const corrections: CorrectionValeur[] = [];
  const aEcrire: { id: string; valeurTotale: number; cout: number }[] = [];

  for (const d of snap.docs) {
    const m = d.data() as any;
    const quantite = m.quantite ?? 0;
    const unites = m.quantiteUnites ?? quantite;
    /* Sans emballage, la quantité vaut les unités : rien à reprendre. */
    if (!m.emballage || quantite <= 0 || unites === quantite) continue;
    /* Une entrée n'a jamais divergé : son prix et son coût sont saisis dans
       l'emballage acheté, et son total les multiplie par la quantité du même
       emballage. C'est la sortie qui opposait un prix de carton à un coût de
       pièce, et un total multiplié par les unités. */
    if (m.sens !== 'sortie') continue;

    const contenance = unites / quantite;
    const prix = m.valeurUnitaire ?? 0;
    const valeurApres = prix * quantite;

    /* Le coût de référence est celui que le stock portait alors, à l'unité
       de base. À défaut, le coût enregistré, qu'on suppose unitaire lui
       aussi puisque c'est de là que vient la faute. */
    const coutUnitaire = m.coutMoyenAlors ?? m.cout ?? 0;
    const coutApres = coutUnitaire * contenance;

    const valeurAvant = m.valeurTotale ?? 0;
    const coutAvant = m.cout ?? 0;
    if (valeurAvant === valeurApres && coutAvant === coutApres) continue;

    corrections.push({
      id: d.id,
      produit: m.produit ?? m.produitId,
      emballage: m.emballage,
      quantite,
      valeurAvant, valeurApres,
      coutAvant, coutApres,
    });
    aEcrire.push({ id: d.id, valeurTotale: valeurApres, cout: coutApres });
  }

  if (!simuler && aEcrire.length > 0) {
    /* Firestore plafonne un lot à cinq cents écritures. */
    for (let i = 0; i < aEcrire.length; i += 400) {
      const batch = writeBatch(db);
      aEcrire.slice(i, i + 400).forEach(x => {
        batch.update(doc(db, 'mouvements', x.id), {
          valeurTotale: x.valeurTotale, cout: x.cout,
        });
      });
      await batch.commit();
    }
  }

  return corrections;
}
