/**
 * Ce qui doit entrer ou sortir de la caisse, et que le caissier n'a pas
 * encore autorisé.
 *
 * Décider d'un mouvement et le faire sont deux gestes, et ils n'appartiennent
 * pas à la même personne. Le gérant vend au comptant, le chargé de
 * recouvrement encaisse chez un client, quelqu'un décide de payer un
 * fournisseur : à cet instant l'acte commercial est fait — la dette
 * s'éteint, la vente est conclue. Mais les billets, eux, n'ont pas bougé du
 * tiroir, et c'est le responsable de la caisse qui en répond.
 *
 * Entre les deux, le mouvement existe et n'est nulle part. C'est ce que
 * cette collection nomme : une écriture en attente, au nom de celui qui l'a
 * provoquée, jusqu'à ce que le caissier la fasse passer au registre.
 *
 * Lui seul autorise. Le gérant voit la file et sait ce qu'elle contient,
 * mais il ne la valide pas : une caisse dont le décideur signe lui-même ses
 * propres mouvements ne prouve plus rien.
 *
 * L'écart ne s'efface pas. Quand le caissier ne reçoit que 4 000 sur 5 000
 * annoncés, il autorise 4 000 : le registre entre ce qui est réellement
 * dans le tiroir, et le manque s'inscrit à part, constat à l'appui. Ce qui
 * a été encaissé chez le client reste vrai — ce qui s'est perdu en route
 * est un autre fait, qui mérite sa propre trace.
 */

import {
  collection, query, where, getDocs, addDoc, doc, updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  enregistrerMouvementCaisse, chargerCaisseDuSite, soldeCaisse,
  type MotifCaisse, type SensCaisse,
} from './caisse';
import { lireParSite, type Portee } from './portee';
import { signalerAttente } from './en-attente';

export type EtatAttente = 'en_attente' | 'autorise' | 'refuse';

/**
 * Un mouvement qui attend son autorisation.
 *
 * Les champs reprennent ceux du registre : ce sont les mêmes colonnes qu'on
 * lira ici puis là-bas. Le motif dit de quoi il s'agit — Recouvrement,
 * Vente, Rémunération — le sous-motif à quel titre — Client, Fournisseur —
 * et le détail nomme qui : le client concerné, l'employé payé.
 */
export interface MouvementAttente {
  id: string;
  siteId: string;

  sens: SensCaisse;
  motif: MotifCaisse;
  sousMotif?: string | null;
  detail?: string | null;
  /** Ce que l'auteur déclare. */
  montant: number;
  /** Ce que le caissier a compté ; absent tant qu'il ne s'est pas prononcé. */
  montantAutorise?: number | null;
  date: string;
  heure: string;

  /* Qui a provoqué le mouvement. Figés à l'écriture : une fiche qui change
     ne doit pas réécrire l'histoire de qui a décidé. */
  userId: string;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;

  etat: EtatAttente;

  /* Ce que le mouvement règle, quand il naît d'un dossier. */
  partenaireId?: string | null;
  documentId?: string | null;
  documentType?: 'vente' | 'achat' | 'transfert' | 'employe' | null;

  /* Qui a autorisé, quand, et ce qu'il a constaté s'il manquait. */
  autorisePar?: string | null;
  autoriseParNom?: string | null;
  dateAutorisation?: string | null;
  constat?: string | null;
  /** Le mouvement de caisse né de l'autorisation. */
  mouvementCaisseId?: string | null;
  /** Le réajustement qui acte l'écart, s'il y en a eu un. */
  mouvementEcartId?: string | null;

  createdAt?: any;
}

function maintenant() {
  return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

/**
 * Met un mouvement en attente d'autorisation.
 *
 * Appelé à la place de l'écriture directe au registre : la caisse ne doit
 * pas compter un argent que le caissier n'a ni vu ni sorti.
 */
export async function mettreEnAttente(saisie: {
  siteId: string;
  userId: string;
  sens: SensCaisse;
  motif: MotifCaisse;
  sousMotif?: string | null;
  detail?: string | null;
  montant: number;
  date?: string;
  heure?: string;
  partenaireId?: string | null;
  documentId?: string | null;
  documentType?: MouvementAttente['documentType'];
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}): Promise<string> {
  if (saisie.montant <= 0) throw new Error('Le montant doit être positif.');

  const ref = await addDoc(collection(db, 'mouvements_attente'), {
    siteId: saisie.siteId,
    userId: saisie.userId,
    sens: saisie.sens,
    motif: saisie.motif,
    sousMotif: saisie.sousMotif ?? null,
    detail: saisie.detail ?? null,
    montant: saisie.montant,
    montantAutorise: null,
    date: saisie.date ?? aujourdhui(),
    heure: saisie.heure ?? maintenant(),
    etat: 'en_attente' as EtatAttente,
    partenaireId: saisie.partenaireId ?? null,
    documentId: saisie.documentId ?? null,
    documentType: saisie.documentType ?? null,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
    autorisePar: null,
    autoriseParNom: null,
    dateAutorisation: null,
    constat: null,
    mouvementCaisseId: null,
    mouvementEcartId: null,
    createdAt: serverTimestamp(),
  });
  /* La file s'est remplie : la pastille du caissier doit le dire avant
     qu'il navigue. */
  signalerAttente();
  return ref.id;
}

/** Tout ce qui attend sur une portée : c'est la file du caissier. */
export async function chargerAttente(portee: Portee): Promise<MouvementAttente[]> {
  const docs = await lireParSite('mouvements_attente', portee);
  return docs
    .map(d => ({ id: d.id, ...d.data() } as MouvementAttente))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/**
 * Ce qu'un compte a provoqué : sa propre file, pour savoir où il en est.
 *
 * Toujours les siennes, jamais celles des autres : cet écran dit « ce que
 * j'ai fait entrer et que la caisse n'a pas encore compté ». La portée,
 * et non un site, parce que le propriétaire vend sur plusieurs boutiques
 * et attend la confirmation de chacune.
 */
export async function attenteDuCompte(
  portee: Portee, userId: string,
): Promise<MouvementAttente[]> {
  const docs = await lireParSite('mouvements_attente', portee);
  return docs
    .map(d => ({ id: d.id, ...d.data() } as MouvementAttente))
    .filter(m => m.userId === userId)
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/**
 * Ce que la caisse peut encore laisser sortir.
 *
 * Le solde dit ce qu'il y a dans le tiroir — c'est vrai, et il doit le
 * dire. Mais une sortie déjà déclarée n'y a pas encore touché : elle
 * attend son autorisation, et l'argent est pourtant promis.
 *
 * Sans cette distinction, on enchaîne les déclarations contre un solde qui
 * ne bouge pas : trois sorties de 40 000 passent sur un tiroir qui en
 * contient 50 000, et c'est le caissier qui découvre le trou en ouvrant.
 *
 * C'est la différence bancaire entre le solde et le solde disponible. Les
 * entrées en attente ne comptent pas : promises n'est pas reçues, et
 * s'appuyer dessus pour sortir reviendrait à dépenser ce qu'on n'a pas.
 */
export function disponibleEnCaisse(
  solde: number, attente: MouvementAttente[],
): { solde: number; engage: number; disponible: number } {
  const engage = attente
    .filter(m => m.etat === 'en_attente' && m.sens === 'sortie')
    .reduce((n, m) => n + m.montant, 0);
  return { solde, engage, disponible: solde - engage };
}

/**
 * Le disponible d'un site, lu d'un coup.
 *
 * Les écrans qui bornent une sortie ne veulent pas deux lectures et un
 * calcul : ils veulent savoir combien ils peuvent laisser sortir. Les deux
 * requêtes partent ensemble — séparées, l'écran se borne d'abord sur le
 * solde, puis se resserre, et le champ refuse une somme qu'il acceptait
 * une seconde plus tôt.
 */
export async function chargerDisponible(
  siteId: string,
): Promise<{ solde: number; engage: number; disponible: number }> {
  const [mouvements, attente] = await Promise.all([
    chargerCaisseDuSite(siteId),
    chargerAttente(siteId).catch(() => [] as MouvementAttente[]),
  ]);
  return disponibleEnCaisse(soldeCaisse(mouvements), attente);
}

/** Ce qui attend, par sens. Les deux ne se compensent pas : ce sont deux gestes. */
export function totauxEnAttente(liste: MouvementAttente[]) {
  const enAttente = liste.filter(m => m.etat === 'en_attente');
  return {
    entrees: enAttente.filter(m => m.sens === 'entree')
      .reduce((n, m) => n + m.montant, 0),
    sorties: enAttente.filter(m => m.sens === 'sortie')
      .reduce((n, m) => n + m.montant, 0),
    nb: enAttente.length,
  };
}

/**
 * Le caissier autorise le mouvement : l'argent bouge vraiment.
 *
 * Il saisit ce qu'il a compté, pas ce qui était annoncé — la caisse entre
 * le réel. Quand les deux diffèrent, l'écart s'inscrit à part plutôt que de
 * corriger le montant déclaré : celui qui a encaissé avait bien reçu la
 * somme annoncée, et ce qui manque à l'arrivée est un fait distinct.
 */
export async function autoriser(params: {
  mouvement: MouvementAttente;
  /** Ce que la caisse a compté. Absent : on retient le montant annoncé. */
  montantAutorise?: number;
  /** Ce que le caissier a constaté, quand il manque quelque chose. */
  constat?: string | null;
  parUid: string;
  parNom?: string | null;
}): Promise<void> {
  const { mouvement: m } = params;
  if (m.etat !== 'en_attente') return;

  const montant = params.montantAutorise ?? m.montant;
  if (montant < 0) throw new Error('Le montant ne peut pas être négatif.');

  const jour = aujourdhui();

  /* Ce qui bouge vraiment dans le tiroir. */
  const mouvementCaisseId = montant > 0
    ? await enregistrerMouvementCaisse({
        siteId: m.siteId,
        sens: m.sens,
        motif: m.motif,
        sousMotif: m.sousMotif ?? null,
        /* Qui l'a provoqué voyage avec la ligne : au registre, « Client
           Ibrahim » ne dit pas qui est allé chercher l'argent. */
        detail: m.detail
          ? `${m.detail}${m.utilisateurNom ? ` · par ${m.utilisateurNom}` : ''}`
          : (m.utilisateurNom ? `Par ${m.utilisateurNom}` : null),
        montant,
        date: jour,
        utilisateur: params.parUid,
        utilisateurNom: params.parNom ?? null,
        partenaireId: m.partenaireId ?? null,
        documentId: m.documentId ?? null,
        documentType: m.documentType ?? null,
      })
    : null;

  /* L'écart ne se retire pas du tiroir : l'argent manquant n'y est jamais
     entré, et le solde est déjà juste. Il reste pourtant un fait — une
     ligne de valeur nulle le dit, avec le constat du caissier. Sans elle,
     la différence entre le déclaré et le compté n'existerait nulle part. */
  const manque = m.montant - montant;
  const mouvementEcartId = manque !== 0
    ? await enregistrerMouvementCaisse({
        siteId: m.siteId,
        sens: 'entree',
        motif: 'reajustement',
        sousMotif: 'Écart à l’autorisation',
        detail: `${Math.abs(manque).toLocaleString('fr-FR')} `
          + `${manque > 0 ? 'manquant' : 'en trop'} sur `
          + `${m.montant.toLocaleString('fr-FR')} déclarés par `
          + `${m.utilisateurNom ?? '—'}`
          + (params.constat?.trim() ? ` — ${params.constat.trim()}` : ''),
        montant: 0,
        date: jour,
        utilisateur: params.parUid,
        utilisateurNom: params.parNom ?? null,
        partenaireId: null,
      })
    : null;

  await updateDoc(doc(db, 'mouvements_attente', m.id), {
    etat: 'autorise' as EtatAttente,
    montantAutorise: montant,
    autorisePar: params.parUid,
    autoriseParNom: params.parNom ?? null,
    dateAutorisation: jour,
    constat: params.constat?.trim() || null,
    mouvementCaisseId,
    mouvementEcartId,
  });

  /* La file a changé : les pastilles la comptent depuis la barre, qui
     n'apprendrait rien sans ce mot. */
  signalerAttente();
}

/**
 * Autorise plusieurs mouvements d'un coup, au montant déclaré.
 *
 * Un porteur remet ce qu'il a collecté dans la journée : trois
 * recouvrements, deux règlements. Les autoriser un par un fait cinq fois
 * le même geste pour une seule remise — c'est la remise qu'on accepte,
 * pas chaque ligne séparément.
 *
 * Chaque mouvement reste pourtant autorisé pour lui-même : cinq écritures
 * au registre, cinq lignes de file mises à jour. Le lot est un geste, pas
 * un mouvement — en faire une seule écriture perdrait ce qui les
 * distingue, et le registre ne saurait plus dire d'où vient chaque franc.
 *
 * Au montant déclaré, sans écart : compter suppose de savoir sur quelle
 * ligne le manque porte, et rien ici ne le dit. Un mouvement dont le
 * compte ne tombe pas juste se traite seul.
 *
 * Les écritures partent en série : chacune prend son numéro dans une
 * transaction sur le compteur du site, et les lancer ensemble les ferait
 * se disputer le même rang.
 */
export async function autoriserLot(params: {
  mouvements: MouvementAttente[];
  parUid: string;
  parNom?: string | null;
}): Promise<{ autorises: number; echecs: number }> {
  const aFaire = params.mouvements.filter(m => m.etat === 'en_attente');
  let autorises = 0;
  let echecs = 0;

  for (const mouvement of aFaire) {
    try {
      await autoriser({ mouvement, parUid: params.parUid, parNom: params.parNom });
      autorises += 1;
    } catch {
      /* Une ligne qui échoue n'arrête pas les autres : celles qui sont
         passées sont passées, et le tiroir les a reçues. Le compte rendu
         dit ce qui reste à reprendre. */
      echecs += 1;
    }
  }

  return { autorises, echecs };
}

/**
 * Le caissier refuse : rien n'entre au registre.
 *
 * Refuser n'efface pas le mouvement — il reste, avec son motif. Celui qui
 * l'a provoqué doit pouvoir lire pourquoi son écriture n'est pas passée.
 */
export async function refuser(params: {
  mouvement: MouvementAttente;
  constat: string;
  parUid: string;
  parNom?: string | null;
}): Promise<void> {
  if (params.mouvement.etat !== 'en_attente') return;
  await updateDoc(doc(db, 'mouvements_attente', params.mouvement.id), {
    etat: 'refuse' as EtatAttente,
    autorisePar: params.parUid,
    autoriseParNom: params.parNom ?? null,
    dateAutorisation: aujourdhui(),
    constat: params.constat.trim() || null,
  });
  signalerAttente();
}
