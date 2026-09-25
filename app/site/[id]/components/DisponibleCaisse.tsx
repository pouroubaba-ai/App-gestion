'use client';

/**
 * Ce que la caisse peut encore laisser sortir, et pourquoi.
 *
 * Le tiroir contient 50 000 et refuse une sortie de 40 000 : sans
 * explication, cela se lit comme une panne. C'est pourtant exact — 40 000
 * sont déjà déclarés et attendent l'autorisation du caissier. Ils sont
 * encore là, mais ils ne sont plus disponibles.
 *
 * Le calcul se montre donc en entier : ce qu'il y a, ce qui est promis, ce
 * qui reste. Un chiffre seul se conteste ; une soustraction se vérifie.
 *
 * Quand rien n'est engagé, le bloc se réduit à une ligne — il n'y a alors
 * rien à expliquer, et trois lignes pour dire un seul chiffre encombrent
 * l'écran de celui qui saisit.
 */

import { formatMontant } from '@/lib/format';

interface Props {
  /** Ce que le registre compte : le contenu réel du tiroir. */
  solde: number;
  /** Ce qui est déclaré et pas encore sorti. */
  engage: number;
  /** Ce qui reste : `solde − engage`. */
  disponible: number;
  className?: string;
}

export default function DisponibleCaisse({
  solde, engage, disponible, className = '',
}: Props) {
  /* Rien de promis : le solde est le disponible, et le dire deux fois ne
     l'éclaire pas. */
  if (engage <= 0) {
    return (
      <p className={`flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 text-xs dark:bg-gray-800/60 ${className}`}>
        <span className="font-bold uppercase tracking-wide text-gray-400">En caisse</span>
        <span className={`font-bold ${
          solde > 0 ? 'text-gray-900 dark:text-gray-100' : 'text-red-500'}`}>
          {formatMontant(solde)}
        </span>
      </p>
    );
  }

  return (
    <div className={`rounded-xl bg-amber-50 px-3 py-2 dark:bg-amber-900/10 ${className}`}>
      <p className="flex items-center justify-between text-[11px] text-amber-700 dark:text-amber-400">
        <span>En caisse</span>
        <span className="font-medium">{formatMontant(solde)}</span>
      </p>
      <p className="flex items-center justify-between text-[11px] text-amber-700 dark:text-amber-400">
        <span>Sorties en attente</span>
        <span className="font-medium">−{formatMontant(engage)}</span>
      </p>
      <p className="mt-1 flex items-center justify-between border-t border-amber-200 pt-1 text-xs font-bold text-amber-800 dark:border-amber-800/40 dark:text-amber-300">
        <span className="uppercase tracking-wide">Disponible</span>
        <span className={disponible > 0 ? '' : 'text-red-500'}>
          {formatMontant(disponible)}
        </span>
      </p>
    </div>
  );
}
