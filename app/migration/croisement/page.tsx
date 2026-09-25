'use client';

/**
 * Le croisement des produits, avant migration.
 *
 * Deux listes portent les mêmes produits sous deux noms : le dépôt vient
 * de l'ancienne base, poto poto d'un export de la plateforme externe. La
 * casse change, les accents tombent, un mot s'abrège — et c'est pourtant
 * le même article.
 *
 * Cet écran ne décide rien. Il propose des rapprochements, classés par ce
 * qu'ils ont de sûr, et c'est la main qui tranche : une fusion fausse
 * mêle deux stocks, et rien ne les sépare ensuite.
 *
 * Rien ne part vers Firestore. Les décisions vivent dans le navigateur et
 * s'exportent en fichier — la migration se prépare à côté de la base,
 * jamais dedans.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Check, X, Download, Loader2, Search, Link2, HelpCircle, Unlink,
  ChevronLeft, ChevronRight,
} from 'lucide-react';

interface Depot {
  cle: string;
  designation: string;
  prix?: number | null;
  emballage?: number | null;
  total?: number | null;
}

interface Poto {
  cle: string;
  libelle: string;
  categorie?: string;
  codebarre?: string;
  prix?: number | null;
  cout?: number | null;
  stock?: number | null;
}

interface Paire {
  score: number;
  rang: 'identique' | 'probable' | 'douteux' | 'manuel';
  depot: Depot;
  poto: Poto;
}

interface Donnees {
  depot: { total: number };
  poto: { total: number };
  paires: Paire[];
  seulsDepot: Depot[];
  seulsPoto: Poto[];
}

/** Ce que la main a tranché, paire par paire. */
type Verdict = 'confirme' | 'rejete';

const CLE_LOCALE = 'ibd:croisement-verdicts';
const CLE_DISSOCIES = 'ibd:croisement-dissocies';
const CLE_MANUELS = 'ibd:croisement-manuels';

/** Le nom dépouillé de ce qui ne le distingue pas : casse, accents, ponctuation. */
function reduire(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Combien deux noms se ressemblent, entre 0 et 1.
 *
 * Deux regards : les mots communs disent le sens — « rouleau papier verre »
 * et « papier verre rouleau » sont le même article dans un autre ordre — et
 * les fragments de trois lettres disent l'écriture, ce qui rattrape une
 * faute ou une abréviation. On garde le meilleur des deux.
 */
function ressemblance(a: string, b: string): number {
  const ra = reduire(a), rb = reduire(b);
  if (!ra || !rb) return 0;
  if (ra === rb) return 1;

  const ma = new Set(ra.split(' ')), mb = new Set(rb.split(' '));
  const communs = [...ma].filter(x => mb.has(x)).length;
  const parMots = communs / new Set([...ma, ...mb]).size;

  const tri = (x: string) => {
    const t = new Set<string>();
    for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3));
    return t;
  };
  const ta = tri(ra), tb = tri(rb);
  const inter = [...ta].filter(x => tb.has(x)).length;
  const parLettres = ta.size && tb.size
    ? inter / new Set([...ta, ...tb]).size : 0;

  return Math.max(parMots, parLettres);
}

function nombre(n?: number | null): string {
  if (n == null) return '—';
  return Number(n).toLocaleString('fr-FR');
}

export default function PageCroisement() {
  const [d, setD] = useState<Donnees | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [onglet, setOnglet] = useState<'paires' | 'depot' | 'poto'>('paires');
  const [rang, setRang] = useState<'tous' | 'identique' | 'probable' | 'douteux'>('tous');
  const [recherche, setRecherche] = useState('');
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  /**
   * Les paires défaites, et rendues à leurs listes.
   *
   * Tant qu'on trie, un rejet n'est qu'un avis : la paire reste à l'écran,
   * on peut se raviser. C'est le bouton qui la défait pour de bon — et il
   * n'attend que les rejets, les paires retenues ne changent pas d'état.
   */
  const [dissocies, setDissocies] = useState<string[]>([]);
  /**
   * Les rapprochements faits à la main.
   *
   * La machine s'arrête où les noms ne se ressemblent plus assez —
   * « bandio » et « bandeau caoutchouc » sont le même article pour qui
   * connaît la boutique, et deux chaînes étrangères pour qui compte des
   * lettres. C'est là que la main reprend.
   */
  const [manuels, setManuels] = useState<{ depot: string; poto: string }[]>([]);
  /* Où l'on en est dans le parcours : l'index du produit regardé, de
     chaque côté. On revient là où l'on était en changeant d'onglet. */
  const [curseurDepot, setCurseurDepot] = useState(0);
  const [curseurPoto, setCurseurPoto] = useState(0);
  const [rechercheFace, setRechercheFace] = useState('');
  const [choisi, setChoisi] = useState<string | null>(null);

  useEffect(() => {
    fetch('/croisement.json')
      .then(r => r.json())
      .then(setD)
      .catch(() => setErreur('Fichier croisement.json introuvable.'));
  }, []);

  /* Les décisions survivent à un rechargement : on en prend deux cents,
     et refermer l'onglet ne doit pas les perdre. */
  useEffect(() => {
    try {
      const brut = window.localStorage.getItem(CLE_LOCALE);
      if (brut) setVerdicts(JSON.parse(brut));
      const d2 = window.localStorage.getItem(CLE_DISSOCIES);
      if (d2) setDissocies(JSON.parse(d2));
      const m = window.localStorage.getItem(CLE_MANUELS);
      if (m) setManuels(JSON.parse(m));
    } catch { /* un stockage bloqué n'empêche pas de travailler */ }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CLE_LOCALE, JSON.stringify(verdicts));
      window.localStorage.setItem(CLE_DISSOCIES, JSON.stringify(dissocies));
      window.localStorage.setItem(CLE_MANUELS, JSON.stringify(manuels));
    } catch { /* idem */ }
  }, [verdicts, dissocies, manuels]);

  function trancher(cle: string, v: Verdict) {
    setVerdicts(x => (x[cle] === v
      ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== cle))
      : { ...x, [cle]: v }));
  }

  const q = recherche.trim().toLowerCase();

  /* Une paire défaite quitte la liste des rapprochements : ses deux
     produits sont retournés chacun chez lui, il n'y a plus de paire. */
  const auto = useMemo(
    () => (d?.paires ?? []).filter(p => !dissocies.includes(p.depot.cle)),
    [d, dissocies]);

  /* Ce que les deux listes portent vraiment : ce qui n'a jamais trouvé
     personne, plus ce que la dissociation leur a rendu. */
  const defaites = useMemo(
    () => (d?.paires ?? []).filter(p => dissocies.includes(p.depot.cle)),
    [d, dissocies]);
  /* Un produit apparié à la main quitte sa liste : il n'est plus seul. */
  const prisDepot = useMemo(() => new Set(manuels.map(m => m.depot)), [manuels]);
  const prisPoto = useMemo(() => new Set(manuels.map(m => m.poto)), [manuels]);
  const listeDepot = useMemo(
    () => [...(d?.seulsDepot ?? []), ...defaites.map(p => p.depot)]
      .filter(x => !prisDepot.has(x.cle)),
    [d, defaites, prisDepot]);
  const listePoto = useMemo(
    () => [...(d?.seulsPoto ?? []), ...defaites.map(p => p.poto)]
      .filter(x => !prisPoto.has(x.cle)),
    [d, defaites, prisPoto]);

  /* Les paires faites à la main rejoignent les autres : même liste, même
     ✗ pour les défaire — on se trompe, et sans retour en arrière on
     hésite à chaque clic. */
  const pairesManuelles = useMemo<Paire[]>(() => {
    const parDepot = new Map<string, Depot>();
    const parPoto = new Map<string, Poto>();
    for (const x of [...(d?.seulsDepot ?? []), ...defaites.map(p => p.depot)]) parDepot.set(x.cle, x);
    for (const x of [...(d?.seulsPoto ?? []), ...defaites.map(p => p.poto)]) parPoto.set(x.cle, x);
    return manuels
      .map<Paire | null>(m => {
        const a = parDepot.get(m.depot), b = parPoto.get(m.poto);
        return a && b ? { score: 1, rang: 'manuel', depot: a, poto: b } : null;
      })
      .filter((x): x is Paire => x !== null);
  }, [manuels, d, defaites]);

  /* Les faites à la main d'abord : ce sont les dernières posées, et l'on
     vérifie ce qu'on vient de faire. */
  const vivantes = useMemo(
    () => [...pairesManuelles, ...auto], [pairesManuelles, auto]);

  const paires = useMemo(() => vivantes.filter(p =>
    (rang === 'tous' || p.rang === rang)
    && (!q || p.depot.designation.toLowerCase().includes(q)
      || p.poto.libelle.toLowerCase().includes(q))), [vivantes, rang, q]);

  const nbConfirmes = vivantes.filter(p => verdicts[p.depot.cle] === 'confirme').length;
  const nbRejetes = vivantes.filter(p => verdicts[p.depot.cle] === 'rejete').length;
  const nbATrancher = vivantes.length - nbConfirmes - nbRejetes;

  /* Le bouton n'attend pas un avis, il attend qu'ils soient tous pris :
     dissocier au milieu du tri laisserait des paires à juger dans une
     liste qui a déjà bougé. */
  const toutTranche = vivantes.length > 0 && nbATrancher === 0;

  function dissocier() {
    const aDefaire = vivantes
      .filter(p => verdicts[p.depot.cle] === 'rejete')
      .map(p => p.depot.cle);
    setDissocies(x => [...x, ...aDefaire]);
    /* Leur verdict n'a plus d'objet : la paire n'existe plus. */
    setVerdicts(x => Object.fromEntries(
      Object.entries(x).filter(([k]) => !aDefaire.includes(k))));
  }

  /* Les identiques ne demandent aucune réflexion : les cocher une à une
     avant d'atteindre les vrais cas est du temps pris à ceux-là. */
  function confirmerIdentiques() {
    setVerdicts(x => {
      const n = { ...x };
      for (const p of vivantes) {
        if (p.rang === 'identique' && !n[p.depot.cle]) n[p.depot.cle] = 'confirme';
      }
      return n;
    });
  }

  /**
   * Le parcours manuel : un produit à gauche, ses candidats à droite.
   *
   * Le modal coûtait un aller-retour par produit — ouvrir, chercher,
   * refermer, et l'on ne se souvenait plus de ce qu'on cherchait. Les deux
   * volets gardent le contexte sous les yeux pendant qu'on cherche.
   */
  const cote = onglet === 'depot' ? 'depot' : 'poto';
  const source = cote === 'depot' ? listeDepot : listePoto;
  const face = cote === 'depot' ? listePoto : listeDepot;
  const curseur = cote === 'depot' ? curseurDepot : curseurPoto;
  const setCurseur = cote === 'depot' ? setCurseurDepot : setCurseurPoto;

  const courant = source[Math.min(curseur, Math.max(0, source.length - 1))];
  const nomCourant = courant
    ? ('designation' in courant ? courant.designation : (courant as Poto).libelle)
    : '';

  /* Les candidats, classés avant même qu'on tape : le bon est souvent en
     tête, et la recherche ne sert qu'aux cas où il ne l'est pas. */
  const candidats = useMemo(() => {
    if (!courant) return [];
    const qf = rechercheFace.trim().toLowerCase();
    return face
      .map(x => {
        const nom = 'designation' in x ? x.designation : (x as Poto).libelle;
        return { x, nom, s: ressemblance(nomCourant, nom) };
      })
      .filter(c => !qf || c.nom.toLowerCase().includes(qf))
      .sort((a, b) => b.s - a.s)
      .slice(0, 40);
  }, [face, nomCourant, rechercheFace, courant]);

  function avancer() {
    setChoisi(null);
    setRechercheFace('');
    /* On reste sur place quand la liste a rétréci sous nous : rapprocher
       retire le produit courant, et le suivant prend sa place. */
    setCurseur(i => Math.min(i + 1, Math.max(0, source.length - 1)));
  }

  function rapprocher() {
    if (!courant || !choisi) return;
    setManuels(x => [...x, cote === 'depot'
      ? { depot: courant.cle, poto: choisi }
      : { depot: choisi, poto: courant.cle }]);
    setChoisi(null);
    setRechercheFace('');
    /* Le produit disparaît de la liste : le curseur désigne déjà le
       suivant, il ne faut pas l'avancer une seconde fois. */
    setCurseur(i => Math.min(i, Math.max(0, source.length - 2)));
  }

  /* Ce qu'on emporte : les paires retenues, et les deux listes de ce qui
     reste seul — un rejet renvoie ses deux produits à leur solitude. */
  function exporter() {
    if (!d) return;
    const retenues = d.paires.filter(p => verdicts[p.depot.cle] === 'confirme');
    const rejetees = d.paires.filter(p => verdicts[p.depot.cle] === 'rejete');
    const contenu = {
      genere: new Date().toISOString(),
      retenues: retenues.map(p => ({
        depot: p.depot.designation,
        poto: p.poto.libelle,
        score: p.score,
        prixDepot: p.depot.prix,
        prixPoto: p.poto.prix,
        stockPoto: p.poto.stock,
        totalDepot: p.depot.total,
      })),
      seulsDepot: [
        ...d.seulsDepot,
        ...rejetees.map(p => p.depot),
      ],
      seulsPoto: [
        ...d.seulsPoto,
        ...rejetees.map(p => p.poto),
      ],
      aTrancher: d.paires
        .filter(p => !verdicts[p.depot.cle])
        .map(p => ({ depot: p.depot.designation, poto: p.poto.libelle })),
    };
    const blob = new Blob([JSON.stringify(contenu, null, 1)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'croisement-confirme.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (erreur) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-5 text-center text-sm text-gray-500 dark:bg-gray-950">
      {erreur}
    </div>
  );

  if (!d) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={26} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 p-4 text-gray-900 dark:bg-gray-950 dark:text-gray-100 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-5xl">

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">Croisement des produits</h1>
            {/* D'où viennent les deux listes : sans cela, on ne sait plus
                laquelle on regarde au bout d'une heure. */}
            <p className="mt-0.5 text-xs text-gray-400">
              Dépôt {d.depot.total} · Poto poto {d.poto.total} · rien n’est
              écrit dans la base
            </p>
          </div>
          <button type="button" onClick={exporter}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
            <Download size={13} /> Exporter
          </button>
        </div>

        {/* L'avancement : combien sont tranchés, combien attendent. */}
        <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
          {([
            { label: 'Confirmés', n: nbConfirmes, ton: 'text-green-600' },
            { label: 'Rejetés', n: nbRejetes, ton: 'text-red-500' },
            { label: 'À trancher', n: nbATrancher, ton: 'text-amber-600' },
          ]).map(c => (
            <div key={c.label}
              className="rounded-2xl border border-black/[0.06] bg-white p-3 shadow-sm dark:border-white/10 dark:bg-neutral-900">
              <p className="text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                {c.label}
              </p>
              <p className={`mt-0.5 text-[19px] font-bold leading-7 ${c.ton}`}>
                {c.n}
              </p>
            </div>
          ))}
        </div>

        {/* Les deux gestes du tri : abattre les évidences, puis défaire
            ce qu'on a jugé incompatible. */}
        {onglet === 'paires' && vivantes.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {vivantes.some(p => p.rang === 'identique' && !verdicts[p.depot.cle]) && (
              <button type="button" onClick={confirmerIdentiques}
                className="flex items-center gap-1.5 rounded-xl border border-green-200 px-3 py-2 text-xs font-bold text-green-700 transition-colors hover:bg-green-50 dark:border-green-800/40 dark:text-green-400 dark:hover:bg-green-900/20">
                <Check size={13} />
                Confirmer les {vivantes.filter(p => p.rang === 'identique'
                  && !verdicts[p.depot.cle]).length} identiques
              </button>
            )}

            <button type="button" onClick={dissocier}
              disabled={!toutTranche || nbRejetes === 0}
              title={!toutTranche
                ? `Il reste ${nbATrancher} rapprochement${nbATrancher > 1 ? 's' : ''} à trancher`
                : nbRejetes === 0 ? 'Aucun rapprochement rejeté'
                : `Défaire ${nbRejetes} rapprochement${nbRejetes > 1 ? 's' : ''}`}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
              <Unlink size={13} />
              Confirmer {nbRejetes > 0 && `· défaire ${nbRejetes}`}
            </button>

            {/* Pourquoi le bouton dort : un bouton gris sans raison se
                cherche, et l'on croit à une panne. */}
            {!toutTranche && (
              <span className="text-[11px] text-gray-400">
                {nbATrancher} rapprochement{nbATrancher > 1 ? 's' : ''} sans avis
              </span>
            )}
          </div>
        )}

        <div className="mt-4 flex gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
          {([
            { cle: 'paires' as const, label: `Rapprochés (${vivantes.length})` },
            { cle: 'depot' as const, label: `Dépôt seul (${listeDepot.length})` },
            { cle: 'poto' as const, label: `Poto seul (${listePoto.length})` },
          ]).map(o => (
            <button key={o.cle} type="button" onClick={() => setOnglet(o.cle)}
              className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                onglet === o.cle
                  ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                  : 'text-gray-400 dark:text-gray-500'}`}>
              {o.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="relative min-w-[200px] flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={recherche} onChange={e => setRecherche(e.target.value)}
              placeholder="Chercher un nom…"
              className="w-full rounded-xl border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800" />
          </span>
          {onglet === 'paires' && (
            <div className="flex gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
              {([
                { cle: 'tous' as const, label: 'Tous' },
                { cle: 'identique' as const, label: 'Identiques' },
                { cle: 'probable' as const, label: 'Probables' },
                { cle: 'douteux' as const, label: 'Douteux' },
              ]).map(o => (
                <button key={o.cle} type="button" onClick={() => setRang(o.cle)}
                  className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
                    rang === o.cle
                      ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                      : 'text-gray-400 dark:text-gray-500'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Les rapprochements : le dépôt à gauche, poto poto à droite, et
            au milieu ce qui les lie. */}
        {onglet === 'paires' && (
          <div className="mt-3 space-y-2">
            {paires.map(p => {
              const v = verdicts[p.depot.cle];
              return (
                <div key={p.depot.cle}
                  className={`rounded-2xl border p-3 shadow-sm transition-colors ${
                    v === 'confirme'
                      ? 'border-green-200 bg-green-50/50 dark:border-green-800/40 dark:bg-green-900/10'
                      : v === 'rejete'
                      ? 'border-gray-200 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-gray-800/40'
                      : 'border-black/[0.06] bg-white dark:border-white/10 dark:bg-neutral-900'}`}>

                  <div className="flex items-start justify-between gap-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      p.rang === 'identique'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : p.rang === 'probable'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                      {p.rang === 'douteux' ? <HelpCircle size={10} /> : <Link2 size={10} />}
                      {p.rang} · {Math.round(p.score * 100)} %
                    </span>

                    <span className="flex shrink-0 gap-1.5">
                      <button type="button" onClick={() => trancher(p.depot.cle, 'rejete')}
                        title="Ce ne sont pas les mêmes"
                        className={`rounded-lg border px-2 py-1 text-xs font-bold transition-colors ${
                          v === 'rejete'
                            ? 'border-red-300 bg-red-50 text-red-600 dark:border-red-800/40 dark:bg-red-900/20'
                            : 'border-gray-200 text-gray-500 dark:border-gray-700'}`}>
                        <X size={12} />
                      </button>
                      <button type="button" onClick={() => trancher(p.depot.cle, 'confirme')}
                        title="C’est le même produit"
                        className={`rounded-lg border px-2 py-1 text-xs font-bold transition-colors ${
                          v === 'confirme'
                            ? 'border-green-300 bg-green-100 text-green-700 dark:border-green-800/40 dark:bg-green-900/30'
                            : 'border-gray-200 text-gray-500 dark:border-gray-700'}`}>
                        <Check size={12} />
                      </button>
                    </span>
                  </div>

                  {/* Les deux noms face à face : c'est en les lisant l'un
                      près de l'autre qu'on tranche, non en lisant un score. */}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl bg-gray-50 p-2.5 dark:bg-gray-800/50">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                        Dépôt
                      </p>
                      <p className="mt-0.5 text-[13px] font-bold">{p.depot.designation}</p>
                      <p className="mt-1 text-[11px] text-gray-400">
                        Prix {nombre(p.depot.prix)} · Emb {nombre(p.depot.emballage)}
                        {' '}· Stock {nombre(p.depot.total)}
                      </p>
                    </div>
                    <div className="rounded-xl bg-gray-50 p-2.5 dark:bg-gray-800/50">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                        Poto poto
                      </p>
                      <p className="mt-0.5 text-[13px] font-bold">{p.poto.libelle}</p>
                      <p className="mt-1 text-[11px] text-gray-400">
                        Prix {nombre(p.poto.prix)} · Coût {nombre(p.poto.cout)}
                        {' '}· Stock {nombre(p.poto.stock)}
                      </p>
                      {p.poto.categorie && (
                        <p className="mt-0.5 truncate text-[11px] text-gray-400">
                          {p.poto.categorie}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {paires.length === 0 && (
              <p className="py-10 text-center text-xs text-gray-400">
                Aucun rapprochement de ce genre.
              </p>
            )}
          </div>
        )}

        {/* Ce qui n'a trouvé personne en face : à créer, ou à rapprocher
            d'un nom que la machine n'a pas su reconnaître. */}
        {/* Le parcours à deux volets.

            Une liste plate obligeait à changer d'onglet pour chercher le
            correspondant, puis à revenir — et l'on avait oublié ce qu'on
            cherchait. Ici le produit reste sous les yeux pendant qu'on
            cherche en face.

            Côte à côte au bureau, empilés sur téléphone : deux colonnes de
            cent cinquante pixels ne se lisent pas. */}
        {(onglet === 'depot' || onglet === 'poto') && (
          source.length === 0 ? (
            <p className="mt-10 text-center text-xs text-gray-400">
              Plus rien de ce côté : tout est rapproché.
            </p>
          ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">

            {/* Le produit qu'on regarde, et de quoi passer au suivant. */}
            <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-900">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                  {cote === 'depot' ? 'Dépôt' : 'Poto poto'}
                </span>
                <span className="flex items-center gap-1">
                  <button type="button"
                    onClick={() => { setChoisi(null); setRechercheFace(''); setCurseur(i => Math.max(0, i - 1)); }}
                    disabled={curseur === 0}
                    className="rounded-lg border border-gray-200 p-1.5 text-gray-500 transition-colors disabled:opacity-30 dark:border-gray-700">
                    <ChevronLeft size={14} />
                  </button>
                  <span className="min-w-[70px] text-center text-[11px] font-bold text-gray-400">
                    {Math.min(curseur + 1, source.length)} / {source.length}
                  </span>
                  <button type="button"
                    onClick={() => { setChoisi(null); setRechercheFace(''); setCurseur(i => Math.min(i + 1, source.length - 1)); }}
                    disabled={curseur >= source.length - 1}
                    className="rounded-lg border border-gray-200 p-1.5 text-gray-500 transition-colors disabled:opacity-30 dark:border-gray-700">
                    <ChevronRight size={14} />
                  </button>
                </span>
              </div>

              <p className="mt-3 text-[17px] font-bold leading-6">{nomCourant}</p>
              {courant && (
                <p className="mt-1 text-[11px] text-gray-400">
                  {'designation' in courant
                    ? `Prix ${nombre(courant.prix)} · Emb ${nombre(courant.emballage)} · Stock ${nombre(courant.total)}`
                    : `Prix ${nombre((courant as Poto).prix)} · Coût ${nombre((courant as Poto).cout)} · Stock ${nombre((courant as Poto).stock)}`}
                </p>
              )}
              {courant && !('designation' in courant) && (courant as Poto).categorie && (
                <p className="mt-0.5 truncate text-[11px] text-gray-400">
                  {(courant as Poto).categorie}
                </p>
              )}

              {/* Les deux gestes, en pleine largeur : on les enchaîne des
                  dizaines de fois, le pouce ne doit pas viser. */}
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={avancer}
                  className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-xs font-bold text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
                  Passer
                </button>
                <button type="button" onClick={rapprocher} disabled={!choisi}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                  <Link2 size={13} /> Rapprocher
                </button>
              </div>
            </div>

            {/* En face : tout ce qui reste libre, le plus ressemblant
                d'abord. La recherche ne sert qu'aux cas où la machine n'a
                rien vu. */}
            <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-900">
              <span className="text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                {cote === 'depot' ? 'Poto poto' : 'Dépôt'} · {face.length} libres
              </span>

              <span className="relative mt-2 block">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={rechercheFace} onChange={e => setRechercheFace(e.target.value)}
                  placeholder="Chercher en face…"
                  className="w-full rounded-xl border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800" />
              </span>

              <div className="mt-2 max-h-[46vh] space-y-1 overflow-y-auto lg:max-h-[52vh]">
                {candidats.map(c => (
                  <button key={c.x.cle} type="button"
                    onClick={() => setChoisi(choisi === c.x.cle ? null : c.x.cle)}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border p-2.5 text-left transition-colors ${
                      choisi === c.x.cle
                        ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/25'
                        : 'border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50'}`}>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{c.nom}</span>
                      <span className="block truncate text-[11px] text-gray-400">
                        {'designation' in c.x
                          ? `Prix ${nombre(c.x.prix)} · Stock ${nombre(c.x.total)}`
                          : `Prix ${nombre((c.x as Poto).prix)} · Stock ${nombre((c.x as Poto).stock)}`}
                      </span>
                    </span>
                    {/* Le score guide l'œil sans décider : c'est le nom qu'on
                        lit, pas le pourcentage. */}
                    <span className={`shrink-0 rounded-lg px-1.5 py-0.5 text-[10px] font-bold ${
                      c.s >= 0.5
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : c.s >= 0.25
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        : 'text-gray-300 dark:text-gray-700'}`}>
                      {Math.round(c.s * 100)} %
                    </span>
                  </button>
                ))}
                {candidats.length === 0 && (
                  <p className="py-8 text-center text-xs text-gray-400">
                    Rien en face.
                  </p>
                )}
              </div>
            </div>
          </div>
          )
        )}

      </div>
    </div>
  );
}
