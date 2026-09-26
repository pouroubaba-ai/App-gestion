'use client';

/**
 * Les retours de marchandise.
 *
 * Un même écran pour trois métiers : le gérant ouvre, le responsable des
 * commandes traite, et tous deux lisent la même liste. Seul le bouton
 * d'ouverture change — celui qui exécute ne décide pas de ce qu'il aura à
 * faire.
 *
 * Ce partage n'est pas qu'une commodité d'affichage : c'est ce qui rend la
 * fraude visible. Un retour déclaré mais jamais parti reste sous les yeux
 * de celui qui devrait l'avoir traité.
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Loader2, Plus, Undo2, PackageCheck, Truck, SlidersHorizontal,
} from 'lucide-react';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from './finance/font';
import { type RoleSite } from '@/lib/roles';
import {
  chargerRetours, ETAPES_RETOUR, LIBELLES_ETAT_RETOUR,
  etatFinal, enCours,
  type DossierRetour, type TypeRetour, type EtatRetour,
} from '@/lib/retours-dossiers';
import { ChampRecherche } from '@/components/Champs';
import {
  useSites, FiltreSite, ToggleVue, CartesParSite, type PropsPortee,
} from './ContexteSites';
import ListeDossiers, { type Colonne } from './ListeDossiers';
import RangeeEtapes from './RangeeEtapes';
import FeuilleFiltreStatut from './FeuilleFiltreStatut';

interface Props extends PropsPortee {
  userId: string;
  /** `null` = propriétaire : aucune restriction */
  role?: RoleSite | null;
}

/**
 * Qui peut ouvrir un retour.
 *
 * Décider qu'une marchandise repart engage le site : une dette s'éteint,
 * ou de l'argent sort. Le responsable des commandes exécute ce qu'on a
 * décidé — lui donner l'ouverture reviendrait à lui confier les deux
 * bouts, et c'est précisément ce que le cycle sépare.
 */
export function peutOuvrirRetour(role: RoleSite | null | undefined): boolean {
  return role === null || role === undefined || role === 'gerant';
}

const TYPES: { cle: TypeRetour; label: string; icone: typeof Undo2 }[] = [
  { cle: 'client', label: 'Clients', icone: PackageCheck },
  { cle: 'fournisseur', label: 'Fournisseurs', icone: Truck },
  { cle: 'transfert', label: 'Transferts', icone: Undo2 },
];

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Le ton d'un état : ce qui attend se voit, ce qui est clos s'efface. */
function tonEtat(d: DossierRetour): string {
  if (d.etat === 'annule') {
    return 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
  }
  if (d.etat === etatFinal(d.type)) {
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  }
  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
}

export default function OngletRetours({
  siteId, sites, userId, role, titre,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ctx = useSites(siteId, sites);
  const [dossiers, setDossiers] = useState<DossierRetour[]>([]);
  const [loading, setLoading] = useState(true);
  /* Le type vit dans l'adresse.
   *
   * Sans cela, on partait des fournisseurs, on ouvrait un dossier, et le
   * retour arrière ramenait sur les clients — vide. L'écran annonçait
   * « 0 retour » sur un site qui en avait, et l'on croyait son travail
   * perdu. Ce que l'on regardait fait partie de l'endroit où l'on est. */
  const typeUrl = (search: URLSearchParams): TypeRetour => {
    const t = search.get('retours') as TypeRetour | null;
    return t === 'fournisseur' || t === 'transfert' || t === 'client'
      ? t : 'client';
  };
  const [type, setTypeBrut] = useState<TypeRetour>(() => typeUrl(searchParams));

  /* `replace` et non `push` : parcourir les trois onglets n'a pas à
     remplir l'historique de pas qu'on devra défaire un à un. */
  function setType(t: TypeRetour) {
    setTypeBrut(t);
    const params = new URLSearchParams(searchParams.toString());
    params.set('retours', t);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  /* L'adresse peut changer sans que l'écran soit remonté — un lien du
     menu, ou le bouton « précédent ». On suit. */
  useEffect(() => {
    const voulu = typeUrl(searchParams);
    setTypeBrut(prev => (prev === voulu ? prev : voulu));
  }, [searchParams]);
  const [recherche, setRecherche] = useState('');
  /* Les états retenus. Vide = tous, ce qui est l'état au repos. */
  const [filtreEtats, setFiltreEtats] = useState<EtatRetour[]>([]);
  const [feuilleFiltre, setFeuilleFiltre] = useState(false);
  /* Voir la marchandise n'est pas voir l'argent : les commandes exécutent
     sans savoir ce que le site doit. */
  const voitLArgent = role !== 'commandes';

  useEffect(() => {
    setLoading(true);
    chargerRetours(ctx.portee)
      .then(setDossiers)
      .catch(() => setDossiers([]))
      .finally(() => setLoading(false));
  }, [ctx.portee]);

  if (loading) return (
    <div className="flex min-h-64 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const q = recherche.trim().toLowerCase();
  const duType = dossiers.filter(d => d.type === type);
  /* Les trois cycles n'ont pas les mêmes étapes : un filtre « Livré »
     retenu chez les fournisseurs ne désigne rien chez les clients, et
     laisserait une liste vide sans dire pourquoi. */
  const etatsDuType: EtatRetour[] = [...ETAPES_RETOUR[type], 'annule'];
  const etatsRetenus = filtreEtats.filter(e => etatsDuType.includes(e));
  const filtreActif = etatsRetenus.length > 0;

  const affiches = duType
    .filter(d => !filtreActif || etatsRetenus.includes(d.etat))
    .filter(d =>
      !q || d.reference.toLowerCase().includes(q)
      || (d.partenaireNom ?? '').toLowerCase().includes(q));

  const colonnes: Colonne<DossierRetour>[] = [
    {
      cle: 'reference', label: 'Référence', rang: 'titre',
      rendu: d => <span className="font-mono text-xs">{d.reference}</span>,
    },
    {
      cle: 'etat', label: 'État', rang: 'marque',
      rendu: d => (
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${tonEtat(d)}`}>
          {LIBELLES_ETAT_RETOUR[d.etat]}
        </span>
      ),
    },
    ...(ctx.ensemble ? [{
      cle: 'site', label: 'Site', rang: 'corps' as const,
      rendu: (d: DossierRetour) => ctx.nomDe(d.siteId),
    }] : []),
    {
      cle: 'tiers', label: type === 'transfert' ? 'Site lié' : 'Partenaire',
      rang: 'corps',
      rendu: d => d.type === 'transfert'
        ? ctx.nomDe(d.siteLieId) : (d.partenaireNom ?? '—'),
    },
    {
      cle: 'lignes', label: 'Produits', rang: 'corps',
      rendu: d => `${d.lignes.length}`,
    },
    /* Le responsable des commandes prépare de la marchandise : ni la
       valeur du retour ni la façon dont il se règle ne le regardent, et
       les lui montrer lui apprendrait ce que le site doit. */
    ...(voitLArgent ? [{
      cle: 'valeur', label: 'Valeur', rang: 'corps' as const,
      rendu: (d: DossierRetour) => (
        <span className="font-bold">{formatMontant(d.valeurTotale)}</span>
      ),
    }] : []),
    /* Ce que le retour a fait, ou ce qu'il fera.
     *
     * Cette colonne affichait le règlement choisi à l'ouverture, ce qui
     * annonçait « Remboursé » sur des retours qui ne remboursaient rien :
     * un retour éteint d'abord la dette du bon qu'il défait, et le choix
     * ne porte que sur un éventuel surplus. Une fois confirmé, on dit le
     * fait ; avant, on dit l'intention sans la déguiser en fait. */
    ...(type === 'transfert' || !voitLArgent ? [] : [{
      cle: 'reglement', label: 'Règlement', rang: 'corps' as const,
      rendu: (d: DossierRetour) =>
        d.rembourse != null
          ? (d.rembourse > 0
              ? `Remboursé ${formatMontant(d.rembourse)}`
              : 'Porté sur la dette')
          : d.reglement === 'deduire'
            ? 'Surplus sur la dette'
            : 'Surplus remboursé',
    }]),
    {
      cle: 'date', label: 'Date', rang: 'pied',
      rendu: d => formatDate(d.date),
    },
  ];

  const parEtat = (e: EtatRetour) => duType.filter(d => d.etat === e).length;
  /* Ce que pèse chaque étape. Un compte dit combien de dossiers
     attendent, jamais ce qu'ils engagent : huit retours de 5 000 et un
     seul de 400 000 n'appellent pas la même attention. */
  const valeurEtat = (e: EtatRetour) => duType
    .filter(d => d.etat === e)
    .reduce((n, d) => n + d.valeurTotale, 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'text-sm font-bold text-gray-900 dark:text-gray-100'}>
          {titre ?? 'Retours'}
        </p>
        <div className="flex items-center gap-2">
          <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
          {/* Le responsable des commandes ne l'a pas : il traite ce qu'on
              lui confie, il ne décide pas de ce qui repart. */}
          {peutOuvrirRetour(role) && ctx.siteEcriture && (
            <button type="button"
              onClick={() => router.push(
                `/site/${ctx.siteEcriture}/retours/nouveau?type=${type}`)}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
              <Plus size={14} /> Nouveau retour
            </button>
          )}
        </div>
      </div>

      {/* De qui vient la marchandise, ou vers qui elle va. Les trois
          cycles n'ont ni les mêmes étapes ni le même effet sur l'argent :
          les mêler dans une liste unique obligerait à relire le type à
          chaque ligne. */}
      <div className="mb-4 flex items-center gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
        {TYPES.map(t => {
          const n = dossiers.filter(d => d.type === t.cle && enCours(d)).length;
          return (
            <button key={t.cle} type="button"
              onClick={() => {
                setType(t.cle); setRecherche(''); setFiltreEtats([]);
              }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                type === t.cle
                  ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                  : 'text-gray-400 hover:text-gray-600'}`}>
              <t.icone size={13} />
              {t.label}
              {n > 0 && (
                <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {ctx.parSite ? (
        <CartesParSite sites={ctx.sitesVus}
          onChoisir={id => { ctx.setFiltre(id); ctx.setVue('ensemble'); }}
          contenu={id => {
            const duSite = duType.filter(d => d.siteId === id);
            const attente = duSite.filter(enCours);
            return {
              titre: 'En cours',
              /* Aux commandes, la carte compte des dossiers : le montant
                 total des retours d'un site ne leur apprend rien d'utile
                 et dit ce que la maison doit. */
              valeur: voitLArgent
                ? formatMontant(
                    attente.reduce((n, d) => n + d.valeurTotale, 0))
                : String(attente.length),
              dort: duSite.length === 0,
              badge: attente.length > 0
                ? {
                    texte: `${attente.length} retour${attente.length > 1 ? 's' : ''}`,
                    ton: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                  }
                : null,
              lignes: ETAPES_RETOUR[type].map(e => ({
                label: LIBELLES_ETAT_RETOUR[e],
                valeur: String(duSite.filter(d => d.etat === e).length),
                vide: duSite.filter(d => d.etat === e).length === 0,
              })),
            };
          }} />
      ) : (
        <>
          {/* Une tuile par étape : on lit ce qui attend le même geste,
              plutôt qu'un mélange qu'il faut retrier à l'œil. */}
          <RangeeEtapes grille={`sm:grid-cols-${ETAPES_RETOUR[type].length}`}>
            {ETAPES_RETOUR[type].map(e => (
              <div key={e}
                className="block rounded-2xl border border-black/[0.06] bg-white p-3 text-left shadow-sm dark:border-white/10 dark:bg-neutral-900 sm:p-4">
                <p className="text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                  {LIBELLES_ETAT_RETOUR[e]}
                </p>
                <p className={`${hankenGrotesk.className} mt-1 text-[22px] font-bold leading-7`}>
                  {parEtat(e)}
                </p>
                {/* La valeur sous le compte, et seulement pour qui voit
                    l'argent : le responsable des commandes compte des
                    sacs, pas des francs. */}
                {voitLArgent && (
                  <p className="mt-0.5 text-[12px] font-medium text-neutral-400">
                    {formatMontant(valeurEtat(e))}
                  </p>
                )}
              </div>
            ))}
          </RangeeEtapes>

          {/* Le tableau vit dans une carte, comme sur les achats et les
              transferts. Posé à même le fond, il n'avait plus de bord où
              s'arrêter, et l'écran se lisait comme une page inachevée. */}
          <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <ChampRecherche valeur={recherche} onChange={setRecherche}
                placeholder="Référence, partenaire…"
                className="min-w-[200px] flex-1" />
              {/* Le même filtre que sur les achats : chaque état y porte
                  son compte, pour ne pas choisir une case vide. */}
              <button type="button" onClick={() => setFeuilleFiltre(true)}
                className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                  filtreActif
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-800/40 dark:bg-indigo-900/20 dark:text-indigo-400'
                    : 'border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700 dark:text-gray-300'}`}>
                <SlidersHorizontal size={13} />
                État
                {filtreActif && (
                  <span className="rounded-md bg-indigo-600 px-1.5 text-[10px] text-white">
                    {etatsRetenus.length}
                  </span>
                )}
              </button>
            </div>

            <ListeDossiers
              dossiers={affiches}
              colonnes={colonnes}
              cleDe={d => d.id}
              /* L'origine voyage avec le lien : « Fermer » revient sur
                 l'onglet qu'on parcourait, et non sur un écran par
                 défaut qui ferait perdre le fil. */
              onOuvrir={d => router.push(
                `/site/${d.siteId}/retours/${d.id}?de=${
                  ctx.ensemble ? 'ensemble' : 'site'}&retours=${d.type}`)}
              compte={
                <span className="text-sm font-medium text-gray-500">
                  {affiches.length} retour{affiches.length > 1 ? 's' : ''}
                </span>
              } />
          </div>
        </>
      )}

      {/* Les états du cycle courant, chacun avec son compte : « Annulé »
          n'est pas une étape mais se filtre comme les autres — on veut
          souvent le mettre de côté, ou ne voir que lui. */}
      {feuilleFiltre && (
        <FeuilleFiltreStatut
          options={etatsDuType.map(e => ({
            cle: e,
            label: LIBELLES_ETAT_RETOUR[e],
            n: duType.filter(d => d.etat === e).length,
          }))}
          choisis={etatsRetenus}
          onChange={c => setFiltreEtats(c as EtatRetour[])}
          onFermer={() => setFeuilleFiltre(false)} />
      )}
    </div>
  );
}
