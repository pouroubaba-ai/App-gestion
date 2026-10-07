import { useEffect, useState } from 'react';

/**
 * Garder une saisie en cours, le temps qu'on la termine.
 *
 * Préparer un transfert de vingt lignes prend du temps : on cherche un
 * produit, on vérifie un prix ailleurs, on revient. Entre-temps la page
 * se recharge — le réseau tombe, on touche la flèche de retour, le
 * navigateur se rafraîchit tout seul — et tout ce qui était saisi
 * disparaît. Ce n'est pas une perte de données au sens du registre :
 * rien n'était encore écrit. C'est une perte de travail, et c'est ce
 * qu'on retient d'un outil.
 *
 * Le brouillon vit dans le navigateur, pas dans la base : il n'engage
 * rien, personne d'autre n'a à le voir, et il disparaît dès que la
 * saisie est validée ou abandonnée.
 *
 * Il est rangé par écran et par site : deux transferts préparés depuis
 * deux sites ne se mélangent pas, et un brouillon d'achat ne ressort
 * pas dans une vente.
 *
 * Ce qui s'y garde : la marchandise, et le tiers à qui elle est
 * destinée. Les deux ensemble, ou rien.
 *
 * Le tiers en était d'abord exclu — on craignait de réengager
 * quelqu'un qu'on n'avait pas revu. C'était prendre le problème à
 * l'envers : un brouillon sans son tiers n'est pas un brouillon, c'est
 * une liste de marchandise qui ne veut plus rien dire. Les quantités,
 * les prix, les remises ont été saisis pour quelqu'un ; le même panier
 * destiné à un autre n'a ni le même sens ni forcément les mêmes prix.
 *
 * La date, elle, ne se garde jamais : dater d'hier un document
 * d'aujourd'hui est une erreur qu'on ne voit pas.
 */

/** La clé d'un brouillon : l'écran, puis le site. */
export function cleBrouillon(ecran: string, siteId: string): string {
  return `brouillon:${ecran}:${siteId}`;
}

/**
 * Un état qui survit au rechargement.
 *
 * S'utilise comme `useState`, avec une clé en plus. Le troisième
 * élément rendu dit si la relecture a eu lieu : avant elle, la valeur
 * est encore celle de départ, et l'écrire effacerait ce qu'on
 * s'apprête à relire.
 *
 * Un stockage indisponible — navigation privée, quota plein, réglage
 * du navigateur — ne doit jamais empêcher de travailler : on repart
 * alors d'une saisie vide, sans rien dire.
 */
export function useBrouillon<T>(
  cle: string, initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>, boolean] {
  const [valeur, setValeur] = useState<T>(initial);
  const [repris, setRepris] = useState(false);

  useEffect(() => {
    try {
      const brut = localStorage.getItem(cle);
      if (brut) setValeur(JSON.parse(brut) as T);
    } catch { /* stockage refusé ou illisible : on repart de zéro */ }
    setRepris(true);
  }, [cle]);

  useEffect(() => {
    if (!repris) return;
    try {
      /* Une saisie vide n'est pas un brouillon : on retire la clé
         plutôt que d'y laisser un tableau vide qui ferait croire à un
         travail en cours. */
      const vide = Array.isArray(valeur)
        ? valeur.length === 0
        : valeur == null;
      if (vide) localStorage.removeItem(cle);
      else localStorage.setItem(cle, JSON.stringify(valeur));
    } catch { /* indisponible : la saisie continue sans filet */ }
  }, [valeur, cle, repris]);

  return [valeur, setValeur, repris];
}

/** Effacer un brouillon : la saisie est partie, ou abandonnée. */
export function oublierBrouillon(cle: string): void {
  try {
    localStorage.removeItem(cle);
    localStorage.removeItem(`${cle}:tiers`);
  } catch { /* rien à oublier si rien ne s'est gardé */ }
}

/**
 * Le tiers d'un brouillon, qui vit et meurt avec lui.
 *
 * Il a d'abord été gardé une heure, puis oublié : on craignait de voir
 * ressortir un client qu'on n'avait pas revu. Mais c'était prendre le
 * problème à l'envers. Un brouillon sans son tiers n'est pas un
 * brouillon, c'est une liste de marchandise qui ne veut plus rien dire
 * — les quantités, les prix, les remises ont été saisis pour
 * quelqu'un, et le même panier destiné à un autre n'a ni le même sens
 * ni forcément les mêmes prix. Rendre l'un sans l'autre rendait
 * quelque chose de faux.
 *
 * Le tiers suit donc exactement la marchandise : il revient tant
 * qu'elle revient, et disparaît avec elle — à l'enregistrement, ou
 * quand on choisit d'effacer en quittant.
 *
 * `null` est une valeur à part entière : « aucun tiers choisi ». On ne
 * la garde pas, on retire la clé — un brouillon n'est pas la trace
 * d'une absence.
 */
export function useBrouillonTiers(
  cle: string,
): [string | null, React.Dispatch<React.SetStateAction<string | null>>, boolean] {
  const cleTiers = `${cle}:tiers`;
  const [valeur, setValeur] = useState<string | null>(null);
  const [repris, setRepris] = useState(false);

  useEffect(() => {
    try {
      const brut = localStorage.getItem(cleTiers);
      if (brut) setValeur(JSON.parse(brut) as string);
    } catch { /* stockage refusé ou illisible : on repart sans tiers */ }
    setRepris(true);
  }, [cleTiers]);

  useEffect(() => {
    if (!repris) return;
    try {
      if (!valeur) localStorage.removeItem(cleTiers);
      else localStorage.setItem(cleTiers, JSON.stringify(valeur));
    } catch { /* indisponible : la saisie continue sans filet */ }
  }, [valeur, cleTiers, repris]);

  return [valeur, setValeur, repris];
}
