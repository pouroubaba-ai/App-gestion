'use client';

/**
 * Les tuiles d'étape, lisibles au bureau comme dans la main.
 *
 * Ces tuiles ne sont pas un tableau de bord : on clique dessus pour choisir
 * l'étape qu'on regarde. C'est un sélecteur.
 *
 * En grille sur un écran large, elles se lisent d'un coup d'œil. Sur un
 * téléphone, deux colonnes : choisir une étape demande de les comparer, et
 * une rangée qui défile n'en montrait que deux et demie — les autres
 * n'existaient qu'au doigt, sans qu'on sache laquelle portait un compte.
 *
 * Les tuiles y sont plus courtes qu'au bureau : c'est leur hauteur, non le
 * nombre de rangées, qui décidait si la liste des dossiers restait visible.
 *
 * Le même balisage sert les deux : ce sont les classes qui changent, pas le
 * contenu. Le rendre deux fois le placerait deux fois dans la page — deux
 * fois lu à voix haute, deux fois trouvé par une recherche.
 */

import { ReactNode } from 'react';
import { LayoutGrid } from 'lucide-react';

export default function RangeeEtapes({
  children, grille, onToutVoir,
}: {
  children: ReactNode;
  /** La disposition en grille, à partir de `sm` : propre à chaque onglet,
      qui n'a ni le même nombre d'étapes ni la même largeur de tuile. */
  grille: string;
  /** Ouvrir le cycle entier. Absent quand la rangée le montre déjà. */
  onToutVoir?: () => void;
}) {
  /* Deux colonnes sur téléphone, et non plus une rangée qui défile.

     Le défilement montrait deux tuiles et demie : les autres n'existaient
     qu'au doigt, et rien ne disait laquelle portait un compte. On choisit
     une étape en comparant les étapes — ce qu'un balayage interdit.

     La hauteur que cette grille coûtait vient des tuiles, pas de la
     grille : compactées, sept étapes tiennent en quatre rangées courtes
     et la liste des dossiers reste à portée. */
  return (
    <div className={`grid grid-cols-2 gap-2.5 sm:gap-4 ${grille}`}>
      {children}

      {/* En dernière case de la grille, où l'œil arrive après avoir lu
          les étapes. */}
      {onToutVoir && (
        <button type="button" onClick={onToutVoir}
          className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-gray-300 p-3 text-center transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700 dark:hover:border-indigo-500 sm:hidden">
          <LayoutGrid size={18} className="text-gray-400" />
          <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Toutes les étapes
          </span>
        </button>
      )}
    </div>
  );
}
