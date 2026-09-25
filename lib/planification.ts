/**
 * Comment une dette ou une créance se règle.
 *
 * Faire naître une dette et laisser l'utilisateur revenir plus tard poser
 * son échéancier, c'est lui demander deux gestes pour une seule décision —
 * et dans les faits, il ne revient pas. Le moment où l'on confirme un achat
 * ou une vente à crédit est celui où l'on sait déjà comment ce sera payé :
 * c'est là qu'il faut le dire.
 *
 * Trois façons de régler, et une seule règle gouverne un partenaire — la
 * sienne :
 *
 *  - `continuer`  : la configuration du partenaire existe, on ne touche à
 *                   rien. S'il a un recouvrement en cours, le suivant
 *                   naîtra en son temps.
 *  - `modele`     : la configuration générale de l'activité sert de patron.
 *                   Elle ne s'applique jamais directement : on la recopie
 *                   en configuration du partenaire. C'est un modèle, pas
 *                   une règle.
 *  - `date`       : une échéance ponctuelle, à une date choisie, pour tout
 *                   ou partie du dû. Elle ne gouverne aucun rythme.
 */
import {
  collection, query, where, getDocs, addDoc, updateDoc, doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { soldeTiers } from '@/lib/soldes';

export type RoleRecouvrement = 'fournisseur' | 'client';

/** Le rythme auquel un partenaire règle : un montant, tous les N jours. */
export interface ConfigRecouvrement {
  id: string;
  siteId: string;
  partenaireId: string;
  role: RoleRecouvrement;
  valeur: number;
  intervalleJours: number;
  actif: boolean;
}

/** Le modèle de l'activité, recopié sur un partenaire quand on le choisit. */
export interface ModeleRecouvrement {
  id: string;
  role: RoleRecouvrement;
  valeur: number;
  intervalleJours: number;
}

/** Ce que l'utilisateur décide au moment où la dette naît. */
export type Planification =
  | { mode: 'aucun' }
  | { mode: 'continuer' }
  | {
      mode: 'modele';
      valeur: number;
      intervalleJours: number;
      /* Le nouveau rythme démarre aujourd'hui, ou attend que l'échéance en
         cours arrive à son terme. */
      desMaintenant: boolean;
    }
  | {
      /* La regle du partenaire, ecrite a la main : meme effet que `modele`,
         mais les valeurs viennent de l'utilisateur et non du patron. */
      mode: 'config';
      valeur: number;
      intervalleJours: number;
      desMaintenant: boolean;
    }
  | { mode: 'date'; date: string; valeur: number };

/**
 * Le jour tel qu'on le vit, pas tel que Greenwich le compte.
 *
 * `toISOString()` bascule en UTC : passe midi sous un fuseau en avance, il
 * rend la veille. L'echeance par defaut tombait donc dans le passe, et le
 * delai affiche valait zero. On lit les composantes locales.
 */
function jourLocal(d: Date): string {
  const mois = String(d.getMonth() + 1).padStart(2, '0');
  const jour = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mois}-${jour}`;
}

function aujourdhui(): string {
  return jourLocal(new Date());
}

function dans(jours: number): string {
  const d = new Date();
  d.setDate(d.getDate() + jours);
  return jourLocal(d);
}

/** La configuration d'un partenaire pour ce rôle, si elle existe. */
export async function configDuPartenaire(
  siteId: string, partenaireId: string, role: RoleRecouvrement,
): Promise<ConfigRecouvrement | null> {
  const snap = await getDocs(query(
    collection(db, 'recouvrement_config'),
    where('siteId', '==', siteId),
    where('partenaireId', '==', partenaireId)));
  const trouve = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as ConfigRecouvrement))
    .find(c => c.role === role);
  return trouve ?? null;
}

/** Le modèle de l'activité pour ce rôle, si quelqu'un l'a posé. */
export async function modeleDuSite(
  siteId: string, role: RoleRecouvrement,
): Promise<ModeleRecouvrement | null> {
  const snap = await getDocs(query(
    collection(db, 'recouvrement_config_defaut'),
    where('siteId', '==', siteId)));
  const trouve = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as ModeleRecouvrement))
    .find(c => c.role === role);
  return trouve ?? null;
}

/** Les échéances automatiques encore ouvertes pour ce partenaire. */
async function echeancesAutoOuvertes(
  siteId: string, partenaireId: string, role: RoleRecouvrement,
) {
  const snap = await getDocs(query(
    collection(db, 'recouvrement_journal'),
    where('siteId', '==', siteId),
    where('partenaireId', '==', partenaireId)));
  return snap.docs
    .map(d => ({ id: d.id, ...(d.data() as any) }))
    .filter(l => l.role === role && (l.source ?? 'auto') === 'auto'
      && (l.reste ?? 0) > 0);
}

/**
 * Applique la décision prise à la confirmation.
 *
 * Rien n'est écrit en mode `aucun` ou `continuer` : dans le premier cas on
 * n'a rien décidé, dans le second la règle du partenaire fait déjà son
 * travail.
 */
export async function appliquerPlanification(params: {
  siteId: string;
  userId: string;
  partenaireId: string;
  role: RoleRecouvrement;
  plan: Planification;
}): Promise<void> {
  const { siteId, userId, partenaireId, role, plan } = params;
  if (plan.mode === 'aucun' || plan.mode === 'continuer') return;

  /* Une date fixe n'est pas un rythme : elle ne touche à aucune
     configuration et ne gouverne rien après elle. */
  if (plan.mode === 'date') {
    if (!(plan.valeur > 0)) return;
    await addDoc(collection(db, 'recouvrement_journal'), {
      siteId, userId, partenaireId, role,
      date: plan.date,
      valeur: plan.valeur,
      verse: 0,
      reste: plan.valeur,
      /* `manuel` : posée à la main, elle échappe au cycle automatique et
         n'entraîne aucune suivante. */
      source: 'manuel',
      createdAt: serverTimestamp(),
    });
    return;
  }

  /* `modele` et `config` aboutissent au même écrit : une règle sur ce
     partenaire. Ils ne diffèrent que par l'origine des valeurs — le patron
     de l'activité, ou la main de l'utilisateur. Le modèle ne gouverne
     jamais directement : il se recopie, puis on l'oublie. */
  const existante = await configDuPartenaire(siteId, partenaireId, role);
  if (existante) {
    await updateDoc(doc(db, 'recouvrement_config', existante.id), {
      valeur: plan.valeur,
      intervalleJours: plan.intervalleJours,
      actif: true,
    });
  } else {
    await addDoc(collection(db, 'recouvrement_config'), {
      siteId, userId, partenaireId, role,
      valeur: plan.valeur,
      intervalleJours: plan.intervalleJours,
      actif: true,
      createdAt: serverTimestamp(),
    });
  }

  if (!plan.desMaintenant) return;

  /* Démarrer tout de suite avec une échéance déjà ouverte donnerait deux
     rythmes concurrents, et la génération automatique — qui s'accroche à la
     dernière ligne `auto` — ne saurait plus lequel suivre.
     L'ancienne passe donc en `manuel` : elle garde sa date et son montant,
     car elle a été annoncée au partenaire et reste due. Elle sort
     simplement du cycle, qu'une seule ligne gouverne désormais. */
  for (const ligne of await echeancesAutoOuvertes(siteId, partenaireId, role)) {
    await updateDoc(doc(db, 'recouvrement_journal', ligne.id), {
      source: 'manuel',
    });
  }

  await addDoc(collection(db, 'recouvrement_journal'), {
    siteId, userId, partenaireId, role,
    date: dans(plan.intervalleJours),
    valeur: plan.valeur,
    verse: 0,
    reste: plan.valeur,
    source: 'auto',
    createdAt: serverTimestamp(),
  });
}

/** Ce qu'on peut proposer, une fois qu'on sait ce qui existe. */
export interface ChoixPlanification {
  config: ConfigRecouvrement | null;
  modele: ModeleRecouvrement | null;
  /** Vrai si une échéance automatique court déjà : le cycle est lancé. */
  cycleEnCours: boolean;
  /** La prochaine échéance ouverte, celle que l'utilisateur veut voir. */
  prochaine: { date: string; valeur: number; reste: number } | null;
  /**
   * Tout ce que ce partenaire doit, toutes factures confondues.
   *
   * La facture en cours dit ce qu'on plafonne ; ce total dit dans quoi elle
   * s'inscrit. Planifier sans le voir, c'est décider à l'aveugle.
   */
  duTotal: number;
}

/** Ce qu'il faut savoir pour proposer les bons choix à la confirmation. */
export async function lireChoix(
  siteId: string, partenaireId: string, role: RoleRecouvrement,
): Promise<ChoixPlanification> {
  const [config, modele, ouvertes, solde] = await Promise.all([
    configDuPartenaire(siteId, partenaireId, role),
    modeleDuSite(siteId, role),
    echeancesAutoOuvertes(siteId, partenaireId, role),
    soldeTiers(siteId, partenaireId, role),
  ]);

  /* La plus proche dans le temps : c'est celle qui tombe, donc celle qu'on
     annonce. */
  const triees = [...ouvertes].sort((a, b) =>
    String(a.date ?? '').localeCompare(String(b.date ?? '')));
  const p = triees[0];

  return {
    config, modele,
    cycleEnCours: ouvertes.length > 0,
    prochaine: p
      ? { date: p.date ?? '', valeur: p.valeur ?? 0, reste: p.reste ?? 0 }
      : null,
    duTotal: solde.reste,
  };
}

/** La date par défaut d'une échéance ponctuelle : dans une semaine. */
export function dateParDefaut(): string {
  return dans(7);
}

export { aujourdhui };
