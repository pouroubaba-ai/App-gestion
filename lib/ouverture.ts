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
import {
  referenceFlux, totalAchat, valeurVente,
} from './flux-marchandise';

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
  /* Plusieurs comptes anciens, parce que c'est ainsi qu'ils arrivent.
   *
   * L'app n'en acceptait qu'un, et refusait d'en poser un dès qu'une
   * opération existait. C'était supposer qu'un commerçant connaît tous
   * ses comptes anciens le jour où il s'informatise, et qu'ils tiennent
   * en une ligne. Ni l'un ni l'autre n'est vrai : les comptes d'avant se
   * retrouvent par morceaux — un cahier, une ardoise, un associé qui se
   * souvient — et un même partenaire peut en porter deux.
   *
   * Ce que la règle protégeait reste à protéger : qu'on ne rattrape pas
   * une saisie oubliée en l'appelant « solde d'ouverture ». Mais
   * l'interdire ne protégeait rien — cela poussait à saisir une fausse
   * vente, et là c'est le stock qui aurait menti. Le garde-fou n'est donc
   * plus l'interdiction, c'est la trace : la date, qui doit précéder la
   * première opération, et la note, exigée dès qu'un second compte se
   * pose.
   */
  const dejaOuvertes = await ouverturesDe(
    params.siteId, params.role, params.partenaireId);

  /* Dire d'où vient ce compte-là. Le premier se comprend seul : c'est le
     report d'avant l'app. Le second a besoin qu'on le distingue — sinon
     deux lignes du même nom, dans six mois, ne se lisent plus. */
  if (dejaOuvertes.length > 0 && !params.note?.trim()) {
    throw new Error(
      'Ce partenaire a déjà un solde d’ouverture : précisez en note d’où '
      + 'vient ce second compte.');
  }

  /* Aucune borne sur la date.
   *
   * Un report avait été borné à la veille de la première opération : il
   * précède ce qu'il reporte, donc il se date avant. L'idée se tient en
   * théorie et ne tient pas au comptoir — les comptes anciens se
   * retrouvent longtemps après, et c'est le commerçant qui sait de quand
   * ils datent, pas le logiciel. Lui refuser sa propre date revenait à
   * lui dire qu'il se trompe sur ce qu'il a vécu.
   *
   * Ce qui reste : la date est écrite, elle est visible, et le dossier
   * porte le nom de celui qui l'a posée. */

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

/**
 * Tous les soldes d'ouverture d'un partenaire, de ce côté.
 *
 * Rendus du plus ancien au plus récent : c'est l'ordre dans lequel les
 * comptes se sont ouverts, et celui dans lequel on les lit.
 */
export async function ouverturesDe(
  siteId: string, role: RoleOuverture, partenaireId: string,
): Promise<{ id: string; montant: number; date: string; verse: number; note: string | null }[]> {
  const champ = role === 'fournisseur' ? 'fournisseurId' : 'clientId';
  const snap = await getDocs(query(
    collection(db, collectionDe(role)),
    where('siteId', '==', siteId),
    where(champ, '==', partenaireId),
    where('ouverture', '==', true)));
  return snap.docs
    .map(d => {
      const x = d.data() as any;
      return {
        id: d.id,
        montant: x.montantOuverture ?? 0,
        date: x.dateConfirmation ?? x.dateLivraison ?? x.dateCommande ?? '',
        verse: x.avanceVersee ?? 0,
        note: x.note ?? null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * La date de la première opération avec ce partenaire, hors ouvertures.
 *
 * C'est elle qui borne un solde d'ouverture : il reporte ce qui précède,
 * donc il se date avant. Chaîne vide quand rien n'existe encore — alors
 * rien ne le borne.
 */
export async function premierDossier(
  siteId: string, role: RoleOuverture, partenaireId: string,
): Promise<string> {
  const champ = role === 'fournisseur' ? 'fournisseurId' : 'clientId';
  const snap = await getDocs(query(
    collection(db, collectionDe(role)),
    where('siteId', '==', siteId),
    where(champ, '==', partenaireId)));
  const dates = snap.docs
    .filter(d => !(d.data() as any).ouverture)
    .map(d => {
      const x = d.data() as any;
      return (x.dateCommande ?? x.dateConfirmation ?? x.dateLivraison ?? '') as string;
    })
    .filter(Boolean)
    .sort();
  return dates[0] ?? '';
}

/**
 * Le dossier d'ouverture d'un partenaire, de ce côté, s'il existe.
 *
 * Rend le plus ancien quand il y en a plusieurs. Les écrans qui doivent
 * tous les montrer passent par `ouverturesDe`.
 */
export async function ouvertureDe(
  siteId: string, role: RoleOuverture, partenaireId: string,
): Promise<{ id: string; montant: number; date: string; verse: number } | null> {
  const champ = role === 'fournisseur' ? 'fournisseurId' : 'clientId';
  const snap = await getDocs(query(
    collection(db, collectionDe(role)),
    where('siteId', '==', siteId),
    where(champ, '==', partenaireId),
    where('ouverture', '==', true)));
  /* Le plus ancien : plusieurs comptes peuvent coexister, et c'est celui
     qui a ouvert la relation qui répond pour elle. */
  const docs = snap.docs
    .map(d => ({ id: d.id, x: d.data() as any }))
    .sort((a, b) => String(a.x.dateConfirmation ?? a.x.dateLivraison ?? a.x.dateCommande ?? '')
      .localeCompare(String(b.x.dateConfirmation ?? b.x.dateLivraison ?? b.x.dateCommande ?? '')));
  const d = docs[0];
  if (!d) return null;
  const x = d.x;
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
 * Ce qu'un dossier vaut, ouverture comprise.
 *
 * Un achat vaut ses lignes et ses frais, une vente ses lignes, une
 * ouverture son montant — elle n'a pas de marchandise à mesurer.
 *
 * Cette règle vivait à six endroits, chacun la redécouvrant à ses
 * dépens : les soldes, l'imputation, la couverture d'un versement, les
 * restes à encaisser, les documents de la fiche recouvrement. Chaque
 * oubli donnait le même symptôme — un dossier valant zéro, donc tenu
 * pour soldé, sur lequel plus rien ne pouvait s'imputer : l'argent
 * entrait et la dette ne bougeait pas. Une valeur se calcule à un seul
 * endroit, sans quoi les copies finissent par diverger.
 */
export function valeurDossier(
  dossier: any, role: RoleOuverture,
): number {
  if (estOuverture(dossier)) return dossier?.montantOuverture ?? 0;
  return role === 'fournisseur'
    ? totalAchat(dossier ?? {})
    : valeurVente(dossier?.lignes ?? []);
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
