'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Filtre en liste déroulante, sur le modèle du sélecteur de période du
 * tableau de bord.
 *
 * Deux filtres côte à côte en boutons donnaient huit pastilles alignées,
 * dont deux « Tous » : rien ne disait lequel agissait sur quoi. Replié, le
 * menu porte son propre nom et ne montre que la valeur choisie ; les
 * compteurs restent lisibles une fois ouvert, là où on en a besoin.
 */
export interface OptionFiltre<T extends string> {
  valeur: T;
  label: string;
  /** nombre d'éléments concernés, affiché entre parenthèses */
  nombre?: number;
}

export default function FiltreDeroulant<T extends string>({
  nom, valeur, options, onChange,
}: {
  /** ce sur quoi porte le filtre — « État », « Statut » */
  nom: string;
  valeur: T;
  options: OptionFiltre<T>[];
  onChange: (v: T) => void;
}) {
  const [ouvert, setOuvert] = useState(false);
  const conteneur = useRef<HTMLDivElement>(null);

  const courante = options.find(o => o.valeur === valeur);

  useEffect(() => {
    if (!ouvert) return;
    function dehors(e: MouseEvent) {
      if (!conteneur.current?.contains(e.target as Node)) setOuvert(false);
    }
    document.addEventListener('mousedown', dehors);
    return () => document.removeEventListener('mousedown', dehors);
  }, [ouvert]);

  return (
    <div ref={conteneur} className="relative">
      <button
        type="button"
        onClick={() => setOuvert(v => !v)}
        aria-expanded={ouvert}
        className="flex items-center gap-1.5 rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-200 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <span className="text-gray-400">{nom}</span>
        <span className="font-bold">{courante?.label ?? ''}</span>
        {courante?.nombre != null && (
          <span className="text-gray-400">({courante.nombre})</span>
        )}
        <ChevronDown size={13} className={`text-gray-400 transition-transform ${ouvert ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {ouvert && (
        <div className="absolute left-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-1 shadow-lg">
          {options.map(o => (
            <button
              key={o.valeur}
              type="button"
              onClick={() => { onChange(o.valeur); setOuvert(false); }}
              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                valeur === o.valeur
                  ? 'text-indigo-600 dark:text-indigo-400 font-bold'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <span>{o.label}</span>
              {o.nombre != null && <span className="text-gray-400">{o.nombre}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
