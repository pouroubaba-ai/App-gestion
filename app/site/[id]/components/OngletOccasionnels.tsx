'use client';
import { useEffect, useMemo, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useRouter } from 'next/navigation';
import { formatMontant, formatDate } from '@/lib/format';
import {
  Handshake, Loader2, Banknote, ArrowUpRight, Search, FileText, ArrowUpDown,
} from 'lucide-react';
import { ChampRecherche } from '@/components/Champs';
import PeriodFilter, { debutPeriode, type Periode }
  from './finance/PeriodFilter';
import ModalVersementTiers from './ModalVersementTiers';
import { soldesDuSite, soldeDe } from '@/lib/soldes';
import { chargerAchatsDuSite } from '@/lib/flux-marchandise';
import { valeurRecue } from '@/lib/flux-marchandise';
import { lireParSite } from '@/lib/portee';
import { ouvrable } from '@/lib/retour';
import {
  useSites, CelluleSite, FiltreSite, ToggleVue, CartesParSite,
  type PropsPortee,
} from './ContexteSites';
import { peutReglerFournisseur, type RoleSite } from '@/lib/roles';

/**
 * Ceux chez qui on prend ce qu'on n'a pas.
 *
 * Le client demande un article en rupture, on traverse la rue le prendre
 * chez le voisin, on le vend dans la minute et on le règle après. Ce
 * voisin n'est pas du carnet : il a dépanné. Le mêler aux fournisseurs
 * réguliers remplirait celui-ci de noms vus une fois, entre lesquels il
 * faudrait chercher ceux avec qui l'on travaille vraiment.
 *
 * Il a donc sa page, et elle répond à deux questions qui ne se posent pas
 * en même temps : **ce qu'on doit**, qu'on règle, et **qui ils sont**,
 * qu'on consulte pour décider si l'un d'eux mérite d'entrer au carnet.
 *
 * C'est cette seconde question qui justifie la page. Tout passer « hors
 * stock » aurait fait disparaître ces gens : on n'aurait su ni ce qu'on
 * prend chez chacun, ni ce qu'ils nous rapportent, ni lequel revient
 * assez souvent pour devenir un fournisseur comme les autres.
 */

interface Occasionnel {
  id: string;
  nom: string;
  siteId: string;
  /** ce qui reste dû, déduit des achats confirmés */
  reste: number;
  /** ce qu'on lui a pris en tout */
  total: number;
  verse: number;
  documents: number;
  derniere: string | null;
}

/** Un achat né d'une vente : ce qu'on doit, et le reçu d'où il vient. */
interface DocumentDu {
  id: string;
  reference: string;
  siteId: string;
  fournisseurId: string;
  fournisseurNom: string;
  date: string;
  montant: number;
  verse: number;
  reste: number;
  venteOrigineId?: string | null;
  venteOrigineReference?: string | null;
}

type Bascule = 'dettes' | 'fournisseurs';
type VueDette = 'documents' | 'fournisseurs';
/* Ou en est ce qu'on doit : rien verse, une partie, ou plus rien. */
type Statut = 'du' | 'partiel' | 'solde';

export default function OngletOccasionnels({
  siteId, sites, titre, userId, roleSite,
}: PropsPortee & { userId: string; roleSite: RoleSite | null }) {
  const ctx = useSites(siteId, sites);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [gens, setGens] = useState<Occasionnel[]>([]);
  const [documents, setDocuments] = useState<DocumentDu[]>([]);
  const [recherche, setRecherche] = useState('');
  /* Trier par ce qu'on cherche. Une dette se lit par son montant — qui
     doit le plus, qui a le plus verse — et non par l'ordre ou les
     documents sont tombes. */
  /* Ce qu'on vient regler, ou ce qu'on vient verifier : « Du » montre ce
     qui appelle un geste, « Solde » ce qui est clos. Tout par defaut —
     masquer d'office ferait croire a une dette eteinte. */
  const [filtreStatut, setFiltreStatut] = useState<Statut | 'tout'>('tout');
  const [tri, setTri] = useState<
    'date' | 'total' | 'verse' | 'reste' | 'documents' | null>(null);
  const [ordre, setOrdre] = useState<'asc' | 'desc'>('desc');

  /**
   * Ou en est une dette.
   *
   * Trois etats, et ils suffisent : on n'a rien verse, on a verse une
   * partie, ou il ne reste plus rien. Ecrit ici une fois — les deux vues
   * et les deux filtres le lisent, et deux copies finiraient par ne plus
   * tomber d'accord sur ce qu'est « partiel ».
   */
  function etatDette(verse: number, reste: number): Statut {
    if (reste <= 0) return 'solde';
    return verse > 0 ? 'partiel' : 'du';
  }

  const LIBELLES_STATUT: Record<Statut, string> = {
    du: 'Dû', partiel: 'Partiel', solde: 'Soldé',
  };

  const TONS_STATUT: Record<Statut, string> = {
    du: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    partiel: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    solde: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  };

  function basculer(cle: NonNullable<typeof tri>) {
    if (tri === cle) setOrdre(o => (o === 'asc' ? 'desc' : 'asc'));
    else { setTri(cle); setOrdre('desc'); }
  }

  function BoutonTri({ cle, label }: {
    cle: NonNullable<typeof tri>; label: string;
  }) {
    return (
      <button onClick={() => basculer(cle)}
        className="flex w-full items-center justify-center gap-1 transition-opacity hover:opacity-80">
        {label}
        <ArrowUpDown size={12} className={tri === cle ? 'opacity-100' : 'opacity-40'} />
      </button>
    );
  }
  const [versementOuvert, setVersementOuvert] = useState(false);
  const [promotion, setPromotion] = useState<Occasionnel | null>(null);
  const [enCours, setEnCours] = useState(false);

  /* Ce qu'on doit d'abord : c'est pour cela qu'on ouvre l'écran. La liste
     des gens se consulte, elle n'appelle aucun geste. */
  const [bascule, setBascule] = useState<Bascule>('dettes');
  const [vueDette, setVueDette] = useState<VueDette>('documents');

  /* La période : on règle ce qu'on doit maintenant, mais on juge un
     fournisseur sur ce qu'il a fourni depuis des mois. Les deux lectures
     ne regardent pas la même fenêtre. */
  const [periode, setPeriode] = useState<Periode>('tout');

  useEffect(() => { charger(); }, [ctx.portee]);

  async function charger() {
    setLoading(true);
    try {
      const [partSnap, achats, soldes] = await Promise.all([
        lireParSite('partenaires', ctx.portee),
        chargerAchatsDuSite(ctx.portee),
        soldesDuSite(ctx.portee),
      ]);

      const occasionnels = partSnap.filter(d => d.data().occasionnel);
      const parId = new Map(occasionnels.map(
        d => [d.id, { nom: d.data().nom as string, siteId: d.data().siteId as string }]));

      /* Les dossiers qui les concernent. Un achat ordinaire passé chez un
         occasionnel compterait aussi : rien ne l'interdit, et l'exclure
         cacherait une dette réelle. */
      const docs: DocumentDu[] = achats
        .filter(a => a.fournisseurId && parId.has(a.fournisseurId))
        .map(a => {
          const montant = valeurRecue(a.lignes);
          const verse = a.avanceVersee ?? 0;
          return {
            id: a.id,
            reference: a.reference,
            siteId: (a as any).siteId,
            fournisseurId: a.fournisseurId!,
            fournisseurNom: parId.get(a.fournisseurId!)?.nom ?? a.fournisseurNom,
            date: a.dateConfirmation ?? a.dateCommande ?? '',
            montant,
            verse,
            reste: Math.max(0, montant - verse),
            venteOrigineId: (a as any).venteOrigineId ?? null,
            venteOrigineReference: (a as any).venteOrigineReference ?? null,
          };
        })
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

      setDocuments(docs);

      setGens(occasionnels.map(d => {
        const siens = docs.filter(x => x.fournisseurId === d.id);
        const s = soldeDe(soldes, d.id, 'fournisseur');
        return {
          id: d.id,
          nom: d.data().nom as string,
          siteId: d.data().siteId as string,
          reste: s.reste,
          total: siens.reduce((n, x) => n + x.montant, 0),
          verse: siens.reduce((n, x) => n + x.verse, 0),
          documents: siens.length,
          derniere: siens[0]?.date ?? null,
        };
      }).sort((a, b) => b.reste - a.reste || a.nom.localeCompare(b.nom)));
    } finally {
      setLoading(false);
    }
  }

  const docsVus = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const debut = debutPeriode(periode);
    const liste = documents.filter(d =>
      (!debut || d.date >= debut)
      && (filtreStatut === 'tout' || etatDette(d.verse, d.reste) === filtreStatut)
      && (!q || d.fournisseurNom.toLowerCase().includes(q)
        || d.reference.toLowerCase().includes(q)));
    if (!tri) return liste;
    const sens = ordre === 'asc' ? 1 : -1;
    return [...liste].sort((a, b) => {
      const v = tri === 'date' ? a.date.localeCompare(b.date)
        : tri === 'total' ? a.montant - b.montant
        : tri === 'verse' ? a.verse - b.verse
        : tri === 'reste' ? a.reste - b.reste
        : 0;
      return v * sens;
    });
  }, [documents, recherche, periode, tri, ordre, filtreStatut]);

  /* Par fournisseur, dans la fenêtre choisie : ce que la vue par document
     dit ligne à ligne, regroupé par qui. */
  /* Le regroupement part des documents de la periode, jamais du filtre de
     statut : grouper des documents deja tries par statut donnerait des
     totaux amputes — un fournisseur a trois dossiers soldes et un du, et
     filtrer sur « du » ferait disparaitre les trois autres de son total.
     Le filtre s'applique ensuite, sur le reste groupe. */
  const docsPeriode = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const debut = debutPeriode(periode);
    return documents.filter(d =>
      (!debut || d.date >= debut)
      && (!q || d.fournisseurNom.toLowerCase().includes(q)
        || d.reference.toLowerCase().includes(q)));
  }, [documents, recherche, periode]);

  const parFournisseur = useMemo(() => {
    const m = new Map<string, {
      id: string; nom: string; documents: number;
      montant: number; verse: number; reste: number;
    }>();
    for (const d of docsPeriode) {
      const e = m.get(d.fournisseurId) ?? {
        id: d.fournisseurId, nom: d.fournisseurNom,
        documents: 0, montant: 0, verse: 0, reste: 0,
      };
      e.documents += 1;
      e.montant += d.montant;
      e.verse += d.verse;
      e.reste += d.reste;
      m.set(d.fournisseurId, e);
    }
    const liste = [...m.values()].filter(
      f => filtreStatut === 'tout' || etatDette(f.verse, f.reste) === filtreStatut);
    if (!tri) return liste.sort((a, b) => b.reste - a.reste);
    const sens = ordre === 'asc' ? 1 : -1;
    return liste.sort((a, b) => {
      const v = tri === 'documents' ? a.documents - b.documents
        : tri === 'total' ? a.montant - b.montant
        : tri === 'verse' ? a.verse - b.verse
        : tri === 'reste' ? a.reste - b.reste
        : 0;
      return v * sens;
    });
  }, [docsPeriode, tri, ordre, filtreStatut]);

  const gensVus = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return gens.filter(g =>
      (!q || g.nom.toLowerCase().includes(q))
      && (filtreStatut === 'tout'
        || etatDette(g.verse, g.reste) === filtreStatut));
  }, [gens, recherche, filtreStatut]);

  /* Combien de voisins attendent leur argent. C'est ce nombre que porte
     la pastille : un montant ne dit pas combien de gens il faut aller
     voir. */
  /* Ce que chaque statut recouvre, dans la liste qu'on regarde. Le
     compteur devant le bouton evite de cliquer pour decouvrir qu'il n'y
     a rien dessous. */
  const comptesStatut = useMemo(() => {
    const source = bascule === 'fournisseurs'
      ? gens.map(g => ({ verse: g.verse, reste: g.reste }))
      : vueDette === 'fournisseurs'
      ? parFournisseur.map(f => ({ verse: f.verse, reste: f.reste }))
      : docsPeriode.map(d => ({ verse: d.verse, reste: d.reste }));
    const n = { du: 0, partiel: 0, solde: 0 } as Record<Statut, number>;
    for (const x of source) n[etatDette(x.verse, x.reste)]++;
    return { ...n, tout: source.length };
  }, [bascule, vueDette, gens, parFournisseur, docsPeriode]);

  const nbEnDette = gens.filter(g => g.reste > 0).length;
  const totalDu = gens.reduce((n, g) => n + g.reste, 0);

  /**
   * Faire entrer un voisin au carnet.
   *
   * Sans retour : c'est une reconnaissance, pas un classement qu'on
   * ajuste. Le drapeau tombe et la fiche devient un fournisseur comme les
   * autres — l'identifiant ne bouge pas, donc tous les dossiers passés
   * continuent de le désigner, et son historique le suit.
   */
  async function promouvoir(g: Occasionnel) {
    setEnCours(true);
    try {
      await updateDoc(doc(db, 'partenaires', g.id), { occasionnel: false });
      setPromotion(null);
      await charger();
    } finally {
      setEnCours(false);
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 size={22} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="space-y-4">

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Handshake size={18} className="shrink-0 text-indigo-500" />
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
            {titre ?? 'Fournisseurs occasionnels'}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Le total dit combien on doit, jamais chez quel site les
              voisins attendent. */}
          <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {ctx.parSite ? (
        /* Une carte par site : ce que chacun doit a ses voisins, et
           combien attendent leur argent. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const siens = gens.filter(g => g.siteId === id);
          const du = siens.reduce((n, g) => n + g.reste, 0);
          const enDette = siens.filter(g => g.reste > 0).length;
          return {
            titre: 'Dû aux voisins',
            valeur: formatMontant(du),
            dort: siens.length === 0,
            badge: siens.length > 0
              ? {
                  texte: `${siens.length} fournisseur${siens.length > 1 ? 's' : ''}`,
                  ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                }
              : null,
            lignes: [
              { label: `En attente · ${enDette}`,
                valeur: formatMontant(du), vide: enDette === 0 },
              { label: 'Pris chez eux',
                valeur: formatMontant(siens.reduce((n, g) => n + g.total, 0)),
                vide: siens.length === 0 },
            ],
          };
        }} />
      ) : (
      <>

      {/* Les deux questions, et elles ne se posent pas en même temps : ce
          qu'on doit se règle, les gens se consultent. La pastille dit
          combien attendent leur argent — un montant ne dirait pas combien
          de voisins il faut aller voir. */}
      <div className="flex items-center rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
        {([
          { cle: 'dettes' as const, label: 'Dettes', n: nbEnDette },
          { cle: 'fournisseurs' as const, label: 'Fournisseurs', n: gens.length },
        ]).map(o => (
          <button key={o.cle} onClick={() => setBascule(o.cle)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              bascule === o.cle
                ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                : 'text-gray-400 hover:text-gray-600'}`}>
            {o.label}
            {/* Ce qu'on doit en tout, sur la bascule qui le regle : la
                pastille du menu compte des gens — combien de voisins il
                reste a voir — et ne peut pas porter un montant sans
                devenir illisible une fois le menu replie. */}
            {o.cle === 'dettes' && totalDu > 0 && (
              <span className="text-[11px] font-bold text-orange-600 dark:text-orange-500">
                {formatMontant(totalDu)}
              </span>
            )}
            {o.n > 0 && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                bascule === o.cle
                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                  : 'bg-gray-200 text-gray-500 dark:bg-gray-700'}`}>
                {o.n}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <ChampRecherche valeur={recherche} onChange={setRecherche}
              placeholder="Un nom, une référence…" />
          </div>
          {/* Le meme selecteur que partout ailleurs. La periode ne borne
              que la lecture : une dette de mars reste due en juin, et la
              masquer ferait croire qu'elle est eteinte. */}
          {bascule === 'dettes' && (
            <PeriodFilter periode={periode} onChange={setPeriode} />
          )}
          {/* Ce qu'on vient faire : regler ce qui est du, ou verifier ce
              qui est clos. Les categories vides se taisent — un bouton a
              zero invite a un clic qui ne montre rien. */}
          <div className="flex items-center gap-1">
            {([
              { cle: 'tout' as const, label: 'Tout', n: comptesStatut.tout },
              { cle: 'du' as const, label: 'Dû', n: comptesStatut.du },
              { cle: 'partiel' as const, label: 'Partiel', n: comptesStatut.partiel },
              { cle: 'solde' as const, label: 'Soldé', n: comptesStatut.solde },
            ]).filter(o => o.cle === 'tout' || o.n > 0).map(o => (
              <button key={o.cle} onClick={() => setFiltreStatut(o.cle)}
                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-colors ${
                  filtreStatut === o.cle
                    ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400'
                    : 'text-gray-400 hover:text-gray-600'}`}>
                {o.label} <span className="font-medium opacity-60">{o.n}</span>
              </button>
            ))}
          </div>

          {/* Verser agit sur les lignes de ce tableau : plus haut, sur la
              ligne du titre, le bouton s'eloignait de ce qu'il solde.
              Un versement sort d'une caisse, et la vue d'ensemble n'en
              designe aucune — d'ou le site a choisir d'abord. */}
          {peutReglerFournisseur(roleSite) && totalDu > 0 && (
            <button onClick={() => setVersementOuvert(true)}
              disabled={!ctx.siteEcriture}
              title={ctx.siteEcriture ? undefined
                : 'Choisissez un site : le versement sort de sa caisse.'}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
              <Banknote size={13} />
              Versement
            </button>
          )}
        </div>

        {bascule === 'dettes' && (
          <>
            {/* Le même fait, lu de deux façons : ligne à ligne pour
                retrouver un dossier, groupé pour savoir à qui l'on doit. */}
            <div className="mb-3 flex items-center gap-1">
              {([
                { cle: 'documents' as const, label: 'Par document', n: docsVus.length },
                { cle: 'fournisseurs' as const, label: 'Par fournisseur', n: parFournisseur.length },
              ]).map(o => (
                <button key={o.cle} onClick={() => setVueDette(o.cle)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                    vueDette === o.cle
                      ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400'
                      : 'text-gray-400 hover:text-gray-600'}`}>
                  {o.label} <span className="font-medium opacity-60">{o.n}</span>
                </button>
              ))}
            </div>

            {vueDette === 'documents' ? (
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      {/* Le document d'abord : c'est lui qu'on ouvre, et
                          c'est son adresse qui dit de quelle vente la
                          dette est nee. */}
                      <th className="px-4 py-3 text-center text-xs font-bold">Document</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Fournisseur</th>
                      {ctx.ensemble && (
                        <th className="px-4 py-3 text-center text-xs font-bold">Site</th>
                      )}
                      <th className="px-4 py-3 text-center text-xs font-bold">
                        <BoutonTri cle="date" label="Date" />
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-bold">
                        <BoutonTri cle="total" label="Total" />
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-bold">
                        <BoutonTri cle="verse" label="Versé" />
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-bold">
                        <BoutonTri cle="reste" label="Reste" />
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Statut</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {docsVus.map(d => (
                      /* Le reçu d'où la dette vient. Sans ce chemin, un
                         montant de six mois est une somme sans
                         justification consultable. */
                      <tr key={d.id}
                        /* `ouvrable` pose la marque qui permet a la fiche
                           de revenir ici plutot que de reconstruire une
                           adresse — sans elle, fermer tombait sur la fiche
                           du site, qu'on n'avait jamais ouverte. */
                        onClick={() => d.venteOrigineId && router.push(ouvrable(
                          `/site/${d.siteId}/ventes/${d.venteOrigineId}`
                          + `?onglet=occasionnels${ctx.depuisEnsemble ? '&de=ensemble' : ''}`))}
                        className={`${d.venteOrigineId
                          ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50' : ''}`}>
                        <td className="px-4 py-3 text-center">
                          <span className="inline-flex items-center gap-1 font-mono text-xs font-medium text-indigo-600 dark:text-indigo-400">
                            <FileText size={11} className="shrink-0" />
                            {d.venteOrigineReference ?? d.reference}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center font-medium">
                          {d.fournisseurNom}
                        </td>
                        {ctx.ensemble && <CelluleSite nom={ctx.nomDe(d.siteId)} />}
                        <td className="px-4 py-3 text-center text-gray-500">
                          {formatDate(d.date)}
                        </td>
                        <td className="px-4 py-3 text-center font-medium">
                          {formatMontant(d.montant)}
                        </td>
                        <td className="px-4 py-3 text-center text-gray-500">
                          {d.verse > 0 ? formatMontant(d.verse) : '—'}
                        </td>
                        <td className={`px-4 py-3 text-center font-bold ${
                          d.reste > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                          {d.reste > 0 ? formatMontant(d.reste) : '—'}
                        </td>
                        {/* Ou en est ce document : rien verse, une partie,
                            ou plus rien du. Le reste le dit en chiffres,
                            le statut le dit d'un coup d'oeil. */}
                        <td className="px-4 py-3 text-center">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            TONS_STATUT[etatDette(d.verse, d.reste)]}`}>
                            {LIBELLES_STATUT[etatDette(d.verse, d.reste)]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="px-4 py-3 text-center text-xs font-bold">Fournisseur</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">
                        <BoutonTri cle="documents" label="Documents" />
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-bold">
                        <BoutonTri cle="total" label="Total" />
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-bold">
                        <BoutonTri cle="verse" label="Versé" />
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-bold">
                        <BoutonTri cle="reste" label="Reste" />
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Statut</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {parFournisseur.map(f => (
                      <tr key={f.id}>
                        <td className="px-4 py-3 text-center font-medium">{f.nom}</td>
                        <td className="px-4 py-3 text-center text-gray-500">{f.documents}</td>
                        <td className="px-4 py-3 text-center font-medium">
                          {formatMontant(f.montant)}
                        </td>
                        <td className="px-4 py-3 text-center text-gray-500">
                          {f.verse > 0 ? formatMontant(f.verse) : '—'}
                        </td>
                        <td className={`px-4 py-3 text-center font-bold ${
                          f.reste > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                          {f.reste > 0 ? formatMontant(f.reste) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            TONS_STATUT[etatDette(f.verse, f.reste)]}`}>
                            {LIBELLES_STATUT[etatDette(f.verse, f.reste)]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {docsVus.length === 0 && (
              <p className="py-10 text-center text-xs text-gray-400">
                Rien dû sur cette période.
              </p>
            )}
          </>
        )}

        {bascule === 'fournisseurs' && (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  <th className="px-4 py-3 text-center text-xs font-bold">Fournisseur</th>
                  {ctx.ensemble && (
                    <th className="px-4 py-3 text-center text-xs font-bold">Site</th>
                  )}
                  <th className="px-4 py-3 text-center text-xs font-bold">Documents</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Total</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Versé</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Dernière fois</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Reste dû</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Statut</th>
                  <th className="px-4 py-3 text-center text-xs font-bold"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {gensVus.map(g => (
                  <tr key={g.id}>
                    <td className="px-4 py-3 text-center font-medium">{g.nom}</td>
                    {ctx.ensemble && <CelluleSite nom={ctx.nomDe(g.siteId)} />}
                    <td className="px-4 py-3 text-center text-gray-500">{g.documents}</td>
                    {/* Ce qu'il nous a fourni en tout : c'est ce chiffre
                        qui dit s'il mérite d'entrer au carnet. */}
                    <td className="px-4 py-3 text-center font-medium">
                      {formatMontant(g.total)}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-500">
                      {g.verse > 0 ? formatMontant(g.verse) : '—'}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-500">
                      {g.derniere ? formatDate(g.derniere) : '—'}
                    </td>
                    <td className={`px-4 py-3 text-center font-bold ${
                      g.reste > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                      {g.reste > 0 ? formatMontant(g.reste) : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        TONS_STATUT[etatDette(g.verse, g.reste)]}`}>
                        {LIBELLES_STATUT[etatDette(g.verse, g.reste)]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button onClick={() => setPromotion(g)}
                        title="En faire un fournisseur du carnet"
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-bold text-gray-500 transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700">
                        <ArrowUpRight size={11} />
                        Au carnet
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {gensVus.length === 0 && (
              <p className="py-10 text-center text-xs text-gray-400">
                Personne pour l&apos;instant.
              </p>
            )}
          </div>
        )}
      </div>

      </>
      )}

      {/* La promotion ne se défait pas : on la confirme. */}
      {promotion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !enCours && setPromotion(null)}>
          <div onClick={e => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              {promotion.nom} entre au carnet
            </p>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">
              Il devient un fournisseur comme les autres : on lui passe des
              achats, il a sa fiche, il quitte cette page. Tout ce qu&apos;on
              lui a déjà pris le suit.
            </p>
            <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-500">
              C&apos;est sans retour.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setPromotion(null)} disabled={enCours}
                className="rounded-xl border border-gray-200 px-4 py-2 text-xs font-bold text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700">
                Revenir
              </button>
              <button onClick={() => promouvoir(promotion)} disabled={enCours}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours && <Loader2 size={12} className="animate-spin" />}
                Le faire entrer
              </button>
            </div>
          </div>
        </div>
      )}

      {versementOuvert && ctx.siteEcriture && (
        <ModalVersementTiers
          siteId={ctx.siteEcriture}
          userId={userId}
          /* Les trois chemins existent déjà : le gérant encaisse au
             tiroir, le chargé de recouvrement remet ce qu'il a porté, et
             le propriétaire peut payer hors caisse. Rien de propre aux
             occasionnels — on doit à un voisin comme on doit à un
             fournisseur. */
          parRemise={roleSite === 'recouvrement'}
          roleSite={roleSite}
          role="fournisseur"
          tiers={gens.filter(g => g.reste > 0)
            .map(g => ({ id: g.id, nom: g.nom, du: g.reste }))}
          onFermer={() => setVersementOuvert(false)}
          onVerse={() => charger()}
        />
      )}
    </div>
  );
}
