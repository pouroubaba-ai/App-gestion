import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { produitsDuSite } from './produits-site';
import { chargerLignesDuSite, type LigneVente } from './lignes-vente';
import { chargerPreparationsDuSite, prepareParLigne } from './preparations';

/**
 * Ce qui manque pour honorer ce qui est promis.
 *
 * Le besoin ne se lit nulle part : il se calcule. Promis d'un cote, stock de
 * l'autre, et la difference dit ce qu'il faut racheter.
 *
 * Tout se compte en unites de base. Trois cartons et cinq pieces ne
 * s'additionnent pas — c'est la contenance figee sur chaque ligne qui les
 * ramene a la meme echelle.
 */

/** Les etats ou la marchandise est promise mais pas encore sortie. */
const ETATS_FERMES = ['commande', 'preparation', 'pret'] as const;

export interface BesoinProduit {
  produitId: string;
  designation: string;
  /** promis par les commandes fermes, en unites */
  commande: number;
  /** promis par les devis encore ouverts, en unites */
  devis: number;
  /** deja sorti du magasin pour ces commandes, en unites */
  prepare: number;
  /** ce qui reste a prelever : commande moins prepare */
  resteAPrelever: number;
  stock: number;
  /** stock moins ce qui est deja promis ailleurs */
  disponible: number;
  /** ce qu'il faut racheter pour honorer les commandes fermes */
  manque: number;
  /** ce qu'il faudrait en plus si tous les devis etaient acceptes */
  manqueAvecDevis: number;
}

interface EtatVente {
  etat: string;
  /* un devis transforme a deja sa commande : le compter serait promettre
     deux fois la meme marchandise */
  accepte?: boolean;
}

/**
 * Le besoin par produit sur tout un site.
 *
 * Trois lectures : les lignes promises, l'etat de leurs ventes, et les
 * produits pour leur stock. Les preparations disent ce qui est deja sorti.
 */
export async function besoinsDuSite(siteId: string): Promise<BesoinProduit[]> {
  const [lignes, ventesSnap, produitsSnap, preparations] = await Promise.all([
    chargerLignesDuSite(siteId),
    getDocs(query(collection(db, 'ventes'), where('siteId', '==', siteId))),
    produitsDuSite(siteId),
    chargerPreparationsDuSite(siteId).catch(() => new Map()),
  ]);

  const etats = new Map<string, EtatVente>();
  for (const d of ventesSnap.docs) {
    const v = d.data();
    etats.set(d.id, { etat: v.etat, accepte: v.accepte === true });
  }

  /* Ce qui a ete preleve, par vente et par ligne. */
  const prepareParVente = new Map<string, Record<number, number>>();
  preparations.forEach((liste, venteId) => {
    prepareParVente.set(venteId, prepareParLigne(liste));
  });

  const parProduit = new Map<string, BesoinProduit>();
  function entree(l: LigneVente): BesoinProduit {
    let e = parProduit.get(l.produitId);
    if (!e) {
      e = {
        produitId: l.produitId, designation: l.designation,
        commande: 0, devis: 0, prepare: 0, resteAPrelever: 0,
        stock: 0, disponible: 0, manque: 0, manqueAvecDevis: 0,
      };
      parProduit.set(l.produitId, e);
    }
    return e;
  }

  for (const l of lignes) {
    const v = etats.get(l.venteId);
    if (!v) continue;

    if (ETATS_FERMES.includes(v.etat as any)) {
      const e = entree(l);
      e.commande += l.quantiteUnites;
      /* Le prepare se compte dans l'unite de la ligne : il faut le convertir
         comme le reste. */
      const prep = prepareParVente.get(l.venteId)?.[l.ligneIndex] ?? 0;
      e.prepare += prep * (l.contenance || 1);
      continue;
    }

    /* Un devis accepte a donne une commande : elle porte deja la promesse. */
    if (v.etat === 'devis' && !v.accepte) {
      entree(l).devis += l.quantiteUnites;
    }
  }

  /* `produitsDuSite` a joint le produit et ce que ce site en detient :
     le stock est deja celui du site. */
  for (const d of produitsSnap) {
    const e = parProduit.get(d.id);
    if (e) {
      e.stock = d.stock ?? 0;
      if (!e.designation) e.designation = d.designation ?? '';
    }
  }

  for (const e of parProduit.values()) {
    /* Ce qui est deja sorti du magasin n'est plus a prelever. */
    e.resteAPrelever = Math.max(0, e.commande - e.prepare);
    /* Le stock porte encore ce qui est prepare mais pas livre : c'est cela
       qui est reserve. */
    e.disponible = e.stock - e.prepare;
    /* Le manque n'est pas ce qui n'est pas prepare : c'est ce qui n'existe
       pas. Une commande non preparee dont la marchandise est en magasin ne
       manque pas, il faut seulement aller la chercher. */
    e.manque = Math.max(0, e.resteAPrelever - e.disponible);
    e.manqueAvecDevis = Math.max(0, e.resteAPrelever + e.devis - e.disponible);
  }

  return [...parProduit.values()]
    .sort((a, b) => b.manque - a.manque || a.designation.localeCompare(b.designation));
}
