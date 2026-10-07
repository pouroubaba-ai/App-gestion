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

/**
 * Revenir, sans refaire le chemin.
 *
 * `router.push` empile une nouvelle entrée et refait le rendu complet
 * de l'écran visé : le cycle de vente relit ses ventes, ses
 * préparations et ses soldes, et l'on regarde tourner un chargement
 * d'une seconde pour un écran qu'on vient de quitter et qui n'a pas
 * bougé. Pour fermer un formulaire, c'est une seconde de trop — le
 * geste est banal, on ferme et l'on passe à autre chose.
 *
 * L'écran d'où l'on vient est pourtant encore là, dans l'historique :
 * `back()` le rend tel quel, sans relire la base. On ne s'en sert que
 * si l'on y est bien arrivé par une navigation de l'app — ouvrir le
 * formulaire directement par son adresse ne laisse rien derrière, et
 * `back()` sortirait alors du site.
 *
 * `history.length` ne vaut rien ici : il compte les entrées de tout
 * l'onglet, y compris celles d'avant l'app.
 *
 * On a d'abord compté nos propres pas, dans un compteur à part : une
 * ouverture l'incrémentait, une fermeture le décrémentait. Mais un
 * compteur tenu à côté de l'historique finit toujours par se décaler
 * de lui — la flèche du navigateur ne le prévient pas, un dossier
 * ouvert depuis un autre dossier le fait monter de deux. Et un
 * compteur décalé fait `back()` quand il ne faut pas : on sort de
 * l'app, une fois sur vingt, sans pouvoir le reproduire.
 *
 * La réponse est dans l'adresse de l'écran ouvert, pas à côté. Le lien
 * qui l'ouvre y écrit `ret=1` ; l'adresse voyage avec son entrée
 * d'historique, le navigateur la garde, elle survit au rafraîchissement
 * et ne peut pas se décaler — il n'y a rien à compter. L'écran lit sa
 * propre adresse et sait s'il a été ouvert depuis l'app ou atteint
 * directement.
 *
 * C'est le procédé déjà employé par `de=ensemble` : l'écran porte son
 * origine, plutôt qu'un état tenu ailleurs.
 */
const MARQUE_RETOUR = 'ret';

/** Vrai quand cet écran a été ouvert depuis l'app, et non par son adresse. */
function ouvertDepuisLApp(): boolean {
  try {
    return new URLSearchParams(window.location.search).get(MARQUE_RETOUR) === '1';
  } catch { return false; }
}

/**
 * Marque un lien d'ouverture : on pourra en revenir par l'historique.
 *
 * À poser sur les liens qui ouvrent une fiche depuis une liste. Le
 * `?` ou le `&` se décide ici, et non chez l'appelant : c'est de
 * laisser ce choix aux appelants que naissaient les adresses mal
 * formées, quand un morceau rendait une chaîne vide et que le suivant
 * commençait par `&`.
 */
export function ouvrable(url: string): string {
  if (url.includes(`${MARQUE_RETOUR}=1`)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${MARQUE_RETOUR}=1`;
}

/**
 * Ferme un écran : par l'historique si l'on peut, par l'adresse sinon.
 *
 * `secours` sert quand il n'y a rien derrière — une adresse ouverte
 * dans un onglet neuf, un lien partagé, un rechargement.
 */
export function fermerEcran(
  router: { push: (url: string) => void; back: () => void },
  secours: string,
): void {
  if (ouvertDepuisLApp()) { router.back(); return; }
  router.push(secours);
}

/**
 * Le lien qui ouvre un formulaire de création, origine et vue comprises.
 *
 * `marqueOrigine` et `marqueVue` se collaient à la main, et chacune
 * devait deviner si elle ouvrait la query avec `?` ou la poursuivait
 * avec `&`. Selon la page, l'une rendait `''` et l'autre commençait
 * alors par `&` — une adresse que le navigateur lit de travers, et des
 * paramètres perdus en silence.
 *
 * Ici la query se construit, elle ne se concatène pas : l'ordre des
 * morceaux ne décide plus de rien.
 */
export function lienCreation(params: {
  /** le chemin, sans query */
  base: string;
  /** vrai quand on regarde depuis `/ensemble` */
  ensemble: boolean;
  /** l'adresse de l'écran que l'on quitte */
  vue: URLSearchParams | { get(cle: string): string | null };
  /** ce que le formulaire demande en propre, comme `type=devis` */
  extra?: Record<string, string>;
}): string {
  const q = new URLSearchParams();
  for (const [cle, v] of Object.entries(params.extra ?? {})) q.set(cle, v);
  if (params.ensemble) q.set('de', 'ensemble');
  /* L'écran saura qu'il a été ouvert depuis l'app, et non atteint par
     son adresse : à la fermeture, `fermerEcran` rendra l'écran gardé
     par le navigateur au lieu d'en reconstruire un. */
  q.set(MARQUE_RETOUR, '1');
  for (const cle of CLES_VUE) {
    const v = params.vue.get(cle);
    if (v) q.set(cle, v);
  }
  const suite = q.toString();
  return suite ? `${params.base}?${suite}` : params.base;
}
