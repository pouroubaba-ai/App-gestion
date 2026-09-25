/**
 * Vider la base d'une activité.
 *
 * Deux portées, parce que deux besoins. L'exploitation seule efface ce que
 * la boutique a fait — vendu, acheté, encaissé — et garde ce qu'elle est.
 * Le vidage complet emporte aussi sa structure : produits, partenaires,
 * employés, sites. Il ne reste alors que l'activité et le compte qui la
 * tient, sans quoi personne ne pourrait plus rentrer.
 *
 * L'opération ne se rattrape pas : Firestore n'a pas de corbeille, et ce
 * plan n'a pas de Cloud Functions pour faire le ménage côté serveur. Tout
 * passe donc par le navigateur, document par document.
 */
import {
  collection, query, where, getDocs, writeBatch, doc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

/**
 * Ce que la boutique a fait. Chaque collection est filtrée par `siteId` :
 * un document sans site n'appartient à personne et ne se supprime pas à
 * l'aveugle.
 */
const EXPLOITATION = [
  /* Le flux de marchandise */
  'mouvements',
  'mouvements_stock',
  'documents',
  'ventes',
  'lignes_vente',
  'achats',
  'transferts',
  'preparations',
  'receptions',

  /* L'argent */
  'mouvements_caisse',
  'versements',

  /* Le recouvrement */
  'recouvrement_journal',
  'recouvrement_versements',
  'recouvrement_suivis',

  /* Ce que les employés ont touché */
  'employe_remunerations',
  'employe_avances',
  'employe_versements',
  'employe_prelevements',
];

/**
 * Ce que la boutique est. Ces collections ne partent qu'au vidage complet :
 * les effacer avec l'exploitation reviendrait à refonder la maison chaque
 * fois qu'on veut repartir d'un compte propre.
 */
const STRUCTURE = [
  'produits',
  /* La détention lie un produit à un site : vider la structure d'un site
     sans elle laisserait des liens vers des produits qu'il ne tient plus. */
  'produits_site',
  'partenaires',
  'categories_partenaire',
  'employes',
  'employe_rem_configs',
  'employe_rem_assignations',
  'employe_avance_configs',
  'recouvrement_config',
  'recouvrement_config_defaut',
];

/** Ce qui a été supprimé, pour le dire à qui a demandé. */
export interface BilanPurge {
  /** Combien de documents par collection. */
  parCollection: Record<string, number>;
  total: number;
  /** Les produits dont le stock a été remis à zéro (exploitation seule). */
  produitsRemisAZero: number;
}

/* Firestore refuse un lot de plus de 500 écritures. */
const LOT = 450;

/** Supprime tous les documents donnés, par lots. */
async function supprimerTout(docs: { id: string }[], nomCollection: string) {
  for (let i = 0; i < docs.length; i += LOT) {
    const batch = writeBatch(db);
    for (const d of docs.slice(i, i + LOT)) {
      batch.delete(doc(db, nomCollection, d.id));
    }
    await batch.commit();
  }
}

/** Compte, et supprime si on ne simule pas. */
async function traiter(
  nomCollection: string, champ: string, valeur: string,
  simuler: boolean, bilan: BilanPurge,
) {
  const snap = await getDocs(query(
    collection(db, nomCollection), where(champ, '==', valeur)));
  if (snap.size === 0) return;
  bilan.parCollection[nomCollection] =
    (bilan.parCollection[nomCollection] ?? 0) + snap.size;
  bilan.total += snap.size;
  if (!simuler) await supprimerTout(snap.docs, nomCollection);
}

/**
 * Vide la base des sites donnés.
 *
 * `complet` emporte aussi la structure et les sites eux-mêmes. `simuler`
 * compte sans rien écrire : c'est le seul moyen de voir ce qu'on perdrait,
 * puisqu'on ne pourra pas revenir dessus.
 */
export async function viderExploitation(
  siteIds: string[],
  simuler = true,
  complet = false,
): Promise<BilanPurge> {
  const bilan: BilanPurge = { parCollection: {}, total: 0, produitsRemisAZero: 0 };
  if (siteIds.length === 0) return bilan;

  const collections = complet ? [...EXPLOITATION, ...STRUCTURE] : EXPLOITATION;

  for (const nomCollection of collections) {
    for (const siteId of siteIds) {
      await traiter(nomCollection, 'siteId', siteId, simuler, bilan);
    }
  }

  /* Un transfert appartient à deux sites : celui qui l'envoie ne le porte
     pas toujours dans `siteId`. On le reprend par ses deux extrémités,
     sinon il survivrait à la purge. */
  for (const champ of ['siteSourceId', 'siteDestId']) {
    for (const siteId of siteIds) {
      await traiter('transferts', champ, siteId, simuler, bilan);
    }
  }

  if (complet) {
    /* Les sites en dernier : tout ce qui précède se trouve par eux. Les
       supprimer d'abord rendrait le reste introuvable, donc indélébile.
       Les membres partent avec : un rôle sur un site qui n'existe plus ne
       désigne rien. Le compte propriétaire, lui, tient à l'activité — elle
       reste, sinon plus personne ne pourrait rentrer. */
    for (const siteId of siteIds) {
      await traiter('membres', 'siteId', siteId, simuler, bilan);
    }
    if (!simuler) {
      const batch = writeBatch(db);
      for (const siteId of siteIds) batch.delete(doc(db, 'sites', siteId));
      await batch.commit();
    }
    bilan.parCollection.sites = siteIds.length;
    bilan.total += siteIds.length;
    return bilan;
  }

  /* Le stock ne se déduit pas des mouvements : il est écrit sur le produit,
     et le coût moyen avec lui. Supprimer les mouvements sans les remettre à
     zéro laisserait des produits chargés d'un stock que plus rien
     n'explique — et un inventaire qui ment. Au vidage complet la question
     ne se pose pas : les produits partent aussi. */
  /* Le stock vit dans la détention, pas sur le produit : c'est elle qu'on
     remet à zéro. Le produit appartient à l'activité et survit au vidage
     d'un site — les autres continuent de le détenir. */
  for (const siteId of siteIds) {
    const snap = await getDocs(query(
      collection(db, 'produits_site'), where('siteId', '==', siteId)));
    const aRemettre = snap.docs.filter(d => {
      const p = d.data() as any;
      return (p.stock ?? 0) !== 0 || (p.coutMoyen ?? 0) !== 0
        || (p.variantes ?? []).some((v: any) => (v.stock ?? 0) !== 0);
    });
    bilan.produitsRemisAZero += aRemettre.length;
    if (simuler || aRemettre.length === 0) continue;

    for (let i = 0; i < aRemettre.length; i += LOT) {
      const batch = writeBatch(db);
      for (const d of aRemettre.slice(i, i + LOT)) {
        const p = d.data() as any;
        batch.update(doc(db, 'produits_site', d.id), {
          stock: 0,
          coutMoyen: 0,
          /* Une variante porte son propre stock : la détention n'en est que
             la somme, la remettre à zéro sans elles ne servirait à rien. */
          ...(p.variantes?.length
            ? { variantes: p.variantes.map((v: any) => ({ ...v, stock: 0, coutMoyen: 0 })) }
            : {}),
        });
      }
      await batch.commit();
    }
  }

  return bilan;
}
