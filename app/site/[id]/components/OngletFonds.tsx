'use client';
import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import {
  chargerEcarts, enAttente as ecartsEnAttente, type EcartCaisse,
} from '@/lib/ecarts-caisse';
import FeuilleEcarts from './FeuilleEcarts';
import ModalEcartCaisse from './ModalEcartCaisse';
import {
  chargerAttente, totauxEnAttente, type MouvementAttente,
} from '@/lib/attente-caisse';
import { Loader2, ArrowDownLeft, ArrowUpRight, ChevronRight, AlertCircle } from 'lucide-react';
import FeuilleMouvement from './FeuilleMouvement';
import MouvementsEnAttente from './MouvementsEnAttente';
import AttenteParAuteur from './AttenteParAuteur';
import { hankenGrotesk } from './finance/font';
import {
  chargerCaisseDuSite, LIBELLES_MOTIF_CAISSE, MouvementCaisse, soldeCaisse,
} from '@/lib/caisse';
import PeriodFilter from './finance/PeriodFilter';
import RegistreCaisse from './RegistreCaisse';
import {
  roleSurSite, peutAutoriserCaisse, type RoleSite,
} from '@/lib/roles';
import { aLOnglet } from '@/lib/onglets-site';
import { BarresHorizontales } from '@/components/Graphiques';
import {
  useSites, FiltreSite, CelluleSite, ToggleVue, CartesParSite,
  type PropsPortee,
} from './ContexteSites';

interface Props extends PropsPortee {
  userId: string;
}

/** Une variation de trésorerie, avec sa provenance. */
interface Flux {
  date: string;
  libelle: string;
  source: string;
  /** précise la source ; vide pour les mouvements qui n'en portent pas */
  sousMotif?: string | null;
  /** numéro de registre ; absent des mouvements encore déduits */
  numero?: string | null;
  /** les soldes figés à l'écriture ; absents des mouvements déduits, qui
      n'ont jamais été écrits et dont le solde se recalcule */
  soldeAvant?: number | null;
  soldeApres?: number | null;
  /** le mouvement du registre dont ce flux vient ; absent des déduits */
  origine?: MouvementCaisse | null;
  /* D'où vient la ligne : sans lui, la vue d'ensemble mélange les caisses
     sans dire laquelle. */
  siteId?: string | null;
  /** qui a fait l'opération ; vide quand elle découle d'un acte */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  montant: number;
  sens: 'entree' | 'sortie';
}

type Periode = 'jour' | 'semaine' | 'mois' | 'annee' | 'tout';

/** Date de début d'une période nommée ; chaîne vide = depuis toujours. */
function debutPeriode(p: Periode): string {
  const d = new Date();
  if (p === 'jour') return d.toISOString().split('T')[0];
  if (p === 'semaine') {
    const jour = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - jour);
    return d.toISOString().split('T')[0];
  }
  if (p === 'mois') { d.setDate(1); return d.toISOString().split('T')[0]; }
  if (p === 'annee') { d.setMonth(0, 1); return d.toISOString().split('T')[0]; }
  return '';
}

const LIBELLE_PERIODE: Record<Periode, string> = {
  jour: "aujourd'hui",
  semaine: 'cette semaine',
  mois: 'ce mois',
  annee: 'cette année',
  tout: 'depuis le début',
};

function formatDate(s?: string): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}


export default function OngletFonds({ siteId, userId, sites, titre }: Props) {
  /* Le même onglet sert un site et l'ensemble : la portée décide de ce qui
     se lit, et de ce qui peut s'écrire. */
  const { profile: profil, activite } = useAuth();
  const ctx = useSites(siteId, sites);
  const [flux, setFlux] = useState<Flux[]>([]);
  /* les mouvements bruts : le solde se lit dessus, jamais sur les flux */
  const [mouvements, setMouvements] = useState<MouvementCaisse[]>([]);
  /* L'argent encaissé dehors, en attente d'être remis au tiroir. */
  const [attente, setAttente] = useState<MouvementAttente[]>([]);
  const [loading, setLoading] = useState(true);
  /* Ce qui s'est passé aujourd'hui : c'est la question qu'on se pose en
     ouvrant l'écran. Les périodes plus larges se demandent, elles ne
     s'imposent pas. */
  const [periode, setPeriode] = useState<Periode>('jour');
  /* les cartes servent d'onglets : la carte active décide de ce qui s'affiche dessous */
  const [vue, setVue] = useState<'fonds' | 'entree' | 'sortie' | 'attente'>('fonds');
  /* Dans la vue « À confirmer », quel sens on regarde. Entrées d'abord :
     c'est ce qui attend le plus souvent. */
  const [sensAttente, setSensAttente] = useState<'entree' | 'sortie'>('entree');
  /* Par mouvement ou par auteur : savoir qui porte combien vaut autant que
     savoir ce qui attend, et le gérant lit d'abord des personnes. */
  const [vueAttente, setVueAttente] =
    useState<'mouvements' | 'auteurs'>('mouvements');
  /* Qui regarde : le caissier ne déclare pas de mouvement, il n'a donc pas
     le bouton de saisie sous le registre. */
  const [roleSite, setRoleSite] = useState<RoleSite | null>(null);

  /* Les écarts constatés : ceux qui attendent une reconnaissance appellent
     un geste, et un geste se signale avant ce qui se contemple. */
  const [ecarts, setEcarts] = useState<EcartCaisse[]>([]);
  const [feuilleEcarts, setFeuilleEcarts] = useState(false);
  const [modalEcart, setModalEcart] = useState(false);
  /* Le mouvement qu'on s'apprête à faire entrer ou sortir : compter vient
     avant d'autoriser, et cela se fait dans l'écran de la file. */
  const [aConfirmer, setAConfirmer] = useState<MouvementAttente | null>(null);
  /* incrémenté après une saisie : relance le chargement */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const charger = async () => {
      setLoading(true);
      /* Le registre est la seule source : un registre qui affiche des lignes
         qu'il ne contient pas n'est pas un registre. Les opérations qui
         touchent la caisse — vente, achat, rémunération, avance,
         recouvrement — y écriront au moment où elles se produisent. */
      /* Le rôle se lit avant de rendre : `null` veut dire « aucune
         restriction », si bien qu'un rendu fait avant sa réponse montrait
         le bouton de saisie à qui ne peut pas déclarer. */
      const [registre, role] = await Promise.all([
        chargerCaisseDuSite(ctx.portee),
        ctx.siteEcriture
          ? roleSurSite(userId, ctx.siteEcriture, activite?.adminUid)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      setMouvements(registre);
      setRoleSite(role);
      /* Ce qui a été encaissé dehors et attend d'entrer : cet argent
         existe, mais le registre ne le compte pas — il n'est pas encore
         dans le tiroir. */
      chargerAttente(ctx.portee).then(setAttente).catch(() => setAttente([]));
      chargerEcarts(ctx.portee).then(setEcarts).catch(() => setEcarts([]));
      setFlux(registre.map(m => ({
        date: m.date,
        libelle: m.detail || LIBELLES_MOTIF_CAISSE[m.motif],
        source: LIBELLES_MOTIF_CAISSE[m.motif],
        sousMotif: m.sousMotif ?? null,
        numero: m.numero ?? null,
        soldeAvant: m.soldeAvant ?? null,
        soldeApres: m.soldeApres ?? null,
        origine: m,
        siteId: m.siteId,
        utilisateurNom: m.utilisateurNom ?? null,
        utilisateurFonction: m.utilisateurFonction ?? null,
        montant: m.montant,
        sens: m.sens,
      })));
      setLoading(false);
    };
    charger();
  }, [ctx.portee, userId, version]);

  /* Ce qui attend une reconnaissance, par sens. Les deux ne s'additionnent
     pas : un manque et un excédent se compenseraient, et une somme nulle
     cacherait deux constats bien réels. */
  const ecartsAttente = ecartsEnAttente(ecarts);
  const totalManque = ecartsAttente
    .filter(e => e.sens === 'manque')
    .reduce((n, e) => n + e.montant, 0);
  const totalExcedent = ecartsAttente
    .filter(e => e.sens === 'excedent')
    .reduce((n, e) => n + e.montant, 0);

  if (loading) return (
    <div className="min-h-64 flex items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const depuis = debutPeriode(periode);


  /* Le solde vient du registre, trié sur le numéro. Chercher le « dernier »
     dans une liste triée par date donnait la mauvaise ligne : une annulation
     saisie aujourd'hui pour un mouvement du 11 n'est pas datée du 11. */
  const fonds = soldeCaisse(mouvements);

  const surPeriode = flux.filter(f => !depuis || (f.date ?? '') >= depuis);
  /* Le registre lit les mouvements, pas les flux : il a besoin du numéro,
     du solde figé et de l'annulation, que le flux ne porte pas. */
  const mouvementsPeriode = mouvements.filter(m => !depuis || (m.date ?? '') >= depuis);
  const entrees = surPeriode.filter(f => f.sens === 'entree').reduce((s, f) => s + f.montant, 0);
  const sorties = surPeriode.filter(f => f.sens === 'sortie').reduce((s, f) => s + f.montant, 0);
  const nbEntrees = surPeriode.filter(f => f.sens === 'entree').length;
  const nbSorties = surPeriode.filter(f => f.sens === 'sortie').length;

  /* barres triees par montant : on compare des longueurs, pas des angles */
  const repartition = ([...surPeriode.reduce((acc, f) => {
    const cle = `${f.sens}|${f.source}`;
    acc.set(cle, (acc.get(cle) ?? 0) + f.montant);
    return acc;
  }, new Map<string, number>())])
    .map(([cle, montant]) => {
      const [sens, source] = cle.split('|');
      return { sens: sens as 'entree' | 'sortie', source, montant };
    })
    .sort((a, b) => b.montant - a.montant);

  /* Ce qui attend d'entrer au tiroir : cet argent existe, mais le registre
     ne le compte pas encore — il n'est pas dans la caisse. */
  const t = totauxEnAttente(attente);

  /* Ce qui attend dans un sens, du plus récent au plus ancien : une file
     se lit par ce qui vient d'arriver. Les mouvements déjà tranchés ne
     s'y trouvent plus — ils sont passés au registre. */
  function attenteVue(sens: 'entree' | 'sortie') {
    return attente
      .filter(m => m.etat === 'en_attente' && m.sens === sens)
      .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));
  }


  /* Ce qu'un site présente sur la période : son tiroir, ce qui y est
     entré, ce qui en est sorti. Le solde ne suit pas la période — c'est
     le contenu réel du tiroir, pas une variation. */
  function chiffresDuSite(id: string) {
    const sien = surPeriode.filter(f => f.siteId === id);
    const ent = sien.filter(f => f.sens === 'entree');
    const sor = sien.filter(f => f.sens === 'sortie');
    return {
      fonds: soldeCaisse(mouvements.filter(m => m.siteId === id)),
      entrees: ent.reduce((n, f) => n + f.montant, 0),
      sorties: sor.reduce((n, f) => n + f.montant, 0),
      nbEntrees: ent.length,
      nbSorties: sor.length,
      /* Ce qui attend une reconnaissance ici : tant qu'elle manque, le
         fonds de ce site ne dit pas le vrai, et la carte le tairait. */
      manque: ecartsAttente
        .filter(e => e.siteId === id && e.sens === 'manque')
        .reduce((n, e) => n + e.montant, 0),
      excedent: ecartsAttente
        .filter(e => e.siteId === id && e.sens === 'excedent')
        .reduce((n, e) => n + e.montant, 0),
      nbEcarts: ecartsAttente.filter(e => e.siteId === id).length,
    };
  }

  return (
    /* Même habillage que le tableau de bord : la carte active en dégradé
       indigo, les autres en blanc. Les trois servent d'onglets. */
    <div className={`${hankenGrotesk.className} flex flex-col gap-4`}>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={titre
          ? 'text-xl font-bold text-neutral-900 dark:text-neutral-100'
          : 'text-sm font-bold text-neutral-900 dark:text-neutral-100'}>
          {titre ?? 'Trésorerie'}
        </p>
        <div className="flex items-center gap-2">
          {/* Le total dit combien il y a, jamais où : la bascule répartit
              les mêmes chiffres entre les sites. */}
          <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {/* La période commande la page entière, cartes de tête comprises :
          dans l'en-tête, parmi les réglages de portée, elle se lisait comme
          un filtre du seul tableau. Elle se tient donc au-dessus d'elles. */}
      <div className="mb-3 flex justify-end">
        <PeriodFilter periode={periode} onChange={setPeriode} />
      </div>

      {ctx.parSite ? (
        /* Une carte par site : son tiroir, ses entrées, ses sorties. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          return {
            titre: 'Fonds disponible',
            valeur: formatMontant(c.fonds),
            dort: c.fonds === 0 && c.entrees === 0 && c.sorties === 0
              && c.nbEcarts === 0,
            /* L'écart passe devant le compte des mouvements : c'est lui
               qui réclame un geste, l'autre ne fait que décrire. */
            badge: c.nbEcarts > 0
              ? {
                  texte: `${c.nbEcarts} écart${c.nbEcarts > 1 ? 's' : ''}`,
                  ton: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                }
              : c.nbEntrees + c.nbSorties > 0
              ? {
                  texte: `${c.nbEntrees + c.nbSorties} mvt${c.nbEntrees + c.nbSorties > 1 ? 's' : ''}`,
                  ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                }
              : null,
            lignes: [
              { label: `Entrées · ${c.nbEntrees}`, valeur: formatMontant(c.entrees),
                vide: c.entrees === 0, ton: 'text-green-600' },
              { label: `Sorties · ${c.nbSorties}`, valeur: formatMontant(c.sorties),
                vide: c.sorties === 0, ton: 'text-red-500' },
              /* Les deux sens ne s'additionnent pas : ils se
                 compenseraient, et une somme nulle cacherait deux
                 constats. Chacun ne paraît que s'il existe. */
              ...(c.manque > 0 ? [{
                label: 'À confirmer · manque',
                valeur: `− ${formatMontant(c.manque)}`,
                vide: false, ton: 'text-red-500',
              }] : []),
              ...(c.excedent > 0 ? [{
                label: 'À confirmer · excédent',
                valeur: `+ ${formatMontant(c.excedent)}`,
                vide: false, ton: 'text-green-600',
              }] : []),
            ],
          };
        }} />
      ) : (
      <>
      {/* Ce qui appelle un geste, avant ce qui se contemple.

          Un écart n'est pas une demande : personne ne réclame rien,
          l'argent n'est déjà plus là — ou il y en a plus qu'annoncé. Ce
          qu'on attend n'est pas une autorisation mais une reconnaissance,
          et tant qu'elle manque le solde affiché ne dit pas le vrai.

          Les deux sens sur la même carte quand les deux existent : ce sont
          deux constats du même comptage. */}
      {vue === 'fonds' && ecartsAttente.length > 0 && (
        <button type="button" onClick={() => setFeuilleEcarts(true)}
          className="mb-3 flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left shadow-sm transition-colors active:bg-amber-100 dark:border-amber-800/30 dark:bg-amber-900/10 dark:active:bg-amber-900/20 sm:p-5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-900/30">
              <AlertCircle size={17} className="text-amber-600" />
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] font-bold uppercase tracking-wide text-amber-700/70 dark:text-amber-400/70">
                Écarts à confirmer
              </span>
              {/* Chaque sens garde son chiffre : un manque et un excédent
                  ne s'additionnent pas, ils se compensent — et une somme
                  nulle cacherait deux constats. */}
              <span className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                {totalManque > 0 && (
                  <span className="text-[13px] font-bold text-red-500 sm:text-[15px]">
                    − {formatMontant(totalManque)}
                  </span>
                )}
                {totalExcedent > 0 && (
                  <span className="text-[13px] font-bold text-green-600 sm:text-[15px]">
                    + {formatMontant(totalExcedent)}
                  </span>
                )}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="rounded-lg bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 sm:px-2.5 sm:text-xs">
              {ecartsAttente.length}
            </span>
            <ChevronRight size={16} className="text-amber-500" />
          </span>
        </button>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
        {([
          {
            key: 'fonds' as const, emoji: '🏦', titre: 'Fonds disponible',
            montant: fonds,
            /* Le solde cumule tout depuis le début : c'est le contenu réel
               du tiroir, il ne suit pas le filtre. La variation de la période
               se lit dans le registre, où chaque ligne porte son solde. */
            compte: null,
            alerte: fonds < 0,
          },
          {
            key: 'entree' as const, emoji: '📥', titre: 'Entrées',
            montant: entrees,
            compte: nbEntrees,
            alerte: false,
          },
          {
            key: 'sortie' as const, emoji: '📤', titre: 'Sorties',
            montant: sorties,
            compte: nbSorties,
            alerte: false,
          },
        ]).map(c => {
          const actif = vue === c.key;
          return (
            /* Sur un téléphone, la carte tient sur une ligne : l'icône, le
               libellé et le montant côte à côte. Empilés, trois chiffres
               remplissaient l'écran et le registre commençait hors champ.
               Au-delà de `sm`, la place ne manque plus : la pile revient,
               et le montant reprend sa taille. */
            <button key={c.key} type="button" onClick={() => setVue(c.key)}
              className={`flex items-center gap-3 rounded-2xl p-3 text-left shadow-sm transition-all sm:block sm:p-5 ${
                actif
                  ? 'text-white'
                  : 'border border-black/[0.06] bg-white hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900'}`}
              style={actif
                ? { background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }
                : undefined}>
              {/* Combien de mouvements, à l'écart du montant : sous lui, les
                  deux chiffres se lisaient comme une seule information. Le
                  fonds disponible n'en porte pas — il cumule tout depuis le
                  début, il ne compte pas une période. */}
              <div className="flex shrink-0 items-start justify-between gap-2 sm:w-full">
                <span className={`flex h-8 w-8 items-center justify-center rounded-[10px] text-lg ${
                  actif ? 'bg-white/15' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
                  {c.emoji}
                </span>
                {/* En ligne, le compte passe à droite du montant : entre
                    l'icône et lui, il couperait la lecture. */}
                {c.compte != null && (
                  <span className={`hidden shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold sm:inline ${
                    actif
                      ? 'bg-white/15 text-white'
                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                    {c.compte} mouvement{c.compte > 1 ? 's' : ''}
                  </span>
                )}
              </div>

              <span className="min-w-0 flex-1 sm:block">
                <span className={`block text-[11px] font-bold uppercase tracking-wide sm:mt-3 ${
                  actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                  {c.titre}
                </span>
                <span className={`block text-[19px] font-bold leading-7 tracking-tight sm:mt-0.5 sm:text-[26px] sm:leading-8 ${
                  c.alerte && !actif ? 'text-red-500'
                    : actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                  {formatMontant(c.montant)}
                </span>
              </span>

              {c.compte != null && (
                <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold sm:hidden ${
                  actif
                    ? 'bg-white/15 text-white'
                    : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                  {c.compte} mvt{c.compte > 1 ? 's' : ''}
                </span>
              )}
            </button>
          );
        })}

        {/* Cet argent existe, mais il n'est pas dans le tiroir : il a été
            déclaré, pas encore compté. Le mêler au solde ferait croire
            qu'on en dispose ; l'omettre ferait croire qu'il n'existe pas.

            Deux montants sur une même carte, et non un solde : ce qui doit
            entrer et ce qui doit sortir sont deux gestes distincts. Les
            compenser dirait qu'il n'y a rien à faire quand ils s'équilibrent,
            alors qu'il y a deux fois à ouvrir le tiroir. */}
        {/* Elle sert d'onglet comme les trois autres : le détail s'ouvre
            dessous, sur la même page. Renvoyer ailleurs ferait quitter
            l'écran pour lire un chiffre qu'on vient d'y voir. */}
        <button type="button" onClick={() => setVue('attente')}
          className={`block rounded-2xl border p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 sm:p-5 ${
            vue === 'attente'
              ? 'border-amber-400 bg-amber-100 dark:border-amber-600/50 dark:bg-amber-900/25'
              : t.nb > 0
                ? 'border-amber-200 bg-amber-50 dark:border-amber-800/30 dark:bg-amber-900/10'
                : 'border-black/[0.06] bg-white dark:border-white/10 dark:bg-neutral-900'}`}>

          {/* L'en-tête sur une ligne : l'icône, le libellé, et le compte à
              droite. Les autres cartes mettent leur montant ici ; celle-ci
              en porte deux, ils descendent d'un cran. */}
          <span className="flex items-center gap-2.5">
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-lg ${
              t.nb > 0 ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
              ⏳
            </span>
            <span className={`min-w-0 flex-1 text-[11px] font-bold uppercase tracking-wide ${
              t.nb > 0 ? 'text-amber-600 dark:text-amber-500' : 'text-neutral-400'}`}>
              À confirmer
            </span>
            {t.nb > 0 && (
              <span className="shrink-0 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                {t.nb} mvt{t.nb > 1 ? 's' : ''}
              </span>
            )}
          </span>

          {/* Deux cases côte à côte, jamais un solde : ce qui doit entrer et
              ce qui doit sortir sont deux gestes. Les compenser dirait qu'il
              n'y a rien à faire quand ils s'équilibrent, alors qu'il y a
              deux fois à ouvrir le tiroir. */}
          <span className="mt-2.5 grid grid-cols-2 gap-2">
            {([
              { cle: 'e', label: 'Entrées', montant: t.entrees, Icone: ArrowDownLeft,
                ton: 'text-green-600' },
              { cle: 's', label: 'Sorties', montant: t.sorties, Icone: ArrowUpRight,
                ton: 'text-red-500' },
            ]).map(({ cle, label, montant, Icone, ton }) => (
              <span key={cle}
                className="block min-w-0 rounded-xl bg-white/70 p-2.5 dark:bg-black/20">
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-neutral-400">
                  <Icone size={11} className={`shrink-0 ${montant > 0 ? ton : ''}`} />
                  {label}
                </span>
                {/* Le montant sous son libellé : côte à côte, deux paires
                    sur une largeur de carte se coupaient. */}
                <span className={`mt-0.5 block truncate text-[15px] font-bold leading-6 sm:text-[17px] ${
                  montant > 0 ? ton : 'text-neutral-900 dark:text-white'}`}>
                  {formatMontant(montant)}
                </span>
              </span>
            ))}
          </span>
        </button>
      </div>


      {(vue === 'entree' || vue === 'sortie') && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mt-4">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              {vue === 'entree' ? 'Entrées par motif' : 'Sorties par motif'}
            </p>
            <span className={`text-sm font-bold ${vue === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
              {formatMontant(vue === 'entree' ? entrees : sorties)}
            </span>
          </div>
          <BarresHorizontales
            parts={repartition.filter(r => r.sens === vue).map(r => ({ label: r.source, valeur: r.montant }))}
            format={formatMontant}
            couleur={vue === 'entree' ? 'bg-green-500' : 'bg-red-500'}
          />
        </div>
      )}

      {/* Compter puis autoriser : le même écran que dans l'onglet du
          caissier, pour que le geste soit identique des deux côtés. Il ne
          reçoit qu'un mouvement — celui qu'on vient d'ouvrir. */}
      {aConfirmer && (
        /* Le droit se relit ici : posé en dur, cet écran donnait le bouton
           d'autorisation à qui l'ouvrait, et la vue par auteur y menait
           depuis une simple ligne dépliée. */
        <MouvementsEnAttente mouvements={[aConfirmer]}
          peutAutoriser={peutAutoriserCaisse(roleSite)}
          ouvertDabord={aConfirmer}
          parUid={userId} parNom={profil?.nom ?? null}
          onChange={() => { setAConfirmer(null); setVersion(v => v + 1); }}
          onFerme={() => setAConfirmer(null)} />
      )}

      {/* Le registre sous les chiffres : pour le gérant et le propriétaire,
          la caisse est une partie du travail — ils lisent le solde, puis ce
          qui l'a fait.

          Le caissier ne l'a pas ici : il a le même registre en page pleine.
          Le répéter lui donnerait deux chemins vers le même écran, et
          allongerait d'un tableau la page qu'il ouvre en premier.

          On demande s'il a l'onglet, non s'il y a droit : le propriétaire a
          droit à tout, et la première question lui retirait le registre
          alors que sa barre n'a pas de page Mouvements. */}

      {vue === 'fonds' && !aLOnglet(roleSite, 'mouvements') && (
        <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:p-5">
          <p className="mb-4 text-sm font-bold text-gray-900 dark:text-gray-100">
            Mouvements de caisse
          </p>
          <RegistreCaisse mouvements={mouvementsPeriode} userId={userId}
            roleSite={roleSite} siteEcriture={ctx.siteEcriture}
            nomDuSite={ctx.ensemble ? ctx.nomDe : null}
            onChange={() => setVersion(v => v + 1)} />
        </div>
      )}

      {/* Le détail de ce qui attend, sur la même page : la carte est un
          onglet, pas un lien. Deux sous-onglets, parce que confirmer une
          entrée et confirmer une sortie sont deux gestes — on vient ici
          pour l'un ou pour l'autre, jamais pour les deux mêlés. */}
      {vue === 'attente' && (
        <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              En attente de confirmation
            </p>
            <div className="flex items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
              {([
                { cle: 'entree' as const, label: 'Entrées',
                  n: attenteVue('entree').length },
                { cle: 'sortie' as const, label: 'Sorties',
                  n: attenteVue('sortie').length },
              ]).map(o => (
                <button key={o.cle} onClick={() => setSensAttente(o.cle)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    sensAttente === o.cle
                      ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                      : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
                  {o.label} ({o.n})
                </button>
              ))}
            </div>
          </div>

          {/* Le total du sens ouvert, au-dessus de sa liste : compter les
              lignes pour savoir combien attend est un travail que l'écran
              peut faire. La carte porte déjà les deux sens ensemble —
              ici on ne voit qu'un côté à la fois. */}
          {attenteVue(sensAttente).length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-gray-500">
                {attenteVue(sensAttente).length} mouvement{attenteVue(sensAttente).length > 1 ? 's' : ''}
                {' '}·{' '}
                <span className={`font-bold ${
                  sensAttente === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
                  {formatMontant(sensAttente === 'entree' ? t.entrees : t.sorties)}
                </span>
              </p>

              {/* Deux façons de lire la même file : ligne par ligne, ou par
                  celui qui l'a déclarée. La bascule ne s'affiche que s'il y
                  a de quoi grouper. */}
              {attenteVue(sensAttente).length > 1 && (
                <div className="flex items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
                  {([
                    { cle: 'mouvements' as const, label: 'Par mouvement' },
                    { cle: 'auteurs' as const,    label: 'Par auteur' },
                  ]).map(o => (
                    <button key={o.cle} onClick={() => setVueAttente(o.cle)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                        vueAttente === o.cle
                          ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                          : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Le caissier confirme depuis la feuille ; les autres y lisent
              le détail sans pouvoir ouvrir le tiroir. */}
          {vueAttente === 'mouvements' || attenteVue(sensAttente).length <= 1 ? (
            <ListeAttente lignes={attenteVue(sensAttente)}
              nomDuSite={ctx.ensemble ? ctx.nomDe : null}
              peutConfirmer={peutAutoriserCaisse(roleSite)}
              onConfirmer={peutAutoriserCaisse(roleSite) ? setAConfirmer : undefined} />
          ) : (
            <AttenteParAuteur mouvements={attenteVue(sensAttente)} sens={sensAttente}
              peutAutoriser={peutAutoriserCaisse(roleSite)}
              parUid={userId} parNom={profil?.nom ?? null}
              onChange={() => setVersion(v => v + 1)}
              onOuvrir={peutAutoriserCaisse(roleSite) ? setAConfirmer : undefined} />
          )}
        </div>
      )}

      </>
      )}


      {/* La file des ecarts : on y reconnait, ou l'on conteste. */}
      {feuilleEcarts && (
        <FeuilleEcarts ecarts={ecartsAttente}
          roleSite={roleSite} uid={userId} nom={profil?.nom ?? null}
          nomDuSite={ctx.ensemble ? ctx.nomDe : null}
          onChange={() => setVersion(v => v + 1)}
          onFermer={() => setFeuilleEcarts(false)} />
      )}

      {/* Constater : on dit ce que le comptage a trouve, le solde ne bouge
          pas avant qu'un autre le reconnaisse. */}
      {modalEcart && ctx.siteEcriture && (
        <ModalEcartCaisse siteId={ctx.siteEcriture}
          utilisateur={userId}
          utilisateurNom={profil?.nom ?? null}
          utilisateurFonction={roleSite ?? 'Proprietaire'}
          roleSite={roleSite}
          soldeTheorique={fonds}
          onFermer={() => setModalEcart(false)}
          onEnregistre={() => setVersion(v => v + 1)} />
      )}
    </div>
  );
}

/**
 * Ce qui attend d'être confirmé, en lecture seule.
 *
 * On lit ici, on n'autorise pas : ouvrir le tiroir se fait dans l'onglet
 * du caissier, et lui seul y a les boutons. Le gérant et le propriétaire
 * viennent savoir ce qui pèse sur la caisse, pas le trancher.
 */
function ListeAttente({ lignes, nomDuSite, peutConfirmer, onConfirmer }: {
  lignes: MouvementAttente[];
  /** Présent en vue d'ensemble : sans lui, on ne sait plus quelle caisse. */
  nomDuSite: ((id?: string | null) => string) | null;
  /** Seul le responsable de la caisse voit le bouton de la feuille. */
  peutConfirmer?: boolean;
  onConfirmer?: (m: MouvementAttente) => void;
}) {
  /* Le mouvement dont on regarde le détail. La carte n'en montre qu'assez
     pour le reconnaître ; le reste s'ouvre par-dessus. */
  const [ouvert, setOuvert] = useState<MouvementAttente | null>(null);

  if (lignes.length === 0) {
    return (
      <p className="py-8 text-center text-xs text-gray-400">
        Rien à confirmer de ce côté.
      </p>
    );
  }

  return (
    <>
      {/* Tablette et bureau : les colonnes du registre, pour qu'on relise
          ici ce qu'on relira là-bas. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full whitespace-nowrap text-sm">
          <thead>
            <tr className="bg-indigo-600 text-white">
              <th className="px-3 py-2.5 text-center font-medium">Motif</th>
              <th className="px-3 py-2.5 text-center font-medium">Sous-motif</th>
              <th className="px-3 py-2.5 text-center font-medium">Détail</th>
              {nomDuSite && <th className="px-3 py-2.5 text-center font-medium">Site</th>}
              <th className="px-3 py-2.5 text-center font-medium">Montant</th>
              <th className="px-3 py-2.5 text-center font-medium">Date</th>
              <th className="px-3 py-2.5 text-center font-medium">Auteur</th>
              <th className="px-3 py-2.5 text-center font-medium">Fonction</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {lignes.map(m => (
              /* La ligne ouvre le même détail que la carte : sur grand
                 écran le tableau montre déjà tout, mais c'est de là qu'on
                 confirme. */
              <tr key={m.id} onClick={() => setOuvert(m)}
                className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">
                  {LIBELLES_MOTIF_CAISSE[m.motif]}
                </td>
                <td className="px-3 py-2.5 text-center text-gray-400">{m.sousMotif || '—'}</td>
                <td className="px-3 py-2.5 text-center text-gray-500">{m.detail || '—'}</td>
                {nomDuSite && <CelluleSite nom={nomDuSite(m.siteId)} />}
                <td className={`px-3 py-2.5 text-center font-bold ${
                  m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
                  {formatMontant(m.montant)}
                </td>
                <td className="px-3 py-2.5 text-center text-gray-500">
                  {formatDate(m.date)} <span className="text-gray-400">{m.heure}</span>
                </td>
                <td className="px-3 py-2.5 text-center text-gray-500">
                  {m.utilisateurNom || '—'}
                </td>
                <td className="px-3 py-2.5 text-center text-gray-400">
                  {m.utilisateurFonction || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Téléphone : une carte par mouvement, réduite à ce qu'on lit d'un
          coup d'œil. Le reste — sous-motif, détail, auteur, fonction,
          heure — s'ouvre en feuille : entassé sur la carte, il fallait
          trois lignes par mouvement pour une liste qu'on parcourt. */}
      <div className="space-y-2 sm:hidden">
        {lignes.map(m => (
          <button key={m.id} type="button" onClick={() => setOuvert(m)}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-gray-100 p-3 text-left transition-colors active:bg-gray-50 dark:border-gray-800 dark:active:bg-gray-800/50">
            <span className="flex min-w-0 items-center gap-2">
              {m.sens === 'entree'
                ? <ArrowDownLeft size={14} className="shrink-0 text-green-600" />
                : <ArrowUpRight size={14} className="shrink-0 text-red-500" />}
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                  {LIBELLES_MOTIF_CAISSE[m.motif]}
                </span>
                {/* Qui a déclaré, pour ne pas ouvrir chaque feuille à la
                    recherche d'un nom. */}
                <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                  {m.utilisateurNom || '—'} · {formatDate(m.date)}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className={`text-[15px] font-bold ${
                m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
                {formatMontant(m.montant)}
              </span>
              <ChevronRight size={15} className="text-gray-300" />
            </span>
          </button>
        ))}
      </div>

      {/* Le détail au complet, avec le bouton pour ceux qui l'autorisent. */}
      {ouvert && (
        <FeuilleMouvement mouvement={ouvert}
          nomDuSite={nomDuSite ? nomDuSite(ouvert.siteId) : null}
          peutConfirmer={peutConfirmer}
          onConfirmer={onConfirmer ? () => { onConfirmer(ouvert); setOuvert(null); } : undefined}
          onFermer={() => setOuvert(null)} />
      )}
    </>
  );
}
