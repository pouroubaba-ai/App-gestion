'use client';
import { formatMontant } from '@/lib/format';

/**
 * Les trois indicateurs de tête, repris du dashboard financier : la carte
 * Ventes en dégradé indigo, les deux autres en blanc. Les chiffres viennent
 * des données du site au lieu d'être écrits en dur.
 */
export default function VentesCard({
  ventes, benefice, encaisse, reste, fonds, sousTitreFonds, onNaviguer,
}: {
  ventes: number;
  benefice: number;
  encaisse: number;
  /**
   * Ce qui reste dû sur les ventes de la période affichée.
   *
   * Distinct de la créance totale, que porte la carte Créances : ici on
   * répond à « de ce que j'ai vendu sur cette période, combien reste-t-il
   * à rentrer ? ».
   */
  reste: number;
  fonds: number;
  sousTitreFonds?: string;
  onNaviguer?: (onglet: string) => void;
}) {
  const tauxMarge = ventes > 0 ? Math.round((benefice / ventes) * 100) : 0;
  const tauxReste = ventes > 0 ? Math.round((reste / ventes) * 100) : 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div
        className="group relative block overflow-hidden rounded-2xl p-5 shadow-sm transition-all"
        style={{ background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white/15 text-lg">
          🛍️
        </span>
        <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-indigo-100">
          Ventes
        </p>
        <p className="mt-0.5 text-[26px] font-bold leading-8 tracking-tight text-white">
          {formatMontant(ventes)}
        </p>
        <p className="mt-1.5 text-xs font-semibold text-lime-300">
          Bénéfice {formatMontant(benefice)} ({tauxMarge}%)
        </p>
      </div>

      <button
        type="button"
        onClick={() => onNaviguer?.('recouvrements')}
        className="group block rounded-2xl border border-black/[0.06] bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
          💰
        </span>
        {/* Ce qui appelle une action, c'est ce qui n'est pas rentré :
            l'encaissé est acquis, on n'y peut plus rien. */}
        <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
          À encaisser
        </p>
        <p className="mt-0.5 text-[26px] font-bold leading-8 tracking-tight text-neutral-900 dark:text-white">
          {formatMontant(reste)}
        </p>
        <p className="mt-1.5 text-xs font-medium text-neutral-400">
          Encaissé {formatMontant(encaisse)}
          {/* Ce taux est celui du reste, pas de l'encaissé. Collé derrière
              « Encaissé 0 FCFA », « 100 % des ventes » se lisait comme un
              encaissement total alors qu'il dit l'inverse. */}
          {ventes > 0 && tauxReste <= 200 ? (
            <span className={reste > 0 ? 'font-semibold text-red-500' : ''}>
              {' · '}{tauxReste}% non encaissé
            </span>
          ) : null}
        </p>
      </button>

      <button
        type="button"
        onClick={() => onNaviguer?.('fonds')}
        className="group block rounded-2xl border border-black/[0.06] bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
          🏦
        </span>
        <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
          Fond disponible
        </p>
        <p className={`mt-0.5 text-[26px] font-bold leading-8 tracking-tight ${
          fonds >= 0 ? 'text-neutral-900 dark:text-white' : 'text-red-500'}`}>
          {formatMontant(fonds)}
        </p>
        <p className="mt-1.5 text-xs font-semibold text-green-600 dark:text-green-400">
          {sousTitreFonds ?? 'En caisse'}
        </p>
      </button>
    </div>
  );
}
