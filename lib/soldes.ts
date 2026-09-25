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
  /** ce qui a été versé là-dessus */
  verse: number;
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
    partenaireId, total: 0, verse: 0, reste: 0,
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
) {
  const e = cible.get(partenaireId) ?? vide(partenaireId);
  const reste = Math.max(0, total - verse);
  cible.set(partenaireId, {
    partenaireId,
    total: e.total + total,
    verse: e.verse + verse,
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
  const [achDocs, venDocs] = await Promise.all([
    lireParSite('achats', siteId),
    lireParSite('ventes', siteId),
  ]);

  const fournisseur = new Map<string, SoldeTiers>();
  const client = new Map<string, SoldeTiers>();

  for (const d of achDocs) {
    const a = d.data() as any;
    if (!a.fournisseurId || !conclu(a, 'fournisseur')) continue;
    cumuler(fournisseur, a.fournisseurId,
      valeurRecue(a.lignes ?? []), a.avanceVersee ?? 0,
      a.dateConfirmation ?? a.dateReception ?? a.dateCommande ?? null);
  }

  for (const d of venDocs) {
    const v = d.data() as any;
    if (!v.clientId || !conclu(v, 'client')) continue;
    cumuler(client, v.clientId,
      valeurVente(v.lignes ?? []), v.avanceVersee ?? 0,
      v.dateLivraison ?? v.dateCommande ?? null);
  }

  return { fournisseur, client };
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

  const cible = new Map<string, SoldeTiers>();
  for (const d of snap.docs) {
    const x = d.data() as any;
    if (!conclu(x, role)) continue;
    cumuler(cible, partenaireId,
      role === 'fournisseur' ? valeurRecue(x.lignes ?? []) : valeurVente(x.lignes ?? []),
      x.avanceVersee ?? 0,
      role === 'fournisseur'
        ? (x.dateConfirmation ?? x.dateReception ?? x.dateCommande ?? null)
        : (x.dateLivraison ?? x.dateCommande ?? null));
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
    reste: liste.reduce((n, s) => n + s.reste, 0),
    ouverts: liste.filter(s => s.reste > 0).length,
    tiers: liste.length,
  };
}
