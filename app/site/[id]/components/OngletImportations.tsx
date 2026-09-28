'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from './finance/font';
import { type RoleSite } from '@/lib/roles';
import { totalFrais } from '@/lib/frais';
import { valeurEnvoyee, valeurRecue } from '@/lib/flux-marchandise';
import {
  importationsDe, ETAPES_IMPORTATION, LIBELLES_IMPORTATION,
  dateOuverture, ageEnJours, delaiLivraison,
  type Importation, type EtatImportation,
} from '@/lib/importations';
import { ChampRecherche } from '@/components/Champs';
import {
  useSites, FiltreSite, ToggleVue, CartesParSite, type PropsPortee,
} from './ContexteSites';
import ListeDossiers, { type Colonne } from './ListeDossiers';
import RangeeEtapes from './RangeeEtapes';

interface Props extends PropsPortee {
  userId: string;
  /** `null` = admin ou propriétaire : aucune restriction */
  role?: RoleSite | null;
}

/**
 * Les importations : un achat avec le voyage en plus.
 *
 * Même marchandise, mêmes frais, même confirmation qui fait entrer le
 * stock. Ce qui change est le temps — entre la commande et le rayon il
 * se passe des semaines et des mains, et chacune est un fait qu'on veut
 * pouvoir dater.
 *
 * L'écran est celui des achats, parce que le geste est le même : deux
 * lectures, une rangée d'étapes, la liste dessous. Un import ne se
 * regarde pas autrement qu'un achat — il dure seulement plus longtemps.
 */
const EMOJIS_ETAT: Record<EtatImportation, string> = {
  en_attente: '⏳',
  valide: '📝',
  expedie: '🚢',
  arrive: '⚓',
  dedouane: '🛃',
  recu: '📥',
  traitement: '⚖️',
  attente_confirmation: '🔍',
  confirme: '✅',
  annule: '🚫',
};

/* L'ordre des cartes : le voyage, avec l'arrêt de contrôle à sa place —
   juste avant la clôture, puisque c'est là qu'il retient. */
const CARTES_ETATS: EtatImportation[] = ETAPES_IMPORTATION.flatMap(e =>
  e === 'confirme' ? ['attente_confirmation' as EtatImportation, e] : [e]);

/* À partir de la réception, le dossier vaut ce qui est arrivé ; avant,
   ce qui était annoncé. */
function compté(e: EtatImportation): boolean {
  return e === 'attente_confirmation'
    || ETAPES_IMPORTATION.indexOf(e) >= ETAPES_IMPORTATION.indexOf('recu');
}

export default function OngletImportations({
  siteId, userId, role, sites, titre,
}: Props) {
  const ctx = useSites(siteId, sites);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [dossiers, setDossiers] = useState<Importation[]>([]);
  const [chargement, setChargement] = useState(true);
  const [recherche, setRecherche] = useState('');

  /* La carte ouverte transite par l'URL : sans ça, revenir d'une fiche
     retombait sur la carte par défaut. */
  const [modeVue, setModeVue] = useState<'encours' | 'statut'>('encours');
  /* Deux façons de juger. Par document : où en est ce dossier-là. Par
     fournisseur : ce que vaut ce partenaire sur la durée — un retard
     isolé est un incident, répété c'est un comportement. */
  const [axe, setAxe] = useState<'document' | 'fournisseur'>('document');
  const [vue, setVueBrut] = useState<EtatImportation>(() => {
    const c = searchParams.get('carte') as EtatImportation | null;
    return c && CARTES_ETATS.includes(c) ? c : 'en_attente';
  });

  function setVue(v: EtatImportation) {
    setVueBrut(v);
    const p = new URLSearchParams(searchParams.toString());
    p.set('carte', v);
    router.replace(`?${p.toString()}`, { scroll: false });
  }

  useEffect(() => {
    let vivant = true;
    setChargement(true);
    importationsDe(ctx.portee)
      .then(l => { if (vivant) setDossiers(l); })
      .catch(() => {})
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [ctx.portee]);

  const parEtat = (e: EtatImportation) => dossiers.filter(d => d.etat === e);

  /* Le responsable des commandes compte des cartons, pas des francs. */
  const montreArgent = role !== 'commandes';

  /* Ce qu'un dossier pèse : la marchandise et le voyage. Le fret est dû
     comme elle — le laisser dehors afficherait une dette inférieure à ce
     qu'on doit. */
  const valeurDe = (d: Importation, compte: boolean) =>
    (compte ? valeurRecue(d.lignes) : valeurEnvoyee(d.lignes)) + totalFrais(d.frais);

  /* Une carte par étape, dans l'ordre du voyage. */
  const CARTES = CARTES_ETATS.map(e => {
    const liste = parEtat(e);
    const valeur = liste.reduce((s, d) => s + valeurDe(d, compté(e)), 0);
    const frais = liste.reduce((s, d) => s + totalFrais(d.frais), 0);
    const verse = liste.reduce((s, d) => s + (d.avanceVersee ?? 0), 0);
    return {
      cle: e,
      emoji: EMOJIS_ETAT[e],
      titre: LIBELLES_IMPORTATION[e],
      montant: valeur,
      frais,
      /* Avant l'expédition l'argent porte sur une promesse ; après, sur
         une marchandise en route. */
      libelleVerse: e === 'en_attente' || e === 'valide' ? 'Avance' : 'Versé',
      verse,
      reste: Math.max(0, valeur - verse),
      nb: liste.length,
    };
  });

  /* Ce qu'un site attend : combien de dossiers viennent vers lui, ce
     qu'ils pèsent, et où ils en sont. La vue d'ensemble additionne tout ;
     celle-ci répond site par site. */
  function chiffresDuSite(id: string) {
    const siens = dossiers.filter(d => d.siteId === id && d.etat !== 'annule');
    return {
      total: siens.length,
      valeur: siens.reduce((n, d) => n + valeurDe(d, compté(d.etat)), 0),
      etapes: CARTES_ETATS.map(e => {
        const l = siens.filter(d => d.etat === e);
        return {
          label: LIBELLES_IMPORTATION[e],
          n: l.length,
          valeur: l.reduce((n, d) => n + valeurDe(d, compté(e)), 0),
        };
      }),
    };
  }

  /* Les deux cartes de tête : ce qui voyage, ce qui est arrivé. */
  const enRoute = dossiers.filter(d => d.etat !== 'confirme' && d.etat !== 'annule');
  const RESUME = ([
    { cle: 'encours' as const, emoji: '🚢', titre: 'En cours', liste: enRoute, compte: false },
    { cle: 'confirme' as const, emoji: '✅', titre: 'Confirmé', liste: parEtat('confirme'), compte: true },
  ]).map(c => {
    const valeur = c.liste.reduce((s, d) => s + valeurDe(d, c.compte), 0);
    const frais = c.liste.reduce((s, d) => s + totalFrais(d.frais), 0);
    const verse = c.liste.reduce((s, d) => s + (d.avanceVersee ?? 0), 0);
    return { ...c, valeur, frais, verse, reste: Math.max(0, valeur - verse) };
  });

  /* En vue « en cours », la carte couvre tous les états sauf le confirmé :
     filtrer sur le seul « en attente » cacherait les dossiers en route,
     que la carte compte pourtant. */
  const listeVue = modeVue === 'encours' && vue !== 'confirme' ? enRoute : parEtat(vue);
  const compteVue = modeVue === 'statut' ? compté(vue) : vue === 'confirme';

  const q = recherche.trim().toLowerCase();
  const affiches = listeVue.filter(d => !q
    || d.reference.toLowerCase().includes(q)
    || d.fournisseurNom.toLowerCase().includes(q)
    || (d.origine ?? '').toLowerCase().includes(q));

  /* Vue par fournisseur : on ne juge plus un dossier mais un partenaire.
     Le délai moyen ne se calcule que sur les dossiers arrivés — un
     import encore en mer n'apprend rien sur les délais tenus. */
  type LigneFournisseur = {
    id: string | null; nom: string; documents: number;
    valeur: number; verse: number; delais: number[];
  };
  const parFournisseur: LigneFournisseur[] = [...affiches.reduce((acc, d) => {
    const cle = d.fournisseurId ?? d.fournisseurNom;
    const prev = acc.get(cle) ?? {
      id: d.fournisseurId ?? null, nom: d.fournisseurNom,
      documents: 0, valeur: 0, verse: 0, delais: [] as number[],
    };
    const delai = d.etat === 'confirme' ? delaiLivraison(d) : null;
    acc.set(cle, {
      ...prev,
      documents: prev.documents + 1,
      valeur: prev.valeur + valeurDe(d, compté(d.etat)),
      verse: prev.verse + (d.avanceVersee ?? 0),
      delais: delai == null ? prev.delais : [...prev.delais, delai],
    });
    return acc;
  }, new Map<string, LigneFournisseur>())]
    .map(([, v]) => v)
    /* Le plus gros d'abord : c'est celui qui engage le plus d'argent. */
    .sort((a, b) => b.valeur - a.valeur);

  const colonnesFournisseur: Colonne<LigneFournisseur>[] = [
    { cle: 'nom', label: 'Fournisseur', rang: 'titre', rendu: f => f.nom },
    { cle: 'documents', label: 'Importations', rang: 'corps',
      rendu: f => String(f.documents) },
    ...(montreArgent ? ([
      { cle: 'valeur', label: 'Valeur', rang: 'corps',
        rendu: (f: LigneFournisseur) => formatMontant(f.valeur) },
      { cle: 'verse', label: 'Versé', rang: 'corps',
        rendu: (f: LigneFournisseur) => formatMontant(f.verse) },
      { cle: 'reste', label: 'Reste', rang: 'corps',
        rendu: (f: LigneFournisseur) => {
          const r = Math.max(0, f.valeur - f.verse);
          return (
            <span className={r > 0 ? 'font-bold text-orange-500' : undefined}>
              {formatMontant(r)}
            </span>
          );
        } },
    ] as Colonne<LigneFournisseur>[]) : []),
    /* Ce qu'il met à livrer, du feu vert à l'arrivée. C'est le vrai
       jugement sur un fournisseur d'import : pas seulement ce qu'il
       coûte, mais en combien de temps il sert. */
    { cle: 'delai', label: 'Délai moyen', rang: 'pied',
      rendu: f => {
        if (f.delais.length === 0) return '—';
        const moy = Math.round(f.delais.reduce((n, x) => n + x, 0) / f.delais.length);
        return (
          <span className={moy >= 60 ? 'font-bold text-orange-500' : undefined}>
            {moy} j
            <span className="ml-1 text-[11px] text-gray-400">
              sur {f.delais.length}
            </span>
          </span>
        );
      } },
  ];

  const colonnes: Colonne<Importation>[] = [
    { cle: 'reference', label: 'Référence', rang: 'titre', rendu: d => d.reference },
    { cle: 'etat', label: 'État', rang: 'marque',
      rendu: d => LIBELLES_IMPORTATION[d.etat] },
    { cle: 'fournisseur', label: 'Fournisseur', rang: 'corps',
      rendu: d => d.fournisseurNom },
    { cle: 'origine', label: 'Origine', rang: 'corps',
      rendu: d => d.origine || '—' },
    { cle: 'destination', label: 'Destination', rang: 'corps',
      rendu: d => d.siteNom || '—' },
    { cle: 'date', label: 'Date', rang: 'corps',
      rendu: d => {
        const j = dateOuverture(d);
        return j ? j.split('-').reverse().join('/') : '—';
      } },
    /* Depuis combien de temps on attend. Un dossier de quarante jours
       encore « expédié » se voit ici d'un coup d'œil : son état seul
       dirait la même chose qu'hier. */
    { cle: 'age', label: 'Jours', rang: 'corps',
      rendu: d => {
        const n = ageEnJours(d);
        if (n == null) return '—';
        const vieux = d.etat !== 'confirme' && d.etat !== 'annule' && n >= 30;
        return (
          <span className={vieux ? 'font-bold text-orange-500' : undefined}>
            {n} j
          </span>
        );
      } },
    ...(montreArgent ? ([
      { cle: 'frais', label: 'Frais', rang: 'corps',
        rendu: (d: Importation) => totalFrais(d.frais) > 0
          ? formatMontant(totalFrais(d.frais)) : '—' },
      { cle: 'valeur', label: 'Valeur', rang: 'corps',
        rendu: (d: Importation) => formatMontant(valeurDe(d, compteVue)) },
      { cle: 'reste', label: 'Reste', rang: 'pied',
        rendu: (d: Importation) => formatMontant(
          Math.max(0, valeurDe(d, compteVue) - (d.avanceVersee ?? 0))) },
    ] as Colonne<Importation>[]) : []),
  ];

  if (chargement) return (
    <div className="flex min-h-64 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  /* Le pied d'une carte : ce qui est versé, ce qui reste. Le même sur les
     deux rangées — deux façons de l'écrire finiraient par diverger. */
  const pied = (
    actif: boolean, libelle: string, verse: number, reste: number,
  ) => (
    <div className={`mt-2.5 flex justify-between gap-2 border-t pt-2 text-xs ${
      actif ? 'border-white/15' : 'border-black/[0.06] dark:border-white/10'}`}>
      <span className="flex items-baseline gap-1.5">
        <span className={actif ? 'text-indigo-100' : 'text-neutral-400'}>{libelle}</span>
        <span className={`font-bold ${actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
          {formatMontant(verse)}
        </span>
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className={actif ? 'text-indigo-100' : 'text-neutral-400'}>Reste</span>
        <span className={`font-bold ${reste > 0
          ? (actif ? 'text-amber-200' : 'text-orange-500')
          : (actif ? 'text-white' : 'text-neutral-900 dark:text-white')}`}>
          {formatMontant(reste)}
        </span>
      </span>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'text-sm font-bold text-gray-900 dark:text-gray-100'}>
          {titre ?? 'Importations'}
        </p>
        <div className="flex items-center gap-2">
          <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {ctx.parSite ? (
        /* Une carte par site : ce qui vient vers lui, étape par étape. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          return {
            titre: montreArgent ? 'Importations' : 'Dossiers',
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
      {/* Les deux lectures du même dossier, comme aux achats. Elles ne
          valent qu'en vue d'ensemble : par site, chaque carte porte déjà
          son détail étape par étape. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-0.5 rounded-xl bg-neutral-100 p-1 dark:bg-neutral-800">
          {([
            { key: 'encours' as const, label: 'En cours' },
            { key: 'statut' as const, label: 'Statut' },
          ]).map(v => (
            <button key={v.key} type="button"
              onClick={() => { setModeVue(v.key); setRecherche(''); }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${modeVue === v.key
                ? 'bg-white text-indigo-600 shadow-sm dark:bg-neutral-700 dark:text-indigo-400'
                : 'text-neutral-400 hover:text-neutral-600 dark:text-neutral-500'}`}>
              {v.label}
            </button>
          ))}
        </div>
        <button type="button"
          onClick={() => router.push('/ensemble/importations/nouvelle')}
          className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
          <Plus size={13} /> Nouvelle importation
        </button>
      </div>

      {modeVue === 'encours' ? (
        <RangeeEtapes grille="sm:grid-cols-2">
          {RESUME.map(c => {
            const actif = c.cle === 'confirme' ? vue === 'confirme' : vue !== 'confirme';
            return (
              <button key={c.cle} type="button"
                onClick={() => setVue(c.cle === 'confirme' ? 'confirme' : 'en_attente')}
                className={`block rounded-2xl p-3 text-left shadow-sm transition-all sm:p-4 ${actif
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
                  {montreArgent && (
                    <span className={`shrink-0 rounded-lg px-2 py-1 text-xs font-bold ${actif
                      ? 'bg-white/15 text-indigo-100'
                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                      {c.liste.length}
                    </span>
                  )}
                </div>
                <p className={`mt-3 text-[11px] font-bold uppercase tracking-wide ${
                  actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                  {c.titre}
                </p>
                <p className={`${hankenGrotesk.className} mt-0.5 text-[22px] font-bold leading-7 tracking-tight ${
                  actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                  {montreArgent ? formatMontant(c.valeur) : c.liste.length}
                </p>
                {!montreArgent && (
                  <p className={`mt-0.5 text-[11px] font-medium ${
                    actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                    dossier{c.liste.length > 1 ? 's' : ''}
                  </p>
                )}
                {montreArgent && (
                  <>
                    {pied(actif, 'Versé', c.verse, c.reste)}
                    {/* Ce que le voyage a coûté, dit à part : noyé dans le
                        total il ne se verrait pas, et c'est lui qui dit si
                        importer vaut le coup. */}
                    {c.frais > 0 && (
                      <p className={`mt-1.5 text-[11px] font-medium ${
                        actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                        dont{' '}
                        <span className={`font-bold ${actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                          {formatMontant(c.frais)}
                        </span>{' '}
                        de frais
                      </p>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </RangeeEtapes>
      ) : (
        <RangeeEtapes grille="sm:grid-cols-3 lg:grid-cols-5">
          {CARTES.map(c => {
            const actif = vue === c.cle;
            return (
              <button key={c.cle} type="button"
                onClick={() => { setVue(c.cle); setRecherche(''); }}
                className={`block rounded-2xl p-3 text-left shadow-sm transition-all sm:p-4 ${actif
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
                  {montreArgent && (
                    <span className={`shrink-0 rounded-lg px-2 py-1 text-xs font-bold ${actif
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
                {montreArgent && pied(actif, c.libelleVerse, c.verse, c.reste)}
              </button>
            );
          })}
        </RangeeEtapes>
      )}

      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-900">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className={`${hankenGrotesk.className} text-sm font-bold text-neutral-900 dark:text-white`}>
            {modeVue === 'encours' && vue !== 'confirme'
              ? 'En route' : LIBELLES_IMPORTATION[vue]}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* Deux façons de juger. Par document : où en est ce
                dossier-là. Par fournisseur : ce que vaut ce partenaire
                sur la durée — et en combien de temps il livre. */}
            <div className="flex shrink-0 items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
              {([
                { cle: 'document' as const, label: 'Par document' },
                { cle: 'fournisseur' as const, label: 'Par fournisseur' },
              ]).map(o => (
                <button key={o.cle} type="button" onClick={() => setAxe(o.cle)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${axe === o.cle
                    ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                    : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
                  {o.label}
                </button>
              ))}
            </div>
            {dossiers.length > 0 && (
              <ChampRecherche valeur={recherche} onChange={setRecherche}
                placeholder="Référence, fournisseur, origine…" className="w-full sm:w-64" />
            )}
          </div>
        </div>

        {axe === 'fournisseur' ? (
          <ListeDossiers
            dossiers={parFournisseur}
            colonnes={colonnesFournisseur}
            cleDe={f => f.id ?? f.nom}
            compte={`${parFournisseur.length} fournisseur${parFournisseur.length > 1 ? 's' : ''}`} />
        ) : (
          <ListeDossiers
            dossiers={affiches}
            colonnes={colonnes}
            cleDe={d => d.id}
            onOuvrir={d => router.push(`/ensemble/importations/${d.id}`)}
            compte={`${affiches.length} dossier${affiches.length > 1 ? 's' : ''}`} />
        )}
      </div>
      </>
      )}
    </div>
  );
}
