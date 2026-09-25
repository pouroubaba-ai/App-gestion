/**
 * Les écarts de caisse : ce que le comptage a trouvé, et que le registre
 * ne disait pas.
 *
 * Un écart n'est pas un mouvement. Un mouvement est une décision — quelqu'un
 * veut faire sortir de l'argent, et le tiroir ne s'ouvre qu'une fois
 * autorisé. Un écart est un constat — l'argent n'est déjà plus là, ou il y
 * en a plus qu'attendu, et personne ne demande rien.
 *
 * Trois conséquences, et c'est pourquoi ils ne partagent pas de collection :
 *
 * — **Qui reconnaît.** Un mouvement se confirme par le caissier, qui ouvre
 *   le tiroir. Un écart se reconnaît par le propriétaire : celui qui a
 *   compté ne peut pas attester que son compte est juste. Sans cela, rien
 *   ne distinguerait un écart d'une soustraction.
 *
 * — **Ce qu'un refus signifie.** Un mouvement rejeté n'a jamais eu lieu.
 *   Un écart rejeté existe toujours : le tiroir ne se remplit pas parce
 *   qu'on a dit non. Il reste donc visible tant qu'il n'est pas reconnu.
 *
 * — **Le sens.** Un écart va dans les deux sens sans changer de nature :
 *   un excédent et un manque sont le même fait, constaté dans deux
 *   directions.
 *
 * Quand le propriétaire déclare lui-même, c'est le caissier qui reconnaît —
 * la règle ne dit pas « le propriétaire confirme », elle dit « pas celui
 * qui a déclaré ».
 */

import {
  collection, addDoc, doc, updateDoc, getDocs, query, where,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { enregistrerMouvementCaisse } from './caisse';
import { signalerAttente } from './en-attente';

/** Dans quel sens le tiroir s'écarte du registre. */
export type SensEcart =
  /** Il y a plus dans le tiroir que ce que dit le registre. */
  | 'excedent'
  /** Il en manque. */
  | 'manque';

export type EtatEcart = 'en_attente' | 'reconnu' | 'rejete';

export interface EcartCaisse {
  id: string;
  siteId: string;
  sens: SensEcart;
  /** Toujours positif : le sens le porte déjà. */
  montant: number;
  /** Ce que celui qui a compté dit du constat. */
  detail?: string | null;

  date: string;
  heure: string;

  /* Qui a constaté. Sa fonction se garde avec son nom : un écart se relit
     des mois plus tard, quand les rôles ont pu changer. */
  parUid: string;
  parNom?: string | null;
  parFonction?: string | null;
  /* Son role au moment du constat : c'est lui qui decide de qui
     reconnaitra, et il se fige ici — un role change, le constat non. */
  parRoleSite?: string | null;

  etat: EtatEcart;
  /* Qui a reconnu, et quand. Absent tant que l'écart attend. */
  reconnuParUid?: string | null;
  reconnuParNom?: string | null;
  reconnuA?: string | null;
  motifRejet?: string | null;

  /** Le mouvement né de la reconnaissance : c'est lui qui bouge le solde. */
  mouvementCaisseId?: string | null;
}

function aujourdhui(): string {
  return new Date().toISOString().split('T')[0];
}

function maintenant(): string {
  return new Date().toTimeString().slice(0, 5);
}

/**
 * Qui doit reconnaître un écart déclaré par tel rôle.
 *
 * La règle tient en une phrase : jamais celui qui l'a constaté. Le
 * propriétaire tranche les écarts du site — c'est son argent, et lui seul
 * répond d'un manque. Quand c'est lui qui constate, le caissier reconnaît :
 * le tiroir est sous sa garde, et l'écart le concerne au premier chef.
 */
export function quiReconnait(
  roleDeclarant: string | null,
): 'proprietaire' | 'caissier' {
  return roleDeclarant === null ? 'caissier' : 'proprietaire';
}

/**
 * Peut-on reconnaître cet écart ?
 *
 * `roleSite` vaut `null` pour le propriétaire : c'est ainsi que
 * `roleSurSite` le désigne, n'étant membre d'aucun site.
 */
export function peutReconnaitre(
  ecart: EcartCaisse,
  roleSite: string | null,
  uid: string,
): boolean {
  /* On ne reconnaît pas son propre constat, quel que soit le rôle. */
  if (ecart.parUid === uid) return false;
  const attendu = quiReconnait(ecart.parRoleSite ?? null);
  return attendu === 'proprietaire' ? roleSite === null : roleSite === 'caissier';
}

/** Constater un écart. Il attend d'être reconnu, le solde ne bouge pas. */
export async function declarerEcart(saisie: {
  siteId: string;
  sens: SensEcart;
  montant: number;
  detail?: string | null;
  parUid: string;
  parNom?: string | null;
  parFonction?: string | null;
  /** Le rôle du déclarant : il décide de qui reconnaîtra. */
  parRoleSite: string | null;
  /** Ce que le registre annonce : un manque ne peut pas le dépasser. */
  soldeTheorique?: number | null;
}): Promise<string> {
  if (saisie.montant <= 0) throw new Error('Le montant doit être positif.');

  /* Le tiroir ne peut pas manquer plus qu'il ne contient.
     L'excédent n'a pas de plafond — on peut toujours trouver plus.

     Le plafond porte sur le disponible, non sur le solde : trois manques
     de 30 000 sur une caisse de 59 500 passent un à un et font 90 000
     ensemble. Chacun paraissait tenable, et la caisse se serait vidée
     deux fois. On relit donc ce qui attend déjà, au moment d'écrire —
     un autre a pu constater entre-temps. */
  if (saisie.sens === 'manque' && saisie.soldeTheorique != null) {
    const dejaConstate = (await chargerEcarts(saisie.siteId))
      .filter(e => e.etat === 'en_attente' && e.sens === 'manque')
      .reduce((n, e) => n + e.montant, 0);
    const disponible = saisie.soldeTheorique - dejaConstate;

    if (saisie.montant > disponible) {
      throw new Error(dejaConstate > 0
        ? `Au plus ${disponible.toLocaleString('fr-FR')} FCFA : `
          + `${dejaConstate.toLocaleString('fr-FR')} sont déjà constatés `
          + 'et attendent une reconnaissance.'
        : 'Un manque ne peut pas dépasser ce que la caisse contient.');
    }
  }

  const ref = await addDoc(collection(db, 'ecarts_caisse'), {
    siteId: saisie.siteId,
    sens: saisie.sens,
    montant: saisie.montant,
    detail: saisie.detail?.trim() || null,
    date: aujourdhui(),
    heure: maintenant(),
    parUid: saisie.parUid,
    parNom: saisie.parNom ?? null,
    parFonction: saisie.parFonction ?? null,
    parRoleSite: saisie.parRoleSite,
    etat: 'en_attente' as EtatEcart,
    createdAt: serverTimestamp(),
  });

  signalerAttente();
  return ref.id;
}

/**
 * Reconnaître un écart : le constat devient un fait, et le solde suit.
 *
 * C'est seulement ici qu'un mouvement naît. Avant, l'écart est une
 * observation ; après, il est inscrit au registre et le fond disponible en
 * tient compte.
 */
export async function reconnaitreEcart(params: {
  ecart: EcartCaisse;
  parUid: string;
  parNom?: string | null;
  /* Le rôle de qui reconnaît. `null` désigne le propriétaire, comme
     partout ailleurs — il n'est membre d'aucun site. */
  roleSite: string | null;
}): Promise<void> {
  const e = params.ecart;
  if (e.etat !== 'en_attente') {
    throw new Error('Cet écart a déjà été tranché.');
  }
  /* La règle entière se vérifie ici, pas seulement à l'affichage : un
     bouton caché n'est pas une permission. `peutReconnaitre` couvre les
     deux refus — son propre constat, et le mauvais rôle. */
  if (!peutReconnaitre(e, params.roleSite, params.parUid)) {
    throw new Error(e.parUid === params.parUid
      ? 'On ne reconnaît pas son propre constat.'
      : `Ce constat attend ${quiReconnait(e.parRoleSite ?? null) === 'proprietaire'
          ? 'le propriétaire' : 'le caissier'}.`);
  }

  /* Le mouvement porte le sens de l'écart : un excédent entre, un manque
     sort. C'est lui qui déplace le solde — l'écart ne fait que le dire. */
  const mouvementId = await enregistrerMouvementCaisse({
    siteId: e.siteId,
    sens: e.sens === 'excedent' ? 'entree' : 'sortie',
    motif: 'reajustement',
    sousMotif: e.sens === 'excedent' ? 'Excédent constaté' : 'Manque constaté',
    detail: (e.detail ? `${e.detail} — ` : '')
      + `constaté par ${e.parNom ?? '—'}`
      + (e.parFonction ? ` (${e.parFonction})` : ''),
    montant: e.montant,
    date: e.date,
    utilisateur: params.parUid,
    utilisateurNom: params.parNom ?? null,
    partenaireId: null,
  });

  await updateDoc(doc(db, 'ecarts_caisse', e.id), {
    etat: 'reconnu' as EtatEcart,
    reconnuParUid: params.parUid,
    reconnuParNom: params.parNom ?? null,
    reconnuA: aujourdhui(),
    mouvementCaisseId: mouvementId,
  });

  signalerAttente();
}

/**
 * Rejeter un écart : le constat est contesté.
 *
 * Il quitte la file sans toucher au solde, mais il reste inscrit — un
 * constat refusé a eu lieu, et le refus dit qui n'y a pas cru.
 */
export async function rejeterEcart(params: {
  ecart: EcartCaisse;
  parUid: string;
  parNom?: string | null;
  motif?: string | null;
  roleSite: string | null;
}): Promise<void> {
  if (params.ecart.etat !== 'en_attente') {
    throw new Error('Cet écart a déjà été tranché.');
  }
  /* Contester engage autant que reconnaître : même garde. */
  if (!peutReconnaitre(params.ecart, params.roleSite, params.parUid)) {
    throw new Error(params.ecart.parUid === params.parUid
      ? 'On ne tranche pas son propre constat.'
      : `Ce constat attend ${quiReconnait(params.ecart.parRoleSite ?? null) === 'proprietaire'
          ? 'le propriétaire' : 'le caissier'}.`);
  }

  await updateDoc(doc(db, 'ecarts_caisse', params.ecart.id), {
    etat: 'rejete' as EtatEcart,
    reconnuParUid: params.parUid,
    reconnuParNom: params.parNom ?? null,
    reconnuA: aujourdhui(),
    motifRejet: params.motif?.trim() || null,
  });

  signalerAttente();
}

/** Les écarts d'un site, du plus récent au plus ancien. */
export async function chargerEcarts(
  siteIds: string | string[],
): Promise<EcartCaisse[]> {
  const ids = Array.isArray(siteIds) ? siteIds : [siteIds];
  if (ids.length === 0) return [];

  /* Firestore limite `in` à trente valeurs : on découpe. */
  const lots: string[][] = [];
  for (let i = 0; i < ids.length; i += 30) lots.push(ids.slice(i, i + 30));

  const pages = await Promise.all(lots.map(lot => getDocs(query(
    collection(db, 'ecarts_caisse'),
    where('siteId', 'in', lot)))));

  return pages
    .flatMap(p => p.docs.map(d => ({ id: d.id, ...d.data() } as EcartCaisse)))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/** Ceux qui attendent encore d'être reconnus. */
export function enAttente(ecarts: EcartCaisse[]): EcartCaisse[] {
  return ecarts.filter(e => e.etat === 'en_attente');
}
