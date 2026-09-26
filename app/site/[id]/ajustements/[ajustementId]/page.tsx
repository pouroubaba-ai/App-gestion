'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Loader2, Check, ChevronLeft, ChevronRight, SlidersHorizontal, X,
} from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { auteurCourant } from '@/lib/auteur';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { formatMontant } from '@/lib/format';
import { estEnsemble, racineRetour } from '@/lib/retour';
import { ChampNombre } from '@/components/Champs';
import {
  MOTIFS_AJUSTEMENT, ETAPES_AJUSTEMENT, LIBELLES_ETAT_AJUSTEMENT,
  lireAjustement, avancerAjustement, constaterAjustement,
  confirmerAjustement, annulerAjustement,
  peutDeclarer, peutTraiterAjustement,
  type DossierAjustement,
} from '@/lib/ajustements';

/**
 * La fiche d'un mouvement déclaré.
 *
 * Le gérant a dit ce qu'il constate ; c'est ici que le responsable des
 * commandes va compter, corrige ce qu'il faut, et confirme. Le stock ne
 * bouge qu'à ce dernier geste, sur les quantités qu'il a vues lui-même.
 */
export default function FicheAjustementPage() {
  const { user, activite, profile } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  const ajustementId = params.ajustementId as string;
  const vientEnsemble = estEnsemble(searchParams);
  /* On revient d'où l'on vient : les mouvements ont leur onglet, et
     renvoyer vers l'inventaire faisait sortir de la page qu'on
     consultait. */
  const fermer = `${racineRetour(vientEnsemble, siteId)}?onglet=mouvements-stock`;

  const [d, setD] = useState<DossierAjustement | null>(null);
  const [nomSite, setNomSite] = useState<string | null>(null);
  const [role, setRole] = useState<RoleSite | null>(null);
  const [loading, setLoading] = useState(true);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  /* Ce que le responsable compte, ligne par ligne, avant de confirmer. */
  const [comptes, setComptes] = useState<number[]>([]);

  async function charger() {
    const x = await lireAjustement(ajustementId);
    setD(x);
    if (x) {
      setComptes(x.lignes.map(l => l.quantiteConstatee ?? l.quantiteDeclaree));
    }
    setLoading(false);
  }

  useEffect(() => { charger(); }, [ajustementId]);

  useEffect(() => {
    getDoc(doc(db, 'sites', siteId))
      .then(s => setNomSite((s.data() as any)?.nom ?? null))
      .catch(() => setNomSite(null));
  }, [siteId]);

  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(setRole)
      .catch(() => setRole(null));
  }, [user, siteId, activite?.adminUid]);

  async function agir(geste: () => Promise<unknown>) {
    setEnCours(true); setErreur('');
    try {
      await geste();
      await charger();
    } catch (e: any) {
      setErreur(e?.message ?? 'Opération impossible.');
    }
    setEnCours(false);
  }

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!d) return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Ce mouvement n’existe plus.</p>
      <button onClick={() => router.push(fermer)}
        className="px-4 py-2 text-xs font-bold text-indigo-600 hover:underline">
        Retour
      </button>
    </div>
  );

  const regle = MOTIFS_AJUSTEMENT[d.motif];
  const entree = d.sens === 'entree';
  const clos = d.etat === 'confirme' || d.etat === 'annule';
  const i = ETAPES_AJUSTEMENT.indexOf(d.etat);
  /* Le comptage n'a lieu qu'en préparation : avant, personne n'est allé
     voir ; après, le fait est inscrit. */
  const compte = d.etat === 'en_preparation' && peutTraiterAjustement(role);
  /* Le responsable des commandes compte des sacs, pas des francs : ce
     qu'une marchandise a coûté ne regarde pas celui qui la constate. */
  const voitLArgent = role !== 'commandes';
  const sonPropreDossier = d.parUid === user?.uid;

  const totalDeclare = d.lignes.reduce((n, l) => n + l.quantiteDeclaree, 0);
  const totalConstate = d.lignes.reduce(
    (n, l) => n + (l.quantiteConstatee ?? 0), 0);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-900/90">
        <div className="w-full px-4 py-3 sm:px-6 lg:px-8">
          <div className="sm:flex sm:items-center sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <button type="button" onClick={() => router.push(fermer)}
                className="mb-0.5 flex max-w-full items-center gap-1 truncate text-[11px] text-gray-400 transition-colors hover:text-indigo-600">
                <ChevronLeft size={12} className="shrink-0" />
                <span className="truncate">{nomSite ?? 'Inventaire'}</span>
                <span className="px-0.5">/</span>
                <span className="truncate text-gray-300 dark:text-gray-600">
                  Mouvement de stock
                </span>
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <SlidersHorizontal size={18} className="shrink-0 text-indigo-500" />
                <h1 className="truncate font-mono text-lg font-bold">
                  {d.reference}
                </h1>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  entree
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                  {entree ? 'Entrée' : 'Sortie'}
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  d.etat === 'confirme'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : d.etat === 'annule'
                    ? 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                    : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'}`}>
                  {LIBELLES_ETAT_AJUSTEMENT[d.etat]}
                </span>
              </div>
            </div>

            {/* L'action vit dans l'en-tête : elle reste sous la main
                pendant qu'on parcourt les lignes. */}
            <div className="mt-2.5 flex gap-2 [&>button]:flex-1 [&>button]:justify-center sm:mt-0 sm:[&>button]:flex-none">
              <button type="button" onClick={() => router.push(fermer)}
                className="hidden rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 sm:block">
                Fermer
              </button>

              {!clos && peutTraiterAjustement(role) && (
                d.etat === 'en_preparation' ? (
                  <button type="button"
                    onClick={() => agir(async () => {
                      await constaterAjustement({
                        dossier: d,
                        quantites: comptes,
                        roleSite: role,
                      });
                      const frais = await lireAjustement(d.id);
                      if (!frais) throw new Error('Ce mouvement n’existe plus.');
                      const a = await auteurCourant(
                        siteId, user!.uid, profile?.nom ?? user!.email);
                      await confirmerAjustement({
                        dossier: frais,
                        parUid: user!.uid,
                        parNom: a.utilisateurNom,
                        utilisateurNom: a.utilisateurNom,
                        utilisateurFonction: a.utilisateurFonction,
                        roleSite: role,
                      });
                    })}
                    disabled={enCours || sonPropreDossier}
                    title={sonPropreDossier
                      ? 'On ne confirme pas le mouvement qu’on a déclaré.'
                      : undefined}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                    {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    Confirmer · le stock bouge
                  </button>
                ) : (
                  <button type="button"
                    onClick={() => agir(() =>
                      avancerAjustement({ dossier: d, roleSite: role }))}
                    disabled={enCours}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                    {enCours ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
                    Passer à « {LIBELLES_ETAT_AJUSTEMENT[ETAPES_AJUSTEMENT[i + 1]]} »
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="w-full px-4 py-5 sm:px-6 sm:py-6 lg:px-8">

        {/* Le chemin parcouru, et ce qui reste. */}
        {d.etat !== 'annule' && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {ETAPES_AJUSTEMENT.map((e, n) => (
              <span key={e} className="flex items-center gap-1.5">
                {n > 0 && <ChevronRight size={12} className="text-gray-300" />}
                <span className={`rounded-lg px-2 py-1 text-[11px] font-bold ${
                  n <= i
                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
                    : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>
                  {LIBELLES_ETAT_AJUSTEMENT[e]}
                </span>
              </span>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { l: 'Motif', v: regle.libelle },
            { l: 'Date', v: d.date.split('-').reverse().join('/') },
            { l: 'Déclaré par', v: d.parNom ?? '—' },
            { l: 'Confirmé par', v: d.confirmeParNom ?? '—' },
          ].map(x => (
            <div key={x.l} className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                {x.l}
              </p>
              <p className="truncate text-[13px] font-bold">{x.v}</p>
            </div>
          ))}
        </div>

        {/* Ce qu'une sortie détruit se dit aussi ici : la fiche se relit
            longtemps après, quand personne ne se souvient du motif. */}
        {!entree && (
          <p className={`mt-3 rounded-xl p-2.5 text-[12px] ${
            regle.perte
              ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
              : 'bg-gray-50 text-gray-500 dark:bg-gray-800/50 dark:text-gray-400'}`}>
            {regle.perte
              ? 'Cette sortie est une perte : elle est retranchée du bénéfice.'
              : 'Cette sortie est une charge : la marchandise a servi, elle n’est pas perdue.'}
          </p>
        )}

        <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">Marchandise</h2>
            <span className="text-[11px] text-gray-400">
              {d.lignes.length} ligne{d.lignes.length > 1 ? 's' : ''}
            </span>
          </div>

          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  <th className="px-4 py-3 text-center text-xs font-bold">Produit</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Unité</th>
                  {voitLArgent && (
                    <>
                      <th className="px-4 py-3 text-center text-xs font-bold">Coût</th>
                      <th className="px-4 py-3 text-center text-xs font-bold">Prix</th>
                    </>
                  )}
                  <th className="px-4 py-3 text-center text-xs font-bold">Déclaré</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Constaté</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {d.lignes.map((l, n) => (
                  <tr key={n}>
                    <td className="px-4 py-3 text-center font-medium">
                      {l.designation}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-400">
                      {l.unite ?? '—'}
                    </td>
                    {voitLArgent && (
                      <>
                        {/* Le coût d'une sortie vit dans le rayon, pas sur
                            la ligne : il n'y est figé qu'à l'entrée. */}
                        <td className="px-4 py-3 text-center text-gray-500">
                          {l.cout != null ? formatMontant(l.cout) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center text-gray-500">
                          {l.prixVente != null ? formatMontant(l.prixVente) : '—'}
                        </td>
                      </>
                    )}
                    <td className="px-4 py-3 text-center">
                      {l.quantiteDeclaree}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {/* Le responsable corrige ce qu'il trouve : déclarer
                          dix cassés et en compter huit, c'est huit qui
                          sortent. Le registre suit ce qu'on a vu. */}
                      {compte ? (
                        <div className="mx-auto w-24">
                          <ChampNombre
                            valeur={comptes[n] ?? 0}
                            onChange={v => setComptes(prev =>
                              prev.map((x, k) => (k === n ? v : x)))}
                          />
                        </div>
                      ) : (
                        <span className={l.quantiteConstatee == null
                          ? 'text-gray-300 dark:text-gray-600'
                          : l.quantiteConstatee !== l.quantiteDeclaree
                          ? 'font-bold text-amber-600'
                          : 'font-bold'}>
                          {l.quantiteConstatee ?? '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-100 font-bold dark:border-gray-800">
                  <td className="px-4 py-3 text-center text-gray-400">Total</td>
                  <td />
                  {voitLArgent && (
                    <>
                      {/* Ce que le mouvement pèse : au coût, ce que la
                          maison avait payé ; au prix, ce qu'elle
                          n'encaissera pas. */}
                      <td className="px-4 py-3 text-center">
                        {formatMontant(d.lignes.reduce((n, l) => n
                          + (l.quantiteConstatee ?? l.quantiteDeclaree) * (l.cout ?? 0), 0))}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {formatMontant(d.lignes.reduce((n, l) => n
                          + (l.quantiteConstatee ?? l.quantiteDeclaree) * (l.prixVente ?? 0), 0))}
                      </td>
                    </>
                  )}
                  <td className="px-4 py-3 text-center">{totalDeclare}</td>
                  <td className="px-4 py-3 text-center">
                    {d.etat === 'confirme' ? totalConstate : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {d.note && (
            <p className="mt-3 border-t border-gray-100 pt-3 text-[12px] text-gray-500 dark:border-gray-800">
              <span className="text-gray-400">Note </span>{d.note}
            </p>
          )}
        </div>

        {d.etat === 'confirme' && (
          <p className="mt-3 rounded-xl bg-green-50 p-2.5 text-[12px] text-green-700 dark:bg-green-900/20 dark:text-green-400">
            Confirmé par {d.confirmeParNom ?? '—'} le{' '}
            {(d.confirmeA ?? '').split('-').reverse().join('/')}. Le stock a bougé.
          </p>
        )}

        {erreur && (
          <p className="mt-3 rounded-xl bg-red-50 p-2.5 text-[12px] text-red-600 dark:bg-red-900/20 dark:text-red-400">
            {erreur}
          </p>
        )}

        {/* Annuler défait une décision : cela revient à qui l'a prise, et
            seulement tant que le stock n'a pas bougé. */}
        {!clos && peutDeclarer(role) && (
          <div className="mt-5">
            <button type="button"
              onClick={() => agir(() => annulerAjustement({
                dossier: d, parUid: user!.uid,
                parNom: profile?.nom ?? null, roleSite: role,
              }))}
              disabled={enCours}
              className="flex items-center gap-1.5 rounded-xl border border-red-200 px-4 py-2 text-sm font-bold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:border-red-900/40 dark:hover:bg-red-900/20">
              <X size={14} /> Annuler ce mouvement
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
