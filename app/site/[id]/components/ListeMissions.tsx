'use client';

/**
 * Les paiements confiés au porteur, tels qu'il les voit.
 *
 * Le tableau des échéances ne lui parle pas : il y lit ce qu'on doit
 * recouvrir, ce qui est convenu, ce qui n'est pas décidé — la gestion de
 * la maison. Lui a trois questions, et elles tiennent toutes dans l'état
 * de ses missions : qu'est-ce qui m'attend au tiroir, qu'est-ce que je
 * porte, qu'est-ce que j'ai remis.
 *
 * Une carte par mission, jamais un tableau : il travaille au téléphone, et
 * douze colonnes ne s'y lisent pas.
 */

import { formatMontant } from '@/lib/format';
import { ArrowRight, Wallet, Check, Clock } from 'lucide-react';
import type { Mission, EtatMission } from '@/lib/missions';

interface Props {
  /** Déjà restreintes au porteur et au mode porté. */
  missions: Mission[];
  /** Ouvre le détail : confirmer au tiroir, ou déclarer la remise. */
  onOuvrir?: (m: Mission) => void;
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Ce que l'état dit au porteur, et rien de plus. */
const ETATS: Partial<Record<EtatMission, {
  label: string; ton: string; Icone: React.ElementType;
}>> = {
  ordonnee: {
    label: 'À retirer',
    ton: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
    Icone: Clock,
  },
  confirmee: {
    label: 'Confirmé, à délivrer',
    ton: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
    Icone: Clock,
  },
  retiree: {
    label: 'En main',
    ton: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    Icone: Wallet,
  },
  soldee: {
    label: 'Remis',
    ton: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    Icone: Check,
  },
};

export default function ListeMissions({ missions, onOuvrir }: Props) {
  if (missions.length === 0) {
    return (
      <p className="py-10 text-center text-xs text-gray-400">
        Aucun paiement à porter.
      </p>
    );
  }

  /* Ce qui attend d'abord : on ouvre cet écran pour savoir quoi faire, non
     pour relire ce qui est fait. */
  const rang: Record<string, number> = {
    confirmee: 0, ordonnee: 1, retiree: 2, soldee: 3, annulee: 4,
  };
  const triees = [...missions].sort((a, b) =>
    (rang[a.etat] ?? 9) - (rang[b.etat] ?? 9)
    || (b.date + b.heure).localeCompare(a.date + a.heure));

  return (
    <div className="space-y-2">
      {triees.map(m => {
        const e = ETATS[m.etat];
        const enMain = Math.max(0, (m.montantRetire ?? 0) - (m.montantRemis ?? 0));
        /* Le montant qui compte dépend de où en est la mission : ce qu'on
           doit prendre, ce qu'on porte, ce qu'on a donné. */
        const montant = m.etat === 'soldee' ? (m.montantRemis ?? 0)
          : m.etat === 'retiree' ? enMain
          : m.montant;

        return (
          <button key={m.id} type="button" onClick={() => onOuvrir?.(m)}
            disabled={!onOuvrir}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-gray-100 p-3 text-left transition-colors enabled:active:bg-gray-50 dark:border-gray-800 dark:enabled:active:bg-gray-800/50">
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                {m.partenaireNom ?? '—'}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                {e && (
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${e.ton}`}>
                    <e.Icone size={10} className="shrink-0" />
                    {e.label}
                  </span>
                )}
                <span className="truncate text-[11px] text-gray-400">
                  {/* La date qui compte : celle du geste le plus récent. */}
                  {m.etat === 'soldee' ? `Remis le ${formatDate(m.remiseA)}`
                    : m.etat === 'retiree' ? `Retiré le ${formatDate(m.retireA)}`
                    : `Ordonné le ${formatDate(m.date)}`}
                </span>
              </span>
              {/* Ce qui a été rapporté : sans cette ligne, une mission
                  partiellement remise se lirait comme entièrement faite. */}
              {m.etat === 'soldee' && (m.montantRendu ?? 0) > 0 && (
                <span className="mt-1 block truncate text-[11px] text-blue-600 dark:text-blue-400">
                  {formatMontant(m.montantRendu ?? 0)} rapportés en caisse
                </span>
              )}
            </span>

            <span className="flex shrink-0 items-center gap-1.5">
              <span className={`text-[15px] font-bold ${
                m.etat === 'retiree' ? 'text-amber-600 dark:text-amber-500'
                  : m.etat === 'soldee' ? 'text-green-600'
                  : 'text-gray-900 dark:text-gray-100'}`}>
                {formatMontant(montant)}
              </span>
              {onOuvrir && <ArrowRight size={14} className="text-gray-300" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
