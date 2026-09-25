/**
 * La portée d'un écran : un site, ou plusieurs.
 *
 * Les onglets ont été écrits pour un site unique. Le propriétaire veut les
 * mêmes, sur l'ensemble de son activité. Plutôt que de les dédoubler — deux
 * copies qui divergeraient à la première correction — on élargit ce qu'ils
 * acceptent : partout où il y avait un identifiant, il peut désormais y en
 * avoir plusieurs.
 */
import {
  collection, query, where, getDocs, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

export type Portee = string | string[];

/** La portée ramenée à une liste, pour ce qui doit la parcourir. */
export function sitesDe(portee: Portee): string[] {
  return typeof portee === 'string' ? [portee] : portee;
}

/** Le site unique, ou `null` quand la portée en couvre plusieurs. */
export function siteUnique(portee: Portee): string | null {
  const l = sitesDe(portee);
  return l.length === 1 ? l[0] : null;
}

/* Firestore refuse un `in` de plus de trente valeurs : au-delà, on découpe.
   Une activité de trente sites est déjà considérable, mais la limite ne se
   négocie pas et un dépassement lèverait une erreur au lieu d'omettre. */
const LOT = 30;

/**
 * Les documents d'une collection appartenant à une portée.
 *
 * Un site : la requête d'égalité d'avant, inchangée. Plusieurs : un `in`,
 * découpé en lots. Aucun : rien à lire, et surtout pas tout — une portée
 * vide n'est pas une portée universelle.
 */
export async function lireParSite(
  nomCollection: string,
  portee: Portee,
  champ = 'siteId',
): Promise<QueryDocumentSnapshot[]> {
  const sites = sitesDe(portee);
  if (sites.length === 0) return [];

  if (sites.length === 1) {
    const snap = await getDocs(query(
      collection(db, nomCollection), where(champ, '==', sites[0])));
    return snap.docs;
  }

  const lots: string[][] = [];
  for (let i = 0; i < sites.length; i += LOT) lots.push(sites.slice(i, i + LOT));

  const snaps = await Promise.all(lots.map(l => getDocs(query(
    collection(db, nomCollection), where(champ, 'in', l)))));

  /* Les lots ne se recouvrent pas, mais un même document peut répondre à
     deux champs différents (un transfert, entre deux sites de la portée) :
     l'appelant qui interroge deux champs dédoublonne par identifiant. */
  return snaps.flatMap(s => s.docs);
}

/** Les documents d'une portée, déjà transformés et dédoublonnés. */
export async function lireDocs<T>(
  nomCollection: string,
  portee: Portee,
  champ = 'siteId',
): Promise<T[]> {
  const docs = await lireParSite(nomCollection, portee, champ);
  const parId = new Map<string, T>();
  docs.forEach(d => parId.set(d.id, { id: d.id, ...d.data() } as T));
  return [...parId.values()];
}
