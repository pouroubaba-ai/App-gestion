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

/** Le stock d'une variante, dans un site donné. */
export interface VarianteSite {
  cle: string;
  stock: number;
  coutMoyen: number;
  prixVente?: number | null;
  /** Ce qui se pratique autour : un fait, pas une décision. */
  prixMarche?: number | null;
  /**
   * Le rayon ignore ce qu'il a payé cette marchandise.
   *
   * Vrai après un stock initial : on compte ce qui est là, on ne sait
   * pas ce qu'il a coûté. `coutMoyen` vaut alors zéro faute de mieux, et
   * ce drapeau dit de ne pas le lire comme une valeur. La première
   * entrée réelle le pose et lève le drapeau.
   */
  coutInconnu?: boolean;
}

/** Ce qu'un site détient d'un produit. */
export interface ProduitSite {
  id: string;
  produitId: string;
  siteId: string;
  userId: string;
  stock: number;
  coutMoyen: number;
  /**
   * Le rayon ignore ce qu'il a payé sa marchandise.
   *
   * Vrai tant qu'aucune entrée réelle n'a posé le coût : `coutMoyen`
   * vaut alors zéro faute de mieux, et le lire comme une valeur ferait
   * d'une vente un bénéfice égal à son prix.
   */
  coutInconnu?: boolean;
  prixVente: number;
  /**
   * Ce qui se pratique autour, quand on le sait.
   *
   * Le prix de vente est une décision ; celui-ci est un fait extérieur,
   * qui ne dépend pas de nous et peut passer sous notre coût. Les
   * confondre ferait passer une contrainte du marché pour un choix.
   * Absent tant que personne ne l'a constaté.
   */
  prixMarche?: number | null;
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
  /** Le rayon ignore ce qu'il a payé : `coutMoyen` vaut zéro faute de
      mieux, et ce drapeau empêche de le lire comme une valeur. */
  coutInconnu?: boolean;
  prixVente?: number;
  prixMarche?: number | null;
  seuilAlerte?: number | null;
  variantes?: VarianteSite[];
  /**
   * Le dossier qui autorise d'ouvrir cette detention chez un autre site.
   *
   * Les regles l'exigent pour une detention qui nait du cote d'en face —
   * un transfert ou la livraison d'un ordre vers un produit que le
   * destinataire n'avait jamais detenu. Sans elle, la creation est
   * refusee et le dossier s'arrete au premier produit nouveau.
   */
  marqueOuvrante?: Record<string, string>;
}): Promise<string> {
  const existante = await detentionDe(params.siteId, params.produitId);
  if (existante) return existante.id;

  const ref = await addDoc(collection(db, 'produits_site'), {
    produitId: params.produitId,
    siteId: params.siteId,
    userId: params.userId,
    stock: params.stock ?? 0,
    coutMoyen: params.coutMoyen ?? 0,
    ...(params.coutInconnu ? { coutInconnu: true } : {}),
    prixVente: params.prixVente ?? 0,
    prixMarche: params.prixMarche ?? null,
    seuilAlerte: params.seuilAlerte ?? null,
    variantes: params.variantes ?? [],
    ...(params.marqueOuvrante ?? {}),
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
  /** Le coût du site d'origine n'est pas connu : il sera posé par le
      premier achat. Les autres sites partent à zéro de toute façon. */
  coutOrigineInconnu?: boolean;
  prixOrigine?: number;
  /** Le marché constaté : il vaut pour tous les sites tant qu'aucun
      n'en relève un autre. */
  marcheOrigine?: number | null;
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
      /* Un site qui ne reçoit rien part de toute façon sans coût : son
         premier approvisionnement le posera, quel qu'il soit. */
      coutInconnu: estOrigine ? !!params.coutOrigineInconnu : true,
      /* Le prix se propose partout, même à stock zéro : un site qui reçoit
         un transfert doit pouvoir vendre sans reparamétrer sa fiche. Il
         reste libre de le changer ensuite. */
      prixVente: params.prixOrigine ?? 0,
      prixMarche: params.marcheOrigine ?? null,
      seuilAlerte: estOrigine ? (params.seuilOrigine ?? null) : null,
      variantes: estOrigine
        ? (params.variantesOrigine ?? [])
        : (params.variantesOrigine ?? []).map(v => ({
            cle: v.cle, stock: 0, coutMoyen: 0, coutInconnu: true,
            prixVente: v.prixVente ?? null,
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
/**
 * L'activité d'un site, retenue une fois pour toutes.
 *
 * Un site ne change jamais de maison : relire sa fiche à chaque ouverture
 * d'écran pose une attente avant les trois requêtes qui en dépendent, pour
 * une réponse qui sera la même toute la session.
 */
const activiteParSite = new Map<string, Promise<string | null>>();

export function activiteDuSite(siteId: string): Promise<string | null> {
  const connue = activiteParSite.get(siteId);
  if (connue) return connue;
  const p = getDoc(doc(db, 'sites', siteId))
    .then(s => (s.data()?.activiteId ?? null) as string | null)
    .catch(e => {
      /* Un échec ne se retient pas : le garder en mémoire condamnerait
         l'écran jusqu'au rechargement de la page. */
      activiteParSite.delete(siteId);
      throw e;
    });
  activiteParSite.set(siteId, p);
  return p;
}

/**
 * Le coût d'un produit détenu.
 *
 * Sans déclinaison, la détention le porte. Avec, chaque déclinaison a le
 * sien et le produit n'en a pas : on le compose alors en pondérant par
 * les stocks, faute de quoi un article rare pèserait autant qu'un autre
 * détenu par centaines.
 */
function coutDuProduit(det: any, variantes: any[]): number {
  if (variantes.length === 0) return det?.coutMoyen ?? 0;
  const vs = det?.variantes ?? [];
  let stock = 0, valeur = 0;
  for (const v of variantes) {
    const d = vs.find((x: any) => x.cle === v.cle);
    const q = d?.stock ?? 0;
    if (q <= 0) continue;
    stock += q;
    valeur += q * (d?.coutMoyen ?? 0);
  }
  /* Rien en rayon : on prend la première déclinaison qui sait ce qu'elle
     a coûté — c'est mieux que zéro pour borner un prix de vente. */
  if (stock <= 0) {
    const connue = vs.find((x: any) => (x.coutMoyen ?? 0) > 0);
    return connue?.coutMoyen ?? 0;
  }
  return Math.round(valeur / stock);
}

export async function produitsDuSite(siteId: string): Promise<any[]> {
  /* Les produits de CETTE maison, et d'aucune autre.
   *
   * La collection était lue entière, sans filtre. Les règles laissent
   * passer la liste — elles ne savent pas ce qu'elle rapportera — mais
   * refusent d'écrire sur le produit d'une autre activité : l'article
   * apparaissait dans le sélecteur, se vendait, et la livraison échouait
   * sur un « Missing or insufficient permissions » que rien n'expliquait.
   * Un écran qui propose ce qu'on ne peut pas écrire ment à celui qui
   * saisit. */
  const activiteId = await activiteDuSite(siteId);

  /* Le coût se lit sur la détention, il ne se reconstruit plus.
   *
   * On rapatriait tous les mouvements du site pour le recalculer, parce
   * que la détention portait un coût faux — le prix d'un carton inscrit
   * sur des pièces. Ce défaut est corrigé à l'écriture, et les
   * détentions ont été recalées : la détention redit le vrai.
   *
   * La lecture, elle, ne tenait pas. Ce sélecteur s'ouvre au comptoir,
   * sur un achat, sur une vente — des dizaines de fois par jour. Lire
   * tout l'historique à chaque ouverture passe inaperçu sur une base
   * neuve et devient insupportable après un an : le volume grandit sans
   * cesse, l'écran qu'on ouvre le plus souvent ralentit le plus.
   *
   * La reconstruction reste dans `cout-moyen.ts` : c'est elle qui sert à
   * vérifier la détention quand on la soupçonne, et à la recaler. */
  const [snapProd, dets] = await Promise.all([
    activiteId
      ? getDocs(query(collection(db, 'produits'),
          where('activiteId', '==', activiteId)))
      : getDocs(query(collection(db, 'produits'),
          where('activiteId', '==', '__aucune__'))),
    getDocs(query(collection(db, 'produits_site'), where('siteId', '==', siteId))),
  ]);

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
        /* Avec déclinaisons, le coût du produit est la moyenne des
           siennes, pondérée par leurs stocks : le produit lui-même n'en
           porte pas. */
        coutMoyen: coutDuProduit(det, data.variantes ?? []),
        prixVente: det?.prixVente ?? 0,
        /* Ce qui se pratique autour : un fait, pas une décision. Les
           écrans qui posent un prix en ont besoin pour le comparer. */
        prixMarche: det?.prixMarche ?? null,
        seuilAlerte: det?.seuilAlerte ?? null,
        /* Les déclinaisons viennent du produit, leurs stocks de la
           détention : une variante inconnue du site vaut zéro. */
        variantes: (data.variantes ?? []).map((v: any) => {
          const vs = (det?.variantes ?? []).find(x => x.cle === v.cle);
          return {
            ...v,
            stock: vs?.stock ?? 0,
            coutMoyen: vs?.coutMoyen ?? 0,
            prixVente: vs?.prixVente ?? v.prixVente ?? 0,
            prixMarche: vs?.prixMarche ?? det?.prixMarche ?? null,
          };
        }),
      };
    })
    .filter(p => p.actif)
    .sort((a, b) => a.designation.localeCompare(b.designation));
}
