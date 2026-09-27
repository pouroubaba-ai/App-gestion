'use client';
import { formatMontant } from '@/lib/format';

/**
 * Les trois indicateurs de tête, repris du dashboard financier : la carte
 * Ventes en dégradé indigo, les deux autres en blanc. Les chiffres viennent
 * des données du site au lieu d'être écrits en dur.
 */
export default function VentesCard({
  ventes, benefice, encaisse, reste, retours = 0, fonds, sousTitreFonds,
  ventesSansMarge = 0, nbSansMarge = 0,
  onNaviguer,
}: {
  ventes: number;
  benefice: number;
  /**
   * Ce qui a été vendu sans qu'on sache ce que ça avait coûté.
   *
   * Un stock initial entre en quantité sans valeur : tant qu'aucun achat
   * n'a posé le coût, la marge de ces ventes est inconnue. Elles
   * comptent dans le chiffre d'affaires — l'argent est entré — et le
   * taux se rapporte au reste, qui est ce qu'on a mesuré.
   */
  ventesSansMarge?: number;
  nbSansMarge?: number;
  encaisse: number;
  /**
   * Ce que les clients ont rendu sur la période.
   *
   * Il ne se retranche pas de l'encaissé : l'argent est bien rentré, et
   * ce qui repart le fait par la caisse ou par la dette, chacune tenant
   * déjà son propre compte. On le montre à côté parce qu'il explique un
   * reste plus petit que prévu — sans lui, la vente et ce qui rentre ne
   * se recoupent plus et l'écart n'a pas de nom.
   */
  retours?: number;
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
  /* Le taux se rapporte aux ventes mesurées : diviser par un total qui
     comprend des ventes sans marge connue écraserait le pourcentage, et
     rien à l'écran ne dirait pourquoi. */
  const ventesMesurees = Math.max(0, ventes - ventesSansMarge);
  const tauxMarge = ventesMesurees > 0
    ? Math.round((benefice / ventesMesurees) * 100) : 0;
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
        {/* Ce que le bénéfice ne couvre pas. Ne s'affiche qu'en existant :
            montré à zéro, il passerait inaperçu le jour où il compte. */}
        {nbSansMarge > 0 && (
          <p className="mt-0.5 text-[11px] text-indigo-200">
            dont {formatMontant(ventesSansMarge)} sans coût connu
            {' '}({nbSansMarge} vente{nbSansMarge > 1 ? 's' : ''})
          </p>
        )}
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
          {/* Le retour ne paraît que s'il existe : un « Retours 0 FCFA »
              permanent ferait lire un incident là où il n'y a rien. */}
          {retours > 0 ? (
            <span className="font-semibold text-red-500">
              {' · '}Retours {formatMontant(retours)}
            </span>
          ) : null}
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
