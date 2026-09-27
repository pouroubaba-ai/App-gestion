import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { ouvrirPartout } from './produits-site';

/**
 * Créer un produit sans quitter le bon qu'on est en train de saisir.
 *
 * Le fournisseur apporte une référence qu'on n'avait jamais achetée. La
 * quitter pour aller la créer ailleurs fait perdre le bon en cours — et
 * en pratique, on la saisit sous un nom approchant qui existe déjà, ce
 * qui mélange deux marchandises dans le même stock.
 *
 * Ce qui naît ici est volontairement nu : une désignation, une unité,
 * une catégorie. Ni emballage, ni variante, ni code-barres — ceux-là se
 * posent sur la fiche du produit, quand on a le temps de les décrire.
 * Un formulaire complet ici ferait de la création une seconde tâche, et
 * on est venu saisir un achat.
 *
 * Le produit appartient à l'activité, comme tous les autres : une même
 * marchandise reste la même dans toutes les boutiques de la maison.
 */
export async function creerProduitRapide(params: {
  activiteId: string | null;
  userId: string;
  designation: string;
  unite: string;
  categorie?: string | null;
  /** les sites de l'activité : le produit s'ouvre partout, à zéro */
  siteIds: string[];
  /** le site d'où l'on saisit, pour y poser le prix s'il est connu */
  siteOrigine?: string | null;
  prixVente?: number | null;
}): Promise<{ id: string; designation: string; unite: string }> {
  const designation = params.designation.trim();
  if (!designation) throw new Error('Il faut une désignation.');

  const unite = params.unite.trim() || 'pièce';

  const ref = await addDoc(collection(db, 'produits'), {
    userId: params.userId,
    activiteId: params.activiteId ?? null,
    designation,
    codeBarre: null,
    categorie: params.categorie?.trim() || null,
    unite,
    /* Vides, et c'est voulu : ils se décrivent sur la fiche. */
    emballages: [],
    caracteristiques: [],
    variantes: [],
    actif: true,
    createdAt: serverTimestamp(),
  });

  /* Il apparaît aussitôt dans l'inventaire de chaque site, à zéro : sans
     cette ligne, un site ne pourrait pas recevoir un transfert d'une
     marchandise qu'il n'a jamais achetée lui-même. */
  await ouvrirPartout({
    produitId: ref.id,
    siteIds: params.siteIds,
    userId: params.userId,
    ...(params.siteOrigine ? { siteOrigine: params.siteOrigine } : {}),
    prixOrigine: params.prixVente ?? 0,
    seuilOrigine: null,
    variantesOrigine: [],
  });

  /* Aucun stock de départ : il entrera par le bon qu'on est en train de
     saisir. En poser un ici ferait entrer la marchandise deux fois. */
  return { id: ref.id, designation, unite };
}
