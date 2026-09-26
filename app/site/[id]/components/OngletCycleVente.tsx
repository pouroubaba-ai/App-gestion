'use client';
import { marqueOrigine } from '@/lib/retour';
import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from './finance/font';
import { useRouter, useSearchParams } from 'next/navigation';
import { type RoleSite } from '@/lib/roles';
import { FileText, Loader2, Plus, ArrowUpDown, AlertTriangle, BarChart3, ShoppingCart, SlidersHorizontal } from 'lucide-react';
import {
  Vente, EtatVente, LIBELLES_VENTE, valeurVente, devisExpire,
  chargerVentesDuSite, peutCommander, Role, joursRestants, venteActive,
} from '@/lib/flux-marchandise';
import { ChampRecherche } from '@/components/Champs';
import FeuilleFiltreStatut from './FeuilleFiltreStatut';
import {
  chargerPreparationsDuSite, prepareParLigne, type Preparation,
} from '@/lib/preparations';
import ModalRapportVente from './ModalRapportVente';
import {
  useSites, FiltreSite, ToggleVue, CartesParSite,
  type PropsPortee,
} from './ContexteSites';
import ListeDossiers, { type Colonne } from './ListeDossiers';
import RangeeEtapes from './RangeeEtapes';

interface Props extends PropsPortee {
  userId: string;
  /** `null` = admin ou propriétaire : aucune restriction */
  role?: RoleSite | null;
}

const ROLE_COURANT: Role | null = null;

/* Une carte par étape du cycle : chacune répond à une question que les
   autres ne posent pas — qu'a-t-on proposé, qu'a-t-on à préparer, sur quoi
   travaille-t-on, qu'est-ce qui attend de partir, qu'est-ce qui est sorti. */
type Vue = EtatVente;

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Nombre de jours depuis une date, pour faire remonter ce qui traîne. */
function joursDepuis(s?: string | null): number {
  if (!s) return 0;
  const diff = Date.now() - new Date(s).getTime();
  return Math.max(0, Math.floor(diff / 86400000));
}

/**
 * Avancement d'une préparation. Une ligne est prête quand ce qu'on a trouvé
 * couvre ce qui a été demandé ; tant que `quantiteRecue` est absente, on n'a
 * pas encore compté cette ligne — elle est en cours, pas prête à zéro.
 */
function avancement(
  v: Vente, prepare?: Record<number, number>,
): { prets: number; enCours: number } {
  let prets = 0;
  v.lignes.forEach((l, i) => {
    const fait = prepare ? (prepare[i] ?? 0) : l.quantiteRecue;
    if (fait != null && fait >= l.quantiteDemandee) prets++;
  });
  return { prets, enCours: v.lignes.length - prets };
}

/** La date qui fait foi pour l'ancienneté : celle du dernier changement d'état. */
function dateEtat(v: Vente): string | null {
  return v.dateLivraison ?? v.datePret ?? v.datePreparation
    ?? v.dateCommande ?? v.dateDevis ?? null;
}

/* Tailwind ne peut pas générer une classe construite à l'exécution :
   les variantes doivent être écrites en toutes lettres. */

const COULEURS_ETAT: Record<EtatVente, string> = {
  devis:       'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  commande:    'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  preparation: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  pret:        'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400',
  livre:       'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  annule:      'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
};

export default function OngletCycleVente({ siteId, userId, role, sites, titre }: Props) {
  const ctx = useSites(siteId, sites);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ventes, setVentes] = useState<Vente[]>([]);
  const [loading, setLoading] = useState(true);
  /* La carte active transite par l'URL : sans ça, revenir d'un devis
     retombait sur la carte Commande, jamais sur celle qu'on avait quittée. */
  const [vueBrute, setVue] = useState<Vue>(
    (searchParams.get('carte') as Vue) ?? 'commande');

  /**
   * Deux façons de choisir ce qu'on regarde.
   *
   * On ouvre cet écran pour savoir ce qui attend, non pour compter les
   * statuts un par un : « En cours » répond en deux chiffres, ce qui
   * bouge et ce qui est fini. Chaque dossier porte alors son statut sur
   * un badge, là où il sert — dans la liste.
   *
   * « Statut » garde l'autre lecture, pour qui cherche une étape précise.
   */
  const [modeVue, setModeVue] = useState<'encours' | 'statut'>('encours');

  /* Les statuts retenus dans la liste. Vide = tous, l'etat au repos.
     Il ne sert qu'en vue « en cours » : ailleurs, la carte active a deja
     choisi l'etape. */
  const [filtreStatuts, setFiltreStatuts] = useState<EtatVente[]>([]);
  const [feuilleFiltre, setFeuilleFiltre] = useState(false);

  /* Le responsable des commandes fait avancer des dossiers, il ne répond pas
     des recettes du site : les montants ne lui apprendraient rien et exposent
     la marge de l'activité. Il compte des dossiers, pas des francs.
     Le devis n'est pas davantage son travail — proposer un prix engage celui
     qui répond du site. */
  const montreArgent = role !== 'commandes';
  /* Deux restrictions distinctes, qui tombent aujourd'hui sur le même rôle :
     l'une cache des montants, l'autre retire une étape. Les confondre sous
     un seul drapeau ferait disparaître le devis le jour où un rôle verrait
     les prix sans les proposer. */
  const montreDevis = role !== 'commandes';
  const etapes = (montreDevis
    ? ['devis', 'commande', 'preparation', 'pret', 'livre']
    : ['commande', 'preparation', 'pret', 'livre']) as EtatVente[];

  /* Une carte absente ne peut pas rester active : l'URL peut porter « devis »
     alors que le rôle ne l'ouvre pas. */
  const vue: Vue = etapes.includes(vueBrute as EtatVente) ? vueBrute : 'commande';

  const [recherche, setRecherche] = useState('');
  const [tri, setTri] = useState<
    'produits' | 'prets' | 'restants' | 'valeur' | 'avance' | 'reste' | 'manque'
    | 'anciennete' | null>(null);
  const [ordre, setOrdre] = useState<'asc' | 'desc'>('desc');
  const [modalRapport, setModalRapport] = useState(false);
  /* Tant qu'un dossier n'est pas pret, le prepare vit dans sa collection :
     la ligne ne le porte pas encore. Sans cette lecture, la colonne Manque
     resterait vide sur les dossiers en cours de preparation. */
  const [preparations, setPreparations] = useState<Map<string, Preparation[]>>(new Map());

  useEffect(() => { charger(); }, [ctx.portee]);

  async function charger() {
    setLoading(true);
    const [liste, prep] = await Promise.all([
      chargerVentesDuSite(ctx.portee),
      chargerPreparationsDuSite(ctx.portee).catch(() => new Map<string, Preparation[]>()),
    ]);
    setVentes(liste);
    setPreparations(prep);
    setLoading(false);
  }

  /* Ce qui a ete prepare sur un dossier. En preparation, cela vit dans la
     collection ; une fois le dossier pret, c'est fige sur la ligne. */
  function prepareDe(v: Vente): Record<number, number> {
    if (v.etat !== 'preparation') {
      return Object.fromEntries(v.lignes.map((l, i) => [i, l.quantiteRecue ?? 0]));
    }
    return prepareParLigne(preparations.get(v.id) ?? []);
  }

  /* Ce qui n'a pas pu etre servi. En preparation c'est un travail en cours ;
     une fois pret, c'est un non-livre assume. Le chiffre est le meme, le sens
     ne l'est pas. */
  function manqueDe(v: Vente): number {
    const prep = prepareDe(v);
    /* Valorise au prix de vente : ce qui manque, c'est le chiffre d'affaires
       qu'on ne fera pas, pas un nombre de pieces. Deux produits de prix
       differents ne se comparent pas en unites. */
    return v.lignes.reduce(
      (n, l, i) => n + Math.max(0, l.quantiteDemandee - (prep[i] ?? 0)) * (l.prixVente ?? 0),
      0);
  }

  /* Le reste se calcule, il ne se stocke pas : valeur du dossier moins ce qui
     a deja ete verse. */
  function resteDe(v: Vente): number {
    return Math.max(0, valeurVente(v.lignes) - (v.avanceVersee ?? 0));
  }

  if (loading) return (
    <div className="min-h-64 flex items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  /* L'onglet ne montre que ce qui est vivant : un dossier clos, annulé ou
     expiré s'archive et se consulte par le rapport. Sans ça, la carte Livré
     accumulerait des années de dossiers et noierait le travail du jour. */
  const actives = ventes.filter(venteActive);
  const parEtat = (e: EtatVente) => actives.filter(v => v.etat === e);
  /* En vue « en cours », la carte couvre tous les statuts sauf le livre :
     filtrer sur le seul « commande » aurait cache les dossiers en
     preparation, que la carte comptait pourtant. */
  /* Le devis suit le même sort que sa carte.
   *
   * Masquer la carte sans filtrer la liste laissait le devis apparaître
   * sous « Bons de commande » : le responsable des commandes y lisait une
   * proposition de prix qu'il n'a pas à connaître, et la carte affichait
   * un compte que la liste démentait. */
  const listeVue = modeVue === 'encours' && vue !== 'livre'
    ? actives.filter(v => v.etat !== 'livre'
        && (montreDevis || v.etat !== 'devis'))
    : parEtat(vue);

  /* Où en est le cycle d'un site : combien de dossiers à chaque étape, et
     ce qu'ils pèsent. Le total dit combien on vend, jamais quelle boutique
     traîne ses commandes. */
  function chiffresDuSite(id: string) {
    const sien = actives.filter(v => (v as any).siteId === id);
    const parE = (e: EtatVente) => sien.filter(v => v.etat === e);
    const valeur = (l: Vente[]) => l.reduce((t, v) => t + valeurVente(v.lignes), 0);
    return {
      total: sien.length,
      valeur: valeur(sien),
      etapes: etapes.map(e => {
        const l = parE(e);
        return { etat: e, label: LIBELLES_VENTE[e], n: l.length, valeur: valeur(l) };
      }),
    };
  }

  function basculer(col: typeof tri) {
    if (tri === col) setOrdre(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setTri(col); setOrdre('desc'); }
  }

  const q = recherche.trim().toLowerCase();
  /* Plus de filtre d'état : chaque carte ne contient qu'un état, et les
     annulés ne sont plus ici — ils sont archivés. */
  const filtreActif = modeVue === 'encours' && vue !== 'livre'
    && filtreStatuts.length > 0;
  const filtrees = listeVue.filter(v =>
    (!q || v.reference.toLowerCase().includes(q) || v.clientNom.toLowerCase().includes(q))
    && (!filtreActif || filtreStatuts.includes(v.etat)));

  const affiches = tri
    ? [...filtrees].sort((a, b) => {
        const val = (v: Vente) =>
          tri === 'produits' ? v.lignes.length
            : tri === 'prets' ? avancement(v, prepareDe(v)).prets
            /* trier par ce qui reste : ce qui est presque fini remonte */
            : tri === 'restants' ? avancement(v, prepareDe(v)).enCours
            : tri === 'valeur' ? valeurVente(v.lignes)
            : tri === 'avance' ? (v.avanceVersee ?? 0)
            : tri === 'reste' ? resteDe(v)
            : tri === 'manque' ? manqueDe(v)
            /* sans échéance, le dossier se range après ceux qui en ont une */
            : (joursRestants(v) ?? 9999);
        return (ordre === 'asc' ? 1 : -1) * (val(a) - val(b));
      })
    /* Sans tri choisi : le plus urgent d'abord — ce qui est en retard, puis
       ce qui arrive à échéance. Les dossiers sans échéance ferment la marche,
       et les dossiers clos se lisent du plus récent au plus ancien. */
    : [...filtrees].sort((a, b) => {
        const ra = joursRestants(a), rb = joursRestants(b);
        if (ra == null && rb == null) {
          return joursDepuis(dateEtat(b)) - joursDepuis(dateEtat(a));
        }
        return (ra ?? 9999) - (rb ?? 9999);
      });

  function Th({ cle, label }: { cle: NonNullable<typeof tri>; label: string }) {
    return (
      <th className="px-3 py-2.5 font-medium">
        <BoutonTri cle={cle} label={label} />
      </th>
    );
  }

  /* Le bouton seul, sans sa cellule : la liste des dossiers pose elle-même
     l'en-tête, et un `<th>` imbriqué dans un `<th>` ne serait pas du HTML. */
  function BoutonTri({ cle, label }: { cle: NonNullable<typeof tri>; label: string }) {
    return (
      <button onClick={() => basculer(cle)}
        className="w-full flex items-center justify-center gap-1 hover:opacity-80 transition-opacity">
        {label}
        <ArrowUpDown size={12} className={tri === cle ? 'opacity-100' : 'opacity-40'} />
      </button>
    );
  }


  /* Une carte par étape, dans l'ordre du cycle : la lecture de gauche à
     droite suit le chemin que parcourt une vente. */
  const CARTES: {
    key: EtatVente; label: string; emoji: string;
    sousTitre: string; alerte: string | null;
    /* Deux montants, pas une phrase : chacun se lit et se colore seul. */
    argent: { avance: number; reste: number } | null; manque: number;
    /* ce que la carte annonce en grand : un montant, ou un nombre */
    chiffre: string; dessous: string | null;
  }[] = etapes.map(e => {
    const liste = parEtat(e);
    const n = liste.length;
    /* Chaque étape a son propre signe de souffrance : un devis qui a expiré,
       un dossier qui stagne. L'alerte ne s'affiche que s'il y en a. */
    const expires = e === 'devis' ? liste.filter(devisExpire).length : 0;
    /* en retard = l'échéance promise est passée. Un dossier sans date promise
       ne peut pas être en retard : on n'a rien promis. */
    const anciens = e === 'devis' || e === 'livre' ? 0
      : liste.filter(v => (joursRestants(v) ?? 0) < 0).length;
    /* Un devis n'engage rien : ni avance, ni reste. Partout ailleurs, le
       montant seul ne dit pas si le dossier est paye. */
    const avance = liste.reduce((t, v) => t + (v.avanceVersee ?? 0), 0);
    const reste = liste.reduce((t, v) => t + resteDe(v), 0);
    /* Le manque ne vaut que la ou la marchandise se rassemble : avant, rien
       n'est commence ; apres la livraison, tout est joue. */
    const manque = e === 'preparation' || e === 'pret'
      ? liste.reduce((t, v) => t + manqueDe(v), 0) : 0;

    /* Sans les montants, la carte dit ce qu'il reste à faire : combien de
       dossiers, et combien d'entre eux butent sur un produit absent. */
    const incomplets = (e === 'preparation' || e === 'pret')
      ? liste.filter(v => manqueDe(v) > 0).length : 0;

    return {
      key: e,
      label: LIBELLES_VENTE[e],
      chiffre: montreArgent
        ? formatMontant(liste.reduce((t, v) => t + valeurVente(v.lignes), 0))
        : String(n),
      dessous: montreArgent ? null
        : e === 'livre' ? `commandé${n > 1 ? 's' : ''} livré${n > 1 ? 's' : ''}`
        : e === 'pret' ? `prêt${n > 1 ? 's' : ''} à livrer`
        : e === 'preparation'
          ? (incomplets > 0
              ? `dont ${incomplets} incomplet${incomplets > 1 ? 's' : ''}`
              : 'toutes servies')
        : `commandé${n > 1 ? 's' : ''}`,
      /* Les deux chiffres se lisent séparément — ce qui est rentré, ce
         qui reste à rentrer : les coller en une phrase obligeait à la
         relire pour distinguer l'un de l'autre. Un devis n'engage aucun
         argent, il n'en porte pas. */
      argent: e === 'devis' || !montreArgent ? null : { avance, reste },
      manque,
      emoji: e === 'devis' ? '📄'
        : e === 'commande' ? '📋'
        : e === 'preparation' ? '📦'
        : e === 'pret' ? '✅'
        : '🚚',
      /* Une pastille tient sur une ligne : le libellé reste court, sinon il
         déborde de la carte sur un écran étroit. */
      sousTitre: e === 'livre'
        ? `${n} livré${n > 1 ? 's' : ''}`
        : `${n} dossier${n > 1 ? 's' : ''}`,
      alerte: expires > 0 ? `${expires} expiré${expires > 1 ? 's' : ''}`
        : anciens > 0 ? `${anciens} en retard`
        : null,
    };
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'text-sm font-bold text-gray-900 dark:text-gray-100'}>
          {/* Sans devis, ce n'est plus un cycle mais une file de bons à
              servir : l'écran porte le nom de ce qu'il contient. */}
          {titre ?? (montreDevis ? 'Cycle de vente' : 'Bons de commande')}
        </p>
        <div className="flex items-center gap-2">
        {/* Le filtre porte sur tout l'écran, cartes comprises : le poser
            sous elles laisserait croire qu'il ne touche que le tableau. */}
        <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
        <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {/* Le rapport chiffre le cycle entier, pas l'étape ouverte : il ne
          suit aucune carte et ne vit pas dans le cadre d'une seule d'entre
          elles. Il se tient au-dessus, où sa portée se lit. */}
      {montreArgent && (
        <div className="mb-3 flex">
          <button onClick={() => setModalRapport(true)}
            className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-indigo-400 hover:text-indigo-600 text-xs font-bold rounded-xl transition-colors">
            <BarChart3 size={14} /> Rapport
          </button>
        </div>
      )}

      {ctx.parSite ? (
        /* Une carte par site : où en sont ses dossiers, étape par étape. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          return {
            titre: montreArgent ? 'En cours' : 'Dossiers en cours',
            valeur: montreArgent ? formatMontant(c.valeur) : String(c.total),
            dort: c.total === 0,
            badge: c.total > 0
              ? {
                  texte: `${c.total} dossier${c.total > 1 ? 's' : ''}`,
                  ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                }
              : null,
            /* Chaque étape du cycle, dans l'ordre où une vente les traverse. */
            lignes: c.etapes.map(e => ({
              label: `${e.label} · ${e.n}`,
              valeur: montreArgent ? formatMontant(e.valeur) : String(e.n),
              vide: e.n === 0,
            })),
          };
        }} />
      ) : (
      <>
      {/* Le choix de lecture, avant les cartes qu'il commande. */}
      <div className="mb-3 flex">
        <div className="flex gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
          {([
            { cle: 'encours' as const, label: 'En cours' },
            { cle: 'statut' as const, label: 'Statut' },
          ]).map(o => (
            <button key={o.cle} type="button"
              onClick={() => {
                setModeVue(o.cle);
                /* Passer à « en cours » sur un statut intermédiaire
                   laisserait la liste filtrée sur une carte qui n'est plus
                   affichée : on la ramène sur ce qui bouge. */
                if (o.cle === 'encours' && vue !== 'livre') {
                  setVue('commande'); setTri(null);
                }
              }}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                modeVue === o.cle
                  ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                  : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* En cours : deux cartes, non cinq. Ce qui bouge d'un côté, ce qui
          est fini de l'autre — et le statut de chaque dossier se lit sur
          son badge, dans la liste. */}
      {modeVue === 'encours' && (
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:gap-4">
        {([
          { cle: 'encours' as const, emoji: '📦', label: 'En cours',
            etats: etapes.filter(e => e !== 'livre') },
          { cle: 'livre' as const, emoji: '🚚', label: 'Livré',
            etats: ['livre'] as EtatVente[] },
        ]).map(c => {
          const liste = c.etats.flatMap(e => parEtat(e));
          /* La carte « en cours » est active tant qu'on n'est pas sur le
             livré : elle couvre tous les autres statuts. */
          const actif = c.cle === 'livre' ? vue === 'livre' : vue !== 'livre';
          return (
            <button key={c.cle}
              onClick={() => {
                const cible: EtatVente = c.cle === 'livre' ? 'livre' : 'commande';
                setVue(cible); setTri(null);
                router.replace(ctx.ensemble
                  ? `/ensemble?onglet=cycle-vente&carte=${cible}`
                  : `/site/${siteId}?onglet=cycle-vente&carte=${cible}`, { scroll: false });
              }}
              className={`block rounded-2xl p-3 text-left shadow-sm transition-all sm:p-5 ${
                actif
                  ? 'text-white'
                  : 'border border-black/[0.06] bg-white hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900'}`}
              style={actif
                ? { background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }
                : undefined}>
              {/* L'embleme et le nom sur une ligne : empiles, ils
                  poussaient le chiffre hors de la premiere vue pour ne rien
                  dire de plus. */}
              <span className="flex items-center gap-2">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] text-[15px] ${
                  actif ? 'bg-white/15' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
                  {c.emoji}
                </span>
                <span className={`min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-wide ${
                  actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                  {c.label}
                </span>
              </span>
              {/* Le compte, et lui seul : « 1 dossier » sous un « 1 » ne
                  faisait que le redire. */}
              <span className={`${hankenGrotesk.className} mt-1.5 block text-[19px] font-bold leading-7 tracking-tight sm:text-[26px] sm:leading-8 ${
                actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                {montreArgent
                  ? formatMontant(liste.reduce((t, v) => t + valeurVente(v.lignes), 0))
                  : liste.length}
              </span>
              {/* Sans les montants, le grand chiffre compte deja les
                  dossiers : la mention n'a de sens que s'il compte des
                  francs. */}
              {montreArgent && (
                <span className={`mt-0.5 block text-[11px] ${
                  actif ? 'text-indigo-100/80' : 'text-neutral-400'}`}>
                  {liste.length} dossier{liste.length > 1 ? 's' : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>
      )}

      {modeVue === 'statut' && (
      <>
      {/* Modèle des cartes de fonds : emoji, titre en capitales, montant en
          gros, et la carte choisie passe en dégradé. */}
      <RangeeEtapes grille={`sm:grid-cols-3 ${montreDevis ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        {CARTES.map(c => {
          const actif = vue === c.key;
          return (
            /* En rangée, la tuile porte sa propre largeur : `flex` la
               réduirait sinon à son contenu. */
            <button key={c.key}
              onClick={() => {
                setVue(c.key); setTri(null);
                /* l'URL suit la carte : la fiche saura où revenir */
                router.replace(ctx.ensemble
                  ? `/ensemble?onglet=cycle-vente&carte=${c.key}`
                  : `/site/${siteId}?onglet=cycle-vente&carte=${c.key}`, { scroll: false });
              }}
              className={`block rounded-2xl p-3 text-left shadow-sm transition-all sm:p-5 ${
                actif
                  ? 'text-white'
                  : 'border border-black/[0.06] bg-white hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900'}`}
              style={actif
                ? { background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }
                : undefined}>
              <div className="flex items-start justify-between gap-3">
                <span className={`flex h-8 w-8 items-center justify-center rounded-[10px] text-lg ${
                  actif ? 'bg-white/15' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
                  {c.emoji}
                </span>
                {/* La pastille compte les dossiers ; sans les montants, le
                    grand chiffre les compte déjà. */}
                {montreArgent && (
                  <span className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-bold ${
                    actif
                      ? 'bg-white/15 text-indigo-100'
                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                    {c.sousTitre}
                  </span>
                )}
              </div>
              <p className={`mt-3 text-[11px] font-bold uppercase tracking-wide ${
                actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                {c.label}
              </p>
              <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight ${
                actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                {c.chiffre}
              </p>
              {c.dessous && (
                <p className={`mt-0.5 text-[11px] font-medium ${
                  actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                  {c.dessous}
                </p>
              )}
              {/* Le cycle porte cinq étapes là où l'achat en a quatre : ses
                  tuiles sont plus étroites, et un montant qui se coupe en
                  « 0 » puis « FCFA » ne se lit plus. On empêche la césure
                  et on resserre le texte. */}
              {c.argent && (
                <div className={`mt-2.5 flex flex-wrap justify-between gap-x-2 gap-y-1 border-t pt-2 text-[11px] ${
                  actif ? 'border-white/15' : 'border-black/[0.06] dark:border-white/10'}`}>
                  <span className="flex items-baseline gap-1 whitespace-nowrap">
                    <span className={actif ? 'text-indigo-100' : 'text-neutral-400'}>
                      Avancé
                    </span>
                    <span className={`font-bold ${actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                      {formatMontant(c.argent.avance)}
                    </span>
                  </span>
                  <span className="flex items-baseline gap-1 whitespace-nowrap">
                    <span className={actif ? 'text-indigo-100' : 'text-neutral-400'}>Reste</span>
                    {/* Ce qui reste dû appelle un geste : il se colore, le
                        reste non. */}
                    <span className={`font-bold ${c.argent.reste > 0
                      ? (actif ? 'text-amber-200' : 'text-orange-500')
                      : (actif ? 'text-white' : 'text-neutral-900 dark:text-white')}`}>
                      {formatMontant(c.argent.reste)}
                    </span>
                  </span>
                </div>
              )}
              {/* Une seule alerte, la plus grave : ne pas pouvoir servir pese
                  plus que d'avoir du retard. La tuile n'en porte pas deux. */}
              {((c.manque > 0 && montreArgent) || c.alerte) && (
                <p className={`mt-2 flex items-center gap-1 text-xs font-medium ${
                  actif ? 'text-amber-200' : 'text-orange-500'}`}>
                  <AlertTriangle size={11} />
                  {c.manque > 0 && montreArgent
                    ? `${c.key === 'pret' ? 'Non livré' : 'Manque'} ${formatMontant(c.manque)}`
                    : c.alerte}
                </p>
              )}
            </button>
          );
        })}
      </RangeeEtapes>
      </>
      )}

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            {LIBELLES_VENTE[vue]}
            {/* La carte Livré ne porte que le jour : sans cette mention, son
                montant se lirait comme un cumul. */}
            {vue === 'livre' && <span className="font-medium text-gray-400"> aujourd'hui</span>}
          </p>
          {/* Seuls devis et commande s'ouvrent : les autres états sont atteints
              par le cycle, jamais créés. Le bouton suit donc la carte active,
              et disparaît là où il n'y a rien à créer. */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Le comptoir ne dépend d'aucune carte : sa vente naît livrée,
                sans passer par les états que les cartes représentent. */}
            {/* Le comptoir encaisse : il appartient à qui répond du site, pas
                à qui saisit les commandes. */}
            {/* Vendre se fait dans un site : le comptoir en exige un. */}
            {(role == null || role === 'gerant') && ctx.siteEcriture && (
              <button
                /* L'origine suit : sans elle, quitter le comptoir ouvert
                   depuis l'ensemble renvoyait dans le site. */
                onClick={() => router.push(
                  `/site/${ctx.siteEcriture}/comptoir${marqueOrigine(ctx.ensemble)}`)}
                className="flex items-center gap-1.5 px-3 py-2 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-xs font-bold rounded-xl transition-colors">
                <ShoppingCart size={14} /> Comptoir
              </button>
            )}
            {/* Ouvrir un dossier engage le site sur un prix : ce rôle fait
                avancer ce qui existe, il ne crée pas. */}
            {montreArgent && peutCommander(ROLE_COURANT) && ctx.siteEcriture && (vue === 'devis' || vue === 'commande') && (
              <button
                onClick={() => router.push(
                  /* L'origine suit la creation : sans elle, un dossier
                     ouvert depuis l'ensemble s'y refermerait dans le site. */
                  `/site/${ctx.siteEcriture}/ventes/nouveau${vue === 'devis' ? '?type=devis' : ''}`
                  + marqueOrigine(ctx.ensemble, vue !== 'devis'))}
                className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
                {vue === 'devis' ? <FileText size={14} /> : <Plus size={14} />}
                {vue === 'devis' ? 'Nouveau devis' : 'Nouvelle commande'}
              </button>
            )}
          </div>
        </div>

        {listeVue.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <ChampRecherche className="flex-1 min-w-[200px]"
              placeholder="Rechercher une référence, un client…"
              valeur={recherche} onChange={setRecherche} />
            {/* Le filtre ne parait qu'ou il sert : en vue « statut », la
                carte active a deja choisi l'etape, et en « livre » il n'y
                a qu'un seul statut. */}
            {modeVue === 'encours' && vue !== 'livre' && (
              <button type="button" onClick={() => setFeuilleFiltre(true)}
                className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                  filtreActif
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-800/40 dark:bg-indigo-900/20 dark:text-indigo-400'
                    : 'border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700 dark:text-gray-300'}`}>
                <SlidersHorizontal size={13} />
                Statut
                {filtreActif && (
                  <span className="rounded-md bg-indigo-600 px-1.5 text-[10px] text-white">
                    {filtreStatuts.length}
                  </span>
                )}
              </button>
            )}
          </div>
        )}

        {affiches.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-8">
            {q ? 'Aucun résultat.' : 'Aucun dossier.'}
          </p>
        ) : (
          <ListeDossiers
            dossiers={affiches}
            cleDe={v => v.id}
            compte={`${affiches.length} dossier${affiches.length > 1 ? 's' : ''}`}
            /* La carte qu'on regardait part avec le lien : un devis
               transformé en commande se ferme sur Devis, là où on l'a ouvert. */
            onOuvrir={v => router.push(
              `/site/${(v as any).siteId ?? ctx.siteEcriture}/ventes/${v.id}?carte=${vue}${ctx.ensemble ? '&de=ensemble' : ''}`)}
            colonnes={[
              { cle: 'reference', label: 'Référence', rang: 'titre',
                rendu: v => (
                  <span className="inline-flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{v.reference}</span>
                    {/* Le statut colle a la reference : en colonne propre,
                        il portait un libelle « Statut » qui n'apprenait
                        rien, et le badge disait deja ce qu'il etait. */}
                    {modeVue === 'encours' && vue !== 'livre' && (
                      <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        v.etat === 'preparation'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                          : v.etat === 'pret'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                        {LIBELLES_VENTE[v.etat]}
                      </span>
                    )}
                  </span>
                ) },
              /* Pas d'état : la carte ouverte le dit déjà, et tous les
                 dossiers de la liste le partagent — le répéter sur chaque
                 ligne ne distinguerait rien. Les achats font de même.
                 Sauf chez les devis, où il ne répète pas : un devis expiré
                 reste rangé parmi les devis, et seule cette colonne le
                 signale. */
              ...(vue === 'devis' ? [{
                cle: 'etat', label: 'État', rang: 'marque' as const,
                rendu: (v: Vente) => {
                  const expire = devisExpire(v);
                  return (
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      expire ? 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400' : COULEURS_ETAT[v.etat]}`}>
                      {expire ? 'Devis expiré' : LIBELLES_VENTE[v.etat]}
                    </span>
                  );
                },
              }] : []),
              { cle: 'client', label: 'Client', rang: 'corps',
                rendu: v => <span className="text-gray-500">{v.clientNom}</span> },
              ...(ctx.ensemble ? [{
                cle: 'site', label: 'Site', rang: 'corps' as const,
                rendu: (v: Vente) => (
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {ctx.nomDe((v as any).siteId)}
                  </span>
                ),
              }] : []),
              /* Deux dates : celle de l'engagement, et celle de son
                 échéance. L'une sans l'autre ne dit rien. */
              { cle: 'date', label: vue === 'devis' ? 'Devis' : 'Commande', rang: 'corps',
                rendu: v => (
                  <span className="text-gray-500">
                    {formatDate(vue === 'devis' ? v.dateDevis : v.dateCommande)}
                  </span>
                ) },
              ...(vue !== 'livre' ? [{
                cle: 'echeance', label: vue === 'devis' ? 'Expiration' : 'Livraison',
                rang: 'corps' as const,
                rendu: (v: Vente) => {
                  const restants = joursRestants(v);
                  return (
                    <span className={restants != null && restants < 0
                      ? 'text-red-500 font-medium' : 'text-gray-500'}>
                      {formatDate(vue === 'devis' ? v.validiteDevis : v.dateLivraisonPrevue)}
                    </span>
                  );
                },
              }] : []),
              { cle: 'produits', label: 'Produits', rang: 'corps',
                enTete: <BoutonTri cle="produits" label="Produits" />,
                rendu: v => v.lignes.length },
              /* « 12 produits » ne dit pas si le travail est presque fini
                 ou pas commencé : ces deux colonnes le disent. */
              ...(vue === 'preparation' ? [
                { cle: 'prets', label: 'Prêts', rang: 'corps' as const,
                  enTete: <BoutonTri cle="prets" label="Prêts" />,
                  rendu: (v: Vente) => {
                    const a = avancement(v, prepareDe(v));
                    return (
                      <span className={`font-medium ${
                        a.prets === v.lignes.length ? 'text-green-600' : 'text-gray-500'}`}>
                        {a.prets}
                      </span>
                    );
                  } },
                { cle: 'restants', label: 'En cours', rang: 'corps' as const,
                  enTete: <BoutonTri cle="restants" label="En cours" />,
                  rendu: (v: Vente) => {
                    const a = avancement(v, prepareDe(v));
                    return (
                      <span className={`font-medium ${
                        a.enCours > 0 ? 'text-amber-600' : 'text-gray-300 dark:text-gray-700'}`}>
                        {a.enCours > 0 ? a.enCours : '—'}
                      </span>
                    );
                  } },
              ] : []),
              ...(montreArgent ? [{
                cle: 'valeur', label: 'Valeur', rang: 'corps' as const,
                enTete: <BoutonTri cle="valeur" label="Valeur" />,
                rendu: (v: Vente) => (
                  <span className="font-bold text-gray-900 dark:text-gray-100">
                    {formatMontant(valeurVente(v.lignes))}
                  </span>
                ),
              }] : []),
              /* Un devis ne reçoit aucun versement : la colonne y serait
                 vide, et surtout elle laisserait croire le contraire.
                 Avant la livraison l'argent est en dépôt — c'est une
                 avance ; après, il éteint une dette — c'est un versement. */
              ...(montreArgent && vue !== 'devis' ? [
                { cle: 'avance', label: vue === 'livre' ? 'Versé' : 'Avance',
                  rang: 'corps' as const,
                  enTete: <BoutonTri cle="avance" label={vue === 'livre' ? 'Versé' : 'Avance'} />,
                  rendu: (v: Vente) => (
                    <span className="text-gray-500">
                      {(v.avanceVersee ?? 0) > 0 ? formatMontant(v.avanceVersee) : '—'}
                    </span>
                  ) },
                /* Le reste se calcule : c'est lui qu'on regarde pour savoir
                   ce qu'il faut encore encaisser. Rien ne reste dû : le
                   dossier est soldé, et ce n'est pas une information neutre. */
                { cle: 'reste', label: 'Reste', rang: 'corps' as const,
                  enTete: <BoutonTri cle="reste" label="Reste" />,
                  rendu: (v: Vente) => {
                    const r = resteDe(v);
                    return (
                      <span className={`font-medium ${
                        r > 0 ? 'text-gray-900 dark:text-gray-100' : 'text-green-600'}`}>
                        {r > 0 ? formatMontant(r) : 'Soldé'}
                      </span>
                    );
                  } },
              ] : []),
              /* Le meme chiffre, deux sens : en preparation un travail
                 inacheve, une fois pret un non-livre assume. */
              ...(montreArgent && (vue === 'preparation' || vue === 'pret') ? [{
                cle: 'manque', label: vue === 'pret' ? 'Non livré' : 'Manque',
                rang: 'corps' as const,
                enTete: <BoutonTri cle="manque" label={vue === 'pret' ? 'Non livré' : 'Manque'} />,
                rendu: (v: Vente) => {
                  const m = manqueDe(v);
                  return (
                    <span className={`font-bold ${
                      m > 0 ? 'text-orange-500' : 'text-gray-300 dark:text-gray-700'}`}>
                      {m > 0 ? formatMontant(m) : '—'}
                    </span>
                  );
                },
              }] : []),
              /* Chaque étape court vers sa propre échéance : un devis vers
                 son expiration, une commande vers sa livraison.
                 Négatif = l'échéance est passée. Le seuil n'est plus une
                 convention arbitraire : c'est zéro. */
              { cle: 'anciennete', label: vue === 'devis' ? 'Expire dans' : 'Livraison dans',
                rang: 'pied',
                enTete: <BoutonTri cle="anciennete"
                  label={vue === 'devis' ? 'Expire dans' : 'Livraison dans'} />,
                rendu: v => {
                  const restants = joursRestants(v);
                  return (
                    <span className={
                      restants == null ? 'text-gray-300 dark:text-gray-700'
                        : restants < 0 ? 'text-red-500 font-bold'
                        : restants <= 2 ? 'text-orange-500 font-medium'
                        : 'text-gray-500'}>
                      {restants == null ? '—' : `${restants} j`}
                    </span>
                  );
                } },
            ] as Colonne<Vente>[]}
          />
        )}
      </div>
      </>
      )}

      {/* Le filtre par statut : il reprend le choix que les tuiles
          offraient, sans quitter la vue d'ensemble. */}
      {feuilleFiltre && (
        <FeuilleFiltreStatut
          options={etapes.filter(e => e !== 'livre').map(e => ({
            cle: e, label: LIBELLES_VENTE[e], n: parEtat(e).length,
          }))}
          choisis={filtreStatuts}
          onChange={c => setFiltreStatuts(c as EtatVente[])}
          onFermer={() => setFeuilleFiltre(false)} />
      )}

      {/* Le rapport lit toutes les ventes, pas seulement les vivantes : il
          regarde une période écoulée, là où l'onglet montre le travail en cours. */}
      {modalRapport && (
        <ModalRapportVente ventes={ventes} onFermer={() => setModalRapport(false)} />
      )}
    </div>
  );
}
