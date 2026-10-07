'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite } from '@/lib/roles';
import { useTheme } from '@/lib/theme-context';
import {
  LogOut, ChevronLeft, ChevronRight, ChevronDown, Sun, Moon, MapPin, Settings,
  LayoutDashboard, Wallet, Handshake, CalendarClock, HandCoins, Users, RefreshCw, Undo2,
  ShoppingCart, Ship, ArrowLeftRight, Package, History, UserCog,
} from 'lucide-react';
import {
  compterEnAttente, AUCUNE_ATTENTE, SIGNAL_ATTENTE, type EnAttente,
} from '@/lib/en-attente';
import { sitesDe, type Portee } from '@/lib/portee';
import { useState, useRef, useCallback, useEffect } from 'react';

type NavChild = { label: string; href: string; icon: React.ElementType };
type NavItem =
  | { type: 'link'; label: string; href: string; icon: React.ElementType }
  | { type: 'accordion'; label: string; icon: React.ElementType; children: NavChild[] };

/* L'app se pilote site par site : chacun tient ses stocks, sa caisse et
   ses partenaires. Le propriétaire, lui, répond de tous à la fois : ses
   onglets montrent les mêmes écrans, à l'échelle de l'activité.

   L'ordre suit la journée, pas l'alphabet. On constate d'abord — où l'on en
   est, ce qu'il y a en caisse. On agit ensuite, dans l'ordre du cycle : ce
   qui se vend, ce qui s'achète, ce qui circule, ce qui reste. On règle
   après avec ceux à qui l'on doit ou qui nous doivent. On consulte enfin.
   Les sites ferment la marche : depuis que ces onglets embrassent
   l'activité, on n'ouvre plus la liste pour travailler, mais pour
   administrer. */
/* Quatre entrées devant, le reste replié.
 *
 * Les quinze tenaient dans la colonne sans y tenir vraiment : on les
 * lisait toutes pour en trouver une, et celles de tous les jours — ce
 * qu'on a vendu, ce qu'il y a en caisse, qui doit encore, ce qu'on a
 * remis — se retrouvaient entre un inventaire qu'on ouvre le lundi et
 * un paramètre qu'on ouvre deux fois l'an. Ranger ce qui est rare n'est
 * pas le cacher : c'est cesser de le faire porter par la lecture
 * quotidienne.
 *
 * Ce qui reste devant est ce qu'on ouvre tous les jours. Le reste se
 * groupe par ce qu'on y fait, non par l'ordre du cycle : on ne déplie
 * pas un menu pour suivre une marchandise d'un bout à l'autre, on le
 * déplie pour trouver un écran. */
const nav: NavItem[] = [
  /* La journée : ce qu'on a fait, ce qu'il y a en caisse, qui doit
     encore, et ce qu'on a soi-même remis. */
  { type: 'link', label: 'Tableau de bord', href: '/ensemble?onglet=dashboard', icon: LayoutDashboard },
  { type: 'link', label: 'Fonds disponible', href: '/ensemble?onglet=fonds', icon: Wallet },
  { type: 'link', label: 'Recouvrements', href: '/ensemble?onglet=recouvrements', icon: CalendarClock },
  /* Le propriétaire vend comme ses gérants : sans cet écran, il ne savait
     pas ce que la caisse avait fait de ses propres ventes. */
  { type: 'link', label: 'Mes remises', href: '/ensemble?onglet=remises', icon: HandCoins },

  /* Tout ce qui fait bouger de la marchandise, dans l'ordre du cycle :
     elle se vend, elle s'achète, elle voyage, elle revient, et ce qui
     reste se compte. */
  { type: 'accordion', label: 'Marchandise', icon: Package, children: [
    { label: 'Cycle de vente', href: '/ensemble?onglet=cycle-vente', icon: RefreshCw },
    { label: 'Achats', href: '/ensemble?onglet=achats', icon: ShoppingCart },
    /* L'import suit l'achat : c'est le même geste, avec le voyage en plus. */
    { label: 'Importations', href: '/ensemble?onglet=importations', icon: Ship },
    { label: 'Transferts', href: '/ensemble?onglet=transferts', icon: ArrowLeftRight },
    { label: 'Retours', href: '/ensemble?onglet=retours', icon: Undo2 },
    { label: 'Inventaire', href: '/ensemble?onglet=inventaire', icon: Package },
  ] },

  /* Les personnes : celles qui doivent ou à qui l'on doit, et celles qui
     travaillent. On les ouvre pour une fiche, pas pour la journée — le
     recouvrement, lui, est resté devant, puisqu'il se fait chaque jour. */
  { type: 'accordion', label: 'Comptes', icon: Handshake, children: [
    { label: 'Partenaires', href: '/ensemble?onglet=partenaires', icon: Handshake },
    /* Les voisins qui depannent. Ils ne sont pas du carnet : les y meler
       le remplirait de noms vus une fois. */
    { label: 'Occasionnels', href: '/ensemble?onglet=occasionnels', icon: HandCoins },
    { label: 'Employés', href: '/ensemble?onglet=employes', icon: Users },
  ] },

  /* Ce qui ne concerne pas la journée mais la structure : ce qui s'est
     passé, où l'on travaille, comment c'est réglé. */
  { type: 'accordion', label: 'Activité', icon: Settings, children: [
    { label: 'Historique', href: '/ensemble?onglet=historique', icon: History },
    { label: 'Sites', href: '/site', icon: MapPin },
    { label: 'Paramètre', href: '/parametre', icon: Settings },
  ] },
];

/* -
   Popup fixe (tooltip ou flyout accordéon)
   position: fixed → échappe à tout overflow:hidden
- */
type PopupState =
  | { kind: 'tooltip'; label: string; y: number }
  | { kind: 'flyout'; label: string; children: NavChild[]; y: number }
  | null;

function FixedPopup({ popup, estActif, enAttenteDe, onMouseEnter, onMouseLeave }: {
  popup: PopupState;
  /* Le même test que partout ailleurs : ces entrées portent un
     `?onglet=`, que la seule comparaison des chemins ignore. */
  estActif: (href: string) => boolean;
  /* L'icône du groupe dit qu'il reste quelque chose ; le panneau doit
     dire quoi. Sans ses pastilles, on l'ouvrait pour découvrir un compte
     sans savoir laquelle des six lignes le portait — il fallait les
     parcourir une à une, ce que la pastille existe précisément pour
     éviter. */
  enAttenteDe: (href: string) => number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  if (!popup) return null;
  const LEFT = 68; // 64px sidebar + 4px gap

  if (popup.kind === 'tooltip') {
    return (
      <div
        style={{ position: 'fixed', left: LEFT, top: popup.y, transform: 'translateY(-50%)', zIndex: 9999 }}
        className="pointer-events-none"
      >
        <div className="relative bg-gray-900 dark:bg-gray-700 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-lg">
          <span className="absolute right-full top-1/2 -translate-y-1/2 border-[5px] border-transparent border-r-gray-900 dark:border-r-gray-700" />
          {popup.label}
        </div>
      </div>
    );
  }

  // flyout accordéon
  return (
    <div
      style={{ position: 'fixed', left: LEFT, top: popup.y, zIndex: 9999 }}
      className="pointer-events-auto"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl min-w-[160px] py-1.5">
        <p className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
          {popup.label}
        </p>
        {popup.children.map(child => {
          const ChildIcon = child.icon;
          const active = estActif(child.href);
          return (
            <Link
              key={child.href}
              href={child.href}
              className={`flex items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors
                ${active ? 'bg-indigo-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
            >
              <ChildIcon size={15} className="shrink-0" />
              <span className="flex-1">{child.label}</span>
              <Badge n={enAttenteDe(child.href)} actif={active} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/* -
   Accordéon (menu déplié)
- */
function AccordionItem({ item, estActif, open, onToggle, enAttenteDe }: {
  item: Extract<NavItem, { type: 'accordion' }>;
  /* Le même test que les liens de premier rang. Il comparait l'adresse
     entière au chemin, alors que ces entrées portent toutes un
     `?onglet=` : l'égalité ne tombait jamais, et ni le groupe ni sa
     ligne ne se seraient marqués comme actifs. */
  estActif: (href: string) => boolean;
  open: boolean;
  onToggle: () => void;
  enAttenteDe: (href: string) => number;
}) {
  const isChildActive = item.children.some(c => estActif(c.href));
  /* Ce qui attend là-dedans, quand c'est fermé.
   *
   * Les pastilles vivaient sur les lignes ; replier les lignes aurait
   * replié les pastilles avec, et un compte enfermé dans un menu fermé
   * ne prévient personne — c'est pourtant tout ce qu'on lui demande.
   * Le groupe porte donc la somme de ce qu'il cache, et la rend à ses
   * lignes dès qu'on l'ouvre. */
  const attente = item.children.reduce((s, c) => s + enAttenteDe(c.href), 0);
  const Icon = item.icon;
  return (
    <div>
      <button
        onClick={onToggle}
        className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
          ${isChildActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50'}`}
      >
        <Icon size={18} className="shrink-0" />
        <span className="flex-1 text-left">{item.label}</span>
        {!open && <Badge n={attente} actif={false} />}
        <ChevronDown size={15} className={`text-gray-400 dark:text-gray-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="ml-4 mt-0.5 pl-3 border-l border-gray-200 dark:border-gray-700 space-y-0.5">
          {item.children.map(child => {
            const ChildIcon = child.icon;
            const active = estActif(child.href);
            return (
              <Link
                key={child.href}
                href={child.href}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors
                  ${active ? 'bg-indigo-600 text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50'}`}
              >
                <ChildIcon size={15} className="shrink-0" />
                <span className="flex-1">{child.label}</span>
                <Badge n={enAttenteDe(child.href)} actif={active} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -
   Sidebar
- */
/**
 * Ce qui attend, en rouge.
 *
 * Rouge parce que ces dossiers coûtent : une réception non comptée fausse
 * le stock, une échéance échue ne se réclame pas toute seule. Zéro ne
 * s'affiche pas — un badge permanent cesse d'être regardé.
 */
function Badge({ n, actif, compact = false }: {
  n: number; actif: boolean; compact?: boolean;
}) {
  if (n <= 0) return null;
  if (compact) {
    /* Menu replié : le compte se lit quand même. La pastille se pose sur
       le coin de l'icône, au-dessus de tout — une pastille muette
       obligeait à déplier pour savoir s'il s'agit d'un dossier ou de
       douze. Au-delà de neuf, « 9+ » : trois chiffres ne tiendraient pas
       sans déborder sur l'icône. */
    return (
      <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white tabular-nums dark:ring-gray-900">
        {n > 9 ? '9+' : n}
      </span>
    );
  }
  return (
    <span className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
      actif ? 'bg-white/20 text-white' : 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400'}`}>
      {n}
    </span>
  );
}

export default function Sidebar({
  mobileOpen = false, onMobileClose = () => {}, items, titre, portee,
}: {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /** Ce que le menu surmonte. Sans activité, « Mon activité » ne désigne
      rien : un membre y lit le nom de son site. */
  titre?: string;
  /** La navigation propre à la page : les onglets d'un site, pour qui n'a
      pas de liste de sites à parcourir. */
  items?: NavItem[];
  /**
   * Sur quoi porte le compte des dossiers en attente : le site ouvert, ou
   * tous ceux de l'activité dans la vue d'ensemble. Absent, aucun badge —
   * un écran qui ne travaille pas sur des dossiers n'a rien à signaler.
   */
  portee?: Portee;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, activite, profile } = useAuth();

  /* Ce qui attend un geste, par onglet. Le sidebar est le seul endroit vu
     depuis tous les écrans : c'est là qu'un dossier oublié se rappelle.
     La clé se mémorise sur le contenu de la portée, pas sur l'objet : une
     page qui reconstruit son tableau d'identifiants à chaque rendu
     relancerait la lecture sans fin. */
  const clePortee = portee ? sitesDe(portee).join(',') : '';
  const [attente, setAttente] = useState<EnAttente>(AUCUNE_ATTENTE);
  /* Incrémenté par le signal : autoriser un mouvement ne change pas
     l'adresse, si bien que la pastille gardait son compte devant une file
     déjà vidée. */
  const [relire, setRelire] = useState(0);
  /* Le role sur le site decide de ce que la pastille compte. On ne le lit
     qu'une fois : il ne change pas sous les pieds de celui qui navigue. */
  const [porteurUid, setPorteurUid] = useState<string | null>(null);
  useEffect(() => {
    const sites = clePortee ? clePortee.split(',') : [];
    if (!user || sites.length !== 1) { setPorteurUid(null); return; }
    let vivant = true;
    roleSurSite(user.uid, sites[0], activite?.adminUid)
      .then(r => { if (vivant) setPorteurUid(r === 'recouvrement' ? user.uid : null); })
      .catch(() => { if (vivant) setPorteurUid(null); });
    return () => { vivant = false; };
  }, [user, clePortee, activite?.adminUid]);
  useEffect(() => {
    const auSignal = () => setRelire(n => n + 1);
    window.addEventListener(SIGNAL_ATTENTE, auSignal);
    return () => window.removeEventListener(SIGNAL_ATTENTE, auSignal);
  }, []);
  useEffect(() => {
    if (!clePortee) { setAttente(AUCUNE_ATTENTE); return; }
    let vivant = true;
    compterEnAttente(clePortee.split(','), porteurUid, user?.uid ?? null)
      .then(a => { if (vivant) setAttente(a); })
      .catch(() => { if (vivant) setAttente(AUCUNE_ATTENTE); });
    return () => { vivant = false; };
  /* Pas `pathname` ici.
   *
   * Compter ce qui attend lit huit collections entières — achats,
   * transferts des deux côtés, ventes, journal de recouvrement, file de
   * caisse, missions, retours. Avec le chemin en dépendance, ces huit
   * lectures repartaient à chaque changement d'adresse : chaque clic
   * d'onglet, chaque fiche ouverte, chaque retour arrière. Des milliers
   * de documents par geste, pour un chiffre sur une pastille.
   *
   * Rien ne s'en trouvait plus juste : une pastille ne change que
   * lorsqu'un dossier avance, et c'est `SIGNAL_ATTENTE` qui le dit
   * — émis par les écritures elles-mêmes, qui seules savent quand le
   * compte a bougé. Naviguer ne fait avancer aucun dossier. */
  }, [clePortee, relire, porteurUid, user?.uid]);

  /* Quel onglet porte quel compte. Un badge ne vaut que là où le geste se
     fait : le poser ailleurs enverrait chercher au mauvais endroit. */
  function enAttenteDe(href: string): number {
    if (href.includes('onglet=achats')) return attente.achats;
    if (href.includes('onglet=transferts')) return attente.transferts;
    if (href.includes('onglet=cycle-vente')) return attente.ventes;
    if (href.includes('onglet=recouvrements')) return attente.recouvrements;
    if (href.includes('onglet=autorisations')) return attente.autorisations;
    if (href.includes('onglet=remises')) return attente.remises;
    /* Le responsable des commandes traite les trois types : un seul
       compte sur l'icône lui dit s'il reste quelque chose, sans ouvrir
       chaque onglet pour le découvrir. */
    if (href.includes('onglet=retours')) return attente.retours;
    /* Un conteneur n'avance que si quelqu'un le pousse : la pastille dit
       combien de dossiers sont encore en route ou a compter. */
    if (href.includes('onglet=importations')) return attente.importations;
    /* Combien de voisins attendent leur argent. */
    if (href.includes('onglet=occasionnels')) return attente.occasionnels;
    return 0;
  }

  /* Un membre n'a qu'un site : lui montrer une liste de sites l'oblige à
     traverser un écran qui ne lui apprend rien. Ses onglets prennent la
     place, passés par la page qui les connaît. */
  /* La vue d'ensemble embrasse toute l'activité : elle appartient à qui en
     répond. Un membre travaille sur un site et n'a de droits que là — lui
     servir ces entrées lui ouvrirait des onglets que son rôle ferme.

     « Paramètre » gère l'activité elle-même : la renommer, purger ses
     données. Un membre n'en a aucune — la page le renvoyait vers
     `/activite`, qui le renvoyait vers `/site`, qui le ramenait à son
     onglet de départ. Trois sauts pour revenir au point de départ, ce qui
     se voyait comme un clignotement. */
  /* Ce qui n'appartient qu'au propriétaire se reconnaissait à l'adresse
     de ses liens. Depuis que ce menu se replie, il porte aussi des
     groupes — et un groupe n'a pas d'adresse : le filtre ne les voyait
     pas, et chaque membre recevait ses propres onglets plus les trois
     groupes du propriétaire. Un caissier ouvrait « Marchandise » et
     « Activité », qui ne sont pas à lui.
     Un groupe est donc jugé sur ce qu'il contient : il appartient au
     propriétaire dès que ses entrées en viennent. */
  const propreAuProprietaire = (i: NavItem): boolean => {
    if (i.type === 'accordion') {
      return i.children.every(c => c.href === '/site' || c.href === '/parametre'
        || c.href.startsWith('/ensemble'));
    }
    return 'href' in i && (i.href === '/site' || i.href === '/parametre'
      || i.href.startsWith('/ensemble'));
  };
  /* Il garde une entrée à lui : sous quelle adresse il est connecté, sur
     quel site il agit, et à quel titre. Sans elle, il faudrait le demander
     à son gérant — et la déconnexion, qui vivait dans le tiroir du menu,
     n'aurait plus de place sur un téléphone. */
  const monCompte: NavItem = {
    type: 'link', label: 'Mon compte', href: '/mon-compte', icon: UserCog,
  };
  /* Le membre échange « Paramètre » contre « Mon compte » : l'un pilote
     l'activité qu'il n'a pas, l'autre dit son poste. */
  const sansEnsemble = [...nav.filter(i => !propreAuProprietaire(i)), monCompte];
  const navVisible: NavItem[] = items
    ? [...items, ...sansEnsemble]
    : profile?.role === 'membre' ? sansEnsemble : nav;

  /* L'onglet ouvert quand l'URL n'en nomme aucun : le premier que la page
     propose, puisque c'est lui qu'elle affiche. */
  const premierOnglet = items?.length
    ? new URLSearchParams((items[0] as any).href?.split('?')[1] ?? '').get('onglet')
    : null;

  /* Un onglet de site vit dans la query, pas dans le chemin : comparer les
     seuls chemins les rendrait tous actifs en même temps.
     Mais comparer l'URL entière n'en rend aucun actif dès qu'un paramètre
     s'ajoute — ou manque : on arrive sur `/site/xxx` sans query, et le
     premier onglet est pourtant celui qu'on regarde. On compare donc le
     chemin et le seul paramètre qui désigne l'onglet. */
  const ongletCourant = searchParams.get('onglet');
  function estActif(href: string) {
    const [chemin, query] = href.split('?');
    if (chemin !== pathname) return false;
    if (!query) return true;
    const voulu = new URLSearchParams(query).get('onglet');
    if (!voulu) return true;
    /* Sans onglet dans l'URL, c'est le premier de la liste qu'on voit. */
    return ongletCourant ? ongletCourant === voulu : voulu === premierOnglet;
  }
  const { theme, toggle } = useTheme();

  /* Fermer le tiroir dès qu'on a choisi.
   *
   * Il ne se fermait que sur le chemin, et les onglets ne changent que la
   * query : cliquer « Achats » depuis « Ventes » laissait le tiroir
   * ouvert sur l'écran qu'on venait de demander, et il fallait un second
   * geste — fermer soi-même ce qu'on croyait avoir quitté. Les deux se
   * surveillent donc, le chemin et l'onglet. */
  useEffect(() => { onMobileClose(); }, [pathname, ongletCourant]);


  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });

  const [accordionOpen, setAccordionOpen] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem('sidebar-accordions') || '{}'); }
    catch { return {}; }
  });

  const [popup, setPopup] = useState<PopupState>(null);
  /* Le menu du bureau se replie aussi, une fois le choix fait.
   *
   * Déplié, il prend une colonne entière pour lister ce qu'on ne va plus
   * relire : on l'a ouvert pour choisir, et le choix est fait. Il restait
   * pourtant là, large, à côté de l'écran qu'on venait de demander —
   * donc un second geste pour récupérer la place, à chaque fois.
   *
   * Replié, il garde ses icônes et ses pastilles : rien ne disparaît, et
   * le survol rend les libellés. Le premier rendu ne compte pas — c'est
   * l'arrivée sur l'app, pas un choix de navigation, et replier alors
   * déferait la position qu'on avait laissée. */
  const premierRendu = useRef(true);
  useEffect(() => {
    if (premierRendu.current) { premierRendu.current = false; return; }
    setCollapsed(prev => {
      if (prev) return prev;
      localStorage.setItem('sidebar-collapsed', 'true');
      return true;
    });
    setPopup(null);
  }, [pathname, ongletCourant]);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showPopup = useCallback((e: React.MouseEvent, p: PopupState) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!p) return;
    setPopup({ ...p, y: p.kind === 'flyout' ? rect.top : rect.top + rect.height / 2 });
  }, []);

  const hidePopup = useCallback(() => {
    hideTimer.current = setTimeout(() => setPopup(null), 80);
  }, []);

  const keepPopup = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('sidebar-collapsed', String(next));
      if (next) setPopup(null);
      return next;
    });
  }

  function toggleAccordion(label: string) {
    setAccordionOpen(prev => {
      const next = { ...prev, [label]: !prev[label] };
      localStorage.setItem('sidebar-accordions', JSON.stringify(next));
      return next;
    });
  }

  async function handleLogout() {
    setConfirmLogout(false);
    await signOut(auth);
    router.push('/login');
  }

  const mobileNavItems = (
    <nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-2">
      {navVisible.map((item, i) => {
        if (item.type === 'accordion') {
          return (
            <AccordionItem
              key={i}
              item={item}
              estActif={estActif}
              enAttenteDe={enAttenteDe}
              open={!!accordionOpen[item.label]}
              onToggle={() => toggleAccordion(item.label)}
            />
          );
        }
        const Icon = item.icon;
        const active = estActif(item.href);
        return (
          <Link key={item.href} href={item.href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
              ${active ? 'bg-indigo-600 text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50'}`}>
            <Icon size={18} className="shrink-0" />
            <span>{item.label}</span>
            <Badge n={enAttenteDe(item.href)} actif={active} />
          </Link>
        );
      })}
    </nav>
  );

  /* Sur un téléphone, peu d'onglets se posent en barre basse plutôt que
     derrière un menu : le pouce les atteint, et surtout les pastilles
     restent visibles. Un compte enfermé dans un menu fermé ne prévient
     personne — c'est justement ce qu'on lui demande de faire.
     Au-delà de cinq, les libellés ne tiennent plus côte à côte : le menu
     reprend la main. */
  const onglets = navVisible.filter(i => 'href' in i) as Extract<NavItem, { href: string }>[];
  /* Seule une page qui apporte ses propres onglets y a droit : ailleurs, la
     navigation complète ne tiendrait pas sur une rangée.
     Et seulement si elle n'en replie aucun : la rangée ne sait porter que
     des liens, donc un menu groupé y perdrait ses groupes en silence —
     on croirait voir toute sa navigation en n'en voyant qu'un morceau. */
  const aDesGroupes = navVisible.some(i => i.type === 'accordion');
  const barreBasse = !!items && !aDesGroupes
    && onglets.length > 0 && onglets.length <= 5;

  return (
    <>
      {/* - Barre basse (< md), quand les onglets sont peu nombreux - */}
      {barreBasse && (
        <nav className="md:hidden fixed inset-x-0 bottom-0 z-40 flex border-t border-gray-200 bg-white/95 backdrop-blur dark:border-gray-700 dark:bg-gray-900/95"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {onglets.map(item => {
            const Icon = item.icon;
            const active = estActif(item.href);
            const n = enAttenteDe(item.href);
            return (
              <Link key={item.href} href={item.href}
                className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] font-medium transition-colors ${
                  active ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500'}`}>
                <span className="relative">
                  <Icon size={21} className="shrink-0" />
                  {/* La pastille se pose sur l'icône : au-delà de neuf,
                      « 9+ » — trois chiffres déborderaient. */}
                  {n > 0 && (
                    <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white tabular-nums dark:ring-gray-900">
                      {n > 9 ? '9+' : n}
                    </span>
                  )}
                </span>
                <span className="w-full truncate text-center leading-tight">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      )}

      {/* - Drawer mobile (< md) - */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {/* Overlay */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onMobileClose} />
          {/* Panneau */}
          <div className="relative w-72 max-w-[85vw] flex flex-col bg-white dark:bg-gray-900 h-full shadow-2xl">
            <div className="flex items-center justify-between px-4 py-4 border-b border-gray-100 dark:border-gray-700">
              <span className="text-xl font-bold text-indigo-600 dark:text-indigo-400 truncate">{titre ?? activite?.nom ?? 'Mon activité'}</span>
              <button onClick={onMobileClose}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500">
                <ChevronLeft size={20} />
              </button>
            </div>
            {user && (
              <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700">
                <p className="text-xs text-gray-400 truncate">{user.email}</p>
              </div>
            )}
            {mobileNavItems}
            <div className="px-2 py-3 border-t border-gray-100 dark:border-gray-700 space-y-1">
              <button onClick={toggle}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50">
                {theme === 'dark' ? <Sun size={18} className="text-yellow-400" /> : <Moon size={18} />}
                <span>{theme === 'dark' ? 'Mode clair' : 'Mode sombre'}</span>
              </button>
              <button onClick={() => setConfirmLogout(true)}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                <LogOut size={18} />
                <span>Se déconnecter</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* - Sidebar desktop (>= md) - */}
      <aside className={`hidden md:flex flex-col shrink-0 overflow-hidden bg-white dark:bg-gray-900
        border-r border-gray-200 dark:border-gray-700 transition-all duration-200
        ${collapsed ? 'w-16' : 'w-64'}`}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-5 border-b border-gray-100 dark:border-gray-700 min-h-[64px]">
          {!collapsed && <span className="text-xl font-bold text-indigo-600 dark:text-indigo-400 truncate">{titre ?? activite?.nom ?? 'Mon activité'}</span>}
          <button onClick={toggleCollapsed}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 ml-auto shrink-0">
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>

        {/* User */}
        {!collapsed && (
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user?.email}</p>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-2">
          {navVisible.map((item, i) => {
            if (item.type === 'accordion') {
              if (collapsed) {
                const isChildActive = item.children.some(c => estActif(c.href));
                /* Replié, le groupe ne montre qu'une icône : ce qui
                   attend dedans doit s'y voir, sinon la colonne étroite
                   devient le seul endroit de l'app qui ne prévient de
                   rien. */
                const attente = item.children.reduce(
                  (n, c) => n + enAttenteDe(c.href), 0);
                const Icon = item.icon;
                return (
                  <div key={i}
                    onMouseEnter={e => showPopup(e, { kind: 'flyout', label: item.label, children: item.children, y: 0 })}
                    onMouseLeave={hidePopup}>
                    <button className={`relative flex items-center justify-center w-full px-3 py-2.5 rounded-lg transition-colors
                      ${isChildActive ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50'}`}>
                      <Icon size={18} />
                      {attente > 0 && (
                        <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white tabular-nums dark:ring-gray-900">
                          {attente > 9 ? '9+' : attente}
                        </span>
                      )}
                    </button>
                  </div>
                );
              }
              return (
                <AccordionItem
                  key={i}
                  item={item}
                  estActif={estActif}
                  enAttenteDe={enAttenteDe}
                  open={!!accordionOpen[item.label]}
                  onToggle={() => toggleAccordion(item.label)}
                />
              );
            }

            const Icon = item.icon;
            const active = estActif(item.href);
            return (
              <div key={item.href}
                onMouseEnter={collapsed ? e => showPopup(e, { kind: 'tooltip', label: item.label, y: 0 }) : undefined}
                onMouseLeave={collapsed ? hidePopup : undefined}>
                <Link
                  href={item.href}
                  className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                    ${active ? 'bg-indigo-600 text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50'}`}
                >
                  <Icon size={18} className="shrink-0" />
                  {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
                  <Badge n={enAttenteDe(item.href)} actif={active} compact={collapsed} />
                </Link>
              </div>
            );
          })}
        </nav>

        {/* Bas */}
        <div className="px-2 py-3 border-t border-gray-100 dark:border-gray-700 space-y-1">
          <div
            onMouseEnter={collapsed ? e => showPopup(e, { kind: 'tooltip', label: theme === 'dark' ? 'Mode clair' : 'Mode sombre', y: 0 }) : undefined}
            onMouseLeave={collapsed ? hidePopup : undefined}>
            <button onClick={toggle}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium
                text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors">
              {theme === 'dark' ? <Sun size={18} className="shrink-0 text-yellow-400" /> : <Moon size={18} className="shrink-0" />}
              {!collapsed && <span className="whitespace-nowrap">{theme === 'dark' ? 'Mode clair' : 'Mode sombre'}</span>}
            </button>
          </div>

          <div
            onMouseEnter={collapsed ? e => showPopup(e, { kind: 'tooltip', label: 'Se déconnecter', y: 0 }) : undefined}
            onMouseLeave={collapsed ? hidePopup : undefined}>
            <button onClick={() => setConfirmLogout(true)}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium
                text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              <LogOut size={18} className="shrink-0" />
              {!collapsed && <span className="whitespace-nowrap">Se déconnecter</span>}
            </button>
          </div>
        </div>
      </aside>

      {/* Popup rendu EN DEHORS du aside — position:fixed, aucun overflow ne peut le couper */}
      {collapsed && (
        <FixedPopup
          popup={popup}
          estActif={estActif}
          enAttenteDe={enAttenteDe}
          onMouseEnter={keepPopup}
          onMouseLeave={hidePopup}
        />
      )}

      {/* Confirmation déconnexion */}
      {confirmLogout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setConfirmLogout(false)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-80 mx-4">
            <div className="flex flex-col items-center gap-3 mb-5">
              <div className="w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
                <LogOut size={22} className="text-red-500" />
              </div>
              <p className="text-base font-bold text-gray-900 dark:text-gray-100 text-center">Se déconnecter ?</p>
              <p className="text-sm text-gray-400 text-center">Tu seras redirigé vers la page de connexion.</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmLogout(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={handleLogout}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                Déconnecter
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
