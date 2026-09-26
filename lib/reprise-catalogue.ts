import {
  collection, addDoc, getDocs, query, where, writeBatch, doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';

/**
 * Reprendre un catalogue, le temps d'un essai.
 *
 * Ce module est un échafaudage : il sert à garnir une activité neuve pour
 * l'éprouver à plusieurs, puis il s'enlève. Rien d'autre dans l'app n'en
 * dépend — les deux boutons qui l'appellent partent avec lui.
 *
 * Il ne pose jamais de stock. Les produits naissent, les rayons restent à
 * zéro, et la marchandise n'entre que par un dossier que le responsable
 * des commandes confirme. Un import qui remplirait les rayons tout seul
 * déciderait de ce qu'il y a en boutique sans que personne n'ait compté.
 */

/** Ce qu'on reprend d'un produit, une fois lu. */
export interface ProduitRepris {
  designation: string;
  prix: number;
  parEmballage: number;
  stock: number;
  categorie: string;
}

/**
 * De quelle famille relève un produit.
 *
 * L'ancienne base n'en portait aucune : on la devine de la désignation,
 * par les mots qui reviennent dans ce métier. C'est imparfait — un nom
 * qui ne dit rien tombe dans « Divers », et c'est honnête ainsi : mieux
 * vaut une case vide qu'un rangement inventé.
 *
 * L'ordre compte : le premier mot trouvé l'emporte, donc les familles les
 * plus précises passent avant les plus larges.
 */
const FAMILLES: { categorie: string; mots: string[] }[] = [
  { categorie: 'Plomberie', mots: [
    'pvc', 'ppr', 'robinet', 'evier', 'lavabo', 'wc', 'siphon', 'tuyau',
    'coude', 'reduction', 'bouchon', 'collier', 'mecanisme', 'ventouse',
  ] },
  { categorie: 'Tôlerie', mots: [
    'tole', 'tôle', 'faitier', 'faitiere', 'naco', 'aluminium',
  ] },
  { categorie: 'Électricité', mots: [
    'ampoule', 'rallonge', 'prise', 'douille', 'fil ', 'cable', 'multiprise',
    'fiche', 'stabilisateur', 'voltometre', 'reglette', 'torch', 'projecteur',
    'antenne', 'decodeur', 'telecommande', 'led',
  ] },
  { categorie: 'Électroménager', mots: [
    'rechaud', 'réchaud', 'fer a repasser', 'fer repasser', 'fer à repasser', 'ventilateur', 'ventilo',
    'mixeur', 'cafetier', 'cafetiere', 'friteuse', 'micro-onde', 'machine a',
    'machine à', 'tondeuse', 'extracteur', 'balance', 'radio', 'thermos',
    'melangeur', 'gaz', 'filtre',
  ] },
  { categorie: 'Nettoyage', mots: [
    'balai', 'balais', 'brosse', 'raclette', 'seau', 'serpilliere',
    'ramassette', 'pelle',
  ] },
  { categorie: 'Peinture', mots: [
    'peinture', 'rouleau', 'papier verre', 'colle', 'taloche',
  ] },
  { categorie: 'Quincaillerie', mots: [
    'pointe', 'cadenas', 'cle ', 'clé ', 'vis', 'boulon', 'casque',
    'fixer', 'fixeur', 'carreau', 'carreaux',
  ] },
  { categorie: 'Mobilier', mots: [
    'table', 'chaise', 'assiette', 'marbre',
  ] },
];

/** La famille d'une désignation, ou « Divers » quand rien ne correspond. */
export function categorieDe(designation: string): string {
  const t = designation.toLowerCase();
  for (const f of FAMILLES) {
    if (f.mots.some(m => t.includes(m))) return f.categorie;
  }
  return 'Divers';
}

/**
 * Le catalogue de reprise.
 *
 * Il vit dans le code plutôt que dans une base tierce : l'app n'a pas à
 * savoir se connecter ailleurs pour se garnir, et le jour où l'on retire
 * l'échafaudage, il part avec.
 */
/**
 * Le catalogue de reprise : une quincaillerie, telle qu'on en tient une.
 *
 * Les désignations viennent de l'ancienne base ; les prix et les
 * quantités sont reconstitués — la base d'origine était hors d'atteinte
 * au moment de l'écrire, et l'on préfère des chiffres plausibles
 * annoncés comme tels à des chiffres faux qu'on croirait vrais. Ils
 * servent à éprouver le cycle à plusieurs, pas à tenir un compte.
 */
export const CATALOGUE: { d: string; p: number; e: number; s: number }[] = [
  { d: 'Tole ordinaire 3kg rouge', p: 2400, e: 1, s: 909 },
  { d: 'Tole ordinaire 3kg vert', p: 2400, e: 1, s: 640 },
  { d: 'Tole ordinaire 3kg bleu', p: 2400, e: 1, s: 512 },
  { d: 'Tole ordinaire 2kg', p: 1800, e: 1, s: 380 },
  { d: 'Tole bac bleue', p: 4500, e: 1, s: 96 },
  { d: 'Tole bac verte', p: 4500, e: 1, s: 84 },
  { d: 'Tole aluminium 0.45mm', p: 6200, e: 1, s: 48 },
  { d: 'Faitiere bleue', p: 3500, e: 1, s: 62 },
  { d: 'Faitiere verte', p: 3500, e: 1, s: 55 },
  { d: 'Lames de naco 0,80', p: 1200, e: 10, s: 240 },
  { d: 'Bouchon pvc 75', p: 700, e: 1, s: 1865 },
  { d: 'Bouchon pvc 100', p: 900, e: 1, s: 1240 },
  { d: 'Bouchon pvc 110', p: 1000, e: 1, s: 980 },
  { d: 'Coude pvc 50', p: 450, e: 1, s: 1520 },
  { d: 'Coude pvc 75', p: 750, e: 1, s: 1105 },
  { d: 'Coude pvc 100', p: 1100, e: 1, s: 860 },
  { d: 'Coude pvc 110-45', p: 1350, e: 1, s: 640 },
  { d: 'Coude pvc 125', p: 1600, e: 1, s: 310 },
  { d: 'Te pvc 75', p: 950, e: 1, s: 720 },
  { d: 'Te pvc 110', p: 1400, e: 1, s: 495 },
  { d: 'Te pvc 125', p: 1800, e: 1, s: 265 },
  { d: 'Reduction pvc 75/40', p: 600, e: 1, s: 840 },
  { d: 'Reduction pvc 110/75', p: 850, e: 1, s: 612 },
  { d: 'Reduction pvc 110/100', p: 900, e: 1, s: 528 },
  { d: 'Collier pvc 100', p: 350, e: 20, s: 1600 },
  { d: 'Tes ppr simple t25', p: 500, e: 10, s: 720 },
  { d: 'Robinet de lavabo', p: 2500, e: 48, s: 48 },
  { d: 'Evier inox 2 bacs', p: 45000, e: 1, s: 12 },
  { d: 'Mecanisme WC 1349-1', p: 8500, e: 1, s: 26 },
  { d: 'Ventouse WC', p: 1500, e: 12, s: 84 },
  { d: 'Ampoule LED Ingelec 15 W', p: 1200, e: 25, s: 500 },
  { d: 'Ampoule led ctorch 7w b22', p: 900, e: 25, s: 625 },
  { d: 'Ampoule led 30w', p: 2200, e: 10, s: 240 },
  { d: 'Ampoule c-torch 10w', p: 1000, e: 25, s: 450 },
  { d: 'Ampoule c-torch 20w', p: 1600, e: 25, s: 375 },
  { d: 'Ampoule ingelec 10w', p: 1100, e: 25, s: 400 },
  { d: 'Ampoule chargeable 20W B22', p: 3500, e: 10, s: 120 },
  { d: 'Ampoule reglette LED petite', p: 2500, e: 10, s: 90 },
  { d: 'Ampoule reglette LED moyenne', p: 3500, e: 10, s: 70 },
  { d: 'Ampoule projecteur 1000 W', p: 12000, e: 1, s: 24 },
  { d: 'Douille locale', p: 300, e: 50, s: 1500 },
  { d: 'Fiche femelle', p: 400, e: 50, s: 900 },
  { d: 'Fil TH 2.5 mm', p: 18000, e: 1, s: 45 },
  { d: 'Rallonge 4 prises locale', p: 2500, e: 12, s: 144 },
  { d: 'Rallonge 5 trous local', p: 3000, e: 12, s: 108 },
  { d: 'Rallonge ingelec usb 3T', p: 4500, e: 10, s: 80 },
  { d: 'Rallonge Ingelec usb 4T', p: 5500, e: 10, s: 70 },
  { d: 'Rallonge Ingelec USB 5T', p: 6500, e: 10, s: 60 },
  { d: 'Rallonge noir/blanc simple', p: 2000, e: 12, s: 132 },
  { d: 'Multiprise', p: 3500, e: 12, s: 96 },
  { d: 'Stabilisateur digital 1000w', p: 28000, e: 1, s: 18 },
  { d: 'Voltometre', p: 4500, e: 10, s: 40 },
  { d: 'Cadenas local 65 mm', p: 2500, e: 12, s: 144 },
  { d: 'Fer a repasser RAF 2003', p: 9500, e: 6, s: 48 },
  { d: 'Fer a repasser raf r.11290b', p: 11000, e: 6, s: 36 },
  { d: 'Fer a repasser raf r.1808b', p: 12500, e: 6, s: 30 },
  { d: 'Fer a repasser MNI', p: 8500, e: 6, s: 54 },
  { d: 'Fer repasser mni-8018M', p: 9000, e: 6, s: 42 },
  { d: 'Rechaud plaque 500 W', p: 6500, e: 6, s: 60 },
  { d: 'Rechaud plaque 1000w', p: 8500, e: 6, s: 48 },
  { d: 'Rechaud plaque 1500w plat', p: 11000, e: 6, s: 36 },
  { d: 'Rechaud plaque digital', p: 15000, e: 4, s: 24 },
  { d: 'Rechaud plaque jaune', p: 7500, e: 6, s: 42 },
  { d: 'Rechaud plaque manche 1 feux', p: 7000, e: 6, s: 54 },
  { d: 'Rechaud grillage 1 feux manche', p: 6500, e: 6, s: 66 },
  { d: 'Rechaud grillage 2 feux manche', p: 11500, e: 4, s: 32 },
  { d: 'Rechaud grillage 1000w hote plat', p: 13000, e: 4, s: 28 },
  { d: 'Rechaud vitre 3 feux', p: 45000, e: 1, s: 14 },
  { d: 'Rechaud 1 feu vitre', p: 18000, e: 2, s: 22 },
  { d: 'Rechaud 4 feux petit noir', p: 52000, e: 1, s: 10 },
  { d: 'Rechaud aygaz 2 feux', p: 22000, e: 2, s: 20 },
  { d: 'Rechaud aygaz 3 feux', p: 32000, e: 1, s: 16 },
  { d: 'Rechaud tole 2 feux', p: 9500, e: 4, s: 40 },
  { d: 'Rechaud plat petit yq-105', p: 5500, e: 6, s: 72 },
  { d: 'Rechaud starlux 2 feux noir petit', p: 24000, e: 2, s: 18 },
  { d: 'Tete de gaz original', p: 8500, e: 12, s: 96 },
  { d: 'Tete de gaz local', p: 4500, e: 12, s: 120 },
  { d: 'Ventilateur CY 16 pouce', p: 18000, e: 2, s: 32 },
  { d: 'Ventilateur 12 pouce en fer CY', p: 15000, e: 4, s: 40 },
  { d: 'Ventilateur plafond', p: 26000, e: 1, s: 20 },
  { d: 'Ventilateur chargeable CY 18 pouce', p: 35000, e: 1, s: 14 },
  { d: 'Ventilo plastic sonox 18 pouces', p: 21000, e: 2, s: 24 },
  { d: 'Mixeur fruit', p: 14000, e: 4, s: 28 },
  { d: 'Micro-Onde', p: 65000, e: 1, s: 8 },
  { d: 'Machine a laver 9kg', p: 185000, e: 1, s: 5 },
  { d: 'Machine a crepe', p: 6500, e: 10, s: 60 },
  { d: 'Cafetiere en fer', p: 7500, e: 6, s: 48 },
  { d: 'Thermos EN-320 3litre', p: 9500, e: 6, s: 36 },
  { d: 'Balance camry 20kg', p: 12000, e: 4, s: 24 },
  { d: 'Balance numerique 40kg', p: 22000, e: 2, s: 16 },
  { d: 'Balance a crochet 100kg', p: 15000, e: 4, s: 20 },
  { d: 'Tondeuse raf R.808', p: 11000, e: 6, s: 30 },
  { d: 'Friteuse raf 3litre', p: 28000, e: 2, s: 12 },
  { d: 'Balai plastique gros', p: 1500, e: 12, s: 180 },
  { d: 'Balai plastique avec fer', p: 2000, e: 12, s: 144 },
  { d: 'Balai brosse', p: 2500, e: 12, s: 120 },
  { d: 'Petit balai', p: 800, e: 24, s: 240 },
  { d: 'Brosse WC simple', p: 1200, e: 24, s: 168 },
  { d: 'Raclette en fer', p: 2000, e: 50, s: 200 },
  { d: 'Raclette simple', p: 1000, e: 50, s: 300 },
  { d: 'Seau serpilliere grand', p: 4500, e: 6, s: 54 },
  { d: 'Ramassette', p: 1200, e: 24, s: 192 },
  { d: 'Pelle verte', p: 1500, e: 12, s: 96 },
  { d: 'Rouleau papier verre 80', p: 15000, e: 1, s: 48 },
  { d: 'Rouleau papier 120', p: 16000, e: 1, s: 42 },
  { d: 'Rouleau a peinture grand', p: 3500, e: 12, s: 72 },
  { d: 'Taloche noire', p: 2500, e: 12, s: 84 },
  { d: 'Colle 99 - 1 kg', p: 4500, e: 12, s: 96 },
  { d: 'Pointe ordinaire', p: 18000, e: 1, s: 55 },
  { d: 'Pointe pour tole', p: 22000, e: 1, s: 38 },
  { d: 'Casque macon', p: 5500, e: 10, s: 60 },
  { d: 'Cle 1 cote', p: 2500, e: 20, s: 140 },
  { d: 'Carreaux 50x50', p: 6500, e: 1, s: 320 },
  { d: 'Carreau 60x60', p: 8500, e: 1, s: 245 },
  { d: 'Fixer dvd gros', p: 2000, e: 10, s: 170 },
  { d: 'Fixeur DVD petit', p: 1200, e: 20, s: 260 },
  { d: 'Fixer tv gros', p: 4500, e: 10, s: 80 },
  { d: 'Decodeur TNT', p: 15000, e: 4, s: 36 },
  { d: 'Telecommande TNT', p: 2500, e: 20, s: 120 },
  { d: 'Antenne bleu', p: 3500, e: 10, s: 90 },
  { d: 'Radio CY moyen', p: 8500, e: 6, s: 42 },
  { d: 'Table vitree simple', p: 17000, e: 1, s: 33 },
  { d: 'Table marbre salon', p: 85000, e: 1, s: 6 },
  { d: 'Impermeable', p: 3500, e: 12, s: 108 },
];

/**
 * Le catalogue prêt à charger : désignation, prix, emballage, catégorie.
 *
 * La quantité d'origine reste à part : elle ne sert qu'à déclarer le
 * stock de départ, et le chargement des produits ne doit rien en savoir.
 */
export function catalogueReprise(): ProduitRepris[] {
  return CATALOGUE.map(x => ({
    designation: x.d,
    prix: x.p,
    parEmballage: x.e,
    stock: x.s,
    categorie: categorieDe(x.d),
  }));
}

/** Les quantités d'origine, par désignation, pour le stock de départ. */
export function quantitesReprise(
  marge = 70,
): Map<string, { quantite: number; cout: number; prix: number }> {
  const m = new Map<string, { quantite: number; cout: number; prix: number }>();
  for (const x of CATALOGUE) {
    if (x.s <= 0) continue;
    /* L'ancienne base ne portait que le prix de vente. Sans coût, toute
       vente paraîtrait pur bénéfice : on en pose un, en disant qu'on le
       pose. */
    m.set(x.d.toLowerCase(), {
      quantite: x.s,
      cout: Math.round(x.p * marge / 100),
      prix: x.p,
    });
  }
  return m;
}

/**
 * Le code-barres interne d'un produit.
 *
 * Même forme que celui de la fiche produit — préfixe 200, réservé aux
 * usages internes, et une clé de contrôle EAN-13 pour qu'une douchette
 * l'accepte.
 */
function genererCodeBarre(): string {
  const base = '200' + Array.from({ length: 9 },
    () => Math.floor(Math.random() * 10)).join('');
  const somme = base.split('').reduce(
    (s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return base + ((10 - (somme % 10)) % 10);
}

/** Une activité a-t-elle déjà des produits ? */
export async function aDesProduits(activiteId: string): Promise<boolean> {
  const snap = await getDocs(query(
    collection(db, 'produits'),
    where('activiteId', '==', activiteId)));
  return !snap.empty;
}

/** Ce que le site détient déjà, pour ne pas reprendre deux fois. */
export async function produitsDeLActivite(
  activiteId: string,
): Promise<{ id: string; designation: string }[]> {
  const snap = await getDocs(query(
    collection(db, 'produits'),
    where('activiteId', '==', activiteId)));
  return snap.docs.map(d => ({
    id: d.id,
    designation: (d.data() as any).designation ?? '',
  }));
}

/* Firestore refuse un lot de plus de 500 écritures. */
const LOT = 200;

/**
 * Créer les produits d'une activité, rayons à zéro.
 *
 * Le produit appartient à la maison : une détention s'ouvre dans chacun de
 * ses sites, vide. C'est ce qui permet à un site de recevoir un transfert
 * d'une marchandise qu'il n'a jamais achetée.
 */
export async function chargerCatalogue(params: {
  activiteId: string;
  siteIds: string[];
  userId: string;
  produits: ProduitRepris[];
}): Promise<{ crees: number }> {
  if (params.produits.length === 0) return { crees: 0 };

  let crees = 0;
  for (const p of params.produits) {
    const refProduit = await addDoc(collection(db, 'produits'), {
      /* Les mêmes champs que la fiche produit de l'app écrit elle-même :
         un import qui en oublie un laisse des produits que les écrans
         lisent à moitié. */
      userId: params.userId,
      activiteId: params.activiteId,
      designation: p.designation,
      /* Sans code-barres, le comptoir ne peut pas scanner. */
      codeBarre: genererCodeBarre(),
      categorie: p.categorie,
      /* Tout se compte à la pièce : l'ancienne base ne portait pas
         d'unité, et ce métier ne vend ni au poids ni au mètre. */
      unite: 'pièce',
      emballages: p.parEmballage > 1
        ? [{ nom: 'Carton', quantite: p.parEmballage }]
        : [],
      caracteristiques: [],
      variantes: [],
      actif: true,
      createdAt: serverTimestamp(),
    });

    const batch = writeBatch(db);
    for (const s of params.siteIds) {
      batch.set(doc(collection(db, 'produits_site')), {
        produitId: refProduit.id,
        siteId: s,
        userId: params.userId,
        /* Rien en rayon : la marchandise entrera par un dossier confirmé. */
        stock: 0,
        coutMoyen: 0,
        prixVente: p.prix,
        seuilAlerte: null,
        variantes: [],
        createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
    crees += 1;
  }

  return { crees };
}

/**
 * Déclarer le stock de départ de tout le catalogue, en un dossier.
 *
 * Un seul dossier plutôt qu'un par produit : le responsable des commandes
 * parcourt son rayon une fois, pas trois cents. Il reste en « Déclaré »
 * jusqu'à ce qu'il aille compter.
 */
export async function declarerStockInitial(params: {
  siteId: string;
  /** les quantités d'origine, par désignation */
  quantites: Map<string, { quantite: number; cout: number; prix: number }>;
  produits: { id: string; designation: string }[];
  parUid: string;
  parNom?: string | null;
}): Promise<{ id: string; lignes: number } | null> {
  const lignes = params.produits
    .map(p => {
      const q = params.quantites.get(p.designation.toLowerCase());
      if (!q || q.quantite <= 0) return null;
      return {
        produitId: p.id,
        varianteCle: null,
        designation: p.designation,
        unite: 'pièce',
        quantiteDeclaree: q.quantite,
        /* Le constat viendra du rayon, pas de l'import. */
        quantiteConstatee: null,
        emballage: null,
        cout: q.cout,
        prixVente: q.prix,
      };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);

  if (lignes.length === 0) return null;

  const date = new Date().toISOString().slice(0, 10);
  const ref = await addDoc(collection(db, 'ajustements'), {
    siteId: params.siteId,
    reference: `M-${date.replace(/-/g, '')}-DEPART`,
    etat: 'declare',
    motif: 'stock_initial',
    sens: 'entree',
    date,
    lignes,
    note: `Stock de départ : ${lignes.length} produit(s).`,
    parUid: params.parUid,
    parNom: params.parNom ?? null,
    confirmeParUid: null,
    confirmeParNom: null,
    confirmeA: null,
    createdAt: serverTimestamp(),
  });

  return { id: ref.id, lignes: lignes.length };
}
