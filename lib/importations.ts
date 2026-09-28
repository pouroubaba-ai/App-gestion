import {
  collection, addDoc, doc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { lireParSite, type Portee } from '@/lib/portee';
import { totalFrais, type Frais, type CleRepartition } from '@/lib/frais';
import { valeurRecue, valeurEnvoyee, type LigneFlux } from '@/lib/flux-marchandise';

/**
 * Une importation : de la marchandise qui vient de loin.
 *
 * C'est un achat, avec le temps en plus. Entre la commande et le rayon,
 * il se passe des semaines et des mains : un fournisseur qui valide, un
 * navire, une douane, un transitaire. Chacune de ces étapes est un fait
 * qu'on veut pouvoir dater — savoir qu'un conteneur est bloqué au port
 * depuis douze jours n'a rien à voir avec savoir qu'il est « en cours ».
 *
 * D'où les neuf états, là où un achat local en a quatre. Le reste est
 * identique : les lignes portent la marchandise, les frais s'y
 * répartissent, et la confirmation seule fait entrer le stock.
 *
 * Le dossier appartient à la maison, mais il vise un site : c'est là que
 * la marchandise ira, et c'est ce site qui la comptera.
 */

export type EtatImportation =
  | 'en_attente'
  | 'valide'
  | 'expedie'
  | 'arrive'
  | 'dedouane'
  | 'recu'
  | 'traitement'
  | 'attente_confirmation'
  | 'confirme'
  | 'annule';

/**
 * L'ordre du cycle. Un état n'est atteint que parce que le précédent est
 * fait — on ne dédouane pas ce qui n'est pas arrivé.
 *
 * `attente_confirmation` n'y figure pas : ce n'est pas une étape du
 * voyage mais un arrêt, posé quand celui qui a compté n'est pas celui
 * qui peut clore.
 */
export const ETAPES_IMPORTATION: EtatImportation[] = [
  'en_attente', 'valide', 'expedie', 'arrive',
  'dedouane', 'recu', 'traitement', 'confirme',
];

export const LIBELLES_IMPORTATION: Record<EtatImportation, string> = {
  /* le fournisseur n'a pas encore dit oui */
  en_attente: 'En attente',
  /* il a confirmé la commande ; rien n'a bougé */
  valide: 'Validé',
  /* la marchandise a quitté le fournisseur */
  expedie: 'Expédié',
  /* elle est au port, à l'aéroport, à la frontière */
  arrive: 'Arrivé',
  /* la douane l'a laissée passer */
  dedouane: 'Dédouané',
  /* elle est chez nous ; ce qu'elle contient reste à compter */
  recu: 'Reçu',
  /* on compte et on confronte au commandé */
  traitement: 'En traitement',
  /* compté par quelqu'un qui ne peut pas clore : l'écart attend un œil */
  attente_confirmation: 'À confirmer',
  /* le stock est entré, les frais sont dans le coût : le dossier est clos */
  confirme: 'Confirmé',
  annule: 'Annulé',
};

/** Ce que chaque étape attend de celui qui la franchit. */
export const AIDE_IMPORTATION: Partial<Record<EtatImportation, string>> = {
  en_attente: 'Le fournisseur n’a pas encore confirmé la commande.',
  valide: 'Commande confirmée. La marchandise n’a pas encore quitté le fournisseur.',
  expedie: 'En route. C’est ici que le transport se connaît.',
  arrive: 'Au port ou à la frontière, pas encore dédouanée.',
  dedouane: 'Sortie de douane. Les droits sont connus.',
  recu: 'Arrivée sur le site. Il reste à compter ce qu’il y a dedans.',
  traitement: 'On compte, et on confronte au commandé.',
  attente_confirmation: 'Compté par le responsable des commandes. Un écart peut exister : à vérifier avant de clore.',
};

export interface Importation {
  id: string;
  reference: string;
  /** L'activité à qui appartient le dossier. */
  activiteId: string;
  /** Le site où la marchandise ira, et qui la comptera. */
  siteId: string;
  siteNom?: string | null;
  fournisseurId?: string | null;
  fournisseurNom: string;
  /** Le pays ou la ville d'où elle part — pour s'y retrouver entre dossiers. */
  origine?: string | null;
  etat: EtatImportation;
  lignes: LigneFlux[];
  /**
   * Les frais du voyage : transport, douane, transit, manutention.
   *
   * Ils s'ajoutent au fil des étapes plutôt qu'en bloc à la fin : le
   * fret se connaît à l'expédition, les droits au dédouanement.
   * Ressaisir de mémoire des montants vieux de six semaines est le
   * meilleur moyen de se tromper.
   */
  frais?: Frais[] | null;
  fraisCorrection?: Record<number, number> | null;
  fraisCle?: CleRepartition | null;
  /** total payé d'avance ; somme des versements */
  avanceVersee?: number;
  note?: string | null;
  /** Quand chaque étape a été franchie : un dossier se lit dans sa durée. */
  dates?: Partial<Record<EtatImportation, string>>;
  /** Qui a franchi quelle étape. */
  auteurs?: Partial<Record<EtatImportation, { nom: string; fonction?: string | null }>>;
  userId: string;
  createdAt?: any;
}

/* ═══════════════════════ LECTURE ═══════════════════════ */

/** Les importations d'une portée. */
export async function importationsDe(portee: Portee): Promise<Importation[]> {
  const docs = await lireParSite('importations', portee);
  return docs
    .map(d => ({ id: d.id, ...(d.data() as any) }) as Importation)
    .sort((a: Importation, b: Importation) =>
      (b.reference ?? '').localeCompare(a.reference ?? ''));
}

/** Ce que le dossier a coûté : la marchandise et le voyage. */
export function totalImportation(i: {
  lignes?: LigneFlux[] | null; frais?: Frais[] | null; etat?: EtatImportation;
}): number {
  const lignes = i.lignes ?? [];
  /* Avant la réception, rien n'est compté : c'est le commandé qui dit ce
     que le dossier engage. Après, c'est le reçu qui dit ce qu'il vaut. */
  const marchandise = i.etat && ETAPES_IMPORTATION.indexOf(i.etat) >= ETAPES_IMPORTATION.indexOf('recu')
    ? valeurRecue(lignes)
    : valeurEnvoyee(lignes);
  return marchandise + totalFrais(i.frais);
}

/** Le jour où le dossier s'est ouvert. */
export function dateOuverture(i: Importation): string | null {
  return i.dates?.en_attente ?? null;
}

/**
 * Depuis combien de jours le dossier existe.
 *
 * Il ne se remet pas à zéro d'une étape à l'autre : ce qu'on veut
 * savoir, c'est depuis quand on attend cette marchandise. Un dossier de
 * quarante jours encore « expédié » se voit au premier regard, là où
 * son état seul dirait la même chose qu'hier.
 *
 * Un dossier clos garde l'âge qu'il avait à sa clôture : il a cessé de
 * vieillir le jour où la marchandise est entrée.
 */
export function ageEnJours(i: Importation): number | null {
  const debut = dateOuverture(i);
  if (!debut) return null;
  const fin = i.etat === 'confirme' || i.etat === 'annule'
    ? (i.dates?.[i.etat] ?? new Date().toISOString().slice(0, 10))
    : new Date().toISOString().slice(0, 10);
  const ms = Date.parse(fin) - Date.parse(debut);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Le temps qu'a mis la marchandise, du feu vert à l'arrivée.
 *
 * On compte de « validé » à « reçu » plutôt que depuis l'ouverture : ce
 * qui précède la validation est une négociation, et elle n'engage pas
 * le fournisseur. Ce qu'on lui impute commence au moment où il a dit
 * oui.
 *
 * `null` quand l'une des deux dates manque : un dossier qui n'a pas
 * franchi ces étapes n'apprend rien sur les délais.
 */
export function delaiLivraison(i: Importation): number | null {
  const debut = i.dates?.valide;
  const fin = i.dates?.recu;
  if (!debut || !fin) return null;
  const ms = Date.parse(fin) - Date.parse(debut);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86400000));
}

/** Un dossier est-il encore en route ? */
export function enCours(etat: EtatImportation): boolean {
  return etat !== 'confirme' && etat !== 'annule';
}

/**
 * L'étape suivante, dans l'ordre du voyage.
 *
 * `attente_confirmation` sort du rang : elle ne vient pas après une
 * étape mais après un compte, et elle mène à la confirmation.
 */
export function etapeSuivante(etat: EtatImportation): EtatImportation | null {
  if (etat === 'attente_confirmation') return 'confirme';
  const i = ETAPES_IMPORTATION.indexOf(etat);
  if (i < 0 || i >= ETAPES_IMPORTATION.length - 1) return null;
  return ETAPES_IMPORTATION[i + 1];
}

/**
 * Qui peut faire avancer un dossier, et jusqu'où.
 *
 * Le voyage appartient à la maison : l'admin suit le conteneur, paie le
 * fret, dédouane. Le responsable des commandes ne voit rien de tout
 * cela — il reçoit la marchandise, et c'est là que son rôle commence.
 *
 * `null` désigne le propriétaire, qui peut tout : sur une maison sans
 * responsable des commandes, personne d'autre ne conclurait.
 */
export function peutAvancer(
  etat: EtatImportation, role: string | null | undefined, estAdmin: boolean,
): boolean {
  if (etat === 'confirme' || etat === 'annule') return false;
  /* Jusqu'à la réception, c'est le voyage : seule la maison le mène. */
  const avantReception = ETAPES_IMPORTATION.indexOf(etat)
    < ETAPES_IMPORTATION.indexOf('recu');
  if (avantReception) return estAdmin;
  /* Un écart entre commandé et reçu doit être vu par quelqu'un qui n'a
     pas compté : celui qui a déclaré les quantités ne clôt pas. */
  if (etat === 'attente_confirmation') return estAdmin;
  return estAdmin || role === 'commandes';
}

/**
 * Vers quel état va-t-on, selon qui pousse.
 *
 * Sortir de « traitement » clôt le dossier — sauf si c'est le
 * responsable des commandes qui pousse : c'est lui qui a fourni les
 * quantités, et un écart avec le commandé doit passer sous un autre
 * regard. Le dossier s'arrête alors à `attente_confirmation`.
 */
export function prochainEtat(
  etat: EtatImportation, role: string | null | undefined, estAdmin: boolean,
): EtatImportation | null {
  if (etat === 'traitement' && !estAdmin && role === 'commandes') {
    return 'attente_confirmation';
  }
  return etapeSuivante(etat);
}

/* ═══════════════════════ ÉCRITURE ═══════════════════════ */

/** Une référence lisible : IM, la date, quatre caractères. */
export function referenceImportation(date: string): string {
  const jour = date.replace(/-/g, '').slice(2);
  const suffixe = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `IM${jour}-${suffixe}`;
}

export async function creerImportation(params: {
  activiteId: string;
  siteId: string;
  siteNom?: string | null;
  fournisseurId?: string | null;
  fournisseurNom: string;
  origine?: string | null;
  lignes: LigneFlux[];
  note?: string | null;
  userId: string;
  auteurNom?: string | null;
  auteurFonction?: string | null;
}): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const ref = await addDoc(collection(db, 'importations'), {
    reference: referenceImportation(date),
    activiteId: params.activiteId,
    siteId: params.siteId,
    siteNom: params.siteNom ?? null,
    fournisseurId: params.fournisseurId ?? null,
    fournisseurNom: params.fournisseurNom,
    origine: params.origine ?? null,
    etat: 'en_attente' as EtatImportation,
    lignes: params.lignes,
    frais: [],
    fraisCorrection: null,
    avanceVersee: 0,
    note: params.note ?? null,
    dates: { en_attente: date },
    auteurs: params.auteurNom
      ? { en_attente: { nom: params.auteurNom, fonction: params.auteurFonction ?? null } }
      : {},
    userId: params.userId,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Franchir une étape.
 *
 * Le dossier garde la date et l'auteur de chacune : un conteneur bloqué
 * trois semaines en douane se lit dans ces dates, pas dans son état
 * courant. Rien ne s'efface — on ajoute.
 *
 * Cette fonction ne fait pas entrer le stock : seule la confirmation le
 * fait, et elle a sa propre porte.
 */
export async function avancerImportation(params: {
  importation: Importation;
  vers: EtatImportation;
  userId: string;
  auteurNom?: string | null;
  auteurFonction?: string | null;
  /** Les quantités comptées, quand l'étape en demande. */
  lignes?: LigneFlux[] | null;
}): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  await updateDoc(doc(db, 'importations', params.importation.id), {
    etat: params.vers,
    ...(params.lignes ? { lignes: params.lignes } : {}),
    [`dates.${params.vers}`]: date,
    ...(params.auteurNom
      ? { [`auteurs.${params.vers}`]: {
          nom: params.auteurNom, fonction: params.auteurFonction ?? null } }
      : {}),
  });
}

/** Renoncer : le dossier reste, son état dit qu'il n'ira pas plus loin. */
export async function annulerImportation(params: {
  id: string; auteurNom?: string | null;
}): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  await updateDoc(doc(db, 'importations', params.id), {
    etat: 'annule' as EtatImportation,
    'dates.annule': date,
    ...(params.auteurNom ? { 'auteurs.annule': { nom: params.auteurNom } } : {}),
  });
}

/** Poser ou reprendre les frais du voyage, tant que rien n'est clos. */
export async function majFraisImportation(params: {
  id: string;
  frais: Frais[];
  correction?: Record<number, number> | null;
  cle?: CleRepartition | null;
}): Promise<void> {
  await updateDoc(doc(db, 'importations', params.id), {
    frais: params.frais,
    fraisCorrection: params.correction ?? null,
    ...(params.cle ? { fraisCle: params.cle } : {}),
  });
}
