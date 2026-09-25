import {
  collection, query, where, getDocs, addDoc, updateDoc, doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Auteur } from './auteur';
import { lireParSite, type Portee } from '@/lib/portee';

/**
 * Les préparations de commande, ligne par ligne.
 *
 * Symétrique des réceptions, dans l'autre sens : là on constate ce qu'un
 * fournisseur apporte, ici on constate ce qu'on sort du magasin pour un
 * client. Chaque prélèvement est un fait daté — qui, quand, combien — et le
 * préparé leur somme. Il ne se saisit pas, il se déduit.
 *
 * Le stock ne bouge pas ici : il sort à la livraison. Une préparation dit ce
 * qui a été rassemblé, pas ce qui a quitté la maison.
 *
 * On ne modifie pas une préparation : on l'annule et on en saisit une autre.
 * Corriger en place effacerait la trace de l'erreur.
 */

export interface Preparation {
  id: string;
  siteId: string;
  /** la vente concernée */
  documentId: string;
  /** l'index de la ligne dans le dossier ; les lignes n'ont pas d'identifiant */
  ligneIndex: number;
  produitId?: string | null;
  /** le stock se tient à la variante quand il y en a une */
  varianteCle?: string | null;
  designation?: string | null;
  /** quantité telle qu'elle a été prélevée : 2 cartons restent 2 cartons */
  quantite: number;
  emballage?: string | null;
  /** ce que vaut un emballage en unités, figé au moment du prélèvement */
  contenance?: number;
  /**
   * La même quantité en unités de base : c'est elle qui s'additionne.
   *
   * Deux dossiers peuvent prélever le même produit dans des emballages
   * différents. 2 cartons et 5 pièces ne font pas 7 : sans cette conversion,
   * le réservé serait faux et le disponible avec lui.
   */
  quantiteUnites?: number;
  date: string;
  heure: string;
  /** qui a préparé, figé au moment du geste */
  utilisateur: string;
  utilisateurNom: string;
  utilisateurFonction: string;
  /** annulée par une écriture inverse : elle reste, barrée */
  annulee?: boolean;
  annuleeLe?: string | null;
  annuleePar?: string | null;
  note?: string | null;
}

export type SaisiePreparation =
  Omit<Preparation, 'id' | 'heure' | 'annulee' | 'annuleeLe' | 'annuleePar'>
  & { heure?: string };

function maintenant() {
  return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Enregistre une préparation. Elle s'ajoute, elle ne remplace rien. */
export async function enregistrerPreparation(saisie: SaisiePreparation): Promise<string> {
  if (saisie.quantite <= 0) throw new Error('La quantité doit être positive.');

  const ref = await addDoc(collection(db, 'preparations'), {
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
 * Annule une préparation sans l'effacer.
 *
 * Le registre doit montrer qu'une erreur a été faite et corrigée : c'est la
 * réalité, et la masquer laisserait un trou qu'on ne saurait plus expliquer.
 */
export async function annulerPreparation(params: {
  preparationId: string;
  par: string;
  parNom?: string | null;
}): Promise<void> {
  await updateDoc(doc(db, 'preparations', params.preparationId), {
    annulee: true,
    annuleeLe: new Date().toISOString().split('T')[0],
    annuleePar: params.parNom ?? params.par,
  });
}

/** Les préparations d'un dossier, de la plus récente à la plus ancienne. */
export async function chargerPreparations(documentId: string): Promise<Preparation[]> {
  const snap = await getDocs(query(
    collection(db, 'preparations'),
    where('documentId', '==', documentId)));

  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Preparation))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
}

/** Les préparations de tout un site, groupées par dossier. */
export async function chargerPreparationsDuSite(
  siteId: Portee,
): Promise<Map<string, Preparation[]>> {
  const docs = await lireParSite('preparations', siteId);

  const parDossier = new Map<string, Preparation[]>();
  for (const d of docs) {
    const p = { id: d.id, ...d.data() } as Preparation;
    const liste = parDossier.get(p.documentId);
    if (liste) liste.push(p);
    else parDossier.set(p.documentId, [p]);
  }
  return parDossier;
}

/** Ce qui a été préparé sur chaque ligne, les annulations déduites. */
export function prepareParLigne(preparations: Preparation[]): Record<number, number> {
  const parLigne: Record<number, number> = {};
  for (const p of preparations) {
    if (p.annulee) continue;
    parLigne[p.ligneIndex] = (parLigne[p.ligneIndex] ?? 0) + (p.quantiteUnites ?? p.quantite);
  }
  return parLigne;
}

/** L'auteur d'une préparation, prêt à écrire. */
export function auteurDePreparation(a: Auteur) {
  return {
    utilisateur: a.utilisateur,
    utilisateurNom: a.utilisateurNom,
    utilisateurFonction: a.utilisateurFonction,
  };
}

/**
 * Ce qui est prélevé mais pas encore sorti, par produit.
 *
 * Le stock ne bouge qu'à la livraison : il porte encore la marchandise que
 * des dossiers en préparation ou prêts ont déjà mise de côté. Sans ce compte,
 * deux commandes peuvent promettre le même carton.
 *
 * La clé est le produit, ou `produit:variante` quand la ligne en porte une —
 * le stock se tient à ce niveau-là.
 */
export async function reserveParProduit(
  siteId: string,
  /** les ventes qui retiennent encore du stock : en préparation ou prêtes */
  dossiersOuverts: Set<string>,
): Promise<Record<string, number>> {
  const snap = await getDocs(query(
    collection(db, 'preparations'),
    where('siteId', '==', siteId)));

  const parProduit: Record<string, number> = {};
  for (const d of snap.docs) {
    const p = { id: d.id, ...d.data() } as Preparation;
    if (p.annulee || !p.produitId) continue;
    if (!dossiersOuverts.has(p.documentId)) continue;
    const cle = p.varianteCle ? `${p.produitId}:${p.varianteCle}` : p.produitId;
    /* Les préparations d'avant la conversion n'ont pas d'unités : leur
       quantité était déjà exprimée dans l'unité de base. */
    parProduit[cle] = (parProduit[cle] ?? 0) + (p.quantiteUnites ?? p.quantite);
  }
  return parProduit;
}
