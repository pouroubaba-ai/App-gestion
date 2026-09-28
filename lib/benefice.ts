/**
 * Poser les prix depuis un bénéfice recherché.
 *
 * On sait ce que la marchandise a coûté, frais du voyage compris. Reste à
 * décider à combien elle repartira. Produit par produit, c'est long et
 * l'on perd de vue le total ; en annonçant ce qu'on veut gagner sur le
 * dossier entier, l'app propose des prix qui y mènent.
 *
 * La règle : garder les écarts déjà pratiqués. Chaque produit a un prix
 * en rayon, donc une marge connue. L'objectif se répartit dans ces mêmes
 * proportions — celui qui marge bien porte plus, celui qui marge peu
 * porte moins. Un taux uniforme, lui, ferait passer une balance de
 * 44 000 à 20 000 : le prix du marché ne se décrète pas depuis un
 * tableau.
 *
 * Rien ne s'écrit ici. La proposition se recalcule à chaque lecture, et
 * la main garde le dernier mot sur chaque ligne.
 */

import type { LigneFlux } from './flux-marchandise';

/** Ce qu'une ligne coûte réellement l'unité, part de frais comprise. */
export function coutReelUnitaire(
  l: LigneFlux, partFrais: number,
): number {
  const qte = l.quantiteRecue ?? l.quantiteDemandee ?? 0;
  if (qte <= 0) return l.valeurUnitaire ?? 0;
  return (l.valeurUnitaire ?? 0) + partFrais / qte;
}

/**
 * Ce que le dossier rapporte aux prix actuels.
 *
 * C'est le point de départ : on ne propose pas un objectif dans le vide,
 * on le compare à ce que les prix en place donneraient déjà.
 */
export function beneficeActuel(
  lignes: LigneFlux[], parts: number[] | null,
): number {
  return lignes.reduce((n, l, i) => {
    const qte = l.quantiteRecue ?? l.quantiteDemandee ?? 0;
    if (qte <= 0) return n;
    const reel = coutReelUnitaire(l, parts?.[i] ?? 0);
    return n + qte * ((l.prixVente ?? 0) - reel);
  }, 0);
}

/** Ce que le dossier a coûté, frais compris. */
export function coutTotal(
  lignes: LigneFlux[], parts: number[] | null,
): number {
  return lignes.reduce((n, l, i) => {
    const qte = l.quantiteRecue ?? l.quantiteDemandee ?? 0;
    if (qte <= 0) return n;
    return n + qte * coutReelUnitaire(l, parts?.[i] ?? 0);
  }, 0);
}

/**
 * Les prix qui mènent au bénéfice voulu.
 *
 * Chaque ligne porte l'objectif à hauteur de ce qu'elle marge déjà. Une
 * ligne sans prix établi ne pèse rien dans ce partage : on ne sait pas
 * ce qu'elle vaut au marché, et lui attribuer une part inventerait un
 * prix sur rien. Elle reçoit alors le taux moyen du dossier, faute de
 * mieux — c'est dit à l'écran, pour qu'on la regarde.
 *
 * Le dernier franc va à la ligne la plus lourde : l'arrondi perdu ferait
 * que la somme des marges ne ferait pas l'objectif.
 */
export function prixPourBenefice(
  lignes: LigneFlux[],
  parts: number[] | null,
  objectif: number,
  /** Les prix déjà pratiqués, par index — le rayon, pas le dossier. */
  prixEtablis: (number | null)[],
): number[] {
  const n = lignes.length;
  const prix = lignes.map(l => l.prixVente ?? 0);
  if (objectif <= 0 || n === 0) return prix;

  const qtes = lignes.map(l => l.quantiteRecue ?? l.quantiteDemandee ?? 0);
  const reels = lignes.map((l, i) => coutReelUnitaire(l, parts?.[i] ?? 0));

  /* Ce que chaque ligne marge aujourd'hui, au prix du rayon. C'est le
     poids du partage : les écarts entre familles de produits sont une
     information du marché, pas un hasard à corriger. */
  const poids = lignes.map((_, i) => {
    const etabli = prixEtablis[i];
    if (etabli == null || etabli <= 0 || qtes[i] <= 0) return 0;
    return Math.max(0, qtes[i] * (etabli - reels[i]));
  });

  const poidsTotal = poids.reduce((s, p) => s + p, 0);

  /* Aucune ligne ne sait ce qu'elle vaut : on ne peut que répartir au
     prorata du coût, et l'écran dira que la proposition est aveugle. */
  if (poidsTotal <= 0) {
    const base = lignes.map((_, i) => qtes[i] * reels[i]);
    const baseTotale = base.reduce((s, b) => s + b, 0);
    if (baseTotale <= 0) return prix;
    return lignes.map((l, i) => qtes[i] <= 0 ? (l.prixVente ?? 0)
      : Math.round(reels[i] + (objectif * base[i] / baseTotale) / qtes[i]));
  }

  let pose = 0;
  let plusLourde = 0;
  const marges = lignes.map((_, i) => {
    const part = Math.floor(objectif * poids[i] / poidsTotal);
    pose += part;
    if (poids[i] > poids[plusLourde]) plusLourde = i;
    return part;
  });
  marges[plusLourde] += objectif - pose;

  return lignes.map((l, i) => {
    if (qtes[i] <= 0) return l.prixVente ?? 0;
    /* Une ligne sans prix établi garde le sien : on ne lui impose pas un
       prix déduit d'un poids nul. */
    if (poids[i] <= 0) return l.prixVente ?? 0;
    return Math.round(reels[i] + marges[i] / qtes[i]);
  });
}

/**
 * Le taux de marge du dossier, pour dire ce qu'on demande.
 *
 * « 500 000 de bénéfice » ne se juge pas seul : sur 2 000 000 d'achat
 * c'est 25 %, sur 20 000 000 c'est 2,5 %. Le taux rend l'objectif
 * lisible.
 */
export function tauxDeMarge(benefice: number, cout: number): number | null {
  if (cout <= 0) return null;
  return Math.round((benefice / cout) * 1000) / 10;
}
