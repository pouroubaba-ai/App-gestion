'use client';
import { formatMontant } from '@/lib/format';

/** Créances et dettes côte à côte, séparées par un filet. Repris tel quel. */
export default function CreancesDettesCard({
  creances, dettes, onNaviguer,
}: {
  creances: number;
  dettes: number;
  onNaviguer?: (onglet: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onNaviguer?.('partenaires')}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-black/10 bg-white p-4 text-left shadow-sm transition-colors hover:border-indigo-300 dark:border-white/10 dark:bg-neutral-950"
    >
      <p className="shrink-0 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
        Créances &amp; Dettes
      </p>

      <div className="mt-2 flex min-h-0 flex-1 items-center">
        <div>
          <p className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">Créances</p>
          <p className="mt-0.5 text-lg font-bold tracking-tight text-amber-500">
            {formatMontant(creances)}
          </p>
        </div>
        <div className="mx-auto h-8 w-px bg-neutral-200 dark:bg-neutral-800" />
        <div>
          <p className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">Dettes</p>
          <p className="mt-0.5 text-lg font-bold tracking-tight text-red-600 dark:text-red-400">
            {formatMontant(dettes)}
          </p>
        </div>
      </div>
    </button>
  );
}
