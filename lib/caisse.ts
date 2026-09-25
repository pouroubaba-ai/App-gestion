import {
  collection, addDoc, getDocs, query, where, serverTimestamp, doc, updateDoc,
  runTransaction,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { lireDocs, type Portee } from '@/lib/portee';

/**
 * Le registre de caisse.
 *
 * Jusqu'ici la caisse n'existait pas : elle était recalculée à chaque
 * affichage en relisant six collections. Un mouvement qui ne découlait
 * d'aucun acte — un loyer, un apport — n'avait donc nulle part où aller.
 *
 * Ce registre lui donne un lieu. La caisse enregistre ce qui la traverse :
 * elle ne dit pas ce que l'activité a coûté, seulement ce qui est entré et
 * sorti du tiroir. Ce qui ne passe pas par elle lui reste invisible.
 */

export type SensCaisse = 'entree' | 'sortie';

/**
 * Le motif dit d'où vient l'argent, ou vers qui il part — jamais à quel
 * moment du cycle. Une avance et un règlement à un fournisseur vont au
 * même endroit : ils partagent le motif Achats, et se distinguent par
 * leur sous-motif.
 */
export type MotifCaisse =
  /* entrées */
  | 'client'        // l'argent qui vient d'un client
  | 'fournisseur'   // l'argent qui part chez un fournisseur
  | 'apport'        // le propriétaire met de l'argent dans l'activité
  | 'remboursement' // avance employé rendue, retour fournisseur remboursé
  /* sorties */
  | 'remuneration'  // salaires et avances employés
  | 'boutique'      // loyer, électricité, transport : les frais de fonctionnement
  | 'retrait'       // le propriétaire retire de l'argent de l'activité
  | 'retour'        // remboursement d'un client qui rend de la marchandise
  | 'annulation'    // l'écriture inverse qui neutralise une erreur
  /**
   * L'écart constaté entre le tiroir et le registre. Il ne s'explique pas
   * par une opération — c'est justement son objet : inscrire ce que le
   * comptage a trouvé, dans un sens ou dans l'autre.
   *
   * Il ne se saisit plus à la main : un écart est un constat, non une
   * décision, et celui qui compte ne peut pas attester que son compte est
   * juste. Il passe par `ecarts_caisse`, où un autre le reconnaît — et
   * c'est cette reconnaissance qui écrit le mouvement porté ici.
   */
  | 'reajustement';

export const LIBELLES_MOTIF_CAISSE: Record<MotifCaisse, string> = {
  client: 'Client',
  apport: 'Apport',
  remboursement: 'Remboursement',
  fournisseur: 'Fournisseur',
  remuneration: 'Rémunérations',
  boutique: 'Boutique',
  retrait: 'Retrait',
  retour: 'Retour',
  annulation: 'Annulation',
  reajustement: 'Réajustement',
};

/**
 * Les seuls motifs qu'on saisit à la main. Tous les autres naissent d'un
 * acte — une vente, un versement — et les ressaisir créerait des doublons
 * que rien ne raccorderait.
 */
export const MOTIFS_MANUELS: Record<SensCaisse, MotifCaisse[]> = {
  entree: ['apport'],
  sortie: ['retrait', 'boutique'],
};

/**
 * Un mouvement peut-il être annulé depuis la caisse ?
 *
 * Seulement s'il y a été saisi à la main. Un mouvement automatique est la
 * conséquence d'un acte : l'annuler ici laisserait sa cause intacte — la
 * vente existerait encore, le stock serait parti, et l'encaissement aurait
 * disparu. Une conséquence se défait par sa cause, c'est le retour du
 * produit qui annule l'entrée d'une vente.
 */
export function annulableEnCaisse(m: MouvementCaisse): boolean {
  if (m.documentId) return false;
  if (m.annuleId || m.annuleParId) return false;
  return MOTIFS_MANUELS[m.sens].includes(m.motif);
}

export interface MouvementCaisse {
  id: string;
  /**
   * Numéro de registre, unique et sans trou : A-2026-0000001.
   *
   * L'horodatage suffit à ordonner, mais il ne se lit pas : on ne dit pas
   * « le mouvement de 14 h 03 min 22 s ». Un numéro se cite, et surtout sa
   * continuité se vérifie — un trou dans la suite prouve qu'une ligne
   * manque, ce qu'aucune date ne peut montrer.
   *
   * L'année est avant le numéro et le numéro est complété de zéros : le
   * tri alphabétique donne donc le bon ordre.
   */
  numero: string;
  siteId: string;
  sens: SensCaisse;
  motif: MotifCaisse;
  /**
   * Précise le motif. Pour un acte automatique il est déduit — « Vente »,
   * « Recouvrement » ; pour un frais de boutique il vient de la liste que
   * l'utilisateur gère — « Loyer », « Électricité ».
   */
  sousMotif?: string | null;
  /**
   * Ce qu'on lit pour savoir de quoi il s'agit. Généré pour un acte
   * automatique — le nom du partenaire et la référence du document —
   * saisi librement pour un mouvement manuel.
   */
  detail?: string | null;
  montant: number;
  /** quand l'argent a bougé */
  date: string;
  /**
   * Qui a fait l'opération. L'identifiant sert à relier, le nom à lire,
   * la fonction à situer : « Kouassi » ne dit pas à quel titre il a sorti
   * l'argent, « Gérant » ne dit pas lequel.
   *
   * Nom et fonction sont copiés au moment de l'écriture, pas résolus à
   * l'affichage : un employé qui change de poste ne doit pas réécrire
   * l'histoire de ce qu'il a fait sous son ancienne fonction.
   */
  utilisateur?: string | null;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /**
   * Le document d'où vient ce mouvement. Le détail est fait pour être lu,
   * cette référence pour être suivie : sans elle, impossible de remonter
   * du registre à la vente ou à l'achat qui l'a produit.
   */
  documentId?: string | null;
  documentType?: 'vente' | 'achat' | 'transfert' | 'employe' | null;
  partenaireId?: string | null;
  /**
   * Quand quelqu'un l'a écrit, distinct de la date du mouvement. Les deux
   * diffèrent dès qu'on saisit en retard — et c'est ce qui rend visible
   * une écriture ajoutée après coup. Sert aussi d'ordre : l'horodatage
   * vient du serveur, une horloge déréglée ne peut pas le fausser.
   */
  dateSaisie?: any;
  /**
   * Ce qu'il y avait dans le tiroir avant l'opération, et ce qu'il y a
   * après. Les deux sont figés à l'écriture : la ligne se suffit à
   * elle-même, sans dépendre du calcul de celles qui l'entourent.
   *
   * Le `soldeApres` d'un mouvement devient le `soldeAvant` du suivant :
   * c'est ce chaînage qui rend la suite vérifiable à l'œil.
   */
  soldeAvant: number;
  soldeApres: number;
  /**
   * Un mouvement ne se supprime jamais : l'argent a bougé, effacer la ligne
   * ne le fait pas revenir — ça fabrique un registre qui ment. Une erreur
   * se corrige par une écriture inverse, et les deux restent visibles.
   *
   * `annuleId` : sur la contre-passation, l'id du mouvement qu'elle annule.
   * `annuleParId` : sur le mouvement annulé, l'id de sa contre-passation.
   */
  annuleId?: string | null;
  annuleParId?: string | null;
}

/** Ce qu'il faut fournir pour écrire au registre : le solde est calculé. */
export type SaisieCaisse = Omit<
  MouvementCaisse,
  'id' | 'numero' | 'dateSaisie' | 'soldeAvant' | 'soldeApres' | 'annuleId' | 'annuleParId'
> & { annuleId?: string | null };

/**
 * Réserve le numéro et le solde de départ du prochain mouvement.
 *
 * Le compteur porte les deux : le dernier rang attribué, et le solde de la
 * caisse après le dernier mouvement. Les lire ensemble dans une transaction
 * est ce qui garantit la cohérence — deux caissiers qui valident au même
 * instant ne peuvent ni recevoir le même numéro, ni partir du même solde.
 *
 * C'est aussi ce qui évite de relire tout le registre à chaque écriture :
 * un seul document, quelle que soit sa taille.
 */
async function reserverPlace(
  siteId: string, montantSigne: number,
): Promise<{ numero: string; soldeAvant: number; soldeApres: number }> {
  const annee = new Date().getFullYear();
  /* le rang repart à 1 chaque année ; le solde, lui, traverse les années */
  const refRang = doc(db, 'caisse_compteurs', `${siteId}_${annee}`);
  const refSolde = doc(db, 'caisse_compteurs', `${siteId}_solde`);

  return runTransaction(db, async (tx) => {
    const [snapRang, snapSolde] = await Promise.all([tx.get(refRang), tx.get(refSolde)]);

    const rang = (snapRang.exists() ? (snapRang.data().dernier ?? 0) : 0) + 1;
    const soldeAvant = snapSolde.exists() ? (snapSolde.data().solde ?? 0) : 0;
    const soldeApres = soldeAvant + montantSigne;

    /* On ne sort pas d'un tiroir plus qu'il ne contient. La vérification est
       ici, dans la transaction : contrôler seulement dans le formulaire
       laisserait passer deux sorties simultanées qui, prises ensemble,
       dépassent le solde. */
    if (soldeApres < 0) {
      throw new Error(
        `La caisse ne contient que ${soldeAvant.toLocaleString('fr-FR')} FCFA.`);
    }

    tx.set(refRang, { siteId, annee, dernier: rang }, { merge: true });
    tx.set(refSolde, { siteId, solde: soldeApres }, { merge: true });

    return {
      numero: `A-${annee}-${String(rang).padStart(7, '0')}`,
      soldeAvant,
      soldeApres,
    };
  });
}

/**
 * Ordre d'écriture. Le numéro suffit — année puis rang complété de zéros,
 * le tri alphabétique donne le bon ordre. L'horodatage ne sert qu'aux
 * lignes écrites avant que la numérotation n'existe.
 */
export function comparerOrdre(a: MouvementCaisse, b: MouvementCaisse): number {
  if (a.numero && b.numero) return a.numero.localeCompare(b.numero);
  const ta = a.dateSaisie?.seconds ?? 0;
  const tb = b.dateSaisie?.seconds ?? 0;
  if (ta !== tb) return ta - tb;
  return a.id.localeCompare(b.id);
}

export async function enregistrerMouvementCaisse(
  saisie: SaisieCaisse,
): Promise<string> {
  const montantSigne = saisie.sens === 'entree' ? saisie.montant : -saisie.montant;
  const { numero, soldeAvant, soldeApres } = await reserverPlace(
    saisie.siteId, montantSigne);

  const ref = await addDoc(collection(db, 'mouvements_caisse'), {
    ...saisie,
    numero,
    soldeAvant,
    soldeApres,
    sousMotif: saisie.sousMotif ?? null,
    detail: saisie.detail ?? null,
    utilisateur: saisie.utilisateur ?? null,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
    documentId: saisie.documentId ?? null,
    documentType: saisie.documentType ?? null,
    partenaireId: saisie.partenaireId ?? null,
    annuleId: saisie.annuleId ?? null,
    annuleParId: null,
    dateSaisie: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Annule un mouvement par une écriture inverse.
 *
 * Le mouvement d'origine reste : le registre montre qu'une erreur a été
 * faite et corrigée, ce qui est la réalité. Aucun solde antérieur ne bouge,
 * puisque les deux écritures s'ajoutent l'une après l'autre.
 */
export async function annulerMouvementCaisse(params: {
  mouvement: MouvementCaisse;
  utilisateur?: string | null;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  motif?: string | null;
}): Promise<string> {
  const { mouvement } = params;
  if (mouvement.annuleParId) throw new Error('Ce mouvement est déjà annulé.');
  if (mouvement.annuleId) throw new Error("Une annulation ne s'annule pas.");
  if (mouvement.documentId) {
    throw new Error(
      "Ce mouvement vient d'un document : il se défait par son document, pas ici.");
  }

  const idContrepassation = await enregistrerMouvementCaisse({
    siteId: mouvement.siteId,
    /* l'écriture inverse : ce qui est sorti rentre, ce qui est entré sort */
    sens: mouvement.sens === 'entree' ? 'sortie' : 'entree',
    /* Son propre motif : reprendre celui du mouvement annulé donnait des
       lignes illisibles — une « sortie » de motif « Apport ». */
    motif: 'annulation',
    sousMotif: LIBELLES_MOTIF_CAISSE[mouvement.motif],
    detail: `Annulation — ${mouvement.detail || LIBELLES_MOTIF_CAISSE[mouvement.motif]}`
      + (params.motif ? ` · ${params.motif}` : ''),
    montant: mouvement.montant,
    date: new Date().toISOString().split('T')[0],
    utilisateur: params.utilisateur ?? null,
    utilisateurNom: params.utilisateurNom ?? null,
    utilisateurFonction: params.utilisateurFonction ?? null,
    annuleId: mouvement.id,
  });

  /* le mouvement d'origine porte la marque de son annulation : sans elle,
     on ne saurait pas, en le lisant, qu'il a été contre-passé */
  await updateDoc(doc(db, 'mouvements_caisse', mouvement.id), {
    annuleParId: idContrepassation,
  });

  return idContrepassation;
}

export async function chargerCaisseDuSite(siteId: Portee): Promise<MouvementCaisse[]> {
  return (await lireDocs<MouvementCaisse>('mouvements_caisse', siteId))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/** Le solde actuel : celui d'après le dernier mouvement écrit. */
export function soldeCaisse(mouvements: MouvementCaisse[]): number {
  if (mouvements.length === 0) return 0;
  return [...mouvements].sort(comparerOrdre)[mouvements.length - 1].soldeApres ?? 0;
}
