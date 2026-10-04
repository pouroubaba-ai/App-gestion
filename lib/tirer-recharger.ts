import { useEffect, useRef, useState } from 'react';

/**
 * Tirer vers le bas pour relire l'écran.
 *
 * Installée sur l'écran d'accueil du téléphone, l'app s'ouvre sans la
 * barre d'adresse du navigateur : plus de bouton de rechargement, et pas
 * non plus le geste que Chrome offre d'ordinaire. On tirait l'écran, il
 * suivait le doigt, et rien ne se relisait — il fallait fermer l'app et
 * la rouvrir pour voir un solde à jour.
 *
 * Le geste rendu ici est celui que tout le monde connaît, et c'est son
 * seul intérêt : personne n'a à l'apprendre. Il appartient à celui qui
 * s'en sert — il tire quand il doute, pas quand l'app le décide.
 *
 * Deux conditions pour qu'il se déclenche, et elles comptent toutes les
 * deux : le contenu doit déjà être en haut, sinon tirer veut dire
 * remonter la liste ; et le doigt doit descendre franchement, sinon
 * chaque frôlement rechargerait.
 *
 * Rien n'est posé sur l'écran tant qu'on ne tire pas. Un bouton
 * permanent mangerait de la place sur un téléphone, et ferait porter à
 * l'utilisateur un défaut qui n'est pas le sien.
 */

/** À partir de quelle distance, en pixels, le geste vaut un rechargement. */
const DECLENCHE = 70;

/** Au-delà, le doigt tire dans le vide : l'indicateur ne descend plus. */
const MAX = 110;

export interface TirerRecharger {
  /** à poser sur l'élément qui défile */
  gestes: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
  /** distance tirée, en pixels : 0 quand on ne tire pas */
  tire: number;
  /** le seuil est franchi : relâcher rechargera */
  pret: boolean;
  /** la relecture est en cours */
  recharge: boolean;
}

/**
 * @param relire ce qu'il faut refaire — le chargement de l'écran
 * @param actif  à faux, le geste ne fait rien (écran en cours de chargement)
 */
export function useTirerRecharger(
  relire: () => void | Promise<void>, actif = true,
): TirerRecharger {
  const [tire, setTire] = useState(0);
  const [recharge, setRecharge] = useState(false);
  /* Où le doigt a touché, et si ce toucher-là compte. Un `ref` plutôt
     qu'un état : ces valeurs changent à chaque pixel parcouru et ne
     doivent pas provoquer de rendu. */
  const depart = useRef<number | null>(null);
  /* La relecture la plus récente, sans que le geste dépende d'elle :
     autrement chaque rendu du parent réinstallerait les écouteurs. */
  const aRelire = useRef(relire);
  aRelire.current = relire;

  /* Pendant qu'on tire, le navigateur ne doit pas emporter la page :
     sur Chrome mobile, `overscroll-behavior` suffit à l'en empêcher, et
     c'est lui qui laisse le geste nous revenir. */
  useEffect(() => {
    if (tire === 0) return;
    const avant = document.body.style.overscrollBehaviorY;
    document.body.style.overscrollBehaviorY = 'contain';
    return () => { document.body.style.overscrollBehaviorY = avant; };
  }, [tire]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (!actif || recharge) return;
    /* Seul un contenu déjà en haut peut être tiré : plus bas, le même
       geste veut dire « remonte la liste ». */
    const haut = window.scrollY <= 0
      && (e.currentTarget as HTMLElement).scrollTop <= 0;
    depart.current = haut ? e.touches[0].clientY : null;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (depart.current === null) return;
    const delta = e.touches[0].clientY - depart.current;
    /* Un doigt qui remonte abandonne le geste. */
    if (delta <= 0) { setTire(0); return; }
    /* Au-delà du maximum, la résistance : le doigt continue, l'écran non. */
    setTire(Math.min(delta, MAX));
  };

  const onTouchEnd = () => {
    const assez = tire >= DECLENCHE;
    depart.current = null;
    setTire(0);
    if (!assez || recharge) return;
    setRecharge(true);
    /* Le temps affiché n'est pas celui de la lecture : elle peut revenir
       du cache en quelques millisecondes, et un indicateur qui clignote
       laisse croire que rien ne s'est passé. On tient un court instant,
       le temps que le geste soit vu. */
    void Promise.all([
      Promise.resolve(aRelire.current()),
      new Promise(r => setTimeout(r, 400)),
    ]).finally(() => setRecharge(false));
  };

  return {
    gestes: { onTouchStart, onTouchMove, onTouchEnd },
    tire,
    pret: tire >= DECLENCHE,
    recharge,
  };
}
