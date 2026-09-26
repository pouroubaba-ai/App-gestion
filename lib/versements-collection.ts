import {
  collection, query, where, getDocs, addDoc, updateDoc, doc, getDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { ecrireEnCaisse } from './ecrire-caisse';
import type { RoleTiers } from './soldes';
import type { Auteur } from './auteur';
import { lireDocs, type Portee } from '@/lib/portee';

/**
 * Les versements, dans leur propre collection.
 *
 * Ils vivaient à trois endroits : un tableau imbriqué dans chaque achat, un
 * autre dans chaque vente, et la collection `recouvrement_versements`. Ce
 * nom disait déjà la faute — un versement n'est pas un appendice d'échéance,
 * c'est un fait qui existe par lui-même et qu'une échéance peut motiver.
 *
 * Un tableau imbriqué ne s'interroge pas : demander « tous les versements de
 * septembre » obligeait à charger tous les achats et à les parcourir. Sortis
 * ici, les versements se lisent d'une requête, quelle que soit leur origine.
 *
 * Un seul sens pour les deux côtés, comme pour les mouvements : l'argent
 * d'une caisse est un flux unique. Deux collections obligeraient à lire les
 * deux et à fusionner pour la moindre question.
 */

export type SensVersement = 'entree' | 'sortie';

/**
 * Pourquoi l'argent a bougé.
 *
 * Le moment où le client paie ne dit pas la même chose selon l'état de la
 * marchandise. Payer avant qu'elle parte, c'est avancer de l'argent — le site
 * le doit encore. Payer au moment où elle part, c'est acheter. Payer après,
 * c'est éteindre une dette qui existait déjà. Les confondre rendrait la
 * caisse illisible : on ne saurait plus ce qui est dû de ce qui est vendu.
 *
 *  - `avance`       : versé avant que la marchandise ne parte
 *  - `vente`        : versé au moment où elle part — livraison ou comptoir
 *  - `reglement`    : versé plus tard, sur une dette déjà née
 *  - `recouvrement` : versé pour honorer une échéance ; porte son identifiant
 *  - `remboursement`: rendu au tiers, sur un retour ou un trop-perçu
 */
export type MotifVersement =
  'avance' | 'vente' | 'reglement' | 'recouvrement' | 'remboursement'
  /* La marchandise rendue éteint la dette sans qu'un centime bouge. Un
     « règlement » le dirait mal : rien n'a été payé, quelque chose a été
     rendu, et celui qui relit ses comptes doit pouvoir faire la
     différence. */
  | 'retour_marchandise'
  /* Deux dettes réciproques s'annulent à hauteur de la plus petite. Rien
     ne circule : c'est du papier contre du papier, et l'appeler
     « règlement » ferait croire qu'un tiroir s'est ouvert. */
  | 'compensation';

export const LIBELLES_MOTIF_VERSEMENT: Record<MotifVersement, string> = {
  avance: 'Avance',
  vente: 'Vente',
  reglement: 'Règlement',
  recouvrement: 'Recouvrement',
  remboursement: 'Remboursement',
  retour_marchandise: 'Retour de marchandise',
  compensation: 'Compensation',
};

export interface Versement {
  id: string;
  siteId: string;
  userId: string;
  date: string;
  heure: string;
  montant: number;
  /** encaissé d'un client, ou payé à un fournisseur */
  sens: SensVersement;
  motif: MotifVersement;
  partenaireId: string;
  partenaireNom?: string | null;
  role: RoleTiers;
  /** le dossier réglé ; l'un ou l'autre, jamais les deux */
  achatId?: string | null;
  venteId?: string | null;
  /** l'échéance honorée, quand le motif est `recouvrement` */
  echeanceId?: string | null;
  /** le mouvement de caisse jumeau, pour pouvoir remonter au registre */
  mouvementCaisseId?: string | null;
  reference?: string | null;
  par?: string | null;
  /* Qui a encaissé. Recopié au moment du geste : une fiche employé qui
     change ou disparaît ne doit pas réécrire l'histoire. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /* Régler cinq dossiers d'un coup ne sort l'argent qu'une fois : cinq
     mouvements de caisse diraient cinq sorties, et chacun coûte une
     transaction sur le compteur — c'est ce qui rendait un versement
     multiple si lent. L'appelant écrit alors la caisse lui-même. */
  sansCaisse?: boolean;
}

export type SaisieVersement = Omit<Versement, 'id' | 'heure'>
  & {
    heure?: string;
    mouvementCaisseId?: string | null;
    /* L'admin de l'activité : il n'a pas de rôle de site, on le reconnaît
       à son identifiant quand la caisse cherche qui agit. */
    adminUid?: string | null;
  };

function maintenant() {
  return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Enregistre un versement, et le mouvement de caisse qu'il produit.
 *
 * Les deux écritures vont ensemble : encaisser sans que la caisse bouge
 * laissait le registre faux de tout ce qui était entré, sans que rien ne le
 * signale. Le versement garde l'identifiant du mouvement pour qu'on puisse
 * toujours retrouver l'un depuis l'autre.
 *
 * Le total du dossier suit dans le même geste : c'est le seul chiffre
 * recopié, et il se recalcule depuis les versements en cas de doute.
 */
export async function enregistrerVersement(saisie: SaisieVersement): Promise<Versement> {
  if (saisie.montant <= 0) throw new Error('Le montant doit être positif.');

  const heure = saisie.heure ?? maintenant();

  /* L'argent d'un client entre, celui d'un fournisseur sort. Un
     remboursement inverse ce sens : c'est le même geste à l'envers. */
  /* L'argent ne va pas droit au tiroir : dès que le site a un responsable
     de la caisse et que ce n'est pas lui qui agit, le mouvement attend son
     autorisation. Le versement existe quand même — la dette est éteinte,
     le dossier est réglé — mais le registre ne compte rien encore. */
  const ecriture = saisie.sansCaisse ? null : await ecrireEnCaisse({
    siteId: saisie.siteId,
    sens: saisie.sens === 'entree' ? 'entree' : 'sortie',
    /* Le motif dit avec qui l'argent circule, le sous-motif à quel titre :
       « fournisseur » et « Règlement » se lisent ensemble, « achat » seul
       mélangeait les deux. */
    motif: saisie.motif === 'remboursement'
      ? (saisie.role === 'client' ? 'retour' : 'remboursement')
      : (saisie.role === 'client' ? 'client' : 'fournisseur'),
    sousMotif: LIBELLES_MOTIF_VERSEMENT[saisie.motif],
    detail: saisie.partenaireNom ?? null,
    montant: saisie.montant,
    date: saisie.date,
    utilisateur: saisie.userId,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
    documentId: saisie.achatId ?? saisie.venteId ?? null,
    documentType: saisie.achatId ? 'achat' : saisie.venteId ? 'vente' : null,
    partenaireId: saisie.partenaireId,
  }, saisie.userId, saisie.adminUid ?? null);

  /* Le versement ne porte le mouvement que si l'argent a bougé : en
     attente, la ligne de registre naîtra à l'autorisation. */
  const mouvementCaisseId = saisie.sansCaisse
    ? (saisie.mouvementCaisseId ?? null)
    : (ecriture?.applique ? ecriture.id : null);

  const ref = await addDoc(collection(db, 'versements'), {
    siteId: saisie.siteId,
    userId: saisie.userId,
    date: saisie.date,
    heure,
    montant: saisie.montant,
    sens: saisie.sens,
    motif: saisie.motif,
    partenaireId: saisie.partenaireId,
    partenaireNom: saisie.partenaireNom ?? null,
    role: saisie.role,
    achatId: saisie.achatId ?? null,
    venteId: saisie.venteId ?? null,
    echeanceId: saisie.echeanceId ?? null,
    mouvementCaisseId,
    reference: saisie.reference ?? null,
    par: saisie.par ?? saisie.userId,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
    createdAt: serverTimestamp(),
  });

  /* Le dossier porte le total, jamais le détail : l'écran de l'achat doit
     pouvoir dire ce qui reste sans lire toute la collection. */
  const dossierId = saisie.achatId ?? saisie.venteId;
  if (dossierId) {
    const col = saisie.achatId ? 'achats' : 'ventes';
    const snap = await getDoc(doc(db, col, dossierId));
    if (snap.exists()) {
      const avance = snap.data().avanceVersee ?? 0;
      /* `avanceVersee` ne porte que de l'argent.
       *
       * Un remboursement défait ce qu'un versement avait réglé ; tout
       * autre motif l'augmente. Le sens du flux ne suffit pas à
       * trancher : un remboursement de fournisseur est une entrée, et il
       * retire pourtant.
       *
       * Le retour de marchandise, lui, ne touche pas à ce champ. Il
       * éteint une dette sans qu'un franc ne circule : l'écrire ici
       * faisait passer des sacs rendus pour un paiement, et l'écran
       * annonçait « Versé 6 500 » à côté d'un onglet qui disait « Aucun
       * versement ». Ce qu'un retour éteint se lit sur le retour. */
      if (saisie.motif === 'retour_marchandise') return { id: ref.id, ...saisie, heure, mouvementCaisseId } as Versement;
      const delta = saisie.motif === 'remboursement' ? -saisie.montant : saisie.montant;
      await updateDoc(doc(db, col, dossierId), {
        avanceVersee: Math.max(0, avance + delta),
      });
    }
  }

  return { id: ref.id, ...saisie, heure, mouvementCaisseId } as Versement;
}

/** Tous les versements d'un site, du plus récent au plus ancien. */
export async function chargerVersementsDuSite(siteId: Portee): Promise<Versement[]> {
  return (await lireDocs<Versement>('versements', siteId))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/** Les versements d'un tiers, tous rôles ou un seul. */
export async function chargerVersementsDuTiers(
  siteId: string, partenaireId: string, role?: RoleTiers,
): Promise<Versement[]> {
  const snap = await getDocs(query(
    collection(db, 'versements'),
    where('siteId', '==', siteId),
    where('partenaireId', '==', partenaireId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Versement))
    .filter(v => !role || v.role === role)
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/** Ce qui a été versé sur un dossier, recalculé depuis les faits. */
export function totalVerse(versements: Versement[], dossierId: string): number {
  return versements
    .filter(v => (v.achatId ?? v.venteId) === dossierId)
    .reduce((n, v) => n + (v.motif === 'remboursement' ? -v.montant : v.montant), 0);
}
