'use client';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Ce qu'un dossier est, repliable sur telephone.
 *
 * Toutes les fiches ouvrent sur le meme bloc : qui, d'ou, combien de
 * lignes, et les dates de chaque etape franchie. Sur un ecran de
 * telephone cela fait trois rangees de cases avant la premiere
 * marchandise — or on ne vient pas ici relire d'ou vient le dossier, on
 * le sait, on vient compter ce qu'il porte. Ce bloc se lit une fois a
 * l'ouverture, et jamais plus ; il ne doit pas repousser chaque jour ce
 * pour quoi on ouvre l'ecran.
 *
 * Replie, il garde ce qui identifie le dossier d'un coup d'oeil : le
 * nom — client, fournisseur, trajet — et le nombre de lignes. Au bureau
 * la place ne manque pas : le bloc y reste entier, et le bouton n'y
 * existe pas.
 *
 * Il vit a part parce qu'il sert quatre fiches — achat, transfert,
 * vente, importation. Recopie quatre fois, il aurait fini par se replier
 * de quatre facons.
 */
export default function BlocIdentite({
  nom, lignes, children, className = '',
}: {
  /** ce qui identifie le dossier : un client, un fournisseur, un trajet */
  nom: string;
  /** combien de lignes de marchandise il porte */
  lignes: number;
  /** le bloc entier, celui qu'on deplie */
  children: React.ReactNode;
  className?: string;
}) {
  const [ouvert, setOuvert] = useState(false);

  return (
    <div className={`rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900 ${className}`}>
      {/* Le resume, sur telephone seulement : il ouvre et ferme le
          reste. Au bureau le bloc est deja entier, et un bouton pour
          replier ce qui tient sans gener serait un geste de plus pour
          rien. */}
      <button type="button" onClick={() => setOuvert(o => !o)}
        className="-m-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-xl p-1 text-left sm:hidden">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-gray-900 dark:text-gray-100">
            {nom}
          </span>
          <span className="block text-[11px] font-medium text-gray-400">
            {lignes} ligne{lignes > 1 ? 's' : ''}
          </span>
        </span>
        <ChevronDown size={16}
          className={`shrink-0 text-gray-400 transition-transform ${
            ouvert ? 'rotate-180' : ''}`} />
      </button>

      <div className={ouvert ? 'mt-4 sm:mt-0' : 'hidden sm:block'}>
        {children}
      </div>
    </div>
  );
}
