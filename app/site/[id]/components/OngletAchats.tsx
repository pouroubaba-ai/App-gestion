'use client';
import { marqueOrigine } from '@/lib/retour';
import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from './finance/font';
import { useRouter, useSearchParams } from 'next/navigation';
import { type RoleSite } from '@/lib/roles';
import { Loader2, Plus, AlertTriangle, ArrowUpDown, SlidersHorizontal } from 'lucide-react';
import {
  Achat, EtatAchat, LIBELLES_ACHAT, ETAPES_ACHAT,
  valeurEnvoyee, valeurRecue, ecartsSepares, produitsEnEcart,
  chargerAchatsDuSite, peutCommander, Role,
} from '@/lib/flux-marchandise';
import { ChampRecherche } from '@/components/Champs';
import FeuilleFiltreStatut from './FeuilleFiltreStatut';
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

/* les rôles n'existent pas encore ici : null laisse tout permis */
const ROLE_COURANT: Role | null = null;

/**
 * Une vue par étape du cycle : on lit les dossiers qui attendent le même
 * geste, plutôt qu'un mélange qu'il faut retrier à l'œil.
 */
type Vue = EtatAchat;

/* Deux lectures des mêmes achats : par dossier, ou par fournisseur. Un écart
   isolé est un incident ; répété, c'est un comportement. */
type Axe = 'document' | 'fournisseur';

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

const EMOJIS_ETAT: Record<EtatAchat, string> = {
  en_attente: '⏳',
  recu: '📥',
  traitement: '⚖️',
  confirme: '✅',
  annule: '🚫',
};

export default function OngletAchats({ siteId, userId, role, sites, titre }: Props) {
  const ctx = useSites(siteId, sites);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [achats, setAchats] = useState<Achat[]>([]);
  const [loading, setLoading] = useState(true);
  const [recherche, setRecherche] = useState('');
  /* Le tri est propre à chaque axe : on ne classe pas des dossiers et des
     fournisseurs sur les mêmes colonnes. */
  const [tri, setTri] = useState<
    'valeur' | 'verse' | 'reste' | 'manque' | 'surplus' | null>(null);

  /* Le responsable des commandes fait avancer des dossiers, il ne répond pas
     des dépenses du site : les montants ne lui apprennent rien et exposent ce
     que l'activité engage. Il compte des dossiers et des produits. */
  const montreArgent = role !== 'commandes';
  const [ordre, setOrdre] = useState<'asc' | 'desc'>('desc');

  /* Recliquer la même colonne inverse le sens : c'est le geste attendu, et il
     évite un second bouton pour dire dans quel ordre on veut lire. */
  function basculer(col: typeof tri) {
    if (tri === col) setOrdre(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setTri(col); setOrdre('desc'); }
  }

  function ordonner<T>(liste: T[], valeur: ((x: T) => number) | null): T[] {
    if (!valeur) return liste;
    return [...liste].sort((a, b) => (ordre === 'asc' ? 1 : -1) * (valeur(a) - valeur(b)));
  }

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

  /* La carte et l'axe ouverts transitent par l'URL : sans ça, revenir d'une
     fiche retombait sur la carte par défaut. */
  /**
   * Deux façons de choisir ce qu'on regarde.
   *
   * On ouvre cet écran pour savoir ce qui attend, non pour compter les
   * statuts un par un : « En cours » répond en deux chiffres, ce qui
   * bouge et ce qui est clos. Chaque dossier porte alors son statut sur
   * un badge, là où il sert — dans la liste.
   */
  const [modeVue, setModeVue] = useState<'encours' | 'statut'>('encours');
  /* Les statuts retenus. Vide = tous, l'état au repos. */
  const [filtreStatuts, setFiltreStatuts] = useState<EtatAchat[]>([]);
  const [feuilleFiltre, setFeuilleFiltre] = useState(false);

  const [vue, setVueBrut] = useState<Vue>(() => {
    const c = searchParams.get('carte') as Vue | null;
    return c && ETAPES_ACHAT.includes(c) ? c : 'en_attente';
  });
  const [axeBrut, setAxeBrut] = useState<Axe>(
    searchParams.get('axe') === 'fournisseur' ? 'fournisseur' : 'document');

  /* Juger un fournisseur sur la durée relève de celui qui le choisit. Le
     responsable des commandes fait avancer des dossiers : il n'a qu'une
     lecture, celle par document. */
  const montreAxes = role !== 'commandes';
  /* L'adresse peut porter `axe=fournisseur` — un lien gardé, un retour de
     fiche. Cacher le bouton ne suffirait pas : l'axe se force. */
  const axe: Axe = montreAxes ? axeBrut : 'document';

  /* `replace` plutôt que `push` : basculer entre deux cartes n'a pas à
     remplir l'historique. */
  function poserUrl(cle: string, valeur: string) {
    const params = new URLSearchParams(window.location.search);
    params.set(cle, valeur);
    window.history.replaceState(null, '', `?${params.toString()}`);
  }
  function setVue(v: Vue) { setVueBrut(v); poserUrl('carte', v); }
  function setAxe(a: Axe) { setAxeBrut(a); poserUrl('axe', a); }

  useEffect(() => { charger(); }, [ctx.portee]);

  async function charger() {
    setLoading(true);
    setAchats(await chargerAchatsDuSite(ctx.portee));
    setLoading(false);
  }

  if (loading) return (
    <div className="min-h-64 flex items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const parEtat = (e: EtatAchat) => achats.filter(a => a.etat === e);

  /* Où en sont les achats d'un site : combien de dossiers à chaque étape,
     et ce qu'ils pèsent. Le total dit combien on achète, jamais quelle
     boutique laisse ses réceptions en attente. */
  function chiffresDuSite(id: string) {
    const siens = achats.filter(a => (a as any).siteId === id);
    return {
      total: siens.length,
      /* Tant que rien n'est compté, le dossier ne vaut que ce qui était
         annoncé ; une fois traité, il vaut ce qui est arrivé. */
      valeur: siens.reduce((n, a) => n + ((a.etat === 'traitement' || a.etat === 'confirme')
        ? valeurRecue(a.lignes) : valeurEnvoyee(a.lignes)), 0),
      etapes: ETAPES_ACHAT.map(e => {
        const l = siens.filter(a => a.etat === e);
        const compte = e === 'traitement' || e === 'confirme';
        return {
          label: LIBELLES_ACHAT[e],
          n: l.length,
          valeur: l.reduce((n, a) => n + (compte
            ? valeurRecue(a.lignes) : valeurEnvoyee(a.lignes)), 0),
        };
      }),
    };
  }

  /* Une carte par étape, dans l'ordre du cycle. */
  const CARTES = ETAPES_ACHAT.map(e => {
    const liste = parEtat(e);
    /* Tant que rien n'est compté, le dossier ne vaut que ce qui était
       annoncé ; une fois traité, il vaut ce qui est arrivé. */
    const compte = e === 'traitement' || e === 'confirme';
    const valeur = liste.reduce((s, a) => s + (compte
      ? valeurRecue(a.lignes) : valeurEnvoyee(a.lignes)), 0);
    const verse = liste.reduce((s, a) => s + (a.avanceVersee ?? 0), 0);
    /* Un écart n'existe qu'une fois compté : avant le traitement, il n'y a
       rien à confronter. */
    const ecarts = compte
      ? liste.reduce((acc, a) => {
          const x = ecartsSepares(a.lignes);
          return { positif: acc.positif + x.positif, negatif: acc.negatif + x.negatif };
        }, { positif: 0, negatif: 0 })
      : { positif: 0, negatif: 0 };
    /* Le même constat en produits : combien manquent, combien dépassent. */
    const produits = compte
      ? liste.reduce((acc, a) => {
          const x = produitsEnEcart(a.lignes);
          return { manque: acc.manque + x.manque, surplus: acc.surplus + x.surplus };
        }, { manque: 0, surplus: 0 })
      : { manque: 0, surplus: 0 };

    return {
      cle: e,
      emoji: EMOJIS_ETAT[e],
      titre: LIBELLES_ACHAT[e],
      montant: valeur,
      /* Avant la réception l'argent porte sur une promesse ; après, sur une
         marchandise reçue. */
      libelleVerse: e === 'en_attente' ? 'Avance' : 'Versé',
      verse,
      reste: Math.max(0, valeur - verse),
      nb: liste.length,
      ecarts,
      produits,
    };
  });

  /* En vue « en cours », la carte couvre tous les statuts sauf le
     confirmé : filtrer sur le seul « en attente » aurait caché les
     dossiers reçus, que la carte comptait pourtant. */
  const listeVue = modeVue === 'encours' && vue !== 'confirme'
    ? achats.filter(a => a.etat !== 'confirme' && a.etat !== 'annule')
    : parEtat(vue);
  const compteVue = vue === 'traitement' || vue === 'confirme';

  const q = recherche.trim().toLowerCase();
  const filtreActif = modeVue === 'encours' && vue !== 'confirme'
    && filtreStatuts.length > 0;
  /* Ce qu'une colonne vaut sur un dossier. L'écart se classe sur ce qu'il
     pèse, manque ou surplus confondus : un dossier où tout diverge appelle
     une décision, quel que soit le sens de la divergence. */
  const valeurDe = (a: Achat) => compteVue ? valeurRecue(a.lignes) : valeurEnvoyee(a.lignes);
  const affiches = ordonner(
    listeVue.filter(a => (!q
      || a.reference.toLowerCase().includes(q)
      || a.fournisseurNom.toLowerCase().includes(q))
      && (!filtreActif || filtreStatuts.includes(a.etat))),
    tri === 'valeur' ? (a => valeurDe(a))
      : tri === 'verse' ? (a => a.avanceVersee ?? 0)
      : tri === 'reste' ? (a => Math.max(0, valeurDe(a) - (a.avanceVersee ?? 0)))
      /* On classe sur ce qu'on montre : des francs pour qui répond des
         dépenses, des produits pour qui réclame au fournisseur. */
      : tri === 'manque' ? (a => montreArgent
          ? ecartsSepares(a.lignes).positif : produitsEnEcart(a.lignes).manque)
      : tri === 'surplus' ? (a => montreArgent
          ? ecartsSepares(a.lignes).negatif : produitsEnEcart(a.lignes).surplus)
      : null);

  /* Vue par fournisseur : on ne juge plus un dossier mais un partenaire. */
  const parFournisseur = [...affiches.reduce((acc, a) => {
    const cle = a.fournisseurId ?? a.fournisseurNom;
    const prev = acc.get(cle) ?? {
      id: a.fournisseurId ?? null, nom: a.fournisseurNom,
      documents: 0, valeur: 0, verse: 0,
      positif: 0, negatif: 0, manque: 0, surplus: 0,
    };
    const e = compteVue ? ecartsSepares(a.lignes) : { positif: 0, negatif: 0 };
    const pr = compteVue ? produitsEnEcart(a.lignes) : { manque: 0, surplus: 0 };
    acc.set(cle, {
      ...prev,
      documents: prev.documents + 1,
      valeur: prev.valeur + (compteVue ? valeurRecue(a.lignes) : valeurEnvoyee(a.lignes)),
      verse: prev.verse + (a.avanceVersee ?? 0),
      positif: prev.positif + e.positif,
      negatif: prev.negatif + e.negatif,
      manque: prev.manque + pr.manque,
      surplus: prev.surplus + pr.surplus,
    });
    return acc;
  }, new Map<string, {
    id: string | null; nom: string; documents: number;
    valeur: number; verse: number; positif: number; negatif: number;
    manque: number; surplus: number;
  }>())].map(([, v]) => v);

  const fournisseursAffiches = ordonner(parFournisseur,
    tri === 'valeur' ? (f => f.valeur)
      : tri === 'verse' ? (f => f.verse)
      : tri === 'reste' ? (f => Math.max(0, f.valeur - f.verse))
      : tri === 'manque' ? (f => montreArgent ? f.positif : f.manque)
      : tri === 'surplus' ? (f => montreArgent ? f.negatif : f.surplus)
      /* Sans tri choisi, le plus gros d'abord : c'est celui qui engage le
         plus d'argent avec ce fournisseur. */
      : (f => f.valeur));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'text-sm font-bold text-gray-900 dark:text-gray-100'}>
          {titre ?? 'Achats'}
        </p>
        <div className="flex items-center gap-2">
        {/* Le total dit combien on achète, jamais où les dossiers traînent. */}
        <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
        <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {/* Modèle de fond : emoji, compte en pastille, montant en gros, et la
          carte choisie passe en dégradé. */}
      {ctx.parSite ? (
        /* Une carte par site : où en sont ses achats, étape par étape. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          return {
            titre: montreArgent ? 'Achats en cours' : 'Dossiers',
            valeur: montreArgent ? formatMontant(c.valeur) : String(c.total),
            dort: c.total === 0,
            badge: c.total > 0
              ? {
                  texte: `${c.total} dossier${c.total > 1 ? 's' : ''}`,
                  ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                }
              : null,
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
                if (o.cle === 'encours' && vue !== 'confirme') {
                  setVue('en_attente'); setRecherche('');
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

      {/* En cours : deux cartes, non quatre. Ce qui bouge d'un côté, ce qui
          est clos de l'autre — et le statut de chaque dossier se lit sur
          son badge, dans la liste. */}
      {modeVue === 'encours' && (
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:gap-4">
        {([
          { cle: 'encours' as const, emoji: '📦', label: 'En cours',
            etats: ETAPES_ACHAT.filter(e => e !== 'confirme') },
          { cle: 'confirme' as const, emoji: '✅', label: 'Confirmé',
            etats: ['confirme'] as EtatAchat[] },
        ]).map(c => {
          const liste = c.etats.flatMap(e => parEtat(e));
          const actif = c.cle === 'confirme' ? vue === 'confirme' : vue !== 'confirme';
          return (
            <button key={c.cle} type="button"
              onClick={() => {
                setVue(c.cle === 'confirme' ? 'confirme' : 'en_attente');
                setRecherche('');
              }}
              className={`block rounded-2xl p-3 text-left shadow-sm transition-all sm:p-4 ${
                actif
                  ? 'text-white'
                  : 'border border-black/[0.06] bg-white hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900'}`}
              style={actif
                ? { background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }
                : undefined}>
              {/* L'emblème et le nom sur une ligne : empilés, ils poussaient
                  le chiffre hors de la première vue. */}
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
              <span className={`${hankenGrotesk.className} mt-1.5 block text-[19px] font-bold leading-7 tracking-tight sm:text-[26px] sm:leading-8 ${
                actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                {liste.length}
              </span>
            </button>
          );
        })}
      </div>
      )}

      {modeVue === 'statut' && (
      <>
      <RangeeEtapes grille="sm:grid-cols-4">
        {CARTES.map(c => {
          const actif = vue === c.cle;
          return (
            /* En rangée, la tuile porte sa propre largeur : `flex` la
               réduirait sinon à son contenu. */
            <button key={c.cle} type="button" onClick={() => { setVue(c.cle); setRecherche(''); }}
              className={`block rounded-2xl p-3 text-left shadow-sm transition-all sm:p-4 ${
                actif
                  ? 'text-white'
                  : 'border border-black/[0.06] bg-white hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900'}`}
              style={actif
                ? { background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }
                : undefined}>
              <div className="flex items-start justify-between gap-2">
                <span className={`flex h-8 w-8 items-center justify-center rounded-[10px] text-lg ${
                  actif ? 'bg-white/15' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
                  {c.emoji}
                </span>
                {/* La pastille compte les dossiers ; sans les montants, le
                    grand chiffre les compte déjà. */}
                {montreArgent && (
                  <span className={`shrink-0 rounded-lg px-2 py-1 text-xs font-bold ${
                    actif
                      ? 'bg-white/15 text-indigo-100'
                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                    {c.nb}
                  </span>
                )}
              </div>
              <p className={`mt-3 text-[11px] font-bold uppercase tracking-wide ${
                actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                {c.titre}
              </p>
              <p className={`${hankenGrotesk.className} mt-0.5 text-[22px] font-bold leading-7 tracking-tight ${
                actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                {montreArgent ? formatMontant(c.montant) : c.nb}
              </p>
              {!montreArgent && (
                <p className={`mt-0.5 text-[11px] font-medium ${
                  actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                  dossier{c.nb > 1 ? 's' : ''}
                </p>
              )}
              {montreArgent && (
                <div className={`mt-2.5 flex justify-between gap-2 border-t pt-2 text-xs ${
                  actif ? 'border-white/15' : 'border-black/[0.06] dark:border-white/10'}`}>
                  <span className="flex items-baseline gap-1.5">
                    <span className={actif ? 'text-indigo-100' : 'text-neutral-400'}>
                      {c.libelleVerse}
                    </span>
                    <span className={`font-bold ${actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                      {formatMontant(c.verse)}
                    </span>
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span className={actif ? 'text-indigo-100' : 'text-neutral-400'}>Reste</span>
                    <span className={`font-bold ${c.reste > 0
                      ? (actif ? 'text-amber-200' : 'text-orange-500')
                      : (actif ? 'text-white' : 'text-neutral-900 dark:text-white')}`}>
                      {formatMontant(c.reste)}
                    </span>
                  </span>
                </div>
              )}
              {/* Un écart appelle une décision : le signaler sur la carte évite
                  d'avoir à ouvrir la liste pour le découvrir. En francs pour qui
                  répond des dépenses, en produits pour qui réclame. */}
              {(montreArgent
                ? c.ecarts.positif > 0 || c.ecarts.negatif > 0
                : c.produits.manque > 0 || c.produits.surplus > 0) && (
                /* Manquer et recevoir en trop ne se lisent pas de la même
                   façon : l'un creuse le compte, l'autre le dépasse. Chacun
                   garde sa couleur — orange pour ce qui manque, bleu pour ce
                   qui déborde, comme partout ailleurs. */
                <p className="mt-1.5 flex items-center gap-1 text-xs font-medium">
                  <AlertTriangle size={11} className={
                    actif ? 'text-amber-200' : 'text-orange-500'} />
                  {montreArgent ? (
                    <>
                      {c.ecarts.positif > 0 && (
                        <span className={actif ? 'text-amber-200' : 'text-orange-500'}>
                          Manque {formatMontant(c.ecarts.positif)}
                        </span>
                      )}
                      {c.ecarts.positif > 0 && c.ecarts.negatif > 0 && (
                        <span className="text-gray-400">·</span>
                      )}
                      {c.ecarts.negatif > 0 && (
                        <span className={actif ? 'text-blue-200' : 'text-blue-500'}>
                          Surplus {formatMontant(c.ecarts.negatif)}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      {c.produits.manque > 0 && (
                        <span className={actif ? 'text-amber-200' : 'text-orange-500'}>
                          {c.produits.manque} manquant{c.produits.manque > 1 ? 's' : ''}
                        </span>
                      )}
                      {c.produits.manque > 0 && c.produits.surplus > 0 && (
                        <span className="text-gray-400">·</span>
                      )}
                      {c.produits.surplus > 0 && (
                        <span className={actif ? 'text-blue-200' : 'text-blue-500'}>
                          {c.produits.surplus} en surplus
                        </span>
                      )}
                    </>
                  )}
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
            {LIBELLES_ACHAT[vue]}
          </p>
          <div className="flex flex-wrap items-center gap-2">
          {/* Engager le site auprès d'un fournisseur, c'est décider d'une
              dépense : ce rôle reçoit la marchandise, il ne la commande pas.
              Une commande part d'un site : il faut le désigner. */}
          {role !== 'commandes' && peutCommander(ROLE_COURANT) && ctx.siteEcriture && (
            <button onClick={() => router.push(
              /* Creer depuis l'ensemble passe par un site : l'origine doit
                 suivre, sinon le dossier cree se refermera dans ce site. */
              `/site/${ctx.siteEcriture}/achats/nouveau${marqueOrigine(ctx.ensemble)}`)}
              className="flex shrink-0 items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
              <Plus size={14} /> Nouvel achat
            </button>
          )}
          {/* Deux lectures des mêmes dossiers : ce qu'on a commandé, ou à qui
              on l'a commandé. La seconde juge un fournisseur sur la durée —
              un écart isolé est un incident, répété c'est un comportement.
              Cela regarde celui qui choisit les fournisseurs, pas celui qui
              fait avancer les dossiers : le bouton disparaît, et avec lui
              le choix, puisqu'il n'en resterait qu'un. */}
          {montreAxes && (
            <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 gap-0.5 shrink-0">
              {([
                { cle: 'document' as const, label: 'Par document' },
                { cle: 'fournisseur' as const, label: 'Par fournisseur' },
              ]).map(o => (
                <button key={o.cle} onClick={() => setAxe(o.cle)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${axe === o.cle
                    ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                    : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          </div>
        </div>

        {listeVue.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <ChampRecherche placeholder="Rechercher une référence, un fournisseur…"
              valeur={recherche} onChange={setRecherche} className="min-w-[200px] flex-1" />
            {/* Le filtre ne paraît qu'où il sert : en vue « statut », la
                carte active a déjà choisi l'étape. */}
            {modeVue === 'encours' && vue !== 'confirme' && (
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
            {recherche.trim() ? 'Aucun résultat.' : 'Aucun dossier.'}
          </p>
        ) : axe === 'document' ? (
          <ListeDossiers
            dossiers={affiches}
            cleDe={a => a.id}
            compte={`${affiches.length} dossier${affiches.length > 1 ? 's' : ''}`}
            onOuvrir={a => router.push(
              `/site/${(a as any).siteId ?? ctx.siteEcriture}/achats/${a.id}?carte=${vue}&axe=${axe}${ctx.ensemble ? '&de=ensemble' : ''}`)}
            colonnes={[
              { cle: 'reference', label: 'Référence', rang: 'titre',
                rendu: a => (
                  <span className="inline-flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{a.reference}</span>
                    {/* Le statut colle à la référence : en vue « en cours »,
                        la liste mêle les étapes et les tuiles qui le disaient
                        ne sont plus à l'écran. */}
                    {modeVue === 'encours' && vue !== 'confirme' && (
                      <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        a.etat === 'recu'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                          : a.etat === 'traitement'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                        {LIBELLES_ACHAT[a.etat]}
                      </span>
                    )}
                  </span>
                ) },
              /* Le fournisseur tient lieu de repère : la liste ne porte pas
                 d'état, tous ses dossiers partagent celui de la carte. */
              { cle: 'fournisseur', label: 'Fournisseur', rang: 'corps',
                rendu: a => (
                  <span className="text-gray-600 dark:text-gray-400">{a.fournisseurNom}</span>
                ) },
              ...(ctx.ensemble ? [{
                cle: 'site', label: 'Site', rang: 'corps' as const,
                rendu: (a: Achat) => (
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {ctx.nomDe((a as any).siteId)}
                  </span>
                ),
              }] : []),
              { cle: 'date', label: 'Date', rang: 'corps',
                rendu: a => <span className="text-gray-500">{formatDate(a.dateCommande)}</span> },
              { cle: 'produits', label: 'Produits', rang: 'corps',
                rendu: a => a.lignes.length },
              ...(montreArgent ? [
                { cle: 'valeur', label: 'Valeur', rang: 'corps' as const,
                  enTete: <BoutonTri cle="valeur" label="Valeur" />,
                  rendu: (a: Achat) => (
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {formatMontant(compteVue ? valeurRecue(a.lignes) : valeurEnvoyee(a.lignes))}
                    </span>
                  ) },
                { cle: 'verse', label: vue === 'en_attente' ? 'Avance' : 'Versé',
                  rang: 'corps' as const,
                  enTete: <BoutonTri cle="verse" label={vue === 'en_attente' ? 'Avance' : 'Versé'} />,
                  rendu: (a: Achat) => {
                    const verse = a.avanceVersee ?? 0;
                    return <span className="text-gray-500">{verse > 0 ? formatMontant(verse) : '—'}</span>;
                  } },
                /* Rien ne reste dû : le dossier est soldé, et ce n'est pas
                   une information neutre. */
                { cle: 'reste', label: 'Reste', rang: 'corps' as const,
                  enTete: <BoutonTri cle="reste" label="Reste" />,
                  rendu: (a: Achat) => {
                    const valeur = compteVue ? valeurRecue(a.lignes) : valeurEnvoyee(a.lignes);
                    const reste = Math.max(0, valeur - (a.avanceVersee ?? 0));
                    return (
                      <span className={`font-medium ${reste > 0 ? 'text-orange-500' : 'text-green-600'}`}>
                        {reste > 0 ? formatMontant(reste) : 'Soldé'}
                      </span>
                    );
                  } },
              ] : []),
              /* Deux colonnes plutôt qu'une : un dossier où 5 000 manquent
                 sur un produit et 5 000 dépassent sur un autre a deux
                 écarts à trancher, pas zéro. */
              ...(compteVue ? [
                { cle: 'manque', label: 'Manque', rang: 'corps' as const,
                  enTete: <BoutonTri cle="manque" label="Manque" />,
                  rendu: (a: Achat) => {
                    const e = ecartsSepares(a.lignes);
                    const pr = produitsEnEcart(a.lignes);
                    const v = montreArgent ? e.positif : pr.manque;
                    return (
                      <span className={`font-bold ${v > 0 ? 'text-orange-500' : 'text-gray-300 dark:text-gray-700'}`}>
                        {v > 0 ? (montreArgent ? formatMontant(e.positif) : pr.manque) : '—'}
                      </span>
                    );
                  } },
                { cle: 'surplus', label: 'Surplus', rang: 'corps' as const,
                  enTete: <BoutonTri cle="surplus" label="Surplus" />,
                  rendu: (a: Achat) => {
                    const e = ecartsSepares(a.lignes);
                    const pr = produitsEnEcart(a.lignes);
                    const v = montreArgent ? e.negatif : pr.surplus;
                    return (
                      <span className={`font-bold ${v > 0 ? 'text-blue-500' : 'text-gray-300 dark:text-gray-700'}`}>
                        {v > 0 ? (montreArgent ? formatMontant(e.negatif) : pr.surplus) : '—'}
                      </span>
                    );
                  } },
              ] : []),
            ] as Colonne<Achat>[]}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  <th className="text-center px-3 py-2.5 font-medium">Fournisseur</th>
                  <th className="text-center px-3 py-2.5 font-medium">Dossiers</th>
                  {montreArgent && <>
                    <Th cle="valeur" label="Valeur" />
                    <Th cle="verse" label={vue === 'en_attente' ? 'Avance' : 'Versé'} />
                    <Th cle="reste" label="Reste" />
                  </>}
                  {/* Deux colonnes plutôt qu'une : un dossier où 5 000 manquent
                      sur un produit et 5 000 dépassent sur un autre a deux
                      écarts à trancher, pas zéro. */}
                  {compteVue && <>
                    <Th cle="manque" label="Manque" />
                    <Th cle="surplus" label="Surplus" />
                  </>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {fournisseursAffiches.map(f => {
                  const reste = Math.max(0, f.valeur - f.verse);
                  return (
                    <tr key={f.id ?? f.nom}
                      onClick={() => { if (f.id && ctx.siteEcriture) router.push(`/site/${ctx.siteEcriture}/partenaires/${f.id}`); }}
                      className={`transition-colors ${f.id
                        ? 'hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer' : ''}`}>
                      <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">
                        {f.nom}
                      </td>
                      <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 text-center">
                        {f.documents}
                      </td>
                      {montreArgent && <>
                        <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">
                          {formatMontant(f.valeur)}
                        </td>
                        <td className="px-3 py-2.5 text-gray-500 text-center">
                          {f.verse > 0 ? formatMontant(f.verse) : '—'}
                        </td>
                        <td className={`px-3 py-2.5 font-medium text-center ${reste > 0
                          ? 'text-orange-500' : 'text-green-600'}`}>
                          {reste > 0 ? formatMontant(reste) : 'Soldé'}
                        </td>
                      </>}
                      {compteVue && <>
                        <td className={`px-3 py-2.5 font-bold text-center ${
                          (montreArgent ? f.positif : f.manque) > 0
                            ? 'text-orange-500' : 'text-gray-300 dark:text-gray-700'}`}>
                          {montreArgent
                            ? (f.positif > 0 ? formatMontant(f.positif) : '—')
                            : (f.manque > 0 ? f.manque : '—')}
                        </td>
                        <td className={`px-3 py-2.5 font-bold text-center ${
                          (montreArgent ? f.negatif : f.surplus) > 0
                            ? 'text-blue-500' : 'text-gray-300 dark:text-gray-700'}`}>
                          {montreArgent
                            ? (f.negatif > 0 ? formatMontant(f.negatif) : '—')
                            : (f.surplus > 0 ? f.surplus : '—')}
                        </td>
                      </>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>
      )}

      {/* Le filtre par statut : il reprend le choix que les tuiles
          offraient, sans quitter la vue d'ensemble. */}
      {feuilleFiltre && (
        <FeuilleFiltreStatut
          options={ETAPES_ACHAT.filter(e => e !== 'confirme').map(e => ({
            cle: e, label: LIBELLES_ACHAT[e], n: parEtat(e).length,
          }))}
          choisis={filtreStatuts}
          onChange={c => setFiltreStatuts(c as EtatAchat[])}
          onFermer={() => setFeuilleFiltre(false)} />
      )}
    </div>
  );
}
