/**
 * Mettre un produit dehors.
 *
 * Un catalogue se salit : une référence créée en double, un nom mal tapé,
 * un article qu'on pensait vendre et qu'on n'a jamais vendu. Ils restent
 * ensuite dans tous les sélecteurs, dans l'inventaire, dans les
 * recherches — et l'on hésite à chaque fois entre les deux « Savon ».
 *
 * Mais un produit qui a vécu ne s'efface pas. Une vente de mars le
 * nomme, un mouvement de stock le compte, une importation le porte : le
 * supprimer laisserait des lignes qui désignent un identifiant que plus
 * rien ne décrit, et l'historique deviendrait illisible exactement là où
 * il sert — quand on cherche ce qui s'est passé.
 *
 * La règle tient donc en une phrase : **sort celui qui n'a rien vécu**.
 * Un stock initial ne compte pas comme une vie — c'est la déclaration
 * d'un point de départ, pas un échange avec quelqu'un.
 */
import {
  collection, query, where, getDocs, doc, writeBatch, limit,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

/**
 * Les motifs qui ne font pas une histoire.
 *
 * Poser un stock de départ, corriger un comptage, réajuster ce qu'on
 * avait mal posé : ces gestes disent ce qu'on croit avoir, ils ne disent
 * pas qu'on a échangé avec quelqu'un. Un produit qui n'a que cela n'a
 * jamais été acheté, vendu, transféré ni reçu.
 *
 * Un apport et une production n'y sont pas : de la marchandise est
 * réellement entrée, même sans achat — un associé l'a amenée, l'atelier
 * l'a fabriquée. Cela compte comme une vie.
 */
const MOTIFS_SANS_HISTOIRE = [
  'stock_initial', 'reajustement',
  'correction_entree', 'correction_sortie',
];

export interface EtatProduit {
  /** Peut-on le mettre dehors ? */
  supprimable: boolean;
  /** Pourquoi pas, en une phrase qu'on peut montrer. */
  motif?: string;
  /** Ce qu'il laisserait derrière lui, pour le dire avant de faire. */
  mouvements: number;
  detentions: number;
  stock: number;
}

/**
 * Ce produit a-t-il vécu ?
 *
 * On regarde les mouvements, jamais les détentions. Un produit créé à la
 * volée s'ouvre à zéro sur tous les sites de l'activité : il aurait cinq
 * fiches de rayon sans avoir jamais bougé, et les compter le rendrait
 * indélébile dès sa naissance.
 */
export async function etatDuProduit(produitId: string): Promise<EtatProduit> {
  const [mvSnap, detSnap, lvSnap] = await Promise.all([
    getDocs(query(collection(db, 'mouvements'),
      where('produitId', '==', produitId))),
    getDocs(query(collection(db, 'produits_site'),
      where('produitId', '==', produitId))),
    /* Une ligne de vente survit à son dossier : un devis jamais livré
       n'a produit aucun mouvement, et pourtant il nomme ce produit. Une
       seule suffit à répondre — on n'a pas besoin de les compter. */
    getDocs(query(collection(db, 'lignes_vente'),
      where('produitId', '==', produitId), limit(1))),
  ]);

  const vivants = mvSnap.docs.filter(
    d => !MOTIFS_SANS_HISTOIRE.includes((d.data() as any).motif));

  const stock = detSnap.docs.reduce(
    (n, d) => n + ((d.data() as any).stock ?? 0), 0);

  if (vivants.length > 0) {
    return {
      supprimable: false,
      motif: `Ce produit a ${vivants.length} mouvement${
        vivants.length > 1 ? 's' : ''} — achat, vente ou transfert. `
        + "L'effacer rendrait ces lignes illisibles.",
      mouvements: mvSnap.size, detentions: detSnap.size, stock,
    };
  }

  if (!lvSnap.empty) {
    return {
      supprimable: false,
      motif: 'Ce produit figure dans un devis ou une commande. '
        + 'Fermez le dossier avant de le retirer.',
      mouvements: mvSnap.size, detentions: detSnap.size, stock,
    };
  }

  return {
    supprimable: true,
    mouvements: mvSnap.size, detentions: detSnap.size, stock,
  };
}

/**
 * Le mettre dehors, lui et ce qui ne vit que par lui.
 *
 * Sa fiche, ses détentions sur chaque site, et les mouvements de stock
 * initial qui ne décrivaient que lui. Rien d'autre ne le nomme — c'est
 * ce que `etatDuProduit` vient de vérifier, et la vérification se refait
 * ici : entre le moment où l'écran a demandé et celui où l'on écrit,
 * quelqu'un a pu vendre.
 */
export async function supprimerProduit(produitId: string): Promise<void> {
  const etat = await etatDuProduit(produitId);
  if (!etat.supprimable) {
    throw new Error(etat.motif ?? 'Ce produit ne peut pas être supprimé.');
  }

  const [mvSnap, detSnap] = await Promise.all([
    getDocs(query(collection(db, 'mouvements'),
      where('produitId', '==', produitId))),
    getDocs(query(collection(db, 'produits_site'),
      where('produitId', '==', produitId))),
  ]);

  const batch = writeBatch(db);
  mvSnap.docs.forEach(d => batch.delete(d.ref));
  detSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(doc(db, 'produits', produitId));
  await batch.commit();
}
