import {
  collection, addDoc, doc, updateDoc, getDoc, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ouvrirDetention, type VarianteSite } from '@/lib/produits-site';

export type SensMouvement = 'entree' | 'sortie';

export type MotifEntree = 'stock_initial' | 'achat' | 'transfert' | 'retour_client' | 'reajustement';
export type MotifSortie = 'vente' | 'transfert' | 'retour_fournisseur' | 'perte' | 'reajustement';

export interface Mouvement {
  id: string;
  siteId: string;
  produitId: string;
  /** clé de la variante concernée, absente si le produit n'en a pas */
  varianteCle?: string | null;
  sens: SensMouvement;
  motif: string;
  date: string;
  /** quantité telle que saisie, dans l'emballage choisi */
  quantite: number;
  emballage?: string | null;
  /** quantité convertie en unités de base : c'est elle qui bouge le stock */
  quantiteUnites: number;
  /** coût unitaire pour une entrée, prix unitaire pour une sortie */
  valeurUnitaire: number;
  /** valeurUnitaire × quantiteUnites */
  valeurTotale: number;
  /**
   * Sorties uniquement : figé à l'instant de la vente.
   * Un achat ultérieur change le coût moyen ; sans ce figeage,
   * le bénéfice des ventes passées serait réécrit rétroactivement.
   */
  coutMoyenAlors?: number;
  benefice?: number;
  partenaireId?: string | null;
  partenaireNom?: string | null;
  /** site d'origine ou de destination pour un transfert */
  siteLieId?: string | null;
  /** facture ou bon auquel la ligne appartient */
  documentId?: string | null;
  /* Qui a fait le geste, recopié à l'instant où il a lieu : la fiche de
     l'employé changera, l'archive doit rester vraie. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  createdAt?: any;
}

interface Variante {
  cle: string;
  stock: number;
  coutMoyen: number;
  [k: string]: any;
}

/**
 * Nouveau coût moyen pondéré après une entrée.
 * (ancien stock × ancien coût + entrée × coût d'entrée) ÷ stock total.
 * Un stock nul ou négatif ne peut pas pondérer : on prend le coût d'entrée.
 */
export function coutMoyenApresEntree(
  stockActuel: number, coutActuel: number,
  quantiteEntree: number, coutEntree: number,
): number {
  if (quantiteEntree <= 0) return coutActuel;
  if (stockActuel <= 0) return coutEntree;
  return Math.round(
    (stockActuel * coutActuel + quantiteEntree * coutEntree) / (stockActuel + quantiteEntree)
  );
}

/** Convertit une quantité exprimée dans un emballage en unités de base. */
export function enUnitesBase(
  quantite: number, nomEmballage: string | null | undefined,
  emballages: { nom: string; quantite: number }[],
): number {
  if (!nomEmballage) return quantite;
  const emb = emballages.find(e => e.nom === nomEmballage);
  return quantite * (emb ? emb.quantite : 1);
}

export interface SaisieMouvement {
  siteId: string;
  userId: string;
  produitId: string;
  varianteCle?: string | null;
  sens: SensMouvement;
  motif: string;
  date: string;
  quantite: number;
  emballage?: string | null;
  valeurUnitaire: number;
  partenaireId?: string | null;
  partenaireNom?: string | null;
  siteLieId?: string | null;
  documentId?: string | null;
  /* Qui fait le geste : son nom et sa fonction se figent sur le mouvement,
     la fiche de l'employé pourra changer sans réécrire l'archive. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}

/**
 * Enregistre un mouvement et met à jour le produit dans la foulée.
 * Une entrée recalcule le coût moyen ; une sortie fige le bénéfice.
 * Tout passe par un lot d'écritures : soit les deux réussissent, soit aucune.
 */
export async function enregistrerMouvement(saisie: SaisieMouvement): Promise<Mouvement> {
  const refProduit = doc(db, 'produits', saisie.produitId);
  const snap = await getDoc(refProduit);
  if (!snap.exists()) throw new Error('Produit introuvable');
  const produit = snap.data();

  const emballages = produit.emballages ?? [];
  const qteUnites = enUnitesBase(saisie.quantite, saisie.emballage, emballages);
  const signe = saisie.sens === 'entree' ? 1 : -1;

  /* Le produit dit ce qu'est la marchandise, la détention ce que CE site
     en a : le stock appartient au site, jamais à l'activité. */
  const detentionId = await ouvrirDetention({
    produitId: saisie.produitId, siteId: saisie.siteId, userId: saisie.userId,
  });
  const refDetention = doc(db, 'produits_site', detentionId);
  const detention = ((await getDoc(refDetention)).data() ?? {}) as any;
  const variantesSite: VarianteSite[] = detention.variantes ?? [];

  const variante = saisie.varianteCle
    ? variantesSite.find(v => v.cle === saisie.varianteCle)
    : undefined;
  const stockAvant = variante ? variante.stock : (detention.stock ?? 0);
  const coutAvant = variante ? variante.coutMoyen : (detention.coutMoyen ?? 0);

  const nouveauCout = saisie.sens === 'entree'
    ? coutMoyenApresEntree(stockAvant, coutAvant, qteUnites, saisie.valeurUnitaire)
    : coutAvant;
  const nouveauStock = stockAvant + signe * qteUnites;

  const mouvement: Omit<Mouvement, 'id'> = {
    siteId: saisie.siteId,
    produitId: saisie.produitId,
    varianteCle: saisie.varianteCle ?? null,
    sens: saisie.sens,
    motif: saisie.motif,
    date: saisie.date,
    quantite: saisie.quantite,
    emballage: saisie.emballage ?? null,
    quantiteUnites: qteUnites,
    valeurUnitaire: saisie.valeurUnitaire,
    valeurTotale: saisie.valeurUnitaire * qteUnites,
    /* Un transfert déplace de la valeur sans la réaliser : ni bénéfice ni perte.
       Une perte détruit le stock : elle coûte son coût moyen.
       Une vente réalise la marge entre le prix obtenu et le coût moyen. */
    ...(saisie.sens === 'sortie' && saisie.motif !== 'transfert' ? {
      coutMoyenAlors: coutAvant,
      benefice: saisie.motif === 'perte'
        ? -coutAvant * qteUnites
        : (saisie.valeurUnitaire - coutAvant) * qteUnites,
    } : {}),
    partenaireId: saisie.partenaireId ?? null,
    partenaireNom: saisie.partenaireNom ?? null,
    siteLieId: saisie.siteLieId ?? null,
    documentId: saisie.documentId ?? null,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
    createdAt: serverTimestamp(),
  };

  const batch = writeBatch(db);
  const refMouvement = doc(collection(db, 'mouvements'));
  batch.set(refMouvement, { ...mouvement, userId: saisie.userId });

  if (saisie.varianteCle) {
    const connue = variantesSite.some(v => v.cle === saisie.varianteCle);
    const majVariantes: VarianteSite[] = connue
      ? variantesSite.map(v => v.cle === saisie.varianteCle
          ? { ...v, stock: nouveauStock, coutMoyen: nouveauCout }
          : v)
      : [...variantesSite, {
          cle: saisie.varianteCle, stock: nouveauStock, coutMoyen: nouveauCout,
        }];
    batch.update(refDetention, {
      variantes: majVariantes,
      stock: majVariantes.reduce((s, v) => s + (v.stock ?? 0), 0),
    });
  } else {
    batch.update(refDetention, { stock: nouveauStock, coutMoyen: nouveauCout });
  }

  await batch.commit();
  return { id: refMouvement.id, ...mouvement } as Mouvement;
}

/**
 * Mouvement d'ouverture posé à la création d'un produit.
 * Sans lui, le stock existerait sans qu'aucune entrée ne l'explique et la
 * différence entrées/sorties ne correspondrait plus au stock réel.
 * Le produit portant déjà son stock, on écrit seulement les mouvements.
 */
export async function enregistrerStockInitial(params: {
  siteId: string;
  userId: string;
  produitId: string;
  date: string;
  /** une ligne par variante, ou une seule ligne sans varianteCle */
  lignes: { varianteCle?: string | null; quantite: number; quantiteUnites: number; emballage?: string | null; cout: number }[];
  /* Qui déclare ce stock de départ : c'est un fait comme un autre. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}): Promise<void> {
  const aEcrire = params.lignes.filter(l => l.quantiteUnites > 0);
  if (aEcrire.length === 0) return;

  const batch = writeBatch(db);
  for (const l of aEcrire) {
    batch.set(doc(collection(db, 'mouvements')), {
      siteId: params.siteId,
      userId: params.userId,
      produitId: params.produitId,
      varianteCle: l.varianteCle ?? null,
      sens: 'entree',
      motif: 'stock_initial',
      date: params.date,
      quantite: l.quantite,
      emballage: l.emballage ?? null,
      quantiteUnites: l.quantiteUnites,
      valeurUnitaire: l.cout,
      valeurTotale: l.cout * l.quantiteUnites,
      partenaireId: null,
      partenaireNom: null,
      siteLieId: null,
      documentId: null,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      createdAt: serverTimestamp(),
    });
  }
  await batch.commit();
}
