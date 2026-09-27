import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { ouvrirPartout } from './produits-site';
import type { Emballage } from './mouvements';
import {
  cleVariante, genererCodeBarre,
  type Caracteristique, type Variante,
} from './produit-forme';

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

/**
 * Créer un produit et toutes ses déclinaisons d'un coup.
 *
 * Le fournisseur n'apporte pas « une ampoule », il apporte la gamme :
 * 15 W, 25 W, 40 W. Les créer une par une obligerait à répéter la même
 * description trois fois — et à inventer trois noms là où il n'y a qu'un
 * produit et trois puissances.
 *
 * On décrit donc ce qui varie — une caractéristique et ses choix — et les
 * déclinaisons en découlent. Chacune a sa clé, son code-barres et son
 * stock propre ; le prix et le coût peuvent différer ou hériter du
 * produit.
 *
 * Aucun stock de départ : il entrera par le bon qu'on est en train de
 * saisir. En poser un ici ferait entrer la marchandise deux fois.
 */
export async function creerGammeRapide(params: {
  activiteId: string | null;
  userId: string;
  designation: string;
  unite: string;
  categorie?: string | null;
  emballages?: Emballage[];
  caracteristiques: Caracteristique[];
  /** ce qui distingue chaque déclinaison, dans l'ordre d'affichage */
  declinaisons: {
    selection: Record<string, string>;
    cout?: number | null;
    prix?: number | null;
  }[];
  coutProduit?: number | null;
  prixProduit?: number | null;
  siteIds: string[];
  siteOrigine?: string | null;
}): Promise<{
  id: string;
  designation: string;
  unite: string;
  variantes: Variante[];
}> {
  const designation = params.designation.trim();
  if (!designation) throw new Error('Il faut une désignation.');

  const unite = params.unite.trim() || 'pièce';
  const caracs = params.caracteristiques
    .filter(c => c.nom.trim() && c.valeurs.length > 0);

  const coutProduit = params.coutProduit ?? 0;
  const prixProduit = params.prixProduit ?? 0;

  /* La clé dit la déclinaison telle qu'on la lit : « 15W », « Rouge / M ».
     C'est elle que porteront le stock, les mouvements et les
     conditionnements qui s'y rattachent. */
  const variantes: Variante[] = params.declinaisons.map(d => ({
    cle: cleVariante(d.selection, caracs),
    codeBarre: genererCodeBarre(),
    selection: d.selection,
    stock: 0,
    /* le coût saisi initialise la moyenne pondérée, à défaut celui du
       produit ; il se repondérera dès la première entrée */
    coutMoyen: d.cout ?? coutProduit,
    ...(d.prix ? { prixVente: d.prix } : {}),
  }));

  const ref = await addDoc(collection(db, 'produits'), {
    userId: params.userId,
    activiteId: params.activiteId ?? null,
    designation,
    codeBarre: genererCodeBarre(),
    categorie: params.categorie?.trim() || null,
    unite,
    emballages: params.emballages ?? [],
    caracteristiques: caracs,
    /* Ce qui existe comme déclinaisons ; leur stock se compte site par
       site, dans la détention. */
    variantes: variantes.map(v => ({
      cle: v.cle, codeBarre: v.codeBarre, selection: v.selection,
      ...(v.prixVente != null ? { prixVente: v.prixVente } : {}),
    })),
    actif: true,
    createdAt: serverTimestamp(),
  });

  await ouvrirPartout({
    produitId: ref.id,
    siteIds: params.siteIds,
    userId: params.userId,
    ...(params.siteOrigine ? { siteOrigine: params.siteOrigine } : {}),
    prixOrigine: prixProduit,
    seuilOrigine: null,
    variantesOrigine: variantes.map(v => ({
      cle: v.cle, stock: 0, coutMoyen: 0, prixVente: v.prixVente ?? null,
    })),
  });

  return { id: ref.id, designation, unite, variantes };
}
