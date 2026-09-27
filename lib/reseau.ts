/**
 * Savoir si le réseau répond, et le dire.
 *
 * Firestore garde ses écritures dans une file quand la connexion tombe, et
 * les envoie au retour : rien n'est perdu. Mais il ne rend la main qu'une
 * fois le serveur joint — un `await` sur une confirmation de vente reste
 * donc suspendu tant que dure la coupure.
 *
 * Vu du comptoir, ce n'est pas la perte qui pose problème, c'est le
 * silence : le caissier voit un bouton qui tourne, ne sait pas si sa vente
 * est passée, et recommence. Une seule marchandise se retrouve vendue deux
 * fois — un dégât que la coupure, elle, n'avait pas causé.
 *
 * D'où ces deux outils : dire l'état de la connexion, et ne pas attendre
 * ce qui peut se terminer sans nous.
 */
import { useEffect, useState } from 'react';

/** Vrai tant que le navigateur se croit connecté. */
export function estEnLigne(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

/**
 * L'état de la connexion, suivi.
 *
 * `navigator.onLine` dit seulement si une interface réseau existe : un
 * wifi branché sur une box sans internet se dit en ligne. C'est une
 * indication, pas une garantie — mais elle suffit à prévenir, et elle ne
 * coûte rien.
 */
export function useReseau(): boolean {
  const [enLigne, setEnLigne] = useState(true);

  useEffect(() => {
    /* Au premier rendu seulement : lire `navigator` pendant le rendu
       initial ferait diverger le serveur et le navigateur. */
    setEnLigne(estEnLigne());
    const monte = () => setEnLigne(true);
    const tombe = () => setEnLigne(false);
    window.addEventListener('online', monte);
    window.addEventListener('offline', tombe);
    return () => {
      window.removeEventListener('online', monte);
      window.removeEventListener('offline', tombe);
    };
  }, []);

  return enLigne;
}

/**
 * Attend une écriture, mais pas indéfiniment.
 *
 * Hors ligne, Firestore ne résout sa promesse qu'au retour du réseau.
 * L'écriture est pourtant déjà inscrite localement : l'écran peut avancer
 * sans elle, et elle partira toute seule.
 *
 * On rend donc la main au bout du délai, en disant que le travail est
 * *différé* et non terminé — l'appelant décide alors quoi montrer. Sans
 * cette distinction, on annoncerait « enregistré » pour quelque chose qui
 * n'a pas encore quitté la machine.
 *
 * En ligne, le délai n'est jamais atteint : l'écriture répond en quelques
 * centaines de millisecondes.
 */
export async function sansAttendreLeReseau<T>(
  travail: Promise<T>,
  delaiMs = 4000,
): Promise<{ termine: boolean; valeur?: T }> {
  let fini = false;
  travail.then(() => { fini = true; }).catch(() => { fini = true; });

  const valeur = await Promise.race([
    travail.then(v => ({ ok: true as const, v })),
    new Promise<{ ok: false }>(r => setTimeout(() => r({ ok: false }), delaiMs)),
  ]).catch(() => ({ ok: true as const, v: undefined as T }));

  if (valeur.ok) return { termine: true, valeur: (valeur as any).v };
  /* La promesse continue sa vie : on ne l'abandonne pas, on cesse
     seulement de l'attendre. */
  return { termine: fini };
}

/**
 * Termine les ventes au comptoir restées en chemin.
 *
 * Une vente au comptoir naît en `preparation` puis se livre dans la foulée.
 * Hors ligne, cette suite peut s'interrompre — onglet fermé, machine
 * éteinte — et la vente reste à mi-parcours : la marchandise est partie
 * avec le client, mais le stock ne l'a pas enregistré.
 *
 * `auComptoir` les reconnaît : chez elles, `preparation` n'est jamais un
 * état où l'on s'arrête. On reprend donc là où la chaîne s'est rompue.
 */
export async function reprendreVentesComptoir(params: {
  siteId: string;
  userId: string;
}): Promise<number> {
  const { collection, query, where, getDocs } = await import('firebase/firestore');
  const { db } = await import('@/lib/firebase');
  const { livrerVente } = await import('@/lib/flux-marchandise');
  const { auteurEtape } = await import('@/lib/auteur');

  /* Deux ruptures possibles, deux formes de vente inachevée.
   *
   * Celle qui est restée en « préparation » n'a pas sorti son stock. Celle
   * qui est « livrée » l'a sorti, mais l'argent a pu ne pas suivre : le
   * client a payé, il est parti, et l'écran annonce une créance. C'est le
   * plus dangereux des deux, parce qu'il est muet — rien ne le distingue
   * d'une vente à crédit ordinaire.
   *
   * On lit donc les deux d'un coup. Une vente au comptoir encaissée porte
   * son montant dans `avanceVersee` : quand elle est livrée et que ce
   * total est en dessous, un versement manque à l'appel. */
  const [enCours, livrees] = await Promise.all([
    getDocs(query(
      collection(db, 'ventes'),
      where('siteId', '==', params.siteId),
      where('auComptoir', '==', true),
      where('etat', '==', 'preparation'))),
    getDocs(query(
      collection(db, 'ventes'),
      where('siteId', '==', params.siteId),
      where('auComptoir', '==', true),
      where('etat', '==', 'livre'))),
  ]);

  if (enCours.empty && livrees.empty) return 0;

  const auteur = await auteurEtape(params.siteId, params.userId);
  let reprises = 0;

  for (const d of enCours.docs) {
    try {
      await livrerVente({
        vente: { id: d.id, ...(d.data() as any) },
        userId: params.userId,
        par: params.userId,
        utilisateurNom: auteur.nom,
        utilisateurFonction: auteur.fonction,
        mode: 'retrait',
      });
      reprises++;
    } catch {
      /* Une vente qu'on ne peut pas reprendre maintenant le sera à la
         prochaine ouverture : on ne bloque pas les autres pour elle. */
    }
  }

  reprises += await recollerVersements({
    ventes: livrees.docs.map(d => ({ id: d.id, ...(d.data() as any) })),
    siteId: params.siteId,
    userId: params.userId,
    auteur,
  });

  return reprises;
}

/**
 * Rattrape l'argent d'une vente au comptoir dont le versement manque.
 *
 * La marchandise est sortie, le client a payé et il est parti : ce qui
 * manque n'est pas une décision, c'est une écriture qui n'a pas abouti.
 * On la refait — on ne demande à personne de la ressaisir de mémoire.
 *
 * Le fait se reconnaît sans ambiguïté : la vente est au comptoir, elle
 * est livrée, et la somme de ses versements ne couvre pas ce qu'elle
 * annonce encaissé. On relit les versements plutôt que de se fier au
 * seul `avanceVersee`, puisque c'est précisément ce total qui a pu ne pas
 * s'écrire.
 *
 * Rien ne se devine : une vente à crédit annonce zéro encaissé et ne
 * bouge pas. Seul l'écart entre ce qui est déclaré payé et ce qui est
 * inscrit appelle une reprise.
 */
async function recollerVersements(params: {
  ventes: any[];
  siteId: string;
  userId: string;
  auteur: { nom: string; fonction: string };
}): Promise<number> {
  const candidates = params.ventes.filter(v => (v.avanceVersee ?? 0) > 0);
  if (candidates.length === 0) return 0;

  const { versementsDuDossier, enregistrerVersement } =
    await import('@/lib/versements-collection');

  let recolles = 0;

  for (const v of candidates) {
    try {
      const faits = await versementsDuDossier(v.id, 'vente');
      const inscrit = faits
        .filter(x => x.motif !== 'retour_marchandise')
        .reduce((n, x) => n + (x.montant ?? 0), 0);

      /* `avanceVersee` dit ce que la vente a encaissé ; les versements
         disent ce qui en est inscrit. L'écart est ce qui manque. */
      const manque = (v.avanceVersee ?? 0) - inscrit;
      if (manque <= 0) continue;

      await enregistrerVersement({
        siteId: params.siteId,
        userId: params.userId,
        date: v.dateLivraison ?? v.dateCommande
          ?? new Date().toISOString().split('T')[0],
        montant: manque,
        sens: 'entree',
        motif: 'vente',
        partenaireId: v.clientId || '',
        partenaireNom: v.clientNom ?? 'Client de passage',
        role: 'client',
        achatId: null,
        venteId: v.id,
        reference: v.reference ?? null,
        par: params.userId,
        utilisateurNom: params.auteur.nom,
        utilisateurFonction: params.auteur.fonction,
        /* `avanceVersee` porte déjà ce montant : c'est le versement qui
           manquait, pas le total. Le réincrémenter le doublerait. */
        sansTotal: true,
      });
      recolles++;
    } catch {
      /* Ce qu'on ne peut pas recoller maintenant le sera à la prochaine
         ouverture : une vente ne bloque pas les autres. */
    }
  }

  return recolles;
}
