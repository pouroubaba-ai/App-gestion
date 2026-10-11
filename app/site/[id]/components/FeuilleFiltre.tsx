'use client';

/**
 * Le filtre, en une seule feuille à deux niveaux.
 *
 * On l'ouvre et elle montre les *types* de filtre — Statut, Origine — chacun
 * disant combien de choix y sont retenus. On clique un type, et la feuille
 * descend d'un cran : elle montre les choix de ce type, qu'on coche. Une
 * flèche ramène à la liste des types.
 *
 * Un filtre actif se voit, et se retire : chaque type porte sa pastille, et
 * un « Tout effacer » remet l'ensemble au repos d'un geste.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, X, ChevronRight, ChevronLeft } from 'lucide-react';

export interface OptionFiltre {
  /** La valeur retenue dans la sélection. */
  cle: string;
  label: string;
  /** Combien de dossiers la portent : un choix vide se voit avant le clic. */
  n: number;
}

export interface PlageDate {
  /** Bornes de la plage, au format AAAA-MM-JJ ; vide = non posée. */
  du: string;
  au: string;
  onChange: (du: string, au: string) => void;
}

export interface GroupeFiltre {
  /** Identifiant du groupe (ex. « statut », « origine »). */
  cle: string;
  /** Le nom du type de filtre, montré au premier niveau. */
  label: string;
  /** Un groupe à cocher : ses choix. Absent si c'est un groupe de dates. */
  options?: OptionFiltre[];
  /** Les clés retenues. Vide = tous, l'état au repos. */
  choisis?: string[];
  onChange?: (choisis: string[]) => void;
  /** Ou bien un groupe de plage de dates, au lieu d'options à cocher. */
  date?: PlageDate;
}

interface Props {
  groupes: GroupeFiltre[];
  onFermer: () => void;
}

export default function FeuilleFiltre({ groupes, onFermer }: Props) {
  /* Le type ouvert, ou null quand on est sur la liste des types. */
  const [ouvert, setOuvert] = useState<string | null>(
    /* Un seul type ? On va droit à ses choix, le premier niveau n'apprend rien. */
    groupes.length === 1 ? groupes[0].cle : null);

  /* De combien la feuille a été tirée vers le bas : elle suit le doigt. */
  const [tire, setTire] = useState(0);
  const depart = useRef<number | null>(null);

  useEffect(() => {
    const auClavier = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      /* Échap remonte d'un cran avant de fermer. */
      if (ouvert && groupes.length > 1) setOuvert(null);
      else onFermer();
    };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  }, [onFermer, ouvert, groupes.length]);

  useEffect(() => {
    const avant = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = avant; };
  }, []);

  function debut(y: number) { depart.current = y; }
  function bouge(y: number) {
    if (depart.current === null) return;
    setTire(Math.max(0, y - depart.current));
  }
  function fin() {
    if (tire > 110) onFermer();
    else setTire(0);
    depart.current = null;
  }

  const groupe = groupes.find(g => g.cle === ouvert) ?? null;
  /* Combien de choix retenus dans un groupe : les cases cochées, ou une
     plage de dates posée (une borne suffit) comptée pour un. */
  const nActifs = (g: GroupeFiltre) =>
    g.date ? ((g.date.du || g.date.au) ? 1 : 0) : (g.choisis?.length ?? 0);
  const totalActifs = groupes.reduce((n, g) => n + nActifs(g), 0);

  function basculer(g: GroupeFiltre, cle: string) {
    if (!g.onChange) return;
    const choisis = g.choisis ?? [];
    g.onChange(choisis.includes(cle)
      ? choisis.filter(c => c !== cle)
      : [...choisis, cle]);
  }

  function viderGroupe(g: GroupeFiltre) {
    if (g.date) g.date.onChange('', '');
    else g.onChange?.([]);
  }

  /* Tout remettre au repos, tous types confondus. */
  function toutEffacer() {
    for (const g of groupes) if (nActifs(g) > 0) viderGroupe(g);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
      onClick={onFermer}>
      <div onClick={e => e.stopPropagation()}
        onTouchStart={e => debut(e.touches[0].clientY)}
        onTouchMove={e => bouge(e.touches[0].clientY)}
        onTouchEnd={fin}
        style={{
          transform: `translateY(${tire}px)`,
          transition: depart.current === null ? 'transform 200ms ease-out' : 'none',
        }}
        className="max-h-[80vh] w-full overflow-y-auto rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl dark:bg-gray-900 sm:max-w-sm sm:rounded-3xl">

        <div className="flex justify-center pb-1 pt-3 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
        </div>

        <div className="px-5 pb-5 pt-3 sm:pt-5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              {/* En descendant dans un type, la flèche ramène aux types —
                  sauf s'il n'y en a qu'un : il n'y a rien au-dessus. */}
              {groupe && groupes.length > 1 && (
                <button type="button" onClick={() => setOuvert(null)}
                  className="shrink-0 rounded-lg p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800">
                  <ChevronLeft size={18} />
                </button>
              )}
              <p className="truncate text-sm font-bold text-gray-900 dark:text-gray-100">
                {groupe ? `Filtrer par ${groupe.label.toLowerCase()}` : 'Filtrer'}
              </p>
            </span>
            {/* Tout effacer : visible dès qu'un filtre quelconque est posé. */}
            {totalActifs > 0 && (
              <button type="button" onClick={toutEffacer}
                className="flex shrink-0 items-center gap-1 text-xs font-bold text-indigo-600 dark:text-indigo-400">
                <X size={12} /> Tout effacer
              </button>
            )}
          </div>

          {/* Premier niveau : les types de filtre. */}
          {!groupe && (
            <div className="mt-3 space-y-1">
              {groupes.map(g => {
                const actifs = nActifs(g);
                return (
                  <button key={g.cle} type="button" onClick={() => setOuvert(g.cle)}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-gray-100 p-3 text-left transition-colors hover:border-indigo-200 dark:border-gray-800 dark:hover:border-indigo-800/40">
                    <span className="truncate text-[13px] font-semibold text-gray-700 dark:text-gray-200">
                      {g.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {actifs > 0 && (
                        <span className="rounded-lg bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                          {actifs}
                        </span>
                      )}
                      <ChevronRight size={16} className="text-gray-300 dark:text-gray-600" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Second niveau — groupe de dates : deux bornes. */}
          {groupe && groupe.date && (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Du</label>
                  <input type="date" value={groupe.date.du}
                    max={groupe.date.au || undefined}
                    onChange={e => groupe.date!.onChange(e.target.value, groupe.date!.au)}
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Au</label>
                  <input type="date" value={groupe.date.au}
                    min={groupe.date.du || undefined}
                    onChange={e => groupe.date!.onChange(groupe.date!.du, e.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                </div>
              </div>
              {(groupe.date.du || groupe.date.au) && (
                <button type="button" onClick={() => viderGroupe(groupe)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-gray-200 py-2 text-xs font-bold text-gray-500 transition-colors hover:border-red-200 hover:text-red-500 dark:border-gray-700 dark:text-gray-400">
                  <X size={12} /> Retirer ce filtre
                </button>
              )}
            </>
          )}

          {/* Second niveau — groupe à cocher : les choix du type ouvert. */}
          {groupe && groupe.options && (
            <>
              <div className="mt-3 space-y-1">
                {groupe.options.map(o => {
                  const actif = (groupe.choisis ?? []).includes(o.cle);
                  return (
                    <button key={o.cle} type="button" onClick={() => basculer(groupe, o.cle)}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors ${
                        actif
                          ? 'border-indigo-200 bg-indigo-50 dark:border-indigo-800/40 dark:bg-indigo-900/20'
                          : 'border-gray-100 dark:border-gray-800'}`}>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                          actif
                            ? 'border-indigo-600 bg-indigo-600'
                            : 'border-gray-300 dark:border-gray-600'}`}>
                          {actif && <Check size={11} className="text-white" />}
                        </span>
                        <span className={`truncate text-[13px] ${
                          actif
                            ? 'font-bold text-indigo-700 dark:text-indigo-300'
                            : 'text-gray-700 dark:text-gray-300'}`}>
                          {o.label}
                        </span>
                      </span>
                      <span className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                        o.n === 0
                          ? 'text-gray-300 dark:text-gray-700'
                          : actif
                          ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                        {o.n}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Retirer le filtre de ce seul type, sans toucher aux autres. */}
              {(groupe.choisis?.length ?? 0) > 0 && (
                <button type="button" onClick={() => viderGroupe(groupe)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-gray-200 py-2 text-xs font-bold text-gray-500 transition-colors hover:border-red-200 hover:text-red-500 dark:border-gray-700 dark:text-gray-400">
                  <X size={12} /> Retirer ce filtre
                </button>
              )}
            </>
          )}

          <button type="button" onClick={onFermer}
            className="mt-4 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700">
            Voir les dossiers
          </button>
        </div>
      </div>
    </div>
  );
}
