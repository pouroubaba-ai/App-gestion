/**
 * L'argent confié à quelqu'un pour aller payer, et le compte qu'il en rend.
 *
 * Quand la maison doit à un fournisseur, elle peut le payer de deux façons.
 * Le fournisseur se présente à la caisse : un seul geste, le caissier
 * délivre, c'est fini. Ou quelqu'un lui porte l'argent — et là, entre le
 * moment où les billets quittent le tiroir et celui où ils arrivent chez le
 * fournisseur, ils sont dans une poche.
 *
 * Cet entre-deux n'existe nulle part dans un registre ordinaire. Le tiroir
 * est allégé, le fournisseur n'a rien reçu, et rien ne dit qui détient la
 * somme. C'est précisément là que l'argent se perd, et c'est ce que cette
 * collection nomme.
 *
 * Le trajet a trois moments, et trois responsables :
 *
 *   1. Le gérant convient d'un paiement et dit qu'on le portera.
 *      La mission naît, au nom de personne encore.
 *   2. Le porteur se présente au tiroir. Il confirme devant le caissier
 *      qu'il reçoit ; le caissier valide, et l'argent sort. Deux
 *      attestations, un seul instant — c'est ce qui rend la sortie
 *      opposable, et c'est pourquoi la confirmation du porteur expire.
 *   3. Le porteur remet, et le déclare. La dette s'éteint alors, pas avant.
 *
 * Entre 2 et 3, la somme est à sa charge. Elle se lit, elle s'accumule, et
 * un porteur qui garde une mission ouverte depuis trois jours se voit sans
 * que personne ait à l'accuser.
 */

import {
  collection, query, where, getDocs, addDoc, doc, getDoc, updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { lireParSite, type Portee } from './portee';
import { signalerAttente } from './en-attente';

/**
 * Où en est la mission.
 *
 * `annulee` n'efface rien : la mission reste, avec la raison. Une mission
 * qu'on peut faire disparaître ne prouverait plus qu'elle a existé.
 */
export type EtatMission =
  /** Décidée, l'argent est encore au tiroir. */
  | 'ordonnee'
  /** Le porteur a confirmé devant le caissier, en attente de validation. */
  | 'confirmee'
  /** L'argent est sorti : il est dans la poche du porteur. */
  | 'retiree'
  /** Remis au fournisseur, en tout ou en partie. */
  | 'soldee'
  /** Abandonnée avant le retrait. */
  | 'annulee';

/**
 * Qui vient chercher l'argent au tiroir.
 *
 * Le circuit est le même jusque-là : le gérant a décidé, le caissier doit
 * délivrer. Ce qui change, c'est le geste au moment de délivrer.
 *
 * Le porteur est un employé : il a un compte, il confirme dans l'app, et
 * il devra rendre compte de ce qu'il a fait de l'argent. D'où la double
 * attestation, et l'état de transit qui suit.
 *
 * Le fournisseur est un tiers : il n'a pas de compte, il ne confirmera
 * rien. Le caissier délivre seul, et la dette s'éteint dans le même
 * geste — il n'y a pas d'entre-deux, l'argent passe de la main à la main.
 */
export type ModeMission =
  /** Un employé porte l'argent au fournisseur. */
  | 'porte'
  /** Le fournisseur vient le prendre lui-même. */
  | 'comptoir';

export interface Mission {
  id: string;
  siteId: string;
  mode: ModeMission;
  /** Le fournisseur à payer. */
  partenaireId: string;
  partenaireNom?: string | null;
  /** Les échéances que cette mission honore. */
  journalIds: string[];
  /** Ce qu'il faut porter. */
  montant: number;
  /** Ce qui a été réellement retiré au tiroir ; nul avant le retrait. */
  montantRetire?: number | null;
  /** Ce qui a été remis au fournisseur. */
  montantRemis: number;

  etat: EtatMission;
  date: string;
  heure: string;

  /* Qui a décidé. Le nom se recopie : une fiche qui change ne doit pas
     réécrire l'histoire. */
  parUid: string;
  parNom?: string | null;

  /* Qui porte. Désigné à la décision quand on sait déjà, sinon posé au
     tiroir par celui qui se présente. */
  porteurUid?: string | null;
  porteurNom?: string | null;

  /* La confirmation du porteur, qui débloque le caissier. Elle vaut pour
     quelques minutes : elle dit « je suis devant toi maintenant », pas
     « je t'autorise pour la journée ». Sans cette limite, le caissier
     pourrait valider deux heures plus tard, hors de sa présence — et
     l'intervalle qu'on cherche à supprimer reviendrait. */
  confirmeeA?: number | null;

  /* Le retrait au tiroir. */
  mouvementCaisseId?: string | null;
  retireA?: string | null;
  retireParUid?: string | null;
  retireParNom?: string | null;

  /* La remise au fournisseur. */
  remiseA?: string | null;
  /** Ce que le porteur a rapporté : la mission se solde en dessous. */
  montantRendu?: number | null;

  /** Pourquoi on a abandonné. */
  motifAnnulation?: string | null;
  createdAt?: any;
}

/** Combien de temps la confirmation du porteur reste valable. */
export const CONFIRMATION_VALIDE_MS = 5 * 60 * 1000;

function aujourdhui() { return new Date().toISOString().split('T')[0]; }
function maintenant() {
  return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** La confirmation tient-elle encore ? */
export function confirmationValide(m: Mission): boolean {
  if (m.etat !== 'confirmee' || !m.confirmeeA) return false;
  return Date.now() - m.confirmeeA < CONFIRMATION_VALIDE_MS;
}

/**
 * Le gérant décide : on paiera ce fournisseur, et quelqu'un portera.
 *
 * Rien ne bouge encore. La mission attend au tiroir, et c'est le retrait
 * qui fera sortir l'argent.
 */
export async function ordonnerMission(saisie: {
  siteId: string;
  mode: ModeMission;
  partenaireId: string;
  partenaireNom?: string | null;
  journalIds: string[];
  montant: number;
  parUid: string;
  parNom?: string | null;
  /* Nommé d'avance quand on sait déjà qui ira. Sinon c'est celui qui se
     présente au tiroir qui devient le porteur — et le gérant l'apprend
     en lisant la mission. */
  porteurUid?: string | null;
  porteurNom?: string | null;
}): Promise<string> {
  if (saisie.montant <= 0) throw new Error('Le montant doit être positif.');

  /* Un engagement se renouvelle, il ne s'empile pas. Convenir deux fois
     sur la même échéance — parce qu'on a changé d'avis, ou refait le
     suivi — remplace ce qui était décidé. Sans cela, le caissier voyait
     six missions pour quatre échéances, et le tiroir aurait dû sortir
     deux fois la même somme.
     Seules les missions encore au tiroir s'effacent : une fois l'argent
     sorti, il faut le solder, pas l'oublier. */
  const anciennes = await getDocs(query(
    collection(db, 'missions_paiement'),
    where('siteId', '==', saisie.siteId),
    where('partenaireId', '==', saisie.partenaireId)));

  await Promise.all(anciennes.docs
    .filter(d => {
      const m = d.data() as Mission;
      if (m.etat !== 'ordonnee' && m.etat !== 'confirmee') return false;
      /* Elle porte la même échéance : c'est la même décision, reprise. */
      return (m.journalIds ?? []).some(id => saisie.journalIds.includes(id));
    })
    .map(d => updateDoc(doc(db, 'missions_paiement', d.id), {
      etat: 'annulee' as EtatMission,
      motifAnnulation: 'Remplacée par un nouvel engagement',
    })));

  const ref = await addDoc(collection(db, 'missions_paiement'), {
    siteId: saisie.siteId,
    mode: saisie.mode,
    partenaireId: saisie.partenaireId,
    partenaireNom: saisie.partenaireNom ?? null,
    journalIds: saisie.journalIds,
    montant: saisie.montant,
    montantRetire: null,
    montantRemis: 0,
    etat: 'ordonnee' as EtatMission,
    date: aujourdhui(),
    heure: maintenant(),
    parUid: saisie.parUid,
    parNom: saisie.parNom ?? null,
    porteurUid: saisie.porteurUid ?? null,
    porteurNom: saisie.porteurNom ?? null,
    confirmeeA: null,
    mouvementCaisseId: null,
    retireA: null,
    retireParUid: null,
    retireParNom: null,
    remiseA: null,
    montantRendu: null,
    motifAnnulation: null,
    createdAt: serverTimestamp(),
  });
  signalerAttente();
  return ref.id;
}

/**
 * Le porteur confirme qu'il reçoit, devant le caissier.
 *
 * Cette confirmation n'écrit rien : elle débloque le bouton du caissier.
 * L'ordre compte — si le caissier validait d'abord, il existerait un
 * moment où l'argent serait officiellement sorti sans que personne
 * n'atteste l'avoir reçu, et c'est là que naissent les versions
 * contradictoires. Ici les deux sont ensemble, la contestation est
 * immédiate ou elle n'a pas lieu.
 */
export async function confirmerReception(params: {
  mission: Mission;
  porteurUid: string;
  porteurNom?: string | null;
}): Promise<void> {
  const { mission: m } = params;
  if (m.etat !== 'ordonnee' && m.etat !== 'confirmee') {
    throw new Error('Cette mission n’attend plus de confirmation.');
  }
  /* Une mission nommée ne se laisse pas prendre par un autre. */
  if (m.porteurUid && m.porteurUid !== params.porteurUid) {
    throw new Error('Cette mission est au nom de quelqu’un d’autre.');
  }

  await updateDoc(doc(db, 'missions_paiement', m.id), {
    etat: 'confirmee' as EtatMission,
    porteurUid: params.porteurUid,
    porteurNom: params.porteurNom ?? m.porteurNom ?? null,
    confirmeeA: Date.now(),
  });
  signalerAttente();
}

/** Le porteur se rétracte : la mission redevient simplement ordonnée. */
export async function retirerConfirmation(mission: Mission): Promise<void> {
  if (mission.etat !== 'confirmee') return;
  await updateDoc(doc(db, 'missions_paiement', mission.id), {
    etat: 'ordonnee' as EtatMission,
    confirmeeA: null,
  });
  signalerAttente();
}

/**
 * Le caissier délivre : l'argent sort, et devient la charge du porteur.
 *
 * Il ne peut le faire que sur une confirmation fraîche. Passé le délai, il
 * faut la redemander — ce qui ne coûte rien, puisque les deux sont censés
 * être face à face.
 *
 * L'écriture de caisse est faite par l'appelant, qui connaît le registre :
 * on lui rend ce qu'il doit y inscrire, et il nous repasse l'identifiant.
 */
export async function marquerRetiree(params: {
  mission: Mission;
  montantRetire: number;
  mouvementCaisseId: string;
  parUid: string;
  parNom?: string | null;
}): Promise<void> {
  const { mission: m } = params;
  /* Au comptoir, le fournisseur reçoit de la main du caissier : il n'y a
     personne d'autre à faire attester, et rien ne transite. Seul le
     paiement porté exige les deux signatures. */
  if (m.mode === 'porte') {
    if (m.etat !== 'confirmee') {
      throw new Error('Le porteur doit d’abord confirmer qu’il reçoit.');
    }
    if (!confirmationValide(m)) {
      throw new Error('La confirmation a expiré : demandez-la à nouveau.');
    }
  } else if (m.etat !== 'ordonnee') {
    throw new Error('Cette mission n’attend plus au tiroir.');
  }
  if (params.montantRetire <= 0) throw new Error('Le montant doit être positif.');
  if (params.montantRetire > m.montant) {
    throw new Error('On ne délivre pas plus que ce qui est ordonné.');
  }

  await updateDoc(doc(db, 'missions_paiement', m.id), {
    /* Au comptoir, retirer et remettre sont le même instant : la mission
       naît et meurt dans le geste du caissier. La laisser « retirée »
       ferait croire que quelqu'un détient cet argent. */
    etat: (m.mode === 'comptoir' ? 'soldee' : 'retiree') as EtatMission,
    montantRetire: params.montantRetire,
    montantRemis: m.mode === 'comptoir' ? params.montantRetire : 0,
    remiseA: m.mode === 'comptoir' ? aujourdhui() : null,
    mouvementCaisseId: params.mouvementCaisseId,
    retireA: aujourdhui(),
    retireParUid: params.parUid,
    retireParNom: params.parNom ?? null,
  });

  /* Et la dette s'éteint tout de suite, pour la même raison. */
  if (m.mode === 'comptoir') {
    await soldeEcheances(m, params.montantRetire);
  }

  signalerAttente();
}

/**
 * Impute une somme sur les échéances d'une mission.
 *
 * De la plus ancienne à la plus récente : c'est l'ordre dans lequel une
 * dette s'éteint, et celui que suit déjà le versement à un tiers.
 */
async function soldeEcheances(m: Mission, montant: number): Promise<void> {
  if (montant <= 0 || m.journalIds.length === 0) return;

  const echeances = await Promise.all(
    m.journalIds.map(async id => {
      const d = await getDoc(doc(db, 'recouvrement_journal', id));
      return d.exists() ? { id, ...(d.data() as any) } : null;
    }));

  const ouvertes = echeances
    .filter((e): e is any => !!e && (e.reste ?? 0) > 0)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  let aPlacer = montant;
  const heure = maintenant();
  for (const e of ouvertes) {
    if (aPlacer <= 0) break;
    const part = Math.min(aPlacer, e.reste ?? 0);
    aPlacer -= part;

    await Promise.all([
      addDoc(collection(db, 'recouvrement_versements'), {
        journalId: e.id,
        siteId: m.siteId,
        userId: m.porteurUid ?? m.parUid,
        heure,
        montant: part,
        resteApres: Math.max(0, (e.reste ?? 0) - part),
        date: aujourdhui(),
        missionId: m.id,
        createdAt: serverTimestamp(),
      }),
      updateDoc(doc(db, 'recouvrement_journal', e.id), {
        verse: (e.verse ?? 0) + part,
        reste: Math.max(0, (e.reste ?? 0) - part),
      }),
    ]);
  }
}

/**
 * Le porteur déclare avoir remis.
 *
 * C'est ce geste qui éteint la dette, jamais le retrait. Ce qu'il rapporte
 * — la différence entre ce qu'il a pris et ce qu'il a donné — revient au
 * tiroir et se déclare à part : l'argent rendu est une entrée, pas une
 * remise qui n'aurait pas eu lieu.
 */
export async function declarerRemise(params: {
  mission: Mission;
  montantRemis: number;
  /** Ce qui revient en caisse ; l'appelant l'y fait rentrer. */
  montantRendu?: number;
}): Promise<void> {
  const { mission: m } = params;
  if (m.etat !== 'retiree') {
    throw new Error('L’argent n’a pas encore été retiré.');
  }
  const enMain = m.montantRetire ?? m.montant;
  const remis = params.montantRemis;
  if (remis < 0) throw new Error('Le montant ne peut pas être négatif.');
  if (remis > enMain) {
    throw new Error('On ne remet pas plus qu’on ne porte.');
  }

  await updateDoc(doc(db, 'missions_paiement', m.id), {
    etat: 'soldee' as EtatMission,
    montantRemis: remis,
    montantRendu: params.montantRendu ?? Math.max(0, enMain - remis),
    remiseA: aujourdhui(),
  });

  /* La dette s'éteint ici, et nulle part ailleurs. Sans cette écriture,
     le porteur déclarait avoir remis et l'échéance restait impayée : il
     fallait retourner dans les recouvrements refaire le même geste, et
     entre les deux les chiffres se contredisaient.

     La somme se répartit de la plus ancienne à la plus récente — c'est
     l'ordre dans lequel une dette s'éteint, et celui que suit déjà le
     versement à un tiers. */
  if (remis > 0 && m.journalIds.length > 0) {
    const echeances = await Promise.all(
      m.journalIds.map(async id => {
        const d = await getDoc(doc(db, 'recouvrement_journal', id));
        return d.exists() ? { id, ...(d.data() as any) } : null;
      }));

    const ouvertes = echeances
      .filter((e): e is any => !!e && (e.reste ?? 0) > 0)
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

    let aPlacer = remis;
    const heure = maintenant();
    for (const e of ouvertes) {
      if (aPlacer <= 0) break;
      const part = Math.min(aPlacer, e.reste ?? 0);
      aPlacer -= part;

      await Promise.all([
        /* Le versement, pour que l'historique de l'échéance le dise. */
        addDoc(collection(db, 'recouvrement_versements'), {
          journalId: e.id,
          siteId: m.siteId,
          userId: m.porteurUid ?? m.parUid,
          heure,
          montant: part,
          resteApres: Math.max(0, (e.reste ?? 0) - part),
          date: aujourdhui(),
          /* D'où vient ce versement : sans lui, on ne saurait plus qu'il
             vient d'une mission et non d'un paiement direct. */
          missionId: m.id,
          createdAt: serverTimestamp(),
        }),
        updateDoc(doc(db, 'recouvrement_journal', e.id), {
          verse: (e.verse ?? 0) + part,
          reste: Math.max(0, (e.reste ?? 0) - part),
        }),
      ]);
    }
  }

  signalerAttente();
}

/**
 * Abandonner une mission avant le retrait.
 *
 * Après, il est trop tard : l'argent est dehors, et seule la remise ou le
 * retour peut le solder. Le motif reste écrit — une mission qui disparaît
 * ne dit pas pourquoi on a changé d'avis.
 */
export async function annulerMission(params: {
  mission: Mission;
  motif: string;
}): Promise<void> {
  const { mission: m } = params;
  if (m.etat === 'retiree' || m.etat === 'soldee') {
    throw new Error('L’argent est déjà sorti : la mission se solde, elle ne s’annule plus.');
  }
  if (!params.motif.trim()) {
    throw new Error('Dites pourquoi : sans motif, l’annulation ne s’explique pas.');
  }
  await updateDoc(doc(db, 'missions_paiement', m.id), {
    etat: 'annulee' as EtatMission,
    motifAnnulation: params.motif.trim(),
  });
  signalerAttente();
}

/** Les missions d'une portée, la plus récente d'abord. */
export async function chargerMissions(portee: Portee): Promise<Mission[]> {
  const docs = await lireParSite('missions_paiement', portee);
  return docs
    .map(d => ({ id: d.id, ...d.data() } as Mission))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/** Les missions d'un porteur : ce qu'il doit aller faire, ce qu'il détient. */
export async function missionsDuPorteur(
  siteId: string, uid: string,
): Promise<Mission[]> {
  const snap = await getDocs(query(
    collection(db, 'missions_paiement'),
    where('siteId', '==', siteId),
    where('porteurUid', '==', uid)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Mission))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/**
 * Ce que les porteurs détiennent en ce moment.
 *
 * C'est le chiffre qui n'existait nulle part : l'argent sorti du tiroir et
 * pas encore arrivé. Il se compte par personne, non en bloc — un total dit
 * combien est dehors, jamais chez qui.
 */
export function enPoche(missions: Mission[]): {
  total: number;
  parPorteur: { uid: string; nom: string; montant: number; missions: Mission[] }[];
} {
  const portees = missions.filter(m => m.etat === 'retiree');
  const parUid = new Map<string, { uid: string; nom: string; montant: number; missions: Mission[] }>();

  for (const m of portees) {
    const uid = m.porteurUid ?? '—';
    const lot = parUid.get(uid) ?? {
      uid, nom: m.porteurNom ?? '—', montant: 0, missions: [],
    };
    lot.montant += m.montantRetire ?? m.montant;
    lot.missions.push(m);
    parUid.set(uid, lot);
  }

  return {
    total: portees.reduce((n, m) => n + (m.montantRetire ?? m.montant), 0),
    parPorteur: [...parUid.values()].sort((a, b) => b.montant - a.montant),
  };
}

/** Ce qu'un porteur détient sur une échéance donnée. */
export function enPochePourEcheance(
  missions: Mission[], journalId: string, uid?: string | null,
): number {
  return missions
    .filter(m => m.etat === 'retiree'
      && m.journalIds.includes(journalId)
      && (!uid || m.porteurUid === uid))
    .reduce((n, m) => n + (m.montantRetire ?? m.montant), 0);
}

/** Ce qui est ordonné mais pas encore sorti du tiroir. */
export function aRecuperer(missions: Mission[]): number {
  return missions
    .filter(m => m.etat === 'ordonnee' || m.etat === 'confirmee')
    .reduce((n, m) => n + m.montant, 0);
}
