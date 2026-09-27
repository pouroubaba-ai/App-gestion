import type { Emballage } from './mouvements';

/**
 * Ce qui décrit un produit, et ce qui sert à le saisir.
 *
 * Ces formes vivaient dans l'écran Inventaire, qui était le seul à créer
 * des produits. Le bon d'achat en crée maintenant aussi — le fournisseur
 * apporte une référence qu'on n'avait jamais achetée — et deux écrans qui
 * décrivent la même chose chacun de leur côté finissent par la décrire
 * différemment.
 */

/** Ce qui fait varier un produit : couleur, taille, puissance. */
export interface Caracteristique {
  nom: string;
  valeurs: string[];
}

/**
 * Déclinaison réelle du produit, avec son propre stock.
 *
 * `selection` ne porte que les caractéristiques qui la concernent : un
 * modèle taille unique n'a qu'une couleur. `prixVente` absent hérite du
 * produit ; `coutMoyen` n'hérite jamais — il résulte des entrées propres
 * à la variante.
 */
export interface Variante {
  cle: string;
  codeBarre: string;
  selection: Record<string, string>;
  stock: number;
  coutMoyen: number;
  prixVente?: number;
}

/** Une déclinaison en cours de saisie : ses valeurs sont encore du texte. */
export interface VarianteSaisie {
  selection: Record<string, string>;
  stock: string;
  stockEmb: string;
  cout: string;
  prix: string;
}

/** Les onglets du formulaire, dans l'ordre où on les parcourt. */
export type OngletForm =
  | 'general' | 'tarifs' | 'emballages' | 'caracteristiques' | 'variantes';

/** Un montant saisi avec ses séparateurs : « 12 500 » vaut 12500. */
export function parseMontant(s: string): number {
  return parseInt(String(s ?? '').replace(/[\s ]/g, ''), 10) || 0;
}

/**
 * Code-barres EAN-13 à usage interne : préfixe 200 — la plage réservée
 * aux numérotations privées —, neuf chiffres, puis la clé de contrôle.
 */
export function genererCodeBarre(): string {
  const base = '200'
    + Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join('');
  const somme = base.split('')
    .reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return base + ((10 - (somme % 10)) % 10);
}

/** Une quantité saisie dans un emballage, ramenée en unités de base. */
export function enUnites(
  quantite: string, nomEmballage: string, emballages: Emballage[],
): number {
  const nb = parseMontant(quantite);
  if (!nb) return 0;
  const emb = emballages.find(e => e.nom === nomEmballage);
  return nb * (emb ? emb.quantite : 1);
}

/** Libellé d'une sélection, dans l'ordre des caractéristiques : « Rouge / M ». */
export function cleVariante(
  selection: Record<string, string>, caracs: Caracteristique[],
): string {
  return caracs
    .map(c => selection[c.nom])
    .filter(Boolean)
    .join(' / ');
}

/** Deux déclinaisons sont identiques si elles portent les mêmes couples. */
export function memeSelection(
  a: Record<string, string>, b: Record<string, string>,
): boolean {
  const cles = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...cles].every(k => a[k] === b[k]);
}
