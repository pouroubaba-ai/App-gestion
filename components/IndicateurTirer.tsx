'use client';
import { Loader2, ArrowDown } from 'lucide-react';
import type { TirerRecharger } from '@/lib/tirer-recharger';

/**
 * Ce que l'on voit quand on tire l'écran vers le bas.
 *
 * Tirer sans retour visible ne dit pas si le geste a pris : c'est ce qui
 * se passait sur l'app installée, où l'écran suivait le doigt sans rien
 * relire. La flèche descend avec le doigt, pivote quand le seuil est
 * franchi — relâcher maintenant rechargera — puis cède la place au
 * rond qui tourne pendant la relecture.
 *
 * Au repos, rien : pas de place prise sur un écran de téléphone.
 */
export default function IndicateurTirer({ etat }: { etat: TirerRecharger }) {
  const { tire, pret, recharge } = etat;
  if (tire === 0 && !recharge) return null;

  /* Pendant la relecture, l'indicateur se tient à hauteur fixe : le doigt
     est parti, mais le travail continue. */
  const hauteur = recharge ? 44 : tire;

  return (
    <div
      className="flex items-end justify-center overflow-hidden"
      style={{ height: hauteur }}
    >
      <div className="flex h-11 items-center justify-center">
        {recharge ? (
          <Loader2 className="h-5 w-5 animate-spin text-indigo-600 dark:text-indigo-400" />
        ) : (
          <ArrowDown
            className={`h-5 w-5 transition-transform duration-150 ${
              pret
                ? 'rotate-180 text-indigo-600 dark:text-indigo-400'
                : 'text-neutral-400 dark:text-neutral-500'
            }`}
            /* Avant le seuil, la flèche s'affirme à mesure qu'on tire :
               elle dit la distance qui reste autant que le geste en cours. */
            style={pret ? undefined : { opacity: 0.35 + (tire / 70) * 0.65 }}
          />
        )}
      </div>
    </div>
  );
}
