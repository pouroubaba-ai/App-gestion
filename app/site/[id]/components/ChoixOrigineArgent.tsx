'use client';
import { peutDisposerDuCapital, type RoleSite } from '@/lib/roles';

/**
 * D'où sort l'argent qui règle un fournisseur.
 *
 * La caisse du site, ou la main du propriétaire — un virement, un
 * retrait déjà fait, de l'argent qui n'a jamais vu le tiroir.
 *
 * Sans ce choix, on s'en tirait par un apport : le propriétaire
 * remettait d'abord l'argent en caisse, puis la caisse payait. Deux
 * écritures pour un seul geste, et un tiroir qui gonflait d'un argent
 * qui n'y est jamais entré — le solde affiché ne correspondait plus à
 * ce qu'on aurait trouvé en l'ouvrant.
 *
 * Réservé à qui dispose du capital, c'est-à-dire au propriétaire :
 * payer de sa poche engage son argent, et un gérant n'a pas à
 * déclarer une sortie qu'il ne fait pas. Pour les autres le composant
 * ne rend rien, et leur règlement passe par la caisse comme avant.
 *
 * Il vit à part parce qu'il sert quatre écrans — la fiche d'un achat,
 * celle d'une importation, le versement global d'un partenaire et
 * celui d'une échéance. Recopié quatre fois, il aurait fini par dire
 * quatre choses légèrement différentes.
 */
export default function ChoixOrigineArgent({
  role, valeur, onChange, className = '',
}: {
  /** le rôle sur le site ; `null` = propriétaire */
  role: RoleSite | null;
  valeur: 'caisse' | 'admin';
  onChange: (v: 'caisse' | 'admin') => void;
  className?: string;
}) {
  if (!peutDisposerDuCapital(role)) return null;

  return (
    <div className={className}>
      <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
        D’où sort l’argent
      </label>
      <div className="grid grid-cols-2 gap-2">
        {([
          { v: 'caisse' as const, titre: 'Caisse du site',
            aide: 'Le tiroir de la boutique' },
          { v: 'admin' as const, titre: 'Hors caisse',
            aide: 'Banque, ou de votre main' },
        ]).map(o => (
          <button key={o.v} type="button" onClick={() => onChange(o.v)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              valeur === o.v
                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'}`}>
            <span className={`block text-xs font-bold ${
              valeur === o.v
                ? 'text-indigo-700 dark:text-indigo-300'
                : 'text-gray-700 dark:text-gray-300'}`}>
              {o.titre}
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-gray-400">
              {o.aide}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
