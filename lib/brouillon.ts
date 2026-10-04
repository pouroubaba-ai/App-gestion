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
 * Ce qui s'y garde : la marchandise, c'est-à-dire ce qu'il a fallu
 * chercher. Pas le partenaire, pas le mode de paiement, pas la date —
 * les retrouver à l'ouverture ferait engager quelqu'un qu'on n'a pas
 * revu, ou dater d'hier ce qu'on fait aujourd'hui.
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
  } catch { /* rien à oublier si rien ne s'est gardé */ }
}
