/**
 * D'où l'on vient, et comment y revenir.
 *
 * Un dossier — achat, vente, transfert — s'ouvre depuis plusieurs écrans :
 * l'onglet d'un site, la vue d'ensemble, l'historique de l'un ou de l'autre.
 * Le fermer doit rendre l'écran qu'on a quitté, dans l'état où on l'a
 * laissé : la bonne carte, le bon sens, la bonne vue. Revenir sur un écran
 * par défaut fait perdre le fil du travail, et oblige à refaire le chemin.
 *
 * Le lien qui ouvre porte donc `de`, et les paramètres de l'écran quitté.
 */

/** Les origines possibles, telles qu'elles s'écrivent dans `de`. */
export type Origine =
  | 'historique'
  | 'ensemble'
  | 'ensemble-historique'
  | null;

/** Vrai quand on vient de la vue d'ensemble, par l'onglet ou l'historique. */
export function estEnsemble(params: URLSearchParams | {
  get(cle: string): string | null;
}): boolean {
  const de = params.get('de');
  return de === 'ensemble' || de === 'ensemble-historique';
}

/**
 * La query pour revenir à l'historique dans l'état quitté.
 *
 * Le sens et la vue ne se devinent pas : entrées et sorties sont deux
 * écrans, et on lit les documents ou les mouvements, pas les deux. Sans
 * eux, fermer un document d'entrée renvoyait sur les sorties.
 */
export function retourHistorique(params: URLSearchParams | {
  get(cle: string): string | null;
}): string {
  const q = new URLSearchParams({ onglet: 'historique' });
  const sens = params.get('sens');
  const vue = params.get('vueHisto');
  if (sens) q.set('sens', sens);
  if (vue) q.set('vueHisto', vue);
  return `?${q.toString()}`;
}

/**
 * Les sous-onglets a emporter dans un document, puis a rendre au retour.
 *
 * Un ecran retient dans l'adresse ce qu'on y regardait — le mode de
 * lecture, l'etape, le sens. Ouvrir un dossier quittait cette adresse
 * pour celle du document, et la refermer reconstruisait un `?onglet=`
 * nu : on revenait sur la vue par defaut. Le travail etait perdu sans
 * que rien ne le dise — on avait ouvert un dossier confirme, on
 * revenait sur les dossiers en cours.
 *
 * `retourHistorique` resolvait deja le meme probleme pour l'historique,
 * avec ses propres cles. Celle-ci sert les autres onglets, qui portent
 * tous les memes.
 */
const CLES_VUE = ['mode', 'etape', 'sens', 'carte', 'axe', 'rubrique', 'groupe'];

/** Ce qu'il faut coller au lien d'un document pour qu'il sache d'ou il vient. */
export function marqueVue(params: URLSearchParams | {
  get(cle: string): string | null;
}): string {
  const q = new URLSearchParams();
  for (const cle of CLES_VUE) {
    const v = params.get(cle);
    if (v) q.set(cle, v);
  }
  const suite = q.toString();
  return suite ? `&${suite}` : '';
}

/** La query pour revenir a un onglet dans l'etat quitte. */
export function retourOnglet(onglet: string, params: URLSearchParams | {
  get(cle: string): string | null;
}): string {
  const q = new URLSearchParams({ onglet });
  for (const cle of CLES_VUE) {
    const v = params.get(cle);
    if (v) q.set(cle, v);
  }
  return `?${q.toString()}`;
}

/**
 * Le suffixe qui dit d'ou l'on vient, a coller sur un lien de creation.
 *
 * Creer un dossier depuis la vue d'ensemble passe par un ecran de site —
 * c'est un site qui recoit la marchandise. Sans cette marque, l'origine se
 * perdait a ce saut : on ouvrait depuis l'ensemble, et le dossier cree s'y
 * refermait dans le site, sur un ecran qu'on n'avait pas demande.
 */
export function marqueOrigine(ensemble: boolean, premier = true): string {
  if (!ensemble) return '';
  return `${premier ? '?' : '&'}de=ensemble`;
}

/**
 * La racine a laquelle un dossier se referme.
 *
 * Le meme dossier vit dans un site et dans la vue d'ensemble : c'est la
 * porte par laquelle on est entre qui decide, jamais le dossier lui-meme.
 */
export function racineRetour(ensemble: boolean, siteId: string): string {
  return ensemble ? '/ensemble' : `/site/${siteId}`;
}
