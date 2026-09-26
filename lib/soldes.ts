import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { valeurRecue, valeurVente } from './flux-marchandise';
import { lireParSite, type Portee } from '@/lib/portee';

/**
 * Ce que chaque tiers doit, déduit et non stocké.
 *
 * La dette d'un fournisseur était écrite sur sa fiche à la confirmation d'un
 * achat. Ce nombre vivait ensuite seul : supprimer l'achat le laissait
 * intact, et rien ne signalait qu'il ne correspondait plus à rien. Le même
 * piège guettait la créance, le versé et le reste.
 *
 * Une dette est la somme des restes des documents non soldés. Cette somme
 * existe déjà dans les documents ; l'en recopier ailleurs crée une seconde
 * vérité qui finit par diverger de la première. On la calcule.
 *
 * Toutes les vues — cartes comme tableaux — passent par ici : deux calculs
 * parallèles finiraient par afficher deux chiffres différents.
 */

export type RoleTiers = 'client' | 'fournisseur';

export interface SoldeTiers {
  partenaireId: string;
  /** valeur de ce qui a été reçu ou livré */
  total: number;
  /**
   * Ce qui a été versé là-dessus : de l'argent, et rien d'autre.
   *
   * Un retour de marchandise éteint une dette sans qu'un franc ne
   * circule. Le compter ici ferait croire que le tiers a payé, et l'on
   * réclamerait moins qu'on n'a encaissé.
   */
  verse: number;
  /** ce que la marchandise rendue a éteint, sans argent */
  retour: number;
  /** ce qui reste dû ; jamais négatif */
  reste: number;
  /** la date du dernier document, pour dire si le compte est encore vivant */
  derniereOperation: string | null;
  /* Ce que pesait ce jour-là : une date seule ne dit pas si l'opération
     comptait. Plusieurs dossiers du même jour se cumulent — sans heure sur
     les dossiers, le jour est la plus petite unité qu'on puisse départager. */
  derniereValeur: number;
  /** nombre de documents non soldés */
  ouverts: number;
}

export interface SoldesParRole {
  fournisseur: Map<string, SoldeTiers>;
  client: Map<string, SoldeTiers>;
}

function vide(partenaireId: string): SoldeTiers {
  return {
    partenaireId, total: 0, verse: 0, retour: 0, reste: 0,
    derniereOperation: null, derniereValeur: 0, ouverts: 0,
  };
}

/**
 * Un achat ne pèse sur la dette qu'une fois confirmé : tant que la
 * marchandise n'est pas reçue, on ne doit rien. Une vente pareillement, à la
 * livraison.
 */
function conclu(doc: any, role: RoleTiers): boolean {
  return role === 'fournisseur'
    ? doc.etat === 'confirme'
    : doc.etat === 'livre';
}

function cumuler(
  cible: Map<string, SoldeTiers>,
  partenaireId: string,
  total: number,
  verse: number,
  date: string | null,
  retour = 0,
) {
  const e = cible.get(partenaireId) ?? vide(partenaireId);
  /* Les deux éteignent la dette, mais on ne les confond pas : l'un est
     de l'argent reçu, l'autre de la marchandise revenue. */
  const reste = Math.max(0, total - verse - retour);
  /* Le payé est borné à ce qui couvre encore cette facture.
   *
   * Versé 15 000 puis rendu pour 10 000 sur une facture de 20 000 : les
   * deux additionnés font 25 000, et la carte annonçait plus que le
   * total. Les 5 000 de trop ont été remboursés ou reportés sur
   * d'anciennes dettes — ils ne sont plus sur cette facture, mais cette
   * carte-ci ne peut pas savoir où ils sont allés.
   *
   * On borne donc le payé, pas le retour : la marchandise rendue est un
   * fait entier, tandis que l'argent, lui, a pu repartir. Rien n'est
   * caché pour autant — le remboursement laisse un mouvement de caisse,
   * la répartition laisse des versements sur les factures qu'elle a
   * éteintes. Ils se lisent là où ils sont, pas ici. */
  const verseVu = Math.min(verse, Math.max(0, total - retour));
  cible.set(partenaireId, {
    partenaireId,
    total: e.total + total,
    verse: e.verse + verseVu,
    retour: e.retour + retour,
    reste: e.reste + reste,
    derniereOperation: !date ? e.derniereOperation
      : !e.derniereOperation || date > e.derniereOperation ? date : e.derniereOperation,
    derniereValeur: !date ? e.derniereValeur
      : !e.derniereOperation || date > e.derniereOperation ? total
      : date === e.derniereOperation ? e.derniereValeur + total
      : e.derniereValeur,
    ouverts: e.ouverts + (reste > 0 ? 1 : 0),
  });
}

/** Les soldes de tous les tiers d'un site, des deux côtés. */
export async function soldesDuSite(siteId: Portee): Promise<SoldesParRole> {
  const [achDocs, venDocs, parRetour] = await Promise.all([
    lireParSite('achats', siteId),
    lireParSite('ventes', siteId),
    retoursParDossier(siteId),
  ]);

  const fournisseur = new Map<string, SoldeTiers>();
  const client = new Map<string, SoldeTiers>();

  for (const d of achDocs) {
    const a = d.data() as any;
    if (!a.fournisseurId || !conclu(a, 'fournisseur')) continue;
    /* `avanceVersee` ne porte que de l'argent : un retour n'y entre
       plus. Le retirer une seconde fois le comptait deux fois. */
    const parRet = parRetour.get(d.id) ?? 0;
    cumuler(fournisseur, a.fournisseurId,
      valeurRecue(a.lignes ?? []),
      a.avanceVersee ?? 0,
      a.dateConfirmation ?? a.dateReception ?? a.dateCommande ?? null,
      parRet);
  }

  for (const d of venDocs) {
    const v = d.data() as any;
    if (!v.clientId || !conclu(v, 'client')) continue;
    const parRet = parRetour.get(d.id) ?? 0;
    cumuler(client, v.clientId,
      valeurVente(v.lignes ?? []),
      v.avanceVersee ?? 0,
      v.dateLivraison ?? v.dateCommande ?? null,
      parRet);
  }

  return { fournisseur, client };
}

/**
 * Ce qu'un retour a imputé sur chaque dossier.
 *
 * Le versement porte le motif `retour_marchandise` : c'est lui qui
 * distingue une dette éteinte par de la marchandise d'une dette éteinte
 * par de l'argent. Sans cette lecture, les deux se ressemblent dans
 * `avanceVersee` et l'écran annonce un encaissement qui n'a pas eu lieu.
 */
async function retoursParDossier(siteId: Portee): Promise<Map<string, number>> {
  const parDossier = new Map<string, number>();
  try {
    const docs = await lireParSite('versements', siteId);
    for (const d of docs) {
      const v = d.data() as any;
      if (v.motif !== 'retour_marchandise') continue;
      const cle = v.achatId ?? v.venteId;
      if (!cle) continue;
      parDossier.set(cle, (parDossier.get(cle) ?? 0) + (v.montant ?? 0));
    }
  } catch {
    /* Sans les versements on ne sait pas séparer : mieux vaut un versé
       trop large qu'un écran vide. Le reste dû, lui, reste juste. */
  }
  return parDossier;
}

/**
 * Ce qui reste dû, vente par vente, avec la date de chacune.
 *
 * Le total des créances dit ce que les tiers doivent en tout. Sur un
 * tableau de bord filtré, la question est autre : des ventes de cette
 * période, combien reste-t-il à encaisser ? Les deux chiffres diffèrent,
 * et les confondre faisait afficher « Ventes 0 · À encaisser 16 000 »
 * pour une journée sans la moindre vente.
 *
 * Un retour de marchandise éteint la dette sans qu'un franc ne rentre :
 * il est retiré du versé ailleurs, mais ici il réduit bien le reste — ce
 * qui n'est plus dû n'est plus à encaisser.
 */
export async function restesDesVentes(
  siteId: Portee,
): Promise<{ date: string | null; reste: number; siteId: string | null }[]> {
  const docs = await lireParSite('ventes', siteId);
  return docs
    .map(d => {
      const v = d.data() as any;
      if (!conclu(v, 'client')) return null;
      const total = valeurVente(v.lignes ?? []);
      return {
        date: v.dateLivraison ?? v.dateCommande ?? null,
        reste: Math.max(0, total - (v.avanceVersee ?? 0)),
        siteId: v.siteId ?? null,
      };
    })
    .filter((x): x is { date: string | null; reste: number; siteId: string | null } =>
      x !== null && x.reste > 0);
}

/** Le solde d'un seul tiers, quand la page n'en affiche qu'un. */
export async function soldeTiers(
  siteId: string, partenaireId: string, role: RoleTiers,
): Promise<SoldeTiers> {
  const champ = role === 'fournisseur' ? 'fournisseurId' : 'clientId';
  const snap = await getDocs(query(
    collection(db, role === 'fournisseur' ? 'achats' : 'ventes'),
    where('siteId', '==', siteId),
    where(champ, '==', partenaireId)));

  const parRetour = await retoursParDossier(siteId);

  const cible = new Map<string, SoldeTiers>();
  for (const d of snap.docs) {
    const x = d.data() as any;
    if (!conclu(x, role)) continue;
    /* Même partage que sur la liste : l'argent d'un côté, la
       marchandise rendue de l'autre. */
    const parRet = parRetour.get(d.id) ?? 0;
    cumuler(cible, partenaireId,
      role === 'fournisseur' ? valeurRecue(x.lignes ?? []) : valeurVente(x.lignes ?? []),
      x.avanceVersee ?? 0,
      role === 'fournisseur'
        ? (x.dateConfirmation ?? x.dateReception ?? x.dateCommande ?? null)
        : (x.dateLivraison ?? x.dateCommande ?? null),
      parRet);
  }
  return cible.get(partenaireId) ?? vide(partenaireId);
}

/** Ce que porte un tiers dans un rôle, sans avoir à tester la présence. */
export function soldeDe(
  soldes: SoldesParRole, partenaireId: string, role: RoleTiers,
): SoldeTiers {
  return (role === 'fournisseur' ? soldes.fournisseur : soldes.client)
    .get(partenaireId) ?? vide(partenaireId);
}

/** Le total d'un côté, pour les cartes de tête. */
export function totalRole(soldes: SoldesParRole, role: RoleTiers) {
  const m = role === 'fournisseur' ? soldes.fournisseur : soldes.client;
  const liste = [...m.values()];
  return {
    total: liste.reduce((n, s) => n + s.total, 0),
    verse: liste.reduce((n, s) => n + s.verse, 0),
    retour: liste.reduce((n, s) => n + s.retour, 0),
    reste: liste.reduce((n, s) => n + s.reste, 0),
    ouverts: liste.filter(s => s.reste > 0).length,
    tiers: liste.length,
  };
}
