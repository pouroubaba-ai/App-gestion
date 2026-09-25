/**
 * Ce qu'un site détient d'un produit.
 *
 * Un produit appartient à l'activité, pas à une boutique : « Mangue » est
 * la même marchandise partout, et c'est ce qui permet de demander combien
 * il en est entré et sorti sur l'ensemble de la maison. Tant que chaque
 * site portait sa propre fiche, deux « Mangue » étaient deux objets sans
 * lien — et un transfert entre eux n'avait rien à rapprocher.
 *
 * Ce qui reste local, c'est la détention :
 *
 *  - `stock`       : ce que ce site a en rayon
 *  - `coutMoyen`   : ce que sa marchandise lui a coûté, selon ses achats
 *  - `prixVente`   : à combien il la revend — un dépôt et une boutique de
 *                    quartier ne pratiquent pas le même prix
 *  - `seuilAlerte` : à partir de quand il doit se réapprovisionner, ce qui
 *                    dépend de son rythme d'écoulement
 *
 * Le nom, la catégorie, l'unité, le code-barres, les emballages et les
 * variantes restent sur le produit : ce sont des faits sur la marchandise
 * elle-même, et les laisser diverger d'un site à l'autre rendrait un
 * transfert ambigu — « trois cartons » ne voudrait plus dire la même chose
 * des deux côtés.
 */
import {
  collection, query, where, getDocs, addDoc, doc, getDoc,
  serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { lireDocs, sitesDe, type Portee } from '@/lib/portee';
import { etatsDepuisMouvements, etatDe, etatDuProduit } from '@/lib/cout-moyen';

/** Le stock d'une variante, dans un site donné. */
export interface VarianteSite {
  cle: string;
  stock: number;
  coutMoyen: number;
  prixVente?: number | null;
}

/** Ce qu'un site détient d'un produit. */
export interface ProduitSite {
  id: string;
  produitId: string;
  siteId: string;
  userId: string;
  stock: number;
  coutMoyen: number;
  prixVente: number;
  seuilAlerte?: number | null;
  /** Le stock par variante, quand le produit en a. */
  variantes?: VarianteSite[];
  createdAt?: any;
}

/** La détention d'un produit par un site, si elle existe. */
export async function detentionDe(
  siteId: string, produitId: string,
): Promise<ProduitSite | null> {
  const snap = await getDocs(query(
    collection(db, 'produits_site'),
    where('siteId', '==', siteId),
    where('produitId', '==', produitId)));
  const d = snap.docs[0];
  return d ? ({ id: d.id, ...d.data() } as ProduitSite) : null;
}

/** Toutes les détentions d'une portée — un site, ou plusieurs. */
export async function detentionsDe(portee: Portee): Promise<ProduitSite[]> {
  return lireDocs<ProduitSite>('produits_site', portee);
}

/**
 * Crée la détention d'un produit sur un site, à zéro.
 *
 * Un produit naît pour toute l'activité : il apparaît dans l'inventaire de
 * chaque site, sans stock, prêt à en recevoir. Sans cette ligne, un site ne
 * pourrait pas recevoir un transfert d'une marchandise qu'il n'a jamais
 * achetée lui-même.
 */
export async function ouvrirDetention(params: {
  produitId: string;
  siteId: string;
  userId: string;
  stock?: number;
  coutMoyen?: number;
  prixVente?: number;
  seuilAlerte?: number | null;
  variantes?: VarianteSite[];
}): Promise<string> {
  const existante = await detentionDe(params.siteId, params.produitId);
  if (existante) return existante.id;

  const ref = await addDoc(collection(db, 'produits_site'), {
    produitId: params.produitId,
    siteId: params.siteId,
    userId: params.userId,
    stock: params.stock ?? 0,
    coutMoyen: params.coutMoyen ?? 0,
    prixVente: params.prixVente ?? 0,
    seuilAlerte: params.seuilAlerte ?? null,
    variantes: params.variantes ?? [],
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Ouvre la détention sur tous les sites d'une activité.
 *
 * Appelé à la naissance d'un produit : il existe dès lors partout, à stock
 * zéro. C'est ce qui rend un transfert possible sans rien rapprocher — les
 * deux sites désignent le même produit, seule la quantité se déplace.
 */
export async function ouvrirPartout(params: {
  produitId: string;
  siteIds: string[];
  userId: string;
  /** Le site qui crée, et qui peut partir avec un stock initial. */
  siteOrigine?: string;
  stockOrigine?: number;
  coutOrigine?: number;
  prixOrigine?: number;
  seuilOrigine?: number | null;
  variantesOrigine?: VarianteSite[];
}): Promise<void> {
  for (const siteId of params.siteIds) {
    const estOrigine = siteId === params.siteOrigine;
    await ouvrirDetention({
      produitId: params.produitId,
      siteId,
      userId: params.userId,
      stock: estOrigine ? (params.stockOrigine ?? 0) : 0,
      coutMoyen: estOrigine ? (params.coutOrigine ?? 0) : 0,
      /* Le prix se propose partout, même à stock zéro : un site qui reçoit
         un transfert doit pouvoir vendre sans reparamétrer sa fiche. Il
         reste libre de le changer ensuite. */
      prixVente: params.prixOrigine ?? 0,
      seuilAlerte: estOrigine ? (params.seuilOrigine ?? null) : null,
      variantes: estOrigine
        ? (params.variantesOrigine ?? [])
        : (params.variantesOrigine ?? []).map(v => ({
            cle: v.cle, stock: 0, coutMoyen: 0, prixVente: v.prixVente ?? null,
          })),
    });
  }
}

/**
 * Les sites d'une activité.
 *
 * Un produit naît pour tous : il faut donc savoir qui ils sont, au moment
 * où on le crée.
 */
export async function sitesDeLActivite(activiteId: string): Promise<string[]> {
  const snap = await getDocs(query(
    collection(db, 'sites'), where('activiteId', '==', activiteId)));
  return snap.docs.map(d => d.id);
}

/**
 * Ce qui empêche de supprimer une variante, un emballage ou un produit.
 *
 * Un fait s'enregistre, il ne s'annote pas : ce qui porte du stock ou qui
 * apparaît dans un document appartient déjà à l'histoire. La vérification
 * porte sur toute l'activité, jamais sur un seul site — un site ne peut pas
 * effacer ce qu'un autre utilise encore.
 */
export async function usageDansLActivite(params: {
  produitId: string;
  varianteCle?: string | null;
  emballage?: string | null;
}): Promise<{ bloque: boolean; raison: string | null }> {
  const { produitId, varianteCle, emballage } = params;

  /* Du stock quelque part : la marchandise est là, on ne l'efface pas. */
  const detentions = await getDocs(query(
    collection(db, 'produits_site'),
    where('produitId', '==', produitId)));
  for (const d of detentions.docs) {
    const p = d.data() as ProduitSite;
    if (varianteCle) {
      const v = (p.variantes ?? []).find(x => x.cle === varianteCle);
      if (v && v.stock > 0) {
        return { bloque: true, raison: 'Cette variante porte encore du stock sur un site.' };
      }
    } else if (!emballage && (p.stock ?? 0) > 0) {
      return { bloque: true, raison: 'Ce produit porte encore du stock sur un site.' };
    }
  }

  /* Un mouvement s'y réfère : son passé cesserait d'être lisible. */
  const mvts = await getDocs(query(
    collection(db, 'mouvements'),
    where('produitId', '==', produitId)));
  for (const d of mvts.docs) {
    const m = d.data() as any;
    if (varianteCle && m.varianteCle === varianteCle) {
      return { bloque: true, raison: 'Cette variante figure dans des mouvements déjà enregistrés.' };
    }
    if (emballage && m.emballage === emballage) {
      return { bloque: true, raison: 'Cet emballage figure dans des mouvements déjà enregistrés.' };
    }
    if (!varianteCle && !emballage) {
      return { bloque: true, raison: 'Ce produit figure dans des mouvements déjà enregistrés.' };
    }
  }

  return { bloque: false, raison: null };
}

/**
 * Les produits qu'un site détient, prêts à être choisis.
 *
 * Les écrans de saisie — achat, vente, comptoir, transfert — travaillent
 * toujours dans un site : ils veulent le produit de l'activité, garni du
 * stock, du coût et du prix de CE site. Sans cette jointure, chacun aurait
 * refait le rapprochement à sa façon.
 */
export async function produitsDuSite(siteId: string): Promise<any[]> {
  const [snapProd, dets, mvts] = await Promise.all([
    getDocs(collection(db, 'produits')),
    getDocs(query(collection(db, 'produits_site'), where('siteId', '==', siteId))),
    /* Le coût moyen se déduit des entrées : stocké, il part du stock
       courant, et une sortie pas encore écrite le fausse durablement. */
    getDocs(query(collection(db, 'mouvements'), where('siteId', '==', siteId))),
  ]);

  const etats = etatsDepuisMouvements(mvts.docs.map(d => d.data() as any));

  const parProduit = new Map<string, ProduitSite>();
  for (const d of dets.docs) {
    const p = { id: d.id, ...d.data() } as ProduitSite;
    parProduit.set(p.produitId, p);
  }

  return snapProd.docs
    /* Un produit que ce site ne détient pas encore reste proposable : il
       peut l'acheter ou le recevoir. Sa détention s'ouvrira au premier
       mouvement, à zéro. */
    .map(d => {
      const data = d.data() as any;
      const det = parProduit.get(d.id);
      return {
        id: d.id,
        siteId,
        designation: data.designation ?? '',
        codeBarre: data.codeBarre ?? null,
        categorie: data.categorie ?? null,
        unite: data.unite ?? '',
        emballages: data.emballages ?? [],
        caracteristiques: data.caracteristiques ?? [],
        actif: data.actif ?? true,
        stock: det?.stock ?? 0,
        coutMoyen: ((data.variantes ?? []).length > 0
          ? etatDuProduit(etats, d.id, data.variantes)
          : etatDe(etats, d.id, null)).coutMoyen,
        prixVente: det?.prixVente ?? 0,
        seuilAlerte: det?.seuilAlerte ?? null,
        /* Les déclinaisons viennent du produit, leurs stocks de la
           détention : une variante inconnue du site vaut zéro. */
        variantes: (data.variantes ?? []).map((v: any) => {
          const vs = (det?.variantes ?? []).find(x => x.cle === v.cle);
          return {
            ...v,
            stock: vs?.stock ?? 0,
            coutMoyen: etatDe(etats, d.id, v.cle).coutMoyen,
            prixVente: vs?.prixVente ?? v.prixVente ?? 0,
          };
        }),
      };
    })
    .filter(p => p.actif)
    .sort((a, b) => a.designation.localeCompare(b.designation));
}
