import {
  collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, doc,
  writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { enUnitesBase } from './mouvements';

/**
 * Les produits promis, un document par ligne de vente.
 *
 * Une ligne enfermée dans le tableau d'une vente ne s'interroge pas : pour
 * savoir combien de savon est promis, il faudrait ouvrir toutes les ventes et
 * parcourir toutes leurs lignes. Ici, on demande les lignes du produit.
 *
 * L'état ne se copie pas sur la ligne. Il appartient à la vente : une ligne
 * ne devient pas « prête » toute seule, c'est le dossier qui avance. Copier
 * l'état obligerait à réécrire toutes les lignes à chaque changement, et la
 * première écriture manquée laisserait une ligne qui ment sur son dossier.
 *
 * La contenance, elle, est figée : si la définition du carton passe de 12 à
 * 10, les ventes déjà passées ne doivent pas changer de sens.
 */

export interface LigneVente {
  id: string;
  siteId: string;
  /** la vente qui porte cette ligne ; son état se lit là-bas */
  venteId: string;
  /** l'index dans le tableau de la vente, pour retrouver la correspondance */
  ligneIndex: number;
  produitId: string;
  varianteCle?: string | null;
  designation: string;
  /** quantité telle qu'elle a été commandée : 3 cartons restent 3 cartons */
  quantite: number;
  emballage?: string | null;
  /** ce que vaut un emballage en unités, figé au moment de la commande */
  contenance: number;
  /** la même quantité en unités de base : c'est elle qui s'additionne */
  quantiteUnites: number;
  clientId?: string | null;
  clientNom?: string | null;
}

export type SaisieLigneVente = Omit<LigneVente, 'id'>;

/**
 * Prépare une ligne à écrire : la quantité commandée d'un côté, sa traduction
 * en unités de l'autre. Sans la seconde, trois cartons et cinq pièces ne
 * s'additionnent pas.
 */
export function ligneDepuisVente(params: {
  siteId: string;
  venteId: string;
  ligneIndex: number;
  ligne: {
    produitId: string;
    varianteCle?: string | null;
    designation: string;
    quantiteDemandee: number;
    emballage?: string | null;
  };
  emballages: { nom: string; quantite: number }[];
  clientId?: string | null;
  clientNom?: string | null;
}): SaisieLigneVente {
  const { ligne, emballages } = params;
  const contenance = ligne.emballage
    ? enUnitesBase(1, ligne.emballage, emballages) : 1;

  return {
    siteId: params.siteId,
    venteId: params.venteId,
    ligneIndex: params.ligneIndex,
    produitId: ligne.produitId,
    varianteCle: ligne.varianteCle ?? null,
    designation: ligne.designation,
    quantite: ligne.quantiteDemandee,
    emballage: ligne.emballage ?? null,
    contenance,
    quantiteUnites: ligne.quantiteDemandee * contenance,
    clientId: params.clientId ?? null,
    clientNom: params.clientNom ?? null,
  };
}

/** Les lignes actuellement enregistrées pour une vente. */
export async function chargerLignesDeVente(venteId: string): Promise<LigneVente[]> {
  const snap = await getDocs(query(
    collection(db, 'lignes_vente'),
    where('venteId', '==', venteId)));

  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as LigneVente))
    .sort((a, b) => a.ligneIndex - b.ligneIndex);
}

/** Les lignes d'un produit, toutes ventes confondues. */
export async function chargerLignesDuProduit(
  siteId: string, produitId: string,
): Promise<LigneVente[]> {
  const snap = await getDocs(query(
    collection(db, 'lignes_vente'),
    where('siteId', '==', siteId),
    where('produitId', '==', produitId)));

  return snap.docs.map(d => ({ id: d.id, ...d.data() } as LigneVente));
}

/** Toutes les lignes d'un site, pour un calcul global. */
export async function chargerLignesDuSite(siteId: string): Promise<LigneVente[]> {
  const snap = await getDocs(query(
    collection(db, 'lignes_vente'),
    where('siteId', '==', siteId)));

  return snap.docs.map(d => ({ id: d.id, ...d.data() } as LigneVente));
}

/**
 * Aligne la collection sur les lignes d'une vente.
 *
 * Un produit retiré voit sa ligne disparaître : ce n'est pas un fait qu'on
 * archive, c'est une commande qui n'a plus ce produit. Ce qui reste est mis à
 * jour, ce qui arrive est ajouté.
 */
export async function synchroniserLignes(params: {
  venteId: string;
  lignes: SaisieLigneVente[];
}): Promise<void> {
  const existantes = await chargerLignesDeVente(params.venteId);
  const batch = writeBatch(db);

  params.lignes.forEach((l, i) => {
    const ancienne = existantes.find(x => x.ligneIndex === i);
    if (ancienne) {
      batch.update(doc(db, 'lignes_vente', ancienne.id), { ...l });
    } else {
      batch.set(doc(collection(db, 'lignes_vente')), {
        ...l, createdAt: serverTimestamp(),
      });
    }
  });

  /* Les lignes au-delà du nouveau compte n'existent plus dans la vente. */
  for (const ancienne of existantes) {
    if (ancienne.ligneIndex >= params.lignes.length) {
      batch.delete(doc(db, 'lignes_vente', ancienne.id));
    }
  }

  await batch.commit();
}

/** Retire toutes les lignes d'une vente. */
export async function supprimerLignesDeVente(venteId: string): Promise<void> {
  const existantes = await chargerLignesDeVente(venteId);
  if (existantes.length === 0) return;

  const batch = writeBatch(db);
  for (const l of existantes) {
    batch.delete(doc(db, 'lignes_vente', l.id));
  }
  await batch.commit();
}
