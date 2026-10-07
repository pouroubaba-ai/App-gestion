/**
 * Fermer un site, ou le retirer.
 *
 * Rien ne permettait ni l'un ni l'autre. Le champ `etat` existait, la
 * liste avait son filtre Actif/Inactif et chaque fiche son badge — mais
 * aucun écran ne posait jamais `inactif` : le filtre ne pouvait rien
 * rendre. Et aucune suppression nulle part, alors que la règle
 * Firestore l'autorisait au propriétaire. Les sites d'essai
 * s'accumulaient, et la base en comptait dix pour trois réels.
 *
 * Deux gestes, pas un :
 *
 * Une boutique qui ferme garde son histoire — ses ventes, sa caisse,
 * ses créances restent dues. On la rend donc seulement invisible, et
 * c'est réversible : voilà la désactivation.
 *
 * Un site d'essai qui n'a jamais servi n'a rien à garder. Lui, on
 * l'efface — mais seulement s'il est vide, et c'est la vérification qui
 * fait tout l'intérêt de cette fonction. Supprimer un site qui porte
 * des écritures ne les effacerait pas : elles resteraient en base avec
 * un `siteId` qui ne désigne plus rien, comptées dans les totaux de
 * l'activité et rattachables à aucun lieu. La base en porte déjà la
 * trace — neuf importations pointent vers deux sites disparus, et
 * l'inventaire ne sait plus où les mettre.
 */
import {
  collection, query, where, getDocs, doc, updateDoc, deleteDoc, getDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';

/**
 * Tout ce qui porte le `siteId` d'un site.
 *
 * `COLLECTIONS_OPERATIONS` de lib/reprise.ts n'y suffit pas : il sert à
 * vider un site pour le réutiliser, donc il laisse volontairement
 * debout ce qui le meuble — produits, partenaires, employés. Ici la
 * question est l'inverse : reste-t-il quoi que ce soit ? On ajoute donc
 * les collections que le vidage épargne, et les importations, qui
 * portent un site de destination et qu'aucune liste ne comptait.
 */
const COLLECTIONS_LIEES = [
  'achats', 'ventes', 'transferts', 'importations',
  'mouvements', 'mouvements_stock', 'mouvements_attente', 'documents',
  'versements', 'recouvrement_versements', 'recouvrement_journal',
  'mouvements_caisse', 'compteurs_caisse', 'caisse_compteurs',
  'retours_dossiers', 'ajustements',
  'produits_site', 'partenaires', 'employes', 'membres',
] as const;

export interface ContenuSite {
  /** ce qui porte ce site, collection par collection */
  parCollection: Record<string, number>;
  total: number;
  /** vrai quand rien ne le retient : la suppression est alors sans perte */
  vide: boolean;
}

/**
 * Ce qu'un site contient encore.
 *
 * Une collection absente de la base n'est pas une erreur — elle n'a
 * rien à retenir. On l'ignore plutôt que d'échouer, sans quoi la
 * première collection jamais créée empêcherait de lire les autres.
 */
export async function contenuDuSite(siteId: string): Promise<ContenuSite> {
  const parCollection: Record<string, number> = {};
  let total = 0;

  await Promise.all(COLLECTIONS_LIEES.map(async col => {
    try {
      const snap = await getDocs(query(
        collection(db, col), where('siteId', '==', siteId)));
      if (snap.size > 0) { parCollection[col] = snap.size; total += snap.size; }
    } catch { /* collection absente : rien à compter */ }
  }));

  /* Un transfert part d'un site et arrive dans un autre : celui qui le
     reçoit le porte en `siteDestId`, pas en `siteId`. Le compter deux
     fois serait faux, mais l'oublier laisserait supprimer un site qui
     attend encore de la marchandise. */
  try {
    const snap = await getDocs(query(
      collection(db, 'transferts'), where('siteDestId', '==', siteId)));
    if (snap.size > 0) {
      parCollection['transferts (reçus)'] = snap.size;
      total += snap.size;
    }
  } catch { /* rien */ }

  return { parCollection, total, vide: total === 0 };
}

/**
 * Fermer un site, ou le rouvrir.
 *
 * On n'efface rien : le site sort des listes et des sélecteurs, son
 * histoire reste lisible, et ses comptes restent justes. Un site
 * rouvert retrouve sa place telle qu'il l'avait laissée.
 */
export async function changerEtatSite(
  siteId: string, etat: 'actif' | 'inactif',
): Promise<void> {
  await updateDoc(doc(db, 'sites', siteId), { etat });
}

/**
 * Retirer un site pour de bon.
 *
 * Refuse tant qu'il reste quoi que ce soit. Ce n'est pas une
 * précaution de principe : les écritures ne portent pas le site, elles
 * le nomment. Les laisser derrière un site effacé ne les supprime pas,
 * cela les rend seulement illisibles — un montant qui compte encore
 * dans un total sans qu'on puisse dire d'où il vient.
 *
 * Celui qui veut vraiment effacer un site qui a servi passe donc
 * d'abord par « Vider les opérations », qui sait, lui, défaire ce qu'il
 * détruit — le stock remis à zéro, les soldes recalculés.
 */
export async function supprimerSite(siteId: string): Promise<void> {
  const ref = doc(db, 'sites', siteId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Ce site n’existe plus.');

  const contenu = await contenuDuSite(siteId);
  if (!contenu.vide) {
    const liste = Object.entries(contenu.parCollection)
      .map(([col, n]) => `${col} (${n})`).join(', ');
    throw new Error(
      `Ce site n’est pas vide : ${liste}. `
      + 'Videz d’abord ses opérations, ou désactivez-le pour le garder '
      + 'avec son historique.');
  }

  await deleteDoc(ref);
}

/**
 * Le ménage d'un site vidé : ce qui le meuble, puis lui.
 *
 * Après un vidage, un site garde ses produits, ses partenaires et son
 * équipe — c'est voulu, on veut pouvoir rejouer dessus. Mais pour le
 * retirer il faut aussi défaire cela, et le faire à la main obligerait
 * à supprimer chaque fiche une par une.
 *
 * On ne touche qu'à ce qui ne vit que par ce site. Les produits non :
 * ils appartiennent à l'activité et servent aux autres sites — seule
 * leur ligne d'inventaire ici (`produits_site`) disparaît.
 */
export async function viderMeublesDuSite(siteId: string): Promise<number> {
  const MEUBLES = ['produits_site', 'partenaires', 'employes', 'membres'] as const;
  let supprimes = 0;

  for (const col of MEUBLES) {
    let snap;
    try {
      snap = await getDocs(query(collection(db, col), where('siteId', '==', siteId)));
    } catch { continue; }

    /* Firestore n'accepte que 500 écritures par lot : on coupe avant. */
    let batch = writeBatch(db);
    let dansLot = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      supprimes++;
      if (++dansLot >= 450) { await batch.commit(); batch = writeBatch(db); dansLot = 0; }
    }
    if (dansLot > 0) await batch.commit();
  }

  return supprimes;
}
