'use client';
import { marqueOrigine } from '@/lib/retour';
import { useEffect, useState } from 'react';
import { hankenGrotesk } from './finance/font';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import {
  Transfert, EtatTransfert, LIBELLES_TRANSFERT, libelleTransfert, ETAPES_TRANSFERT,
  aUnEcart, lignesEnEcart, valeurEnvoyee,
  chargerTransfertsDuSite, peutInitierTransfert, Role,
} from '@/lib/flux-marchandise';
import { ChampRecherche } from '@/components/Champs';
import FeuilleFiltreStatut from './FeuilleFiltreStatut';
import { formatMontant } from '@/lib/format';
import { type RoleSite } from '@/lib/roles';
import {
  useSites, FiltreSite, ToggleVue, CartesParSite, type PropsPortee,
} from './ContexteSites';
import { sitesDe } from '@/lib/portee';
import ListeDossiers, { type Colonne } from './ListeDossiers';
import RangeeEtapes from './RangeeEtapes';
import ModalEtapes from './ModalEtapes';

interface Props extends PropsPortee {
  userId: string;
  /* Le rôle décide de ce qu'on peut faire ici. Codé en dur à `null`, la
     garde valait « admin » et ne retenait personne. */
  role?: RoleSite | null;
}

/**
 * Deux façons de lire le même dossier.
 *
 * Un transfert appartient à deux sites. Vu d'ici, c'est soit de la
 * marchandise qui part — on la rassemble, on la charge — soit de la
 * marchandise qui arrive — on la compte, on conteste l'écart.
 *
 * Le cycle est le même des deux côtés ; ce qui change, c'est qui peut agir.
 * D'où deux onglets plutôt que deux cycles.
 */
type Sens = 'transfert' | 'reception';

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Ce sur quoi chaque bout doit encore agir.
 *
 * Un transfert a sept étapes, mais aucune des deux extrémités ne les
 * parcourt toutes : l'expéditeur rassemble puis charge ; le destinataire
 * prend la suite quand la marchandise arrive.
 *
 * `expedie` appartient au seul destinataire. Le camion est parti : celui
 * qui l'a chargé n'a plus rien à faire, et la marchandise attend d'être
 * accusée à l'autre bout. La compter encore du côté de l'envoi gonflerait
 * un chiffre qui ne réclame plus aucun geste — or ces comptes ne valent
 * que s'ils disent ce qui attend vraiment.
 *
 * Au-delà, plus rien à faire ici non plus : `a_confirmer` attend
 * l'arbitrage d'un tiers, et `confirme` est clos.
 */
/* Le confirmé clot les deux côtés : celui qui expedie veut savoir ce qui
   est arrive a bon port, celui qui recoit ce qu'il a fini de compter. Le
   retirer ne cachait pas un geste — il n'y en a plus — mais la preuve que
   le travail a abouti. */
const ETAPES_ENVOI: EtatTransfert[] = ['en_cours', 'preparation', 'confirme'];
const ETAPES_RECEPTION: EtatTransfert[] = ['expedie', 'recu', 'traitement', 'confirme'];

const EMOJIS_ETAT: Record<EtatTransfert, string> = {
  en_cours: '🕓',
  preparation: '📦',
  expedie: '🚚',
  recu: '📥',
  traitement: '⚖️',
  a_confirmer: '⏳',
  confirme: '✅',
  annule: '🚫',
};

export default function OngletTransferts({ siteId, userId, sites, role, titre }: Props) {
  /* Deux vocabulaires pour une même personne : `RoleSite` la nomme dans le
     site, `Role` dit ce qu'elle peut faire de la marchandise. */
  const ROLE_COURANT = (role ?? null) as Role | null;
  /* Le responsable des commandes charge et compte la marchandise ; ce
     qu'elle vaut engage le site, pas lui. Les achats et les bons de
     commande le lui cachaient déjà — les transferts, non. */
  const montreArgent = role !== 'commandes';
  const ctx = useSites(siteId, sites);
  const router = useRouter();
  const [transferts, setTransferts] = useState<Transfert[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [filtreStatuts, setFiltreStatuts] = useState<EtatTransfert[]>([]);
  const [feuilleFiltre, setFeuilleFiltre] = useState(false);

  const [sens, setSens] = useState<Sens>('transfert');
  const [etatBrut, setEtat] = useState<EtatTransfert>('en_cours');
  const [recherche, setRecherche] = useState('');
  const [voirEtapes, setVoirEtapes] = useState(false);

  useEffect(() => { charger(); }, [ctx.portee]);

  async function charger() {
    setLoading(true);
    setTransferts(await chargerTransfertsDuSite(ctx.portee));
    setLoading(false);
  }

  if (loading) return (
    <div className="min-h-64 flex items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  /* Ce qui part d'ici, ce qui arrive ici. Un même dossier ne peut pas être
     dans les deux : un site ne se transfère rien à lui-même. */
  /* Le sens se dit depuis un site : « ce qui part d'ici », « ce qui arrive
     ici ». Sur l'ensemble, un transfert entre deux sites de la maison est
     les deux à la fois — le dédoubler ferait compter deux fois un seul
     mouvement. Une liste unique, avec source et destination nommées. */
  const dedans = sitesDe(ctx.portee);
  const duSens = ctx.ensemble
    ? transferts
    : transferts.filter(t => sens === 'transfert'
        ? dedans.includes(t.siteSourceId)
        : dedans.includes(t.siteDestId));

  const parEtat = (e: EtatTransfert) => duSens.filter(t => t.etat === e);

  /* D'où l'on regarde le dossier. Un transfert expédié se dit « Transféré »
     pour celui qui l'a chargé — c'est le geste qu'il vient de faire — mais
     « Annoncé » pour celui qui l'attend : un autre site déclare lui avoir
     envoyé quelque chose, rien n'est arrivé ni compté.
     Sur l'ensemble, aucun des deux bouts n'est « ici » : on garde le
     vocabulaire de l'envoi, qui suit l'ordre du cycle. */
  const sensVu: 'envoi' | 'reception' =
    !ctx.ensemble && sens === 'reception' ? 'reception' : 'envoi';

  /* Celui qui répond du site voit tout le cycle : c'est lui qui arbitre les
     écarts et qui répond des dossiers clos. Celui qui fait avancer la
     marchandise ne voit que les étapes où son geste est attendu — et elles
     ne sont pas les mêmes selon qu'il expédie ou qu'il reçoit. */
  const etapesVues = montreArgent
    ? ETAPES_TRANSFERT
    : (sens === 'transfert' ? ETAPES_ENVOI : ETAPES_RECEPTION);

  /* Une étape absente ne peut pas rester ouverte : on passe des envois aux
     réceptions et « En attente » n'existe plus de ce côté. La première de
     la fenêtre prend le relais, sinon l'écran afficherait une liste vide
     sans tuile pour la désigner. */
  const etat: EtatTransfert = etapesVues.includes(etatBrut)
    ? etatBrut : etapesVues[0];

  /* Une carte par étape, dans l'ordre du cycle.
     Un transfert déplace de la marchandise entre deux sites d'une même
     activité : rien ne se vend, rien ne s'achète, et la valeur ne quitte
     jamais la maison. Ce qui compte, c'est combien de dossiers attendent un
     geste, et ce qu'ils déplacent.

     Un transfert est un dossier, pas un produit : il en porte souvent
     plusieurs, et compter les produits mélangeait deux unités — le grand
     chiffre disait les dossiers, la ligne du dessous les produits. */
  const CARTES = etapesVues.map(e => {
    const liste = parEtat(e);
    /* Ce que l'étape déplace, au coût moyen : l'expédié quand il est connu,
       le demandé tant que rien n'est parti. Sans ce repli, tout ce qui
       précède l'expédition vaudrait zéro. */
    const valeur = liste.reduce((s, t) => s + valeurEnvoyee(t.lignes), 0);
    /* Un écart n'existe qu'une fois compté : avant la réception, il n'y a
       rien à confronter, et le signaler ferait croire à un différend sur un
       dossier que personne n'a encore ouvert. */
    const compte = e === 'recu' || e === 'traitement'
      || e === 'a_confirmer' || e === 'confirme';
    const ecarts = compte ? liste.filter(t => aUnEcart(t.lignes)).length : 0;
    return { key: e, label: libelleTransfert(e, sensVu), emoji: EMOJIS_ETAT[e],
      n: liste.length, valeur, ecarts };
  });

  /* Ce qui concerne un site : ce qui en part et ce qui y arrive. Un
     transfert lie deux sites — il compte pour les deux, chacun ayant un
     geste à faire. */
  function chiffresDuSite(id: string) {
    const siens = transferts.filter(
      t => t.siteSourceId === id || t.siteDestId === id);
    return {
      total: siens.length,
      envoyes: siens.filter(t => t.siteSourceId === id).length,
      recus: siens.filter(t => t.siteDestId === id).length,
      etapes: ETAPES_TRANSFERT.map(e => ({
        label: LIBELLES_TRANSFERT[e],
        n: siens.filter(t => t.etat === e).length,
      })),
    };
  }

  /* En vue « en cours », la carte couvre toutes les étapes de la fenêtre
     sauf le confirmé : filtrer sur la seule première aurait caché les
     dossiers en route, que la carte comptait pourtant. */
  const enCoursVues: EtatTransfert[] = etapesVues.filter(e => e !== 'confirme');
  const listeVue = modeVue === 'encours' && etat !== 'confirme'
    ? duSens.filter(t => enCoursVues.includes(t.etat))
    : parEtat(etat);
  /* La colonne Écart ne vaut que là où la marchandise a été comptée. */
  const compteVue = etat === 'recu' || etat === 'traitement'
    || etat === 'a_confirmer' || etat === 'confirme';

  const filtreActif = modeVue === 'encours' && etat !== 'confirme'
    && filtreStatuts.length > 0;
  const affiches = listeVue.filter(t => {
    if (filtreActif && !filtreStatuts.includes(t.etat)) return false;
    const q = recherche.trim().toLowerCase();
    if (!q) return true;
    return t.reference.toLowerCase().includes(q)
      || t.siteSourceNom.toLowerCase().includes(q)
      || t.siteDestNom.toLowerCase().includes(q);
  });

  /* Un écart gèle le dossier tant qu'un tiers ne l'a pas tranché : le signaler
     en haut évite d'avoir à ouvrir la carte pour le découvrir. */
  const enTraitement = duSens.filter(t => t.etat === 'traitement');

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'text-sm font-bold text-gray-900 dark:text-gray-100'}>
          {titre ?? 'Transferts'}
        </p>
        <div className="flex items-center gap-2">
        {/* Le total dit combien circulent, jamais entre quelles boutiques. */}
        <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
        {/* Le filtre porte sur tout l'écran, cartes comprises. */}
        <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {/* Le sens d'abord : il décide de tout ce qui suit. Sur l'ensemble, il
          n'y a pas de « chez nous » à opposer au reste : les deux bouts sont
          dans la maison. */}
      <div className={`gap-2 mb-4 ${ctx.ensemble ? 'hidden' : 'flex'}`}>
        {([
          /* Le compte dit ce qui attend derrière le bouton. Pour qui fait
             avancer la marchandise, ce sont les seules étapes où son geste
             est attendu : compter les dossiers clos gonflerait un chiffre
             qui ne descendrait jamais, et que plus personne ne lirait. */
          { cle: 'transfert' as const, label: 'Transferts',
            n: transferts.filter(t => dedans.includes(t.siteSourceId)
              && (montreArgent || ETAPES_ENVOI.includes(t.etat))).length },
          { cle: 'reception' as const, label: 'Réceptions',
            n: transferts.filter(t => dedans.includes(t.siteDestId)
              && (montreArgent || ETAPES_RECEPTION.includes(t.etat))).length },
        ]).map(o => (
          <button key={o.cle}
            /* Pas de remise à « En attente » : cette étape n'existe pas du
               côté des réceptions. L'étape se recale d'elle-même sur la
               première de la fenêtre ouverte. */
            onClick={() => { setSens(o.cle); setRecherche(''); }}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors ${sens === o.cle
              ? 'bg-indigo-600 text-white'
              : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
            {o.label}
            <span className={`ml-1.5 font-medium ${sens === o.cle
              ? 'text-indigo-200' : 'text-gray-400'}`}>{o.n}</span>
          </button>
        ))}
      </div>

      {/* Modèle de fond : emoji, compte en pastille, montant en gros, et la
          carte choisie passe en dégradé. */}
      {ctx.parSite ? (
        /* Une carte par site : ce qui le concerne, étape par étape. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          return {
            titre: 'Transferts',
            valeur: String(c.total),
            dort: c.total === 0,
            /* Ce qui part et ce qui arrive : un site peut être encombré de
               réceptions sans avoir rien expédié. */
            badge: c.total > 0
              ? {
                  texte: `${c.envoyes} → · ← ${c.recus}`,
                  ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                }
              : null,
            lignes: c.etapes.map(e => ({
              label: e.label, valeur: String(e.n), vide: e.n === 0,
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
                if (o.cle === 'encours' && etat !== 'confirme') {
                  setEtat(enCoursVues[0]); setRecherche('');
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

      {/* En cours : deux cartes, non sept. Ce qui bouge d'un côté, ce qui
          est clos de l'autre — et le statut de chaque dossier se lit sur
          son badge, dans la liste. */}
      {modeVue === 'encours' && (
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:gap-4">
        {([
          { cle: 'encours' as const, emoji: '🚚', label: 'En cours',
            etats: enCoursVues },
          { cle: 'confirme' as const, emoji: '✅', label: 'Confirmé',
            etats: ['confirme'] as EtatTransfert[] },
        ]).map(c => {
          const liste = c.etats.flatMap(e => parEtat(e));
          const actif = c.cle === 'confirme' ? etat === 'confirme' : etat !== 'confirme';
          return (
            <button key={c.cle} type="button"
              onClick={() => {
                setEtat(c.cle === 'confirme' ? 'confirme' : enCoursVues[0]);
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
      {/* Le panneau n'a de sens que si des étapes manquent à la rangée :
          le proposer quand elle les porte toutes ouvrirait sur la même
          chose. */}
      <RangeeEtapes grille="sm:grid-cols-4 lg:grid-cols-7"
        onToutVoir={etapesVues.length < ETAPES_TRANSFERT.length
          ? () => setVoirEtapes(true) : undefined}>
        {CARTES.map(c => {
          const actif = etat === c.key;
          return (
            /* En rangée, la tuile porte sa propre largeur : `flex` la
               réduirait sinon à son contenu, et les sept ne se
               ressembleraient plus. */
            <button key={c.key} type="button" onClick={() => { setEtat(c.key); setRecherche(''); }}
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
                {/* Combien de dossiers, à l'écart du montant : les deux
                    chiffres ne disent pas la même chose et se confondaient
                    l'un sous l'autre. Quand le grand chiffre porte déjà ce
                    compte, la pastille se tait — le répéter deux fois sur
                    la même tuile ne l'aurait pas rendu plus vrai. */}
                {montreArgent && (
                  <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    actif
                      ? 'bg-white/15 text-white'
                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                    {c.n} dossier{c.n > 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <p className={`mt-3 text-[11px] font-bold uppercase tracking-wide ${
                actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                {c.label}
              </p>
              {/* Le grand chiffre dit ce que l'étape déplace : c'est la
                  valeur qui se compare d'une étape à l'autre, pas un
                  décompte. Sauf pour qui ne répond pas de l'argent : lui
                  fait avancer des dossiers, et c'est leur nombre qui prend
                  la grande place.
                  Sept étapes tiennent sur la largeur d'écran : la tuile est
                  deux fois plus étroite que celle d'un achat, et un montant
                  en 26px s'y coupe en deux lignes. */}
              <p className={`${hankenGrotesk.className} mt-0.5 whitespace-nowrap text-[19px] font-bold leading-7 tracking-tight ${
                actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                {montreArgent ? formatMontant(c.valeur) : c.n}
              </p>
              {/* Un chiffre nu ne dit pas ce qu'il compte : le mot le dit,
                  comme sur les cartes d'achat. */}
              {!montreArgent && (
                <p className={`text-[11px] font-medium ${
                  actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                  dossier{c.n > 1 ? 's' : ''}
                </p>
              )}
              {c.ecarts > 0 && (
                <p className={`mt-1.5 flex items-center gap-1 text-xs font-medium ${
                  actif ? 'text-amber-200' : 'text-orange-500'}`}>
                  <AlertTriangle size={11} />
                  {c.ecarts} écart{c.ecarts > 1 ? 's' : ''}
                </p>
              )}
            </button>
          );
        })}
      </RangeeEtapes>
      </>
      )}

      {enTraitement.length > 0 && (
        <div className="mt-4 flex items-start gap-2 px-4 py-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-2xl">
          <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {enTraitement.length} transfert{enTraitement.length > 1 ? 's' : ''} en traitement.
            Un écart sépare l'envoyé du compté : il doit être tranché avant que le stock ne bouge.
          </p>
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mt-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            {libelleTransfert(etat, sensVu)}
          </p>
          {listeVue.length > 0 && (
            /* Sur un téléphone, la recherche passe sous le libellé : à
               partager la ligne avec lui, il ne lui restait qu'un tiers de
               l'écran et le texte s'y coupait. */
            <ChampRecherche placeholder="Rechercher une référence, un site…"
              valeur={recherche} onChange={setRecherche}
              className="w-full sm:w-auto sm:min-w-[200px] sm:flex-1" />
          )}
          {/* Le filtre ne paraît qu'où il sert : en vue « statut », la
              tuile active a déjà choisi l'étape. */}
          {modeVue === 'encours' && etat !== 'confirme' && enCoursVues.length > 1 && (
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
          {/* On initie depuis le site qui envoie : la réception n'ouvre aucun
              dossier, elle répond à celui qu'un autre site a ouvert. */}
          {/* Un transfert part d'un site : il faut savoir lequel. Depuis
              l'ensemble, il faut donc en avoir choisi un. */}
          {(ctx.ensemble ? true : sens === 'transfert') && peutInitierTransfert(ROLE_COURANT)
            && ctx.siteEcriture && (
            <button onClick={() => router.push(
              `/site/${ctx.siteEcriture}/transferts/nouveau${marqueOrigine(ctx.ensemble)}`)}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
              <Plus size={14} /> Initier un transfert
            </button>
          )}
        </div>

        {affiches.length === 0
          ? <p className="text-xs text-gray-400 text-center py-8">
              {recherche.trim() ? 'Aucun résultat.' : 'Aucun transfert.'}
            </p>
          : (
            <ListeDossiers
              dossiers={affiches}
              cleDe={t => t.id}
              compte={`${affiches.length} transfert${affiches.length > 1 ? 's' : ''}`}
              onOuvrir={t => router.push(
                `/site/${ctx.ensemble ? t.siteSourceId : siteId}/transferts/${t.id}${ctx.ensemble ? '?de=ensemble' : ''}`)}
              colonnes={[
                { cle: 'reference', label: 'Référence', rang: 'titre',
                  rendu: t => (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">{t.reference}</span>
                      {/* Le statut colle à la référence : en vue « en cours »,
                          la liste mêle les étapes et les tuiles qui le
                          disaient ne sont plus à l'écran. */}
                      {modeVue === 'encours' && etat !== 'confirme' && (
                        <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          t.etat === 'traitement' || t.etat === 'a_confirmer'
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                            : t.etat === 'expedie' || t.etat === 'recu'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                          {LIBELLES_TRANSFERT[t.etat]}
                        </span>
                      )}
                    </span>
                  ) },
                /* Pas d'état : la tuile d'étape ouverte le dit déjà, et
                   tous les dossiers de la liste le partagent — le répéter
                   sur chaque ligne ne distinguerait rien. Les achats et les
                   bons de commande font de même. */
                /* Sur l'ensemble, les deux bouts comptent : aucun n'est
                   « ici » plus que l'autre. */
                ...(ctx.ensemble ? [
                  { cle: 'source', label: 'Source', rang: 'corps' as const,
                    rendu: (t: Transfert) => (
                      <span className="text-gray-600 dark:text-gray-400">{t.siteSourceNom}</span>
                    ) },
                  { cle: 'dest', label: 'Destination', rang: 'corps' as const,
                    rendu: (t: Transfert) => (
                      <span className="text-gray-600 dark:text-gray-400">{t.siteDestNom}</span>
                    ) },
                ] : [
                  { cle: 'bout', label: sens === 'transfert' ? 'Destination' : 'Provenance',
                    rang: 'corps' as const,
                    rendu: (t: Transfert) => (
                      <span className="text-gray-600 dark:text-gray-400">
                        {sens === 'transfert' ? t.siteDestNom : t.siteSourceNom}
                      </span>
                    ) },
                ]),
                { cle: 'date', label: 'Date', rang: 'corps',
                  rendu: t => <span className="text-gray-500">{formatDate(t.dateInitiation)}</span> },
                { cle: 'produits', label: 'Produits', rang: 'corps',
                  rendu: t => t.lignes.length },
                ...(compteVue ? [{
                  cle: 'ecart', label: 'Écart', rang: 'corps' as const,
                  rendu: (t: Transfert) => {
                    /* Tant que rien n'est compté, il n'y a pas d'écart : on ne
                       peut pas différer d'un compte qui n'existe pas. */
                    const compte = t.etat === 'recu' || t.etat === 'traitement'
                      || t.etat === 'a_confirmer' || t.etat === 'confirme';
                    /* L'écart se dit en lignes, pas en francs : ce qui manque
                       n'a jamais quitté la source, rien n'est perdu. C'est
                       combien de produits divergent qui demande un geste. */
                    const lignesEcart = lignesEnEcart(t.lignes).length;
                    return (
                      <span className={`font-bold ${lignesEcart === 0
                        ? 'text-gray-300 dark:text-gray-600' : 'text-orange-500'}`}>
                        {!compte ? '—'
                          : lignesEcart === 0 ? 'Conforme'
                          : `${lignesEcart} ligne${lignesEcart > 1 ? 's' : ''}`}
                      </span>
                    );
                  },
                }] : []),
              ] as Colonne<Transfert>[]}
            />
          )
        }
      </div>
      </>
      )}

      {/* Le cycle entier : les étapes de son ressort s'ouvrent, les autres
          se lisent. Le compte porte sur le sens ouvert — ce qui part, ou
          ce qui arrive. */}
      {voirEtapes && (
        <ModalEtapes
          titre={sens === 'transfert' ? 'Transferts' : 'Réceptions'}
          courante={etat}
          onFermer={() => setVoirEtapes(false)}
          onChoisir={cle => setEtat(cle as EtatTransfert)}
          etapes={ETAPES_TRANSFERT.map(e => ({
            cle: e,
            label: libelleTransfert(e, sensVu),
            emoji: EMOJIS_ETAT[e],
            n: parEtat(e).length,
            ouvrable: etapesVues.includes(e),
          }))}
        />
      )}

      {/* Le filtre par statut : il reprend le choix que les tuiles
          offraient, sans quitter la vue d'ensemble. */}
      {feuilleFiltre && (
        <FeuilleFiltreStatut
          options={enCoursVues.map(e => ({
            cle: e, label: LIBELLES_TRANSFERT[e], n: parEtat(e).length,
          }))}
          choisis={filtreStatuts}
          onChange={c => setFiltreStatuts(c as EtatTransfert[])}
          onFermer={() => setFeuilleFiltre(false)} />
      )}
    </div>
  );
}
