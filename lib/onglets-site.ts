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

/** Ces mêmes onglets en entrées de menu, pour le site donné. */
export function navDuSite(siteId: string, role: RoleSite | null) {
  return ongletsVisibles(role).map(o => ({
    type: 'link' as const,
    label: o.label,
    href: `/site/${siteId}?onglet=${o.key}`,
    icon: o.icon,
  }));
}
