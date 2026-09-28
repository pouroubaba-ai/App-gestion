'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Ship, CheckCircle2 } from 'lucide-react';
import { formatMontant } from '@/lib/format';
import { totalFrais } from '@/lib/frais';
import {
  importationsDe, totalImportation, enCours,
  ETAPES_IMPORTATION, LIBELLES_IMPORTATION,
  type Importation, type EtatImportation,
} from '@/lib/importations';
import { useSites, type PropsPortee } from './ContexteSites';

/**
 * Les importations de la maison.
 *
 * Un achat qui vient de loin : mêmes lignes, mêmes frais, même
 * confirmation qui fait entrer le stock — mais neuf états au lieu de
 * quatre, parce qu'entre la commande et le rayon il se passe des
 * semaines et des mains.
 *
 * L'écran se lit de deux façons, comme les achats. « En cours » répond
 * en deux chiffres : combien de dossiers voyagent, et ce qu'ils pèsent.
 * « Statut » ouvre le détail, étape par étape.
 */
export default function OngletImportations(props: PropsPortee) {
  const router = useRouter();
  const ctx = useSites(props.siteId, props.sites);

  const [dossiers, setDossiers] = useState<Importation[]>([]);
  const [chargement, setChargement] = useState(true);
  const [modeVue, setModeVue] = useState<'encours' | 'statut'>('encours');
  const [etatOuvert, setEtatOuvert] = useState<EtatImportation | null>(null);

  useEffect(() => {
    let vivant = true;
    setChargement(true);
    importationsDe(ctx.portee)
      .then(l => { if (vivant) setDossiers(l); })
      .catch(() => {})
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [ctx.portee]);

  /* Ce qui voyage encore, et ce qui est arrivé au bout. Les annulés ne
     comptent ni d'un côté ni de l'autre : ils n'ont rien coûté et rien
     rapporté. */
  const { route, clos } = useMemo(() => ({
    route: dossiers.filter(d => enCours(d.etat)),
    clos: dossiers.filter(d => d.etat === 'confirme'),
  }), [dossiers]);

  const valeurRoute = route.reduce((n, d) => n + totalImportation(d), 0);
  const valeurClose = clos.reduce((n, d) => n + totalImportation(d), 0);
  /* Ce que le voyage a coûté, à part de la marchandise : c'est le
     chiffre qui dit si importer vaut le coup. Noyé dans le total, il ne
     se voit pas. */
  const fraisClos = clos.reduce((n, d) => n + totalFrais(d.frais), 0);

  /* Une carte par étape, dans l'ordre du voyage : on veut voir où les
     dossiers s'accumulent. */
  const parEtape = useMemo(() => {
    const m = new Map<EtatImportation, Importation[]>();
    for (const e of ETAPES_IMPORTATION) m.set(e, []);
    m.set('attente_confirmation', []);
    for (const d of dossiers) {
      const l = m.get(d.etat);
      if (l) l.push(d);
    }
    return m;
  }, [dossiers]);

  const liste = etatOuvert ? (parEtape.get(etatOuvert) ?? []) : route;

  if (chargement) return (
    <div className="flex min-h-64 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Les deux lectures du même dossier. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
          {([
            { key: 'encours' as const, label: 'En cours' },
            { key: 'statut' as const, label: 'Statut' },
          ]).map(v => (
            <button key={v.key}
              onClick={() => { setModeVue(v.key); setEtatOuvert(null); }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${modeVue === v.key
                ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
              {v.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => router.push('/ensemble/importations/nouvelle')}
          className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
          <Plus size={13} /> Nouvelle importation
        </button>
      </div>

      {modeVue === 'encours' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Ce qui voyage. */}
          <button type="button" onClick={() => setEtatOuvert(null)}
            className="rounded-2xl border border-gray-100 bg-white p-5 text-left shadow-sm transition-shadow hover:shadow-md dark:border-gray-800 dark:bg-gray-900">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 dark:bg-indigo-900/30">
                <Ship size={15} className="text-indigo-600 dark:text-indigo-400" />
              </span>
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
                En cours
              </span>
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {route.length}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {route.length > 1 ? 'dossiers en route' : 'dossier en route'}
            </p>
            <p className="mt-2 text-sm font-bold text-gray-900 dark:text-gray-100">
              {formatMontant(valeurRoute)}
            </p>
          </button>

          {/* Ce qui est arrivé — et ce que le voyage a coûté. */}
          <button type="button" onClick={() => setEtatOuvert('confirme')}
            className="rounded-2xl border border-gray-100 bg-white p-5 text-left shadow-sm transition-shadow hover:shadow-md dark:border-gray-800 dark:bg-gray-900">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-green-50 dark:bg-green-900/30">
                <CheckCircle2 size={15} className="text-green-600 dark:text-green-400" />
              </span>
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
                Confirmé
              </span>
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {clos.length}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {clos.length > 1 ? 'dossiers arrivés' : 'dossier arrivé'}
            </p>
            <p className="mt-2 text-sm font-bold text-gray-900 dark:text-gray-100">
              {formatMontant(valeurClose)}
            </p>
            {/* Ce que le voyage a coûté, dit à part : noyé dans le
                total, il ne se verrait pas — et c'est lui qui dit si
                importer vaut le coup. */}
            {fraisClos > 0 && (
              <p className="mt-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400">
                dont {formatMontant(fraisClos)} de frais
              </p>
            )}
          </button>
        </div>
      ) : (
        /* Une carte par étape : on voit où les dossiers s'accumulent. */
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* L'ordre du voyage, avec l'arrêt de contrôle à sa place :
              juste avant la clôture, puisque c'est là qu'il retient. */}
          {(ETAPES_IMPORTATION.flatMap(e =>
            e === 'confirme'
              ? ['attente_confirmation' as EtatImportation, e]
              : [e]
          )).map(e => {
              const n = (parEtape.get(e) ?? []).length;
              const actif = etatOuvert === e;
              return (
                <button key={e} type="button"
                  onClick={() => setEtatOuvert(actif ? null : e)}
                  className={`rounded-xl border p-3 text-left transition-colors ${actif
                    ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/20'
                    : 'border-gray-100 bg-white hover:border-indigo-200 dark:border-gray-800 dark:bg-gray-900'}`}>
                  <p className="text-[11px] font-medium text-gray-400">
                    {LIBELLES_IMPORTATION[e]}
                  </p>
                  <p className={`mt-1 text-lg font-bold ${n > 0
                    ? 'text-gray-900 dark:text-gray-100' : 'text-gray-300 dark:text-gray-700'}`}>
                    {n}
                  </p>
                </button>
              );
            })}
        </div>
      )}

      {/* Les dossiers de la carte ouverte. */}
      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <p className="mb-3 text-sm font-bold text-gray-900 dark:text-gray-100">
          {etatOuvert ? LIBELLES_IMPORTATION[etatOuvert] : 'En route'}
          <span className="ml-2 text-xs font-medium text-gray-400">
            {liste.length} dossier{liste.length > 1 ? 's' : ''}
          </span>
        </p>

        {liste.length === 0 ? (
          <p className="py-8 text-center text-xs text-gray-400">Aucun dossier.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-center text-sm">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  <th className="rounded-l-lg px-3 py-2.5 text-left font-medium">Référence</th>
                  <th className="px-3 py-2.5 font-medium">Fournisseur</th>
                  <th className="px-3 py-2.5 font-medium">Destination</th>
                  <th className="px-3 py-2.5 font-medium">Produits</th>
                  <th className="px-3 py-2.5 font-medium">Frais</th>
                  <th className="px-3 py-2.5 font-medium">Valeur</th>
                  <th className="rounded-r-lg px-3 py-2.5 font-medium">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {liste.map(d => (
                  <tr key={d.id}
                    onClick={() => router.push(`/ensemble/importations/${d.id}`)}
                    className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-3 py-2.5 text-left font-medium text-gray-900 dark:text-gray-100">
                      {d.reference}
                    </td>
                    <td className="px-3 py-2.5 text-gray-500">{d.fournisseurNom}</td>
                    <td className="px-3 py-2.5 text-gray-500">{d.siteNom ?? '—'}</td>
                    <td className="px-3 py-2.5 text-gray-500">{(d.lignes ?? []).length}</td>
                    <td className="px-3 py-2.5 text-gray-500">
                      {totalFrais(d.frais) > 0 ? formatMontant(totalFrais(d.frais)) : '—'}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100">
                      {formatMontant(totalImportation(d))}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                        d.etat === 'confirme'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : d.etat === 'annule'
                          ? 'bg-gray-100 text-gray-500 dark:bg-gray-800'
                          : d.etat === 'attente_confirmation'
                          ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                          : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'}`}>
                        {LIBELLES_IMPORTATION[d.etat]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
