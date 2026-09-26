'use client';

/**
 * Ouvrir un retour.
 *
 * On part du dossier, jamais du partenaire : un bon porte déjà le tiers,
 * les produits, les quantités et les prix convenus.
 *
 * L'écran dit d'abord où en est ce bon — sa valeur, ce qui en est déjà
 * revenu, ce qui reste à rendre. Sans ces chiffres, on saisit à l'aveugle
 * et l'on découvre le dépassement à la confirmation, quand la marchandise
 * est sur le camion.
 *
 * Le prix est celui du bon, jamais celui du jour. On défait ce qui a été
 * fait : un sac acheté 5 000 revient à 5 000, même si le cours a monté.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { auteurCourant } from '@/lib/auteur';
import { produitsDuSite } from '@/lib/produits-site';
import { formatMontant } from '@/lib/format';
import { Loader2, Check, Undo2, ArrowLeft, Search } from 'lucide-react';
import {
  ouvrirRetour, dejaEngage, type TypeRetour, type ReglementRetour,
  type LigneDossierRetour,
} from '@/lib/retours-dossiers';
import { peutOuvrirRetour } from '../../components/OngletRetours';
import {
  simulerImputation, dossiersOuverts, sortieAutorisee, type PartFacture,
} from '@/lib/imputation';

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

interface LigneSource {
  /**
   * Le mouvement de stock que cette ligne a produit.
   *
   * C'est lui qu'on rend, pas la ligne du bon. Un bon dit ce qui était
   * convenu ; le mouvement dit ce qui est réellement entré, et c'est sur
   * lui que se comptent les retours déjà faits. Fabriquer ici un
   * identifiant à partir du numéro de ligne donnerait un retour qui ne
   * désigne rien : au moment de confirmer, on chercherait un mouvement
   * qui n'existe pas.
   */
  mouvementId: string;
  produitId: string;
  designation: string;
  varianteCle?: string | null;
  unite?: string | null;
  emballage?: string | null;
  /** ce qui a réellement changé de mains */
  quantite: number;
  prixUnitaire: number;
  /** ce que la marchandise avait coûté, pour la lire des deux côtés */
  cout: number;
}

interface DossierSource {
  id: string;
  reference: string;
  partenaireId: string | null;
  partenaireNom: string;
  date: string;
  lignes: LigneSource[];
  valeur: number;
  /** ce qui a réellement été versé dessus, en argent */
  verse: number;
}

export default function NouveauRetourPage() {
  const { user, activite, profile } = useAuth();
  const router = useRouter();
  const params = useParams();
  const search = useSearchParams();
  const siteId = params.id as string;
  const type = (search.get('type') as TypeRetour) ?? 'client';

  const [role, setRole] = useState<RoleSite | null>(null);
  const [roleLu, setRoleLu] = useState(false);
  const [sources, setSources] = useState<DossierSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [recherche, setRecherche] = useState('');
  const [choisi, setChoisi] = useState<string>('');
  const [engage, setEngage] = useState<Record<string, number>>({});
  const [quantites, setQuantites] = useState<Record<number, number>>({});
  const [reglement, setReglement] = useState<ReglementRetour>('deduire');
  const [motif, setMotif] = useState('');
  const [date, setDate] = useState(aujourdhui());
  const [apercu, setApercu] = useState<PartFacture[] | null>(null);
  /* Ce que l'imputation donnerait : ce qui s'éteint, et ce qui dépasse.
     On ne demande pas de confirmer un partage qu'on ne voit pas. */
  const [partage, setPartage] = useState<{ impute: number; surplus: number } | null>(null);
  /* La dette du tiers, pour dire sur quoi l'on impute. Un client de
     passage n'en a pas : c'est ce qui décide si le choix a un sens. */
  const [detteTiers, setDetteTiers] = useState<number | null>(null);
  /* Ce que le site a réellement en rayon, par produit. Un bon dit ce qui
     est entré ; le stock dit ce qui est encore là. */
  const [stocks, setStocks] = useState<Record<string, number>>({});
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(r => { setRole(r); setRoleLu(true); })
      .catch(() => { setRole(null); setRoleLu(true); });
  }, [user, siteId, activite?.adminUid]);

  useEffect(() => {
    if (!user) return;
    const col = type === 'client' ? 'ventes' : 'achats';
    const champ = type === 'client' ? 'clientId' : 'fournisseurId';
    const nomChamp = type === 'client' ? 'clientNom' : 'fournisseurNom';

    /* On lit les dossiers et les mouvements qu'ils ont produits.
       Le bon dit ce qui était convenu, le mouvement ce qui est
       réellement passé : c'est le second qu'on rend, et lui seul porte
       l'identifiant auquel un retour peut se rattacher. */
    const champDossier = type === 'client' ? 'venteId' : 'achatId';
    Promise.all([
      getDocs(query(collection(db, col), where('siteId', '==', siteId))),
      getDocs(query(collection(db, 'mouvements'),
        where('siteId', '==', siteId),
        where('motif', '==', type === 'client' ? 'vente' : 'achat'))),
    ])
      .then(([snap, snapMvt]) => {
        /* Les mouvements rangés par dossier : une passe, pas une requête
           par bon. */
        const parDossier = new Map<string, { id: string; d: any }[]>();
        for (const m of snapMvt.docs) {
          const x = m.data() as any;
          const cle = x[champDossier];
          if (!cle) continue;
          const liste = parDossier.get(cle) ?? [];
          liste.push({ id: m.id, d: x });
          parDossier.set(cle, liste);
        }

        const l: DossierSource[] = [];
        for (const d of snap.docs) {
          const x = d.data() as any;
          const mvts = parDossier.get(d.id) ?? [];
          /* Un bon dont les mouvements ne sont pas encore écrits n'est pas
             rendable : rien n'a bougé, il n'y a rien à défaire. */
          if (mvts.length === 0) continue;

          const lignes: LigneSource[] = mvts
            .map(({ id, d: m }) => ({
              mouvementId: id,
              produitId: m.produitId,
              designation: m.produit ?? m.designation ?? '—',
              varianteCle: m.varianteCle ?? null,
              unite: m.unite ?? null,
              emballage: m.emballage ?? null,
              quantite: m.quantite ?? 0,
              /* `valeurUnitaire` est le nom du document : le coût pour un
                 achat, le prix pour une vente. Un transfert n'a pas de
                 prix — rien ne se vend d'un site à l'autre —, sa colonne
                 reste donc à zéro et c'est le coût qui dit la valeur. */
              prixUnitaire: type === 'transfert'
                ? 0
                : m.valeurUnitaire
                  ?? (type === 'client' ? m.prixVente : m.cout) ?? 0,
              /* Le coût du mouvement d'origine : ce que le site avait
                 déboursé, indépendamment du prix convenu. */
              cout: m.cout ?? m.coutMoyenAlors ?? 0,
            }))
            .filter((li: LigneSource) => li.quantite > 0);
          if (lignes.length === 0) continue;
          l.push({
            id: d.id,
            reference: x.reference ?? d.id.slice(0, 6),
            partenaireId: x[champ] ?? null,
            partenaireNom: x[nomChamp] ?? '—',
            date: x.dateConfirmation ?? x.dateLivraison ?? x.dateCommande ?? '',
            lignes,
            valeur: lignes.reduce((n, li) => n + li.quantite * li.prixUnitaire, 0),
            verse: x.avanceVersee ?? 0,
          });
        }
        l.sort((a, b) => b.date.localeCompare(a.date));
        setSources(l);
      })
      .catch(() => setSources([]))
      .finally(() => setLoading(false));
  }, [user, siteId, type]);

  const source = useMemo(
    () => sources.find(s => s.id === choisi) ?? null, [sources, choisi]);

  /* Ce qui est déjà parti sur ce bon : un dossier en cours retient autant
     qu'un dossier confirmé. */
  useEffect(() => {
    if (!choisi) { setEngage({}); return; }
    let vivant = true;
    dejaEngage(siteId, choisi)
      .then(e => { if (vivant) setEngage(e); })
      .catch(() => { if (vivant) setEngage({}); });
    return () => { vivant = false; };
  }, [choisi, siteId]);

  /** Ce qui reste rendable sur une ligne. */
  /* Un retour fournisseur sort la marchandise du rayon : il est borné
     par ce qui s'y trouve. Un retour client l'y fait rentrer — rien à
     vérifier de ce côté. */
  const sortDuSite = type === 'fournisseur';

  /* Le stock du site, pour ne jamais proposer de rendre ce qui n'est
     plus au rayon. Chargé une fois : il ne bouge pas pendant la saisie. */
  useEffect(() => {
    if (!user || !sortDuSite) return;
    let vivant = true;
    produitsDuSite(siteId)
      .then(ps => {
        if (!vivant) return;
        setStocks(Object.fromEntries(ps.map(p => [p.id, p.stock ?? 0])));
      })
      .catch(() => { /* sans stock, on garde le plafond du bon */ });
    return () => { vivant = false; };
  }, [user, siteId, sortDuSite]);

  const restant = (i: number) => {
    if (!source) return 0;
    const li = source.lignes[i];
    const surLeBon = Math.max(0, li.quantite - (engage[li.mouvementId] ?? 0));
    if (!sortDuSite) return surLeBon;
    /* Tant que le stock n'est pas chargé, on ne débloque rien : mieux
       vaut attendre une seconde que proposer un retour impossible. */
    const enRayon = stocks[li.produitId];
    return enRayon === undefined ? surLeBon : Math.min(surLeBon, Math.max(0, enRayon));
  };

  const lignes: LigneDossierRetour[] = useMemo(() => {
    if (!source) return [];
    return source.lignes
      .map((li, i) => ({
        mouvementId: li.mouvementId,
        produitId: li.produitId,
        designation: li.designation,
        varianteCle: li.varianteCle ?? null,
        quantite: quantites[i] ?? 0,
        emballage: li.emballage ?? null,
        prixUnitaire: li.prixUnitaire,
        unite: li.unite ?? null,
        cout: li.cout ?? 0,
      }))
      .filter(l => l.quantite > 0);
  }, [source, quantites]);

  const valeur = lignes.reduce((n, l) => n + l.quantite * l.prixUnitaire, 0);
  const dejaRendu = source
    ? source.lignes.reduce(
        (n, li) => n + (engage[li.mouvementId] ?? 0) * li.prixUnitaire, 0)
    : 0;

  useEffect(() => {
    if (!source?.partenaireId || valeur <= 0) {
      setApercu(null); setPartage(null); setDetteTiers(null);
      return;
    }
    let vivant = true;
    const role = type === 'client' ? 'client' : 'fournisseur';
    /* On ne simule que le surplus.
     *
     * Ce qui éteint le bon d'origine ne se répartit pas : il est déjà
     * placé. Simuler la valeur entière annonçait un partage que la
     * confirmation contredisait ensuite — l'écran promettait d'imputer
     * sur de vieilles factures ce qui allait en réalité solder le bon
     * qu'on défait. */
    const aPlacer = sortieAutorisee({
      valeurRetour: valeur,
      totalDocument: source.valeur,
      verseDocument: source.verse,
    }).restituable;
    Promise.all([
      simulerImputation({
        siteId, partenaireId: source.partenaireId, role, montant: aPlacer,
      }),
      /* La dette entière, pas seulement les dossiers que ce retour
         touche : on montre sur quoi l'on impute avant de le faire. */
      dossiersOuverts(siteId, source.partenaireId, role),
    ])
      .then(([r, ouverts]) => {
        if (!vivant) return;
        setApercu(r.parts);
        setPartage({ impute: r.impute, surplus: r.surplus });
        setDetteTiers(ouverts.reduce((n, o) => n + o.reste, 0));
      })
      .catch(() => {
        if (vivant) { setApercu(null); setPartage(null); setDetteTiers(null); }
      });
    return () => { vivant = false; };
  }, [source?.partenaireId, source?.valeur, source?.verse, valeur, siteId, type]);

  /* Ce que ce retour laisse après avoir éteint sa propre dette.
   *
   * Un retour éteint d'abord le bon qu'il défait — ce n'est pas un
   * choix, c'est un fait : la marchandise repart, donc elle n'est plus
   * due. Sur 20 000 dus, rendre pour 10 000 ramène la dette à 10 000, et
   * il ne reste rien : ni à rembourser, ni à répartir.
   *
   * L'écran demandait ce règlement dès l'ouverture, en se fondant sur la
   * dette du tiers. Il offrait donc un choix sans objet dans le cas le
   * plus courant. On ne demande plus que lorsqu'il reste vraiment
   * quelque chose à placer. Le calcul est celui du serveur : on ne
   * montre pas un partage que la confirmation contredirait. */
  const surplus = useMemo(() => {
    if (!source || type === 'transfert') return 0;
    return sortieAutorisee({
      valeurRetour: valeur,
      totalDocument: source.valeur,
      verseDocument: source.verse,
    }).restituable;
  }, [source, valeur, type]);

  /* Sans partenaire, il n'y a personne à qui imputer : un client de
     passage paie et s'en va. Le surplus ne peut alors que lui être
     rendu. */
  const aUneDette = !!source?.partenaireId && (detteTiers ?? 0) > 0;
  const aChoisir = surplus > 0 && aUneDette;

  useEffect(() => {
    if (!aChoisir && reglement === 'deduire') setReglement('rembourser');
  }, [aChoisir, reglement]);

  async function valider() {
    if (!user || !source || lignes.length === 0) return;
    setEnCours(true); setErreur('');
    try {
      /* « Ouvert par » doit nommer une personne : le profil porte parfois
         l'email en guise de nom, la fiche du site porte le vrai. */
      const a = await auteurCourant(siteId, user.uid, profile?.nom ?? user.email);
      const id = await ouvrirRetour({
        siteId, type, date, lignes, reglement,
        partenaireId: source.partenaireId,
        partenaireNom: source.partenaireNom,
        achatId: type === 'fournisseur' ? source.id : null,
        venteId: type === 'client' ? source.id : null,
        motif,
        parUid: user.uid,
        parNom: a.utilisateurNom,
      });
      router.push(`/site/${siteId}/retours/${id}`);
    } catch (e: any) {
      setErreur(e?.message ?? 'L’ouverture a échoué.');
      setEnCours(false);
    }
  }

  if (loading || !roleLu) return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!peutOuvrirRetour(role)) return (
    <div className="mx-auto max-w-lg p-10 text-center">
      <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
        Ouvrir un retour ne vous revient pas.
      </p>
      <p className="mt-2 text-xs text-gray-400">
        Cela éteint une dette ou fait sortir de l’argent.
      </p>
    </div>
  );

  const q = recherche.trim().toLowerCase();
  const visibles = sources.filter(s =>
    !q || s.reference.toLowerCase().includes(q)
    || s.partenaireNom.toLowerCase().includes(q));

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <button type="button" onClick={() => router.back()}
        className="mb-3 flex items-center gap-1.5 text-xs font-bold text-gray-400 transition-colors hover:text-gray-600">
        <ArrowLeft size={14} /> Retour
      </button>

      <h1 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-gray-100">
        <Undo2 size={18} className="text-indigo-600" />
        Retour {type === 'client' ? 'client' : 'fournisseur'}
      </h1>

      {!source ? (
        /* Le choix du bon : une liste qui dit d'emblée ce que chacun pèse
           et ce qui en est déjà revenu. Choisir sur la seule référence
           obligeait à ouvrir pour savoir. */
        <div className="mt-4">
          <span className="relative block">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={recherche} onChange={e => setRecherche(e.target.value)}
              placeholder="Référence ou partenaire…"
              className="w-full rounded-xl border border-gray-200 py-2.5 pl-9 pr-3 text-sm outline-none transition-colors focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800" />
          </span>

          <div className="mt-3 space-y-2">
            {visibles.map(s => (
              <button key={s.id} type="button" onClick={() => { setChoisi(s.id); setQuantites({}); }}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-gray-100 bg-white p-3.5 text-left transition-colors hover:border-indigo-200 hover:bg-indigo-50/40 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-indigo-900/10">
                <span className="min-w-0">
                  <span className="block font-mono text-xs text-gray-400">{s.reference}</span>
                  <span className="mt-0.5 block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                    {s.partenaireNom}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-gray-400">
                    {formatDate(s.date)} · {s.lignes.length} produit{s.lignes.length > 1 ? 's' : ''}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold text-gray-900 dark:text-gray-100">
                    {formatMontant(s.valeur)}
                  </span>
                </span>
              </button>
            ))}
            {visibles.length === 0 && (
              <p className="py-10 text-center text-xs text-gray-400">
                Aucun dossier livré : il n’y a rien à rendre.
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* L'en-tête du bon : ce qu'il pèse, ce qui en est revenu, ce
              qu'on s'apprête à rendre. Trois chiffres côte à côte valent
              mieux qu'un paragraphe. */}
          <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block font-mono text-xs text-gray-400">{source.reference}</span>
                <span className="mt-0.5 block text-sm font-bold text-gray-900 dark:text-gray-100">
                  {source.partenaireNom}
                </span>
                <span className="text-[11px] text-gray-400">{formatDate(source.date)}</span>
              </span>
              <button type="button" onClick={() => { setChoisi(''); setQuantites({}); }}
                className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:border-gray-700">
                Changer
              </button>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
              {([
                { l: 'Valeur du bon', v: formatMontant(source.valeur), ton: 'text-gray-900 dark:text-gray-100' },
                { l: 'Déjà rendu', v: formatMontant(dejaRendu), ton: dejaRendu > 0 ? 'text-amber-600' : 'text-gray-300 dark:text-gray-600' },
                { l: 'Ce retour', v: formatMontant(valeur), ton: valeur > 0 ? 'text-indigo-600' : 'text-gray-300 dark:text-gray-600' },
              ]).map(c => (
                <span key={c.l} className="block">
                  <span className="block text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    {c.l}
                  </span>
                  <span className={`block text-[15px] font-bold ${c.ton}`}>{c.v}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Une ligne par produit : reçu, déjà rendu, reste, et le champ.
              Le plafond se lit à côté du champ, pas dans un message. */}
          <div className="mt-3 overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-indigo-600 text-[11px] text-white">
                  <th className="px-3 py-2 text-left font-medium">Produit</th>
                  <th className="px-2 py-2 text-center font-medium">Reçu</th>
                  <th className="px-2 py-2 text-center font-medium">Rendu</th>
                  <th className="px-2 py-2 text-center font-medium">Reste</th>
                  <th className="px-2 py-2 text-center font-medium">Prix</th>
                  <th className="px-3 py-2 text-center font-medium">À rendre</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {source.lignes.map((li, i) => {
                  const rendu = engage[li.mouvementId] ?? 0;
                  const reste = restant(i);
                  return (
                    <tr key={i} className={reste === 0 ? 'opacity-40' : ''}>
                      <td className="px-3 py-2.5">
                        <span className="block text-[13px] font-medium text-gray-900 dark:text-gray-100">
                          {li.designation}
                        </span>
                        {li.unite && (
                          <span className="block text-[11px] text-gray-400">{li.unite}</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-center text-gray-500">{li.quantite}</td>
                      <td className={`px-2 py-2.5 text-center ${
                        rendu > 0 ? 'font-bold text-amber-600' : 'text-gray-300 dark:text-gray-600'}`}>
                        {rendu || '—'}
                      </td>
                      <td className="px-2 py-2.5 text-center font-bold text-gray-900 dark:text-gray-100">
                        {reste}
                      </td>
                      <td className="px-2 py-2.5 text-center text-gray-500">
                        {formatMontant(li.prixUnitaire)}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {reste === 0 ? (
                          <span className="text-[11px] text-gray-400">Tout rendu</span>
                        ) : (
                          <span className="flex items-center justify-center gap-1">
                            <input type="number" min={0} max={reste}
                              value={quantites[i] ?? ''}
                              onChange={e => {
                                const n = Number(e.target.value);
                                setQuantites(q => ({
                                  ...q,
                                  /* Le plafond suit la ligne : on ne rend
                                     pas ce qu'on n'a plus. */
                                  [i]: Math.min(Math.max(0, n || 0), reste),
                                }));
                              }}
                              className="w-16 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm outline-none transition-colors focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800" />
                            <button type="button"
                              onClick={() => setQuantites(q => ({ ...q, [i]: reste }))}
                              title="Tout rendre"
                              className="rounded-lg border border-gray-200 px-1.5 py-1.5 text-[10px] font-bold text-gray-400 transition-colors hover:text-indigo-600 dark:border-gray-700">
                              max
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {valeur > 0 && (
            <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              {/* Le choix ne porte que sur le surplus.
                  Tant que le retour ne fait qu'éteindre le bon qu'il
                  défait, il n'y a rien à placer : demander « sur la dette
                  ou remboursé » reviendrait à faire choisir du vide. */}
              {type !== 'transfert' && aChoisir && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    { cle: 'deduire' as const, t: 'Sur la dette', s: 'Impute, plus ancienne d’abord' },
                    { cle: 'rembourser' as const, t: 'Remboursé', s: 'Passe par la caisse' },
                  ]).map(o => (
                    <button key={o.cle} type="button" onClick={() => setReglement(o.cle)}
                      className={`rounded-xl border p-2.5 text-left transition-colors ${
                        reglement === o.cle
                          ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/20'
                          : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700'}`}>
                      <span className="block text-[13px] font-bold text-gray-900 dark:text-gray-100">
                        {o.t}
                      </span>
                      <span className="block text-[11px] text-gray-400">{o.s}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Pas de surplus : on le dit plutôt que de laisser l'écran
                  muet. Celui qui cherche « sur la dette » doit savoir
                  pourquoi le choix n'est pas là. */}
              {type !== 'transfert' && !aChoisir && (
                <p className="rounded-xl bg-gray-50 p-2.5 text-[12px] text-gray-500 dark:bg-gray-800/50 dark:text-gray-400">
                  {surplus <= 0
                    ? `Ce retour éteint ${formatMontant(valeur)} sur ce bon. `
                      + 'Rien ne reste à rendre ni à imputer ailleurs.'
                    : source?.partenaireId
                      ? `${source.partenaireNom} ne doit rien d'autre : `
                        + 'le surplus part en remboursement.'
                      : 'Client de passage : rien à imputer, le surplus part '
                        + 'en remboursement.'}
                </p>
              )}

              {/* Le partage, avant de valider. Ce qui éteint la dette et
                  ce qui dépasse ne suivent pas le même chemin : l'un
                  s'inscrit sur les factures, l'autre attend le caissier. */}
              {reglement === 'deduire' && aChoisir && partage && (
                <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-gray-50 p-2.5 dark:bg-gray-800/50">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                      Dette
                    </p>
                    <p className="text-[13px] font-bold text-gray-900 dark:text-gray-100">
                      {formatMontant(detteTiers ?? 0)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-gray-50 p-2.5 dark:bg-gray-800/50">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                      Imputé
                    </p>
                    <p className="text-[13px] font-bold text-gray-900 dark:text-gray-100">
                      {formatMontant(partage.impute)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-gray-50 p-2.5 dark:bg-gray-800/50">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                      En caisse
                    </p>
                    <p className={`text-[13px] font-bold ${
                      partage.surplus > 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-gray-400'}`}>
                      {formatMontant(partage.surplus)}
                    </p>
                  </div>
                </div>
              )}

              {apercu && apercu.length > 0 && (
                <div className="mt-2.5 rounded-xl bg-gray-50 p-2.5 dark:bg-gray-800/50">
                  {apercu.map(p => (
                    <p key={p.dossierId} className="text-[12px] text-gray-600 dark:text-gray-300">
                      <span className="font-mono text-gray-400">
                        {p.reference ?? p.dossierId.slice(0, 6)}
                      </span>
                      {' '}<span className="font-bold">{formatMontant(p.impute)}</span>
                      <span className="text-gray-400"> / {formatMontant(p.restait)}</span>
                    </p>
                  ))}
                </div>
              )}

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input value={motif} onChange={e => setMotif(e.target.value)}
                  placeholder="Motif — abîmé, erreur de référence…"
                  className="rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800" />
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                  className="rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800" />
              </div>
            </div>
          )}

          {erreur && (
            <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-medium text-red-600 dark:bg-red-900/20">
              {erreur}
            </p>
          )}

          <button type="button" onClick={valider}
            disabled={enCours || lignes.length === 0}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
            {enCours ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            {valeur > 0 ? `Ouvrir le retour · ${formatMontant(valeur)}` : 'Ouvrir le retour'}
          </button>
        </>
      )}
    </div>
  );
}
