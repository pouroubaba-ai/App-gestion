/**
 * Ce qu'on devait, ou qu'on nous devait, avant l'app.
 *
 * Une activité ne commence pas le jour où on l'informatise. Des
 * fournisseurs attendent déjà leur argent, des clients doivent encore le
 * leur, et ces comptes-là n'ont aucun dossier ici — ils sont nés dans
 * des cahiers.
 *
 * On ne les reconstitue pas en inventant des achats ou des ventes avec
 * de la marchandise : elle entrerait en stock pour de bon, et les coûts
 * moyens s'en trouveraient faussés durablement. Le document d'ouverture
 * n'a donc aucune ligne — rien à parcourir, rien à faire entrer, aucun
 * mouvement écrit.
 *
 * Mais c'est bien un document : il a une date, une référence, un
 * montant, il reçoit des versements et il se solde. Le porter comme un
 * simple champ sur la fiche l'aurait rendu invisible partout où les
 * dettes se lisent.
 *
 * Il se pose depuis la fiche du partenaire, et seulement sur un rôle
 * qu'il porte : un tiers qui n'est que client n'a pas de solde
 * fournisseur, la question ne se pose pas.
 */

import {
  collection, addDoc, getDocs, query, where, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { referenceFlux } from './flux-marchandise';

export type RoleOuverture = 'fournisseur' | 'client';

/** La collection où vit le document, selon le côté. */
function collectionDe(role: RoleOuverture): 'achats' | 'ventes' {
  return role === 'fournisseur' ? 'achats' : 'ventes';
}

/**
 * Un dossier d'ouverture : la même forme qu'un achat ou qu'une vente,
 * vidée de tout ce qui touche à la marchandise.
 *
 * `etat` vaut « confirme » ou « livre » : c'est ce que les soldes
 * regardent pour décider qu'une dette existe. Un solde d'ouverture est
 * dû dès qu'il est posé — il n'a pas d'étapes à franchir.
 */
export async function creerOuverture(params: {
  siteId: string;
  role: RoleOuverture;
  partenaireId: string;
  partenaireNom: string;
  montant: number;
  date: string;
  note?: string | null;
  userId: string;
  parNom?: string | null;
}): Promise<string> {
  if (!(params.montant > 0)) {
    throw new Error('Un solde d’ouverture porte un montant.');
  }
  const deja = await ouvertureDe(params.siteId, params.role, params.partenaireId);
  if (deja) {
    throw new Error('Ce partenaire a déjà un solde d’ouverture de ce côté.');
  }

  /* Un solde d'ouverture se pose avant tout, ou jamais.
   *
   * Posé après des achats ou des ventes, il ne reporterait plus rien :
   * il viendrait gonfler une dette déjà constituée, ou rattraper une
   * saisie oubliée sous un nom qui ment. Borné au premier jour, il ne
   * peut être que ce qu'il prétend — ce qui était dû avant l'app. */
  if (await aDesDossiers(params.siteId, params.role, params.partenaireId)) {
    throw new Error(
      'Ce partenaire a déjà des dossiers : un solde d’ouverture se pose '
      + 'avant la première opération, pas après.');
  }

  const estFourn = params.role === 'fournisseur';
  const ref = await addDoc(collection(db, collectionDe(params.role)), {
    reference: referenceFlux('OUV', params.date),
    siteId: params.siteId,
    /* Le marqueur qui distingue ce dossier de tous les autres : sans
       lui, il se lirait comme un achat sans marchandise. */
    ouverture: true,
    ...(estFourn
      ? { fournisseurId: params.partenaireId, fournisseurNom: params.partenaireNom }
      : { clientId: params.partenaireId, clientNom: params.partenaireNom }),
    /* Dû dès sa pose : il reporte un compte déjà ouvert ailleurs. */
    etat: estFourn ? 'confirme' : 'livre',
    /* Aucune ligne : rien n'entre, rien ne sort. C'est ce vide qui
       garantit que le stock et les coûts moyens ne bougent pas. */
    lignes: [],
    /* La valeur du dossier. Les achats la déduisent de leurs lignes ;
       celui-ci la porte en propre, faute de marchandise à mesurer. */
    montantOuverture: params.montant,
    avanceVersee: 0,
    ...(estFourn
      ? { dateConfirmation: params.date, dateCommande: params.date }
      : { dateLivraison: params.date, dateCommande: params.date }),
    note: params.note?.trim() || null,
    userId: params.userId,
    par: params.userId,
    parNom: params.parNom ?? null,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/** Le dossier d'ouverture d'un partenaire, de ce côté, s'il existe. */
export async function ouvertureDe(
  siteId: string, role: RoleOuverture, partenaireId: string,
): Promise<{ id: string; montant: number; date: string; verse: number } | null> {
  const champ = role === 'fournisseur' ? 'fournisseurId' : 'clientId';
  const snap = await getDocs(query(
    collection(db, collectionDe(role)),
    where('siteId', '==', siteId),
    where(champ, '==', partenaireId),
    where('ouverture', '==', true)));
  const d = snap.docs[0];
  if (!d) return null;
  const x = d.data() as any;
  return {
    id: d.id,
    montant: x.montantOuverture ?? 0,
    date: x.dateConfirmation ?? x.dateLivraison ?? x.dateCommande ?? '',
    verse: x.avanceVersee ?? 0,
  };
}

/**
 * La valeur d'un dossier, ouverture comprise.
 *
 * Un achat vaut ses lignes ; une ouverture vaut son montant. Les écrans
 * qui totalisent des dettes passent tous par là, pour qu'aucun ne
 * découvre un dossier sans lignes et n'en conclue qu'il ne vaut rien.
 */
export function estOuverture(dossier: any): boolean {
  return dossier?.ouverture === true;
}

/**
 * Ce partenaire a-t-il déjà un dossier de ce côté ?
 *
 * Les dossiers d'ouverture ne comptent pas : c'est précisément ce qu'on
 * cherche à poser. Un dossier annulé compte quand même — il a existé, et
 * son existence dit que le compte était déjà ouvert ici.
 */
export async function aDesDossiers(
  siteId: string, role: RoleOuverture, partenaireId: string,
): Promise<boolean> {
  const champ = role === 'fournisseur' ? 'fournisseurId' : 'clientId';
  const snap = await getDocs(query(
    collection(db, collectionDe(role)),
    where('siteId', '==', siteId),
    where(champ, '==', partenaireId)));
  return snap.docs.some(d => !(d.data() as any).ouverture);
}
