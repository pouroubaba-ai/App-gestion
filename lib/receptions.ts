import {
  collection, query, where, getDocs, addDoc, updateDoc, doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Auteur } from './auteur';

/**
 * Les réceptions de marchandise, ligne par ligne.
 *
 * Le reçu était un nombre qu'on écrasait : un fournisseur qui livre 10 lundi
 * et 5 mercredi laissait un 15 sans mémoire des deux passages. Chaque
 * réception est désormais un fait daté, et le reçu leur somme — il ne se
 * saisit plus, il se déduit.
 *
 * On ne modifie pas une réception : on l'annule et on en saisit une autre,
 * comme un mouvement de caisse. Une quantité est juste ou elle ne l'est pas,
 * et corriger en place effacerait la trace de l'erreur.
 */

export interface Reception {
  id: string;
  siteId: string;
  /** le dossier concerné : un achat ou un transfert */
  documentId: string;
  /** l'index de la ligne dans le dossier ; les lignes n'ont pas d'identifiant */
  ligneIndex: number;
  /**
   * Sur un transfert, un même dossier se compte deux fois : la source charge,
   * le destinataire reçoit. Sans cette marque les deux comptes se
   * mélangeraient, et l'écart disparaîtrait.
   * Absent sur un achat : il n'a qu'une réception.
   */
  etape?: 'expedition' | 'reception' | null;
  produitId?: string | null;
  designation?: string | null;
  quantite: number;
  date: string;
  heure: string;
  /** qui a constaté la réception, figé au moment du geste */
  utilisateur: string;
  utilisateurNom: string;
  utilisateurFonction: string;
  /** annulée par une écriture inverse : elle reste, barrée */
  annulee?: boolean;
  annuleeLe?: string | null;
  annuleePar?: string | null;
  note?: string | null;
}

export type SaisieReception = Omit<Reception, 'id' | 'heure' | 'annulee' | 'annuleeLe' | 'annuleePar'>
  & { heure?: string };

function maintenant() {
  return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Enregistre une réception. Elle s'ajoute, elle ne remplace rien. */
export async function enregistrerReception(saisie: SaisieReception): Promise<string> {
  if (saisie.quantite <= 0) throw new Error('La quantité doit être positive.');

  const ref = await addDoc(collection(db, 'receptions'), {
    ...saisie,
    heure: saisie.heure ?? maintenant(),
    annulee: false,
    annuleeLe: null,
    annuleePar: null,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Annule une réception sans l'effacer.
 *
 * Le registre doit montrer qu'une erreur a été faite et corrigée : c'est la
 * réalité, et la masquer laisserait un trou qu'on ne saurait plus expliquer.
 */
export async function annulerReception(params: {
  receptionId: string;
  par: string;
  parNom?: string | null;
}): Promise<void> {
  await updateDoc(doc(db, 'receptions', params.receptionId), {
    annulee: true,
    annuleeLe: new Date().toISOString().split('T')[0],
    annuleePar: params.parNom ?? params.par,
  });
}

/** Les réceptions d'un dossier, de la plus récente à la plus ancienne. */
export async function chargerReceptions(documentId: string): Promise<Reception[]> {
  const snap = await getDocs(query(
    collection(db, 'receptions'),
    where('documentId', '==', documentId)));

  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Reception))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/** Ce qui a été reçu sur chaque ligne, les annulations déduites. */
export function recuParLigne(
  receptions: Reception[],
  /* Sur un transfert, on ne somme que les déclarations de l'étape qu'on lit :
     ce que la source a chargé n'est pas ce que le destinataire a compté. */
  etape?: 'expedition' | 'reception',
): Record<number, number> {
  const parLigne: Record<number, number> = {};
  for (const r of receptions) {
    if (r.annulee) continue;
    if (etape && (r.etape ?? 'reception') !== etape) continue;
    parLigne[r.ligneIndex] = (parLigne[r.ligneIndex] ?? 0) + r.quantite;
  }
  return parLigne;
}

/** L'auteur d'une réception, prêt à écrire. */
export function auteurDeReception(a: Auteur) {
  return {
    utilisateur: a.utilisateur,
    utilisateurNom: a.utilisateurNom,
    utilisateurFonction: a.utilisateurFonction,
  };
}
