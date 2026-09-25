'use client';

/**
 * Une liste de dossiers, lisible au bureau comme dans la main.
 *
 * Un tableau dit bien les choses tant qu'il a la largeur pour : les colonnes
 * s'alignent, l'œil compare une ligne à l'autre. Sur un téléphone il n'a plus
 * cette largeur — il se met à défiler de côté, et les dernières colonnes
 * sortent de l'écran. C'est justement là que tombent l'état et l'écart, ce
 * qu'on vient regarder.
 *
 * Plutôt que d'enlever des colonnes au téléphone — ce serait priver celui qui
 * travaille dehors de ce dont il a besoin — la même ligne se dit deux fois :
 * en rangée au-dessus de `sm`, en carte en dessous. Rien ne disparaît, la
 * disposition seule change.
 *
 * Le responsable des commandes travaille au marché et au dépôt : ses cibles
 * sont larges, ses cartes espacées, et il ne défile jamais de côté.
 */

import { ReactNode, isValidElement } from 'react';

/**
 * Cette cellule dit-elle quelque chose ?
 *
 * Une colonne absente s'écrit « — » : c'est juste dans un tableau, où la
 * cellule existe de toute façon et où la laisser vide décalerait la lecture
 * d'une ligne à l'autre. Sur une carte, ce tiret occupe une place entière
 * pour dire qu'il n'y a rien — et trois tirets sur cinq informations font
 * une carte qui n'apprend rien mais remplit l'écran.
 *
 * On descend dans le JSX rendu parce que la valeur y est souvent enveloppée
 * dans un `<span>` porteur de couleur : ce qui compte est le texte au bout,
 * pas l'emballage.
 */
function aQuelqueChose(n: ReactNode): boolean {
  if (n === null || n === undefined || n === false || n === true) return false;
  if (typeof n === 'number') return true;
  if (typeof n === 'string') {
    const t = n.trim();
    return t !== '' && t !== '—' && t !== '-';
  }
  if (Array.isArray(n)) return n.some(aQuelqueChose);
  if (isValidElement(n)) {
    return aQuelqueChose((n.props as { children?: ReactNode }).children);
  }
  return true;
}

/** Une colonne : son titre, et ce qu'elle affiche d'un dossier. */
export interface Colonne<T> {
  /** Ce qui l'identifie — sert de clé et de repère de tri. */
  cle: string;
  label: string;
  /** Le contenu de la cellule. */
  rendu: (d: T) => ReactNode;
  /**
   * Le rang de l'information dans la carte :
   * `titre`    — la référence, en tête ;
   * `marque`   — l'état, en pastille à côté du titre ;
   * `corps`    — le gros du dossier, en paires libellé/valeur ;
   * `pied`     — ce qui se lit en dernier, discret.
   * Une colonne sans rang reste dans le tableau et n'entre pas dans la carte :
   * elle se déduit d'une autre, ou ne vaut pas la place sur un téléphone.
   */
  rang?: 'titre' | 'marque' | 'corps' | 'pied';
  /** En-tête cliquable, quand la colonne se trie. */
  enTete?: ReactNode;
}

interface Props<T> {
  dossiers: T[];
  colonnes: Colonne<T>[];
  /** Ce qui distingue un dossier d'un autre. */
  cleDe: (d: T) => string;
  /** Ouvrir le dossier. */
  onOuvrir?: (d: T) => void;
  /** Le compte, au-dessus : « 3 dossiers ». */
  compte?: ReactNode;
}

export default function ListeDossiers<T>({
  dossiers, colonnes, cleDe, onOuvrir, compte,
}: Props<T>) {

  const titre = colonnes.find(c => c.rang === 'titre');
  const marque = colonnes.find(c => c.rang === 'marque');
  const corps = colonnes.filter(c => c.rang === 'corps');
  const pied = colonnes.filter(c => c.rang === 'pied');

  return (
    <div>
      {compte && (
        <p className="text-sm font-medium text-gray-500 mb-2">{compte}</p>
      )}

      {/* ————— Tablette et bureau : le tableau, inchangé ————— */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="bg-indigo-600 text-white">
              {colonnes.map(c => (
                <th key={c.cle} className="text-center px-3 py-2.5 font-medium">
                  {c.enTete ?? c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {dossiers.map(d => (
              <tr key={cleDe(d)}
                onClick={onOuvrir ? () => onOuvrir(d) : undefined}
                className={`transition-colors ${onOuvrir
                  ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50' : ''}`}>
                {colonnes.map(c => (
                  <td key={c.cle} className="px-3 py-2.5 text-center">
                    {c.rendu(d)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ————— Téléphone : une carte par dossier —————
          La carte entière est la cible : au marché, on ouvre un dossier au
          pouce, sans viser un lien de deux millimètres. */}
      <div className="space-y-2.5 sm:hidden">
        {dossiers.map(d => (
          <div key={cleDe(d)}
            onClick={onOuvrir ? () => onOuvrir(d) : undefined}
            role={onOuvrir ? 'button' : undefined}
            tabIndex={onOuvrir ? 0 : undefined}
            onKeyDown={onOuvrir ? e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOuvrir(d); }
            } : undefined}
            className={`rounded-2xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 ${
              onOuvrir ? 'cursor-pointer active:bg-gray-50 dark:active:bg-gray-800/50' : ''}`}>

            {/* La référence et l'état se lisent ensemble : ce dossier-ci, et
                où il en est. C'est la question qu'on pose en premier. */}
            {(titre || marque) && (
              <div className="flex items-start justify-between gap-3">
                {titre && (
                  <p className="text-[15px] font-bold text-gray-900 dark:text-gray-100">
                    {titre.rendu(d)}
                  </p>
                )}
                {marque && <div className="shrink-0">{marque.rendu(d)}</div>}
              </div>
            )}

            {/* Le corps se lit comme une phrase, pas comme un formulaire :
                le libellé précède sa valeur sur la même ligne au lieu de la
                surmonter. Un libellé au-dessus doublait la hauteur de
                chaque information — onze lignes de texte pour cinq faits.

                Ce qui est vide ne s'écrit pas. « Livraison — » occupait
                autant de place qu'une vraie date pour dire qu'il n'y en a
                pas ; l'absence se remarque mieux quand elle ne s'affiche
                pas du tout. */}
            {corps.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {corps.filter(c => aQuelqueChose(c.rendu(d))).map(c => (
                  <span key={c.cle} className="flex items-baseline gap-1.5 text-[13px]">
                    <span className="text-gray-400">{c.label}</span>
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {c.rendu(d)}
                    </span>
                  </span>
                ))}
              </div>
            )}

            {pied.some(c => aQuelqueChose(c.rendu(d))) && (
              <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-gray-100 pt-2 dark:border-gray-800">
                {pied.filter(c => aQuelqueChose(c.rendu(d))).map(c => (
                  <span key={c.cle} className="flex items-baseline gap-1.5 text-xs">
                    <span className="text-gray-400">{c.label}</span>
                    <span className="text-gray-900 dark:text-gray-100">{c.rendu(d)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
