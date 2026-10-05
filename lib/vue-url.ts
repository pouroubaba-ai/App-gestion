/**
 * Une vue qui se souvient d'elle-même dans l'adresse.
 *
 * Les onglets d'un écran vivaient en mémoire seule. Cela se voyait dès
 * qu'on quittait la page : actualiser ramenait sur l'onglet par défaut,
 * revenir d'une fiche ouverte depuis « Sorties » rouvrait « Fonds », et
 * un lien partagé n'emportait pas ce qu'on regardait. Le travail était
 * perdu sans que rien ne le dise — on croyait voir ce qu'on avait
 * choisi, et on voyait autre chose.
 *
 * Le motif était déjà écrit deux fois à la main, dans l'inventaire et
 * dans le contexte des sites. Il vit ici pour que les autres écrans
 * n'aient pas à le redécouvrir, chacun avec ses propres oublis.
 *
 * Deux principes, repris de ces deux écrans :
 *
 * L'état mène le rendu, l'adresse le conserve. `replaceState` ne
 * prévient pas React : sans état local, le clic changerait l'URL sans
 * redessiner l'écran.
 *
 * `replaceState` plutôt que le routeur. Changer d'onglet n'est pas une
 * navigation : ni rechargement, ni une entrée d'historique par clic —
 * qui ferait du bouton Retour un bouton « onglet précédent », et
 * obligerait à l'appuyer dix fois pour sortir d'une page parcourue.
 */
'use client';
import { useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Un onglet retenu dans l'adresse.
 *
 * `cle` est le paramètre d'URL, `defaut` la vue ordinaire, `valeurs` ce
 * qui est acceptable. Une valeur hors liste est ignorée : l'adresse se
 * modifie à la main, et un onglet inventé laisserait l'écran vide.
 *
 * La vue par défaut ne s'écrit pas dans l'adresse. Elle n'apprend rien
 * à qui la lit, et l'y laisser encombrerait l'URL d'un paramètre qui ne
 * dit rien.
 */
export function useVueUrl<T extends string>(
  cle: string, defaut: T, valeurs: readonly T[],
): [T, (v: T) => void] {
  const params = useSearchParams();
  const lu = params.get(cle) as T | null;
  const [vue, setVueEtat] = useState<T>(
    lu && valeurs.includes(lu) ? lu : defaut);

  const setVue = useCallback((v: T) => {
    setVueEtat(v);
    /* On relit l'adresse courante plutôt que les `searchParams` du
       rendu : deux onglets changés de suite écriraient sinon chacun
       par-dessus l'autre, le second ne voyant pas le premier. */
    const q = new URLSearchParams(window.location.search);
    if (v === defaut) q.delete(cle);
    else q.set(cle, v);
    const suite = q.toString();
    window.history.replaceState(null, '',
      suite ? `${window.location.pathname}?${suite}` : window.location.pathname);
  }, [cle, defaut]);

  return [vue, setVue];
}
