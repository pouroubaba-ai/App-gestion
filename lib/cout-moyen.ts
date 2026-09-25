/**
 * Le coût moyen se déduit, il ne se stocke pas.
 *
 * Il était recopié sur la détention à chaque entrée : on lisait le stock et
 * le coût courants, on calculait, on réécrivait. Chaque calcul partait donc
 * du résultat du précédent — et d'un stock qui, lui, bouge à chaque sortie.
 *
 * Une sortie ne repondère pas le coût, mais elle change la base du calcul
 * suivant. Vendre 8 sur 10 puis acheter 10 à 7 000 ne donne pas le même
 * coût que d'acheter 10 à 7 000 sans avoir rien vendu. Si cette sortie
 * n'est pas encore partie — coupure réseau, second appareil, purge qui a
 * remis le coût à zéro en laissant les mouvements — l'entrée se calcule sur
 * un stock faux, et l'erreur se propage à toutes les suivantes sans que
 * rien ne la signale.
 *
 * Ici, on rejoue les mouvements dans l'ordre. Le résultat est identique à
 * la règle d'avant — seules les entrées repondèrent, la moyenne reste
 * glissante — mais il ne dépend plus de ce qui a été écrit avant, ni de
 * l'ordre d'arrivée des écritures.
 *
 * `coutMoyenAlors`, lui, reste figé sur chaque sortie : c'est ce que la
 * marchandise coûtait au moment du geste, et c'est ce qui permet de dire la
 * marge d'une vente passée. Un fait, pas une déduction.
 */
import { coutMoyenApresEntree } from '@/lib/mouvements';

/** Un mouvement, réduit à ce qui pèse sur le stock et le coût. */
export interface MouvementCout {
  produitId: string;
  varianteCle?: string | null;
  sens: 'entree' | 'sortie';
  quantiteUnites: number;
  /** La valeur de la ligne entière : la seule qui vaille dans les deux
      conventions d'écriture — l'emballage ici, l'unité de base là. */
  valeurTotale?: number;
  valeurUnitaire?: number;
  date?: string | null;
  createdAt?: any;
}

/** Ce qu'un produit — ou une de ses variantes — vaut et pèse. */
export interface EtatStock {
  stock: number;
  coutMoyen: number;
}

/** La clé d'un rayon : un produit, ou l'une de ses déclinaisons. */
function cle(m: { produitId: string; varianteCle?: string | null }): string {
  return `${m.produitId}::${m.varianteCle ?? ''}`;
}

/**
 * L'ordre du temps.
 *
 * `createdAt` dit quand l'écriture a été faite, `date` quand le geste a eu
 * lieu. Hors ligne, la seconde est saisie par l'utilisateur et la première
 * n'existe qu'au retour du réseau : on suit la date du geste, et
 * l'horodatage ne sert qu'à départager deux gestes du même jour.
 */
function ordonner(a: MouvementCout, b: MouvementCout): number {
  const da = a.date ?? '';
  const dbb = b.date ?? '';
  if (da !== dbb) return da.localeCompare(dbb);
  const ta = a.createdAt?.seconds ?? 0;
  const tb = b.createdAt?.seconds ?? 0;
  return ta - tb;
}

/**
 * Rejoue les mouvements d'un site et rend l'état de chaque rayon.
 *
 * La clé est `produitId::varianteCle` : un produit sans variante en a une
 * seule, vide. Un produit à variantes tient son stock par déclinaison, et
 * le total n'est que leur somme.
 */
export function etatsDepuisMouvements(
  mouvements: MouvementCout[],
): Map<string, EtatStock> {
  const etats = new Map<string, EtatStock>();

  for (const m of [...mouvements].sort(ordonner)) {
    const q = m.quantiteUnites ?? 0;
    if (q <= 0) continue;

    const k = cle(m);
    const e = etats.get(k) ?? { stock: 0, coutMoyen: 0 };

    if (m.sens === 'entree') {
      /* La valeur de la ligne divisée par ses unités : c'est le coût réel
         d'une unité de base, quelle que soit la façon dont la ligne a été
         écrite. */
      const valeur = m.valeurTotale ?? (m.valeurUnitaire ?? 0) * q;
      const coutUnite = valeur / q;
      e.coutMoyen = coutMoyenApresEntree(e.stock, e.coutMoyen, q, coutUnite);
      e.stock += q;
    } else {
      /* Une sortie ne repondère rien : elle retire, c'est tout. */
      e.stock -= q;
    }

    etats.set(k, e);
  }

  return etats;
}

/** L'état d'un rayon, sans avoir à tester sa présence. */
export function etatDe(
  etats: Map<string, EtatStock>,
  produitId: string,
  varianteCle?: string | null,
): EtatStock {
  return etats.get(cle({ produitId, varianteCle })) ?? { stock: 0, coutMoyen: 0 };
}

/**
 * L'état d'un produit entier : ses variantes réunies.
 *
 * Le stock s'additionne ; le coût moyen se pondère par les quantités — la
 * moyenne des moyennes serait fausse dès que les volumes diffèrent.
 */
export function etatDuProduit(
  etats: Map<string, EtatStock>,
  produitId: string,
  variantes: { cle: string }[],
): EtatStock {
  if (variantes.length === 0) return etatDe(etats, produitId, null);

  let stock = 0;
  let valeur = 0;
  for (const v of variantes) {
    const e = etatDe(etats, produitId, v.cle);
    stock += e.stock;
    valeur += e.stock * e.coutMoyen;
  }
  return { stock, coutMoyen: stock > 0 ? Math.round(valeur / stock) : 0 };
}
