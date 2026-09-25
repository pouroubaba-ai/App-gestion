'use client';
import { useState } from 'react';
import { formatMontant } from '@/lib/format';
import { X, TrendingUp, TrendingDown } from 'lucide-react';

/** Une ligne du reçu, réduite à ce qui décide de sa marge. */
export interface LigneMarge {
  cle: string;
  designation: string;
  varianteLibelle?: string | null;
  /** l'emballage vendu ; null pour l'unité de base */
  emballage?: string | null;
  quantiteDemandee: number;
  /** ce que coûte un emballage vendu */
  cout: number;
  /** ce qu'il rapporte */
  prix: number;
}

interface Props {
  lignes: LigneMarge[];
  onFermer: () => void;
  /** ce dont on lit la marge : un reçu au comptoir, un dossier ailleurs */
  titre?: string;
}

/**
 * Ce que le reçu en cours rapporte, et ce qu'il coûte.
 *
 * Les deux ne se compensent pas. Une ligne vendue sous son coût creuse
 * l'activité ; une autre vendue avec marge ne la comble pas — ce sont deux
 * faits distincts, et n'en montrer que la différence cacherait celui qui
 * coûte. D'où deux cartes, et une ligne qui n'apparaît que dans l'une.
 *
 * Le détail se déplie par carte : au comptoir on veut d'abord les deux
 * totaux, et seulement ensuite savoir quel produit les porte.
 */
export default function ModalMargeRecu({ lignes, onFermer, titre = 'Marge du reçu' }: Props) {
  const [vue, setVue] = useState<'benefice' | 'perte'>('benefice');

  const detail = lignes.map(l => ({
    ...l,
    /* La marge de la ligne entière : le prix d'un carton moins ce qu'il a
       coûté, multiplié par le nombre de cartons. */
    marge: (l.prix - l.cout) * l.quantiteDemandee,
  }));

  const gagnantes = detail.filter(d => d.marge > 0)
    .sort((a, b) => b.marge - a.marge);
  const perdantes = detail.filter(d => d.marge < 0)
    .sort((a, b) => a.marge - b.marge);

  const benefice = gagnantes.reduce((s, d) => s + d.marge, 0);
  const perte = perdantes.reduce((s, d) => s - d.marge, 0);

  const affichees = vue === 'benefice' ? gagnantes : perdantes;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-lg my-8 p-5">

        <div className="flex items-center justify-between gap-3 mb-4">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            {titre}
          </p>
          <button onClick={onFermer}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Les deux cartes servent d'onglets : l'indigo dit laquelle on lit. */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <button onClick={() => setVue('benefice')}
            className={`text-left p-4 rounded-2xl border transition-colors ${vue === 'benefice'
              ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
              : 'border-gray-100 dark:border-gray-800 hover:border-indigo-300'}`}>
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-500 dark:text-gray-400">
              <TrendingUp size={13} className="text-green-600 dark:text-green-400" />
              Bénéfice
            </p>
            <p className="mt-1 text-lg font-bold text-green-600 dark:text-green-400">
              {formatMontant(benefice)}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {gagnantes.length} produit{gagnantes.length > 1 ? 's' : ''}
            </p>
          </button>

          <button onClick={() => setVue('perte')}
            className={`text-left p-4 rounded-2xl border transition-colors ${vue === 'perte'
              ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
              : 'border-gray-100 dark:border-gray-800 hover:border-indigo-300'}`}>
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-500 dark:text-gray-400">
              <TrendingDown size={13} className="text-red-500" />
              Perte
            </p>
            <p className="mt-1 text-lg font-bold text-red-500">
              {formatMontant(perte)}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {perdantes.length} produit{perdantes.length > 1 ? 's' : ''}
            </p>
          </button>
        </div>

        {/* Le détail de la carte choisie. */}
        {affichees.length === 0 ? (
          <p className="py-8 text-center text-xs text-gray-400">
            {vue === 'benefice'
              ? 'Aucun produit ne dégage de marge.'
              : 'Aucun produit vendu sous son coût.'}
          </p>
        ) : (
          <div className="space-y-1.5 max-h-[45vh] overflow-y-auto">
            {affichees.map(d => (
              <div key={d.cle}
                className="p-2.5 rounded-xl border border-gray-100 dark:border-gray-800">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-bold leading-tight">
                    {d.designation}{d.varianteLibelle ? ` · ${d.varianteLibelle}` : ''}
                  </p>
                  <span className={`text-xs font-bold shrink-0 ${vue === 'benefice'
                    ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                    {formatMontant(Math.abs(d.marge))}
                  </span>
                </div>
                {/* D'où vient le chiffre : sans le détail, une marge se
                    conteste sans pouvoir se vérifier. */}
                <p className="text-xs text-gray-400 mt-1">
                  {d.quantiteDemandee} {(d.emballage ?? 'unité').toLowerCase()}
                  {d.quantiteDemandee > 1 ? 's' : ''} · achat {formatMontant(d.cout)} ·
                  vente {formatMontant(d.prix)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
