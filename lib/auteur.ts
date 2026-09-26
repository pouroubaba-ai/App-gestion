import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { LIBELLES_ROLE, type RoleSite } from './roles';

/**
 * Qui a fait le geste.
 *
 * Toute la journée nous avons retiré des chiffres recopiés, parce qu'ils
 * divergeaient de leur source. L'auteur est l'exception, et pour une raison
 * précise : son nom et sa fonction ne sont pas des chiffres qu'on recalcule,
 * ce sont des faits datés.
 *
 * Un employé change de fonction, quitte l'entreprise, voit sa fiche
 * supprimée. Lire son nom depuis sa fiche au moment de l'affichage ferait
 * mentir l'archive : un versement encaissé par un caissier apparaîtrait
 * signé du gérant qu'il est devenu, ou de personne. On recopie donc, une
 * fois, au moment du geste — et cette copie ne bouge plus jamais.
 *
 * L'identifiant reste à côté, pour pouvoir remonter à la fiche tant qu'elle
 * existe.
 */

export interface Auteur {
  /** le compte qui a agi ; permet de remonter à la fiche */
  utilisateur: string;
  /** son nom au moment du geste, figé */
  utilisateurNom: string;
  /** sa fonction au moment du geste, figée */
  utilisateurFonction: string;
}

/** Ce qu'on inscrit quand aucune fiche employé ne correspond au compte. */
const PROPRIETAIRE: Omit<Auteur, 'utilisateur'> = {
  utilisateurNom: 'Propriétaire',
  utilisateurFonction: 'Propriétaire',
};

/**
 * L'auteur à inscrire sur un geste fait maintenant.
 *
 * Le compte connecté est d'abord cherché parmi les employés du site : c'est
 * là que vivent le nom et la fonction. Sans correspondance, le geste est
 * celui du propriétaire, qui n'a pas de fiche d'employé.
 */
export async function auteurCourant(
  siteId: string, userId: string, nomCompte?: string | null,
): Promise<Auteur> {
  try {
    /* Deux tables portent une identité, et elles ne se recouvrent pas. Un
       employé travaille sur le site, avec une fonction — caissier, vendeur.
       Un membre y a un accès, avec un rôle — gérant, recouvrements. La même
       personne peut être les deux, ou l'un sans l'autre : un gérant n'est
       pas forcément sur la paie, un manutentionnaire n'a pas de compte.

       L'employé passe en premier : sa fonction dit ce qu'il fait, là où le
       rôle ne dit que ce qu'il peut ouvrir. */
    /* Hors ligne, une requête que le cache ne connaît pas n'échoue pas :
       elle attend le serveur, indéfiniment. Le `catch` ci-dessous ne se
       déclenche donc jamais, et la vente reste suspendue à la recherche
       d'une signature.

       On borne l'attente : passé ce délai, on signe du nom du compte. Une
       signature imprécise vaut mieux qu'une vente qu'on n'enregistre pas —
       et le geste, lui, est un fait qui doit être inscrit. */
    const [empSnap, memSnap] = await Promise.race([
      Promise.all([
        getDocs(query(
          collection(db, 'employes'),
          where('siteId', '==', siteId),
          where('compteUid', '==', userId))),
        getDocs(query(
          collection(db, 'membres'),
          where('siteId', '==', siteId),
          where('compteUid', '==', userId))),
      ]),
      new Promise<never>((_, rejeter) =>
        setTimeout(() => rejeter(new Error('hors ligne')), 2500)),
    ]);

    const emp = empSnap.docs[0]?.data();
    if (emp) {
      return {
        utilisateur: userId,
        utilisateurNom: emp.nom ?? nomLisible(nomCompte),
        utilisateurFonction: emp.fonction || 'Employé',
      };
    }

    /* Un membre retiré n'agit plus : sa ligne désactivée ne doit pas
       continuer à signer. */
    const mem = memSnap.docs.map(d => d.data()).find(m => m.actif !== false);
    if (mem) {
      return {
        utilisateur: userId,
        utilisateurNom: mem.nom || nomLisible(nomCompte),
        utilisateurFonction: LIBELLES_ROLE[mem.role as RoleSite] ?? 'Membre',
      };
    }
  } catch {
    /* Une identité indisponible ne doit jamais empêcher d'enregistrer le
       geste : mieux vaut une signature imprécise qu'une opération perdue. */
  }

  /* Ni employé ni membre : c'est le compte qui a créé l'activité. */
  return {
    utilisateur: userId,
    utilisateurNom: nomLisible(nomCompte),
    utilisateurFonction: PROPRIETAIRE.utilisateurFonction,
  };
}

/**
 * Un nom, jamais une adresse.
 *
 * `nomCompte` vaut souvent l'email quand le compte n'a pas de nom
 * affiché : la signature devenait alors « pouroubaba@gmail.com » sur
 * chaque versement, lisible par toute l'équipe. Une adresse est un moyen
 * de joindre quelqu'un, pas une manière de le nommer, et elle n'a rien à
 * faire dans un registre que d'autres relisent.
 */
function nomLisible(nom?: string | null): string {
  const n = (nom ?? '').trim();
  if (!n || n.includes('@')) return PROPRIETAIRE.utilisateurNom;
  return n;
}

/**
 * L'auteur d'un geste déjà enregistré, pour l'affichage.
 *
 * Il vient du document lui-même, jamais d'une relecture de la fiche : c'est
 * tout l'intérêt de l'avoir recopié.
 */
export function auteurDe(x: {
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  par?: string | null;
}): { nom: string; fonction: string } {
  return {
    nom: x.utilisateurNom ?? '—',
    fonction: x.utilisateurFonction ?? '',
  };
}

/** « Awa Diallo · Caissière », ou le seul nom si la fonction manque. */
export function libelleAuteur(x: {
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}): string {
  const a = auteurDe(x);
  if (a.nom === '—') return '—';
  return a.fonction ? `${a.nom} · ${a.fonction}` : a.nom;
}

/**
 * L'auteur d'une étape de dossier : nom et fonction, sans l'identifiant.
 *
 * Les dossiers gardent déjà le compte dans leurs champs `parCommande`,
 * `parReception` et les autres. Ce qui leur manquait, c'est de quoi les
 * lire sans ouvrir une fiche qui peut ne plus exister.
 */
export async function auteurEtape(
  siteId: string, userId: string, nomCompte?: string | null,
): Promise<{ nom: string; fonction: string }> {
  const a = await auteurCourant(siteId, userId, nomCompte);
  return { nom: a.utilisateurNom, fonction: a.utilisateurFonction };
}
