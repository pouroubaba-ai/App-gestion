/**
 * Les onglets d'un site, et la navigation qu'un membre emporte avec lui.
 *
 * Ces onglets vivaient dans la page du site, qui les construisait pour
 * elle-même. Mais un membre navigue avec eux : ils sont sa barre du bas.
 * Dès qu'il ouvre un écran hors du site — sa fiche de compte, par exemple —
 * cette page ne les connaît pas, la barre disparaît, et le menu burger
 * reprend la main sous ses pieds.
 *
 * Ils vivent donc ici, où toute page peut les demander.
 */
import {
  LayoutDashboard, Wallet, RefreshCw, ShoppingCart, ArrowLeftRight, Package,
  Handshake, CalendarClock, Users, History, ClipboardList, Settings, HandCoins,
  ListOrdered, ShieldCheck, Undo2, SlidersHorizontal,
} from 'lucide-react';
import { ongletsDuRole, type RoleSite } from './roles';

export type Onglet =
  | 'dashboard' | 'fonds' | 'cycle-vente' | 'achats' | 'transferts'
  | 'inventaire' | 'partenaires' | 'recouvrements' | 'employes'
  | 'historique' | 'audit' | 'configuration' | 'remises' | 'retours'
  | 'mouvements' | 'mouvements-stock' | 'autorisations';

export const ONGLETS_SITE: { key: Onglet; label: string; icon: React.ElementType }[] = [
  /* Constater */
  { key: 'dashboard',      label: 'Dashboard',        icon: LayoutDashboard },
  { key: 'fonds',          label: 'Fonds disponible', icon: Wallet },
  /* Le registre et la file n'ont leur propre page que pour le caissier :
     il ne fait que cela, et il travaille au téléphone, où les trois
     empilés se poussent hors de l'écran. Les autres rôles les lisent
     sous leurs chiffres, dans « Fonds disponible ». */
  { key: 'mouvements',     label: 'Mouvements',       icon: ListOrdered },
  { key: 'autorisations',  label: 'Autorisations',    icon: ShieldCheck },

  /* Agir, dans l'ordre du cycle */
  { key: 'cycle-vente',    label: 'Cycle de vente',   icon: RefreshCw },
  { key: 'achats',         label: 'Achats',           icon: ShoppingCart },
  { key: 'transferts',     label: 'Transferts',       icon: ArrowLeftRight },
  /* Le retour défait ce que les trois précédents ont fait : il suit le
     cycle plutôt que de vivre à part. */
  { key: 'retours',        label: 'Retours',          icon: Undo2 },
  { key: 'inventaire',     label: 'Inventaire',       icon: Package },
  /* Les mouvements de stock ont leur page, et non un recoin de
     l'inventaire : le responsable des commandes n'ouvre pas l'inventaire,
     et c'est pourtant lui qui va compter au rayon puis confirmer. Les y
     enterrer les lui rendrait invisibles. */
  { key: 'mouvements-stock', label: 'Mouvements de stock', icon: SlidersHorizontal },

  /* Ceux qui doivent, ceux à qui l'on doit */
  { key: 'partenaires',    label: 'Partenaires',      icon: Handshake },
  { key: 'recouvrements',  label: 'Recouvrements',    icon: CalendarClock },
  /* L'argent encaissé dehors, avant qu'il entre en caisse : il suit les
     recouvrements, puisqu'il en naît. */
  { key: 'remises',        label: 'Mes remises',      icon: HandCoins },
  { key: 'employes',       label: 'Employés',         icon: Users },

  /* Consulter, puis administrer */
  { key: 'historique',     label: 'Historique',       icon: History },
  { key: 'audit',          label: 'Audit',            icon: ClipboardList },
  { key: 'configuration',  label: 'Configuration',    icon: Settings },
];

/**
 * Les onglets qu'un rôle ouvre sur un site, prêts pour la navigation.
 *
 * Le cycle de vente part du devis — une intention — et va jusqu'à la
 * livraison. Le responsable des commandes n'entre qu'après, quand
 * l'intention est devenue engagement : pour lui, ce sont des bons de
 * commande, et lui promettre un cycle lui promettrait une étape qu'il ne
 * verra jamais.
 */
export function ongletsVisibles(role: RoleSite | null) {
  const permis = ongletsDuRole(role, ONGLETS_SITE.map(o => o.key))
    /* Le registre et la file vivent sous « Fonds disponible » pour tout le
       monde ; le caissier seul les déplie en onglets. Les montrer à qui
       les a déjà sous les yeux ferait deux chemins vers le même écran. */
    .filter(o => role === 'caissier'
      || (o !== 'mouvements' && o !== 'autorisations'));
  return ONGLETS_SITE
    .filter(o => permis.includes(o.key))
    .map(o => o.key === 'cycle-vente' && role === 'commandes'
      ? { ...o, label: 'Bons de commande' } : o);
}

/**
 * Ce rôle a-t-il cet onglet dans sa barre ?
 *
 * À distinguer de `ongletAutorise`, qui dit si l'onglet lui est permis :
 * le propriétaire a droit à tout, mais le registre et la file ne sont dans
 * la barre que du caissier. C'est cette question-là que se pose un écran
 * qui veut éviter de montrer deux fois la même chose.
 */
export function aLOnglet(role: RoleSite | null, onglet: Onglet): boolean {
  return ongletsVisibles(role).some(o => o.key === onglet);
}

/**
 * Ce qui reste devant, pour qui en a trop.
 *
 * Le gérant ouvre quatorze onglets là où sa journée en demande quatre :
 * ce qu'il a vendu, ce qu'il y a en caisse, qui doit encore, ce qu'il a
 * remis. Le reste existe et doit rester atteignable — mais le lire
 * chaque fois pour trouver l'un des quatre coûtait un parcours entier.
 *
 * Les groupes ne valent que pour qui en a assez pour s'y perdre. Le
 * caissier en a trois, le responsable des commandes cinq : les replier
 * ajouterait un geste pour cacher ce qui tenait déjà sous les yeux.
 */
const QUOTIDIEN: Onglet[] = [
  'dashboard', 'fonds', 'mouvements', 'autorisations',
  'recouvrements', 'remises',
];

const GROUPES: { label: string; cles: Onglet[] }[] = [
  { label: 'Marchandise',
    cles: ['cycle-vente', 'achats', 'transferts', 'retours',
      'inventaire', 'mouvements-stock'] },
  { label: 'Comptes', cles: ['partenaires', 'employes'] },
  { label: 'Activité', cles: ['historique', 'audit', 'configuration'] },
];

/** En deçà, une liste plate se lit d'un coup d'œil : rien à replier. */
const SEUIL_GROUPES = 8;

/**
 * Les onglets d'un rôle, séparés en ce qui reste devant et ce qui se range.
 *
 * Le menu latéral et la barre du haut montrent les mêmes onglets et ne les
 * montrent pas pareil — l'un replie des accordéons, l'autre n'a qu'une
 * ligne et pousse le reste sous un bouton. Mais ce qui mérite de rester
 * devant ne dépend pas de la forme du menu : si les deux en décidaient
 * chacun de son côté, le même onglet finirait visible ici et caché là.
 */
export function ongletsGroupes(role: RoleSite | null) {
  const visibles = ongletsVisibles(role);
  if (visibles.length < SEUIL_GROUPES) {
    return { devant: visibles, groupes: [] as
      { label: string; enfants: typeof visibles }[] };
  }
  const range = new Set<Onglet>([
    ...QUOTIDIEN, ...GROUPES.flatMap(g => g.cles),
  ]);
  return {
    /* Ce qu'aucun groupe ne réclame reste devant plutôt que de
       disparaître : un onglet ajouté demain n'a pas à attendre qu'on
       pense à le ranger pour exister. */
    devant: visibles.filter(
      o => QUOTIDIEN.includes(o.key) || !range.has(o.key)),
    groupes: GROUPES
      .map(g => ({
        label: g.label,
        enfants: visibles.filter(o => g.cles.includes(o.key)),
      }))
      .filter(g => g.enfants.length > 0),
  };
}

/** Ces mêmes onglets en entrées de menu, pour le site donné. */
export function navDuSite(siteId: string, role: RoleSite | null) {
  const visibles = ongletsVisibles(role);
  const lien = (o: typeof visibles[number]) => ({
    type: 'link' as const,
    label: o.label,
    href: `/site/${siteId}?onglet=${o.key}`,
    icon: o.icon,
  });

  const { devant, groupes } = ongletsGroupes(role);
  if (groupes.length === 0) return visibles.map(lien);

  /* L'ordre de la barre est conservé à l'intérieur de chaque groupe :
     un menu qui réorganise ce que l'écran range autrement obligerait à
     réapprendre deux fois la même app. */
  return [
    ...devant.map(lien),
    ...groupes.map(g => ({
      type: 'accordion' as const,
      label: g.label,
      /* L'emblème du groupe est celui de sa première entrée : il n'a pas
         d'icône à lui, et en inventer une de plus ferait un symbole que
         rien n'explique ailleurs. */
      icon: g.enfants[0].icon,
      children: g.enfants.map(o => ({
        label: o.label,
        href: `/site/${siteId}?onglet=${o.key}`,
        icon: o.icon,
      })),
    })),
  ];
}
