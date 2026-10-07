'use client';
import { useEffect, useMemo, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useRouter } from 'next/navigation';
import { formatMontant, formatDate } from '@/lib/format';
import {
  Handshake, Loader2, Banknote, ArrowUpRight, Search, FileText,
} from 'lucide-react';
import { ChampRecherche } from '@/components/Champs';
import ModalVersementTiers from './ModalVersementTiers';
import { soldesDuSite, soldeDe } from '@/lib/soldes';
import { chargerAchatsDuSite } from '@/lib/flux-marchandise';
import { valeurRecue } from '@/lib/flux-marchandise';
import { lireParSite } from '@/lib/portee';
import { useSites, CelluleSite, type PropsPortee } from './ContexteSites';
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

export default function OngletOccasionnels({
  siteId, sites, titre, userId, roleSite,
}: PropsPortee & { userId: string; roleSite: RoleSite | null }) {
  const ctx = useSites(siteId, sites);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [gens, setGens] = useState<Occasionnel[]>([]);
  const [documents, setDocuments] = useState<DocumentDu[]>([]);
  const [recherche, setRecherche] = useState('');
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
  const [depuis, setDepuis] = useState('');
  const [jusqua, setJusqua] = useState('');

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

  /* La période ne borne que ce qu'on lit, jamais ce qu'on doit : une
     dette de mars reste due en juin, et la cacher ferait croire qu'elle
     est éteinte. */
  const dansLaPeriode = (d: string) =>
    (!depuis || d >= depuis) && (!jusqua || d <= jusqua);

  const docsVus = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return documents.filter(d =>
      dansLaPeriode(d.date)
      && (!q || d.fournisseurNom.toLowerCase().includes(q)
        || d.reference.toLowerCase().includes(q)));
  }, [documents, recherche, depuis, jusqua]);

  /* Par fournisseur, dans la fenêtre choisie : ce que la vue par document
     dit ligne à ligne, regroupé par qui. */
  const parFournisseur = useMemo(() => {
    const m = new Map<string, {
      id: string; nom: string; documents: number;
      montant: number; verse: number; reste: number;
    }>();
    for (const d of docsVus) {
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
    return [...m.values()].sort((a, b) => b.reste - a.reste);
  }, [docsVus]);

  const gensVus = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return gens.filter(g => !q || g.nom.toLowerCase().includes(q));
  }, [gens, recherche]);

  /* Combien de voisins attendent leur argent. C'est ce nombre que porte
     la pastille : un montant ne dit pas combien de gens il faut aller
     voir. */
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
        {peutReglerFournisseur(roleSite) && totalDu > 0 && (
          <button onClick={() => setVersementOuvert(true)}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
            <Banknote size={13} />
            Versement
          </button>
        )}
      </div>

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
          {/* La période ne borne que la lecture : une dette de mars reste
              due en juin, et la masquer ferait croire qu'elle est
              éteinte. */}
          {bascule === 'dettes' && (
            <div className="flex items-center gap-1.5">
              <input type="date" value={depuis} onChange={e => setDepuis(e.target.value)}
                className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800" />
              <span className="text-xs text-gray-400">→</span>
              <input type="date" value={jusqua} onChange={e => setJusqua(e.target.value)}
                className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800" />
              {(depuis || jusqua) && (
                <button onClick={() => { setDepuis(''); setJusqua(''); }}
                  className="text-xs font-bold text-gray-400 hover:text-indigo-600">
                  Tout
                </button>
              )}
            </div>
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
                      <th className="px-4 py-3 text-center text-xs font-bold">Date</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Fournisseur</th>
                      {ctx.ensemble && (
                        <th className="px-4 py-3 text-center text-xs font-bold">Site</th>
                      )}
                      <th className="px-4 py-3 text-center text-xs font-bold">Montant</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Versé</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Reste</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {docsVus.map(d => (
                      /* Le reçu d'où la dette vient. Sans ce chemin, un
                         montant de six mois est une somme sans
                         justification consultable. */
                      <tr key={d.id}
                        onClick={() => d.venteOrigineId && router.push(
                          `/site/${d.siteId}/ventes/${d.venteOrigineId}`)}
                        className={`${d.venteOrigineId
                          ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50' : ''}`}>
                        <td className="px-4 py-3 text-center text-gray-500">
                          {formatDate(d.date)}
                        </td>
                        <td className="px-4 py-3 text-center font-medium">
                          {d.fournisseurNom}
                          {d.venteOrigineReference && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-gray-400">
                              <FileText size={10} />
                              {d.venteOrigineReference}
                            </span>
                          )}
                        </td>
                        {ctx.ensemble && <CelluleSite nom={ctx.nomDe(d.siteId)} />}
                        <td className="px-4 py-3 text-center font-medium">
                          {formatMontant(d.montant)}
                        </td>
                        <td className="px-4 py-3 text-center text-gray-500">
                          {d.verse > 0 ? formatMontant(d.verse) : '—'}
                        </td>
                        <td className={`px-4 py-3 text-center font-bold ${
                          d.reste > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                          {d.reste > 0 ? formatMontant(d.reste) : 'soldé'}
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
                      <th className="px-4 py-3 text-center text-xs font-bold">Documents</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Dette</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Versé</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Reste</th>
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
                          f.reste > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                          {f.reste > 0 ? formatMontant(f.reste) : 'soldé'}
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
                  <th className="px-4 py-3 text-center text-xs font-bold">Pris chez lui</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Dernière fois</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Reste dû</th>
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
                      {g.derniere ? formatDate(g.derniere) : '—'}
                    </td>
                    <td className={`px-4 py-3 text-center font-bold ${
                      g.reste > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                      {g.reste > 0 ? formatMontant(g.reste) : '—'}
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
