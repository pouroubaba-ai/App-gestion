'use client';

/**
 * Le filtre par statut, en feuille glissante.
 *
 * En vue « en cours », la liste mêle les étapes : on y voit les dossiers
 * à commander, ceux en préparation, ceux qui attendent d'être livrés. Les
 * tuiles qui laissaient choisir une étape ne sont plus à l'écran — le
 * filtre reprend ce choix, sans quitter la vue d'ensemble.
 *
 * En feuille plutôt qu'en menu déroulant : chaque statut y porte son
 * compte, et une liste qui dit « 3 en préparation » évite de la choisir
 * pour découvrir qu'elle est vide.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';

export interface OptionStatut {
  /** La valeur retenue dans la sélection. */
  cle: string;
  label: string;
  /** Combien de dossiers le portent : un statut vide se voit avant le clic. */
  n: number;
}

interface Props {
  options: OptionStatut[];
  /** Les statuts retenus. Vide = tous, ce qui est l'état au repos. */
  choisis: string[];
  onChange: (choisis: string[]) => void;
  onFermer: () => void;
}

export default function FeuilleFiltreStatut({
  options, choisis, onChange, onFermer,
}: Props) {
  /* De combien la feuille a été tirée vers le bas : elle suit le doigt. */
  const [tire, setTire] = useState(0);
  const depart = useRef<number | null>(null);

  useEffect(() => {
    const auClavier = (e: KeyboardEvent) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  }, [onFermer]);

  /* Le fond ne défile plus derrière : sans cela, le doigt qui tire la
     feuille emporte la page avec lui. */
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

  /* Un statut se coche et se décoche : on cherche souvent deux étapes à la
     fois — ce qui est prêt et ce qui va l'être. */
  function basculer(cle: string) {
    onChange(choisis.includes(cle)
      ? choisis.filter(c => c !== cle)
      : [...choisis, cle]);
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

        {/* La poignée : elle dit que la feuille se tire, sans le nommer. */}
        <div className="flex justify-center pb-1 pt-3 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
        </div>

        <div className="px-5 pb-5 pt-3 sm:pt-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              Filtrer par statut
            </p>
            {/* Tout effacer d'un geste : décocher un à un pour revenir au
                départ est un travail que la feuille doit s'épargner. */}
            {choisis.length > 0 && (
              <button type="button" onClick={() => onChange([])}
                className="flex items-center gap-1 text-xs font-bold text-indigo-600 dark:text-indigo-400">
                <X size={12} /> Tout effacer
              </button>
            )}
          </div>

          <div className="mt-3 space-y-1">
            {options.map(o => {
              const actif = choisis.includes(o.cle);
              return (
                <button key={o.cle} type="button" onClick={() => basculer(o.cle)}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors ${
                    actif
                      ? 'border-indigo-200 bg-indigo-50 dark:border-indigo-800/40 dark:bg-indigo-900/20'
                      : 'border-gray-100 dark:border-gray-800'}`}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    {/* La case dit ce qui est retenu sans avoir à comparer
                        les fonds entre eux. */}
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
                  {/* Le compte : un statut vide se voit avant d'être choisi. */}
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

          <button type="button" onClick={onFermer}
            className="mt-4 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700">
            Voir les dossiers
          </button>
        </div>
      </div>
    </div>
  );
}
