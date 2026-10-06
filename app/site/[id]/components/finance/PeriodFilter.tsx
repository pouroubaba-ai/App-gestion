'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Sélecteur de période en liste déroulante, repris du dashboard financier.
 * Cinq boutons alignés prenaient toute la largeur de l'en-tête ; replié, il
 * ne montre que la période active.
 */
export type Periode = 'jour' | 'semaine' | 'mois' | 'annee' | 'tout';

/**
 * Le premier jour d'une période, au format que portent les documents.
 *
 * Elle vivait recopiée dans les écrans qui filtrent — chacun avec sa
 * version, et rien pour garantir qu'elles tombent le même lundi. Elle
 * vit ici, à côté du filtre qui la commande.
 *
 * Chaîne vide pour « tout » : il n'y a pas de borne, et comparer à ''
 * laisse tout passer sans qu'on ait à traiter le cas à part.
 */
export function debutPeriode(p: Periode): string {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const d = new Date();
  if (p === 'jour') return iso(d);
  if (p === 'semaine') {
    /* semaine commençant le lundi */
    const jour = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - jour);
    return iso(d);
  }
  if (p === 'mois') { d.setDate(1); return iso(d); }
  if (p === 'annee') { d.setMonth(0, 1); return iso(d); }
  return '';
}

const PERIODES: { key: Periode; label: string }[] = [
  { key: 'jour', label: "Aujourd'hui" },
  { key: 'semaine', label: 'Cette semaine' },
  { key: 'mois', label: 'Ce mois' },
  { key: 'annee', label: 'Cette année' },
  { key: 'tout', label: 'Tout' },
];

export default function PeriodFilter<T extends string = Periode>({
  periode, onChange, options,
}: {
  periode: T;
  onChange: (p: T) => void;
  /* Sans options, les périodes du dashboard. Le recouvrement a les siennes,
     dont les libellés changent selon qu'on regarde l'échu ou l'à-venir. */
  options?: { key: T; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const liste = (options ?? (PERIODES as unknown as { key: T; label: string }[]));
  const currentLabel = liste.find(({ key }) => key === periode)?.label ?? '';

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-xl border border-black/10 px-3 py-2.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-neutral-900"
      >
        {currentLabel}
        <ChevronDown
          size={14}
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-neutral-950">
          {liste.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => { onChange(key); setOpen(false); }}
              className={`block w-full px-3 py-2 text-left text-xs transition-colors ${
                periode === key
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
