import {
  collection, query, where, getDocs, addDoc, updateDoc, doc, getDoc,
  increment, writeBatch,
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
  /**
   * Le total du dossier porte déjà ce montant : ne pas l'ajouter.
   *
   * Sert à recoller un versement qui n'avait pas abouti. `avanceVersee`
   * s'était écrit, la ligne non : c'est la ligne qui manque, pas le
   * total. L'incrémenter une seconde fois doublerait ce que la vente
   * annonce encaissé.
   */
  sansTotal?: boolean;
  /**
   * D'où l'argent est sorti.
   *
   * Un fournisseur d'importation se règle souvent par virement, ou de la
   * main de l'admin : l'argent ne passe alors jamais par le tiroir du
   * site, et l'y faire transiter inventerait deux mouvements qui n'ont
   * pas eu lieu. Le versement existe quand même — la dette s'éteint —
   * mais le registre du site ne compte rien.
   *
   * Absent sur les anciens versements : ils sont tous passés par la
   * caisse, c'est ce que `caisse` veut dire.
   */
  origine?: 'caisse' | 'admin';
  /**
   * Le dossier réglé est une importation.
   *
   * `achatId` porte son identifiant, mais le dossier vit dans une autre
   * collection : rien, sur la ligne, ne disait de quel genre d'achat il
   * s'agissait. Le tableau de bord en a besoin pour grouper la dépense —
   * un conteneur ne se lit pas comme un réassort de boutique, et les
   * deux chemins de l'argent doivent se retrouver sous le même titre.
   */
  importation?: boolean;
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
     autorisation — et le versement attend avec lui.
     L'écrire tout de suite éteignait la dette et faisait passer le dossier
     à « réglé » alors que rien n'était entré : le registre disait qu'on
     avait payé avec un argent qui n'était pas là. La ligne voyage donc en
     réserve sur le mouvement d'attente, et c'est l'autorisation qui
     l'écrit. */
  const ecriture = saisie.sansCaisse ? null : await ecrireEnCaisse({
    siteId: saisie.siteId,
    sens: saisie.sens === 'entree' ? 'entree' : 'sortie',
    /* Le motif dit avec qui l'argent circule, le sous-motif à quel titre :
       « fournisseur » et « Règlement » se lisent ensemble, « achat » seul
       mélangeait les deux. */
    motif: saisie.motif === 'remboursement'
      ? (saisie.role === 'client' ? 'retour' : 'remboursement')
      : (saisie.role === 'client' ? 'client' : 'fournisseur'),
    /* Une importation se règle au même fournisseur, mais ce n'est pas le
       même genre de dépense : le sous-motif le dit au registre, pour que
       le conteneur ne se lise pas comme un réassort de boutique. */
    sousMotif: saisie.importation
      ? `Importation · ${LIBELLES_MOTIF_VERSEMENT[saisie.motif]}`
      : LIBELLES_MOTIF_VERSEMENT[saisie.motif],
    detail: saisie.partenaireNom ?? null,
    montant: saisie.montant,
    date: saisie.date,
    utilisateur: saisie.userId,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
    documentId: saisie.achatId ?? saisie.venteId ?? null,
    documentType: saisie.achatId ? 'achat' : saisie.venteId ? 'vente' : null,
    partenaireId: saisie.partenaireId,
  }, saisie.userId, saisie.adminUid ?? null, {
    /* La même saisie, rejouée à l'autorisation — mais sans repasser par
       la caisse : le mouvement sera déjà écrit, et c'est lui qu'on
       rattachera. */
  });

  /* Le versement s'écrit dans tous les cas : c'est un fait entre le
     partenaire et nous, et il ne dépend pas du tiroir. Ce qui attend,
     c'est le mouvement de caisse.

     Le versement ne porte donc le mouvement que si l'argent a bougé : en
     attente, `mouvementCaisseId` reste nul et la ligne de registre naîtra
     à l'autorisation. C'est là, et nulle part ailleurs, que se lit la
     différence entre « il a payé » et « c'est dans la caisse ». */
  const mouvementCaisseId = saisie.sansCaisse
    ? (saisie.mouvementCaisseId ?? null)
    : (ecriture?.applique ? ecriture.id : null);

  /* Le versement et le total du dossier s'écrivent ensemble.
   *
   * C'étaient deux écritures qui s'attendaient, et entre les deux il y
   * avait un trou : le versement inscrit, `avanceVersee` pas encore. La
   * vente paraissait alors impayée alors que l'argent était encaissé et
   * le client parti — un écart muet, que rien ne serait venu corriger.
   *
   * Un lot ferme ce trou et supprime l'attente : les deux passent, ou
   * aucune. Le dossier porte le total et jamais le détail, pour que
   * l'écran d'un achat dise ce qui reste sans lire toute la collection.
   *
   * `avanceVersee` ne porte que de l'argent. Un remboursement défait ce
   * qu'un versement avait réglé ; tout autre motif l'augmente. Le sens du
   * flux ne suffit pas à trancher : un remboursement de fournisseur est
   * une entrée, et il retire pourtant.
   *
   * Le retour de marchandise, lui, n'y touche pas. Il éteint une dette
   * sans qu'un franc ne circule : l'écrire ici faisait passer des sacs
   * rendus pour un paiement, et l'écran annonçait « Versé 6 500 » à côté
   * d'un onglet qui disait « Aucun versement ». Ce qu'un retour éteint se
   * lit sur le retour. */
  const dossierId = saisie.achatId ?? saisie.venteId;
  const touchePasAuTotal = !dossierId || saisie.motif === 'retour_marchandise'
    || saisie.sansTotal === true;

  /* Un remboursement doit savoir ce qu'il y avait : le total ne descend
     pas sous zéro, et l'écriture seule ne le garantirait pas. Il est rare
     — l'aller-retour se justifie pour lui seul. */
  const avanceAvant = (!touchePasAuTotal && saisie.motif === 'remboursement')
    ? await getDoc(doc(db, saisie.achatId ? 'achats' : 'ventes', dossierId!))
        .then(s => (s.exists() ? (s.data().avanceVersee ?? 0) : null))
        .catch(() => null)
    : null;

  const lot = writeBatch(db);
  const ref = doc(collection(db, 'versements'));
  lot.set(ref, {
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
    origine: saisie.origine ?? 'caisse',
    importation: saisie.importation ?? false,
    echeanceId: saisie.echeanceId ?? null,
    mouvementCaisseId,
    reference: saisie.reference ?? null,
    par: saisie.par ?? saisie.userId,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
    createdAt: serverTimestamp(),
  });

  if (!touchePasAuTotal) {
    const ligne = doc(db, saisie.achatId ? 'achats' : 'ventes', dossierId!);
    if (saisie.motif === 'remboursement') {
      /* Le dossier a pu disparaître : on n'écrit alors que le versement,
         plutôt que de perdre le fait pour un total dérivé. */
      if (avanceAvant !== null) {
        lot.update(ligne, {
          avanceVersee: Math.max(0, avanceAvant - saisie.montant),
        });
      }
    } else {
      /* `increment` additionne sur le serveur : deux versements
         simultanés s'ajoutent au lieu de s'écraser. */
      lot.update(ligne, { avanceVersee: increment(saisie.montant) });
    }
  }

  await lot.commit();

  return { id: ref.id, ...saisie, heure, mouvementCaisseId } as Versement;
}

/** Tous les versements d'un site, du plus récent au plus ancien. */
export async function chargerVersementsDuSite(siteId: Portee): Promise<Versement[]> {
  return (await lireDocs<Versement>('versements', siteId))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/**
 * Les versements d'un seul dossier.
 *
 * L'écran d'une vente ne montre que les siens. Les demander au site
 * entier pour n'en garder qu'une poignée faisait rapatrier toute la
 * collection à chaque ouverture, et à chaque confirmation — un coût qui
 * grandit avec l'ancienneté de l'activité, pour trois lignes affichées.
 */
export async function versementsDuDossier(
  dossierId: string, type: 'achat' | 'vente',
): Promise<Versement[]> {
  const snap = await getDocs(query(
    collection(db, 'versements'),
    where(type === 'achat' ? 'achatId' : 'venteId', '==', dossierId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Versement))
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
