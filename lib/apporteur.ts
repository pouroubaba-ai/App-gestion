import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from './firebase';

/**
 * Qui a amené un partenaire.
 *
 * À ne pas confondre avec l'auteur de la fiche : le comptable qui saisit dix
 * clients un lundi ne les a pas amenés. L'auteur est automatique et atteste
 * d'une saisie ; l'apporteur se déclare et atteste d'un apport.
 *
 * Il peut être un employé — sa fonction suit alors la sienne — ou quelqu'un
 * du dehors : un client qui en recommande un autre, une connaissance. Un
 * partenaire venu de lui-même n'en a pas, et ce n'est pas une donnée
 * manquante mais une information.
 *
 * `employeId` suffit à dire d'où il vient : présent, l'apporteur est interne ;
 * absent, il est externe. Stocker cette distinction en plus créerait un
 * second état à maintenir d'accord avec le premier.
 */

export interface Apporteur {
  /** l'employé qui a amené le partenaire ; absent s'il vient du dehors */
  employeId: string | null;
  nom: string;
  fonction: string;
}

export type SourceApport = 'interne' | 'externe' | 'aucun';

export function sourceDe(a: Apporteur | null | undefined): SourceApport {
  if (!a) return 'aucun';
  return a.employeId ? 'interne' : 'externe';
}

export const LIBELLES_SOURCE: Record<SourceApport, string> = {
  interne: 'Interne',
  externe: 'Externe',
  aucun: 'Sans apporteur',
};

/** Le nom de l'apporteur, ou ce qui en tient lieu. */
export function libelleApporteur(a: Apporteur | null | undefined): string {
  return a?.nom || 'Sans apporteur';
}

/** Les employés d'un site, pour le choix à la saisie. */
export interface EmployeChoix {
  id: string;
  nom: string;
  fonction: string;
}

export async function employesDuSite(
  siteId: string, userId: string,
): Promise<EmployeChoix[]> {
  const snap = await getDocs(query(
    collection(db, 'employes'),
    where('siteId', '==', siteId),
    where('userId', '==', userId)));

  return snap.docs
    .map(d => {
      const e = d.data();
      return { id: d.id, nom: e.nom ?? '—', fonction: e.fonction || 'Employé' };
    })
    .sort((a, b) => a.nom.localeCompare(b.nom));
}

/**
 * Ce que les partenaires d'un apporteur ont produit.
 *
 * C'est le rendement d'un portefeuille, pas l'activité de quelqu'un : peu
 * importe qui a tenu la caisse, ce qui compte est ce que ses tiers ont
 * rapporté.
 */
export interface StatApporteur {
  cle: string;
  nom: string;
  fonction: string;
  source: SourceApport;
  tiers: number;
  /* La plus récente opération parmi ses tiers, et ce qu'elle pesait :
     un portefeuille sans mouvement depuis six mois se repère ainsi. */
  derniere: string | null;
  derniereValeur: number;
  total: number;
  benefice: number;
  perte: number;
  verse: number;
  retour: number;
  reste: number;
}

/** Regroupe des lignes déjà agrégées par partenaire sous leur apporteur. */
export function parApporteur(
  lignes: {
    apporteur?: Apporteur | null;
    total: number; benefice: number; verse: number; retour: number; reste: number;
    derniere?: string | null; derniereValeur?: number;
  }[],
): StatApporteur[] {
  const map = new Map<string, StatApporteur>();

  for (const l of lignes) {
    const source = sourceDe(l.apporteur);
    /* Un apporteur se reconnaît à son employé quand il en est un, à son nom
       sinon : deux homonymes externes resteraient confondus, mais un nom est
       tout ce qu'on a d'eux. */
    const cle = l.apporteur?.employeId ?? l.apporteur?.nom ?? '—';

    const e = map.get(cle) ?? {
      cle,
      nom: libelleApporteur(l.apporteur),
      fonction: l.apporteur?.fonction ?? '',
      source,
      tiers: 0, derniere: null, derniereValeur: 0,
      total: 0, benefice: 0, perte: 0, verse: 0, retour: 0, reste: 0,
    };

    map.set(cle, {
      ...e,
      tiers: e.tiers + 1,
      /* La date la plus récente l'emporte ; le même jour se cumule, comme
         partout ailleurs. */
      derniere: !l.derniere ? e.derniere
        : !e.derniere || l.derniere > e.derniere ? l.derniere : e.derniere,
      derniereValeur: !l.derniere ? e.derniereValeur
        : !e.derniere || l.derniere > e.derniere ? (l.derniereValeur ?? 0)
        : l.derniere === e.derniere ? e.derniereValeur + (l.derniereValeur ?? 0)
        : e.derniereValeur,
      total: e.total + l.total,
      /* Bénéfice et perte se séparent : une marge négative noyée dans un
         total positif ne se voit plus. */
      benefice: e.benefice + Math.max(0, l.benefice),
      perte: e.perte + Math.min(0, l.benefice),
      verse: e.verse + l.verse,
      retour: e.retour + l.retour,
      reste: e.reste + l.reste,
    });
  }

  /* Les plus gros portefeuilles d'abord : c'est là que se joue l'essentiel. */
  return [...map.values()].sort((a, b) => b.total - a.total);
}
