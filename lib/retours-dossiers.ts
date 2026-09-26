import {
  collection, addDoc, doc, getDoc, updateDoc, serverTimestamp,
  runTransaction, getDocs, query, where,
} from 'firebase/firestore';
import { db } from './firebase';
import { lireParSite, type Portee } from './portee';
import { signalerAttente } from './en-attente';
import { enregistrerRetour } from './retours';
import {
  dossiersOuverts, repartir, sortieAutorisee, type PartFacture,
} from './imputation';
import type { RoleTiers } from './soldes';
import { enregistrerVersement } from './versements-collection';
import { valeurRecue, valeurVente } from './flux-marchandise';

/**
 * Les retours de marchandise, comme dossiers.
 *
 * Un retour annoncé n'est pas un retour fait. Entre le moment où l'on
 * décide de rendre et celui où la marchandise change de mains, il se passe
 * du temps : on prépare, on contrôle, le fournisseur vient ou ne vient
 * pas. Écrire tout d'un coup ferait bouger le stock pour une marchandise
 * encore sur l'étagère, et éteindrait une dette avant que quiconque ait
 * rien rendu.
 *
 * Le dossier porte donc ce temps. Le stock ne bouge qu'à la dernière
 * étape, quand la marchandise a réellement changé de mains.
 *
 * Et surtout : celui qui décide n'est pas celui qui constate. Le gérant
 * ouvre le retour, le responsable des commandes confirme le départ ou
 * l'arrivée, et seulement alors l'argent devient un mouvement que le
 * caissier tranche encore. Sans cette séparation, un gérant seul
 * déclarerait un retour qui n'a jamais quitté la boutique et encaisserait
 * le remboursement d'une marchandise toujours en rayon.
 */

/** De qui vient le retour, ou vers qui il va. */
export type TypeRetour = 'client' | 'fournisseur' | 'transfert';

/**
 * Les étapes, par type.
 *
 * L'étape finale dit qui a la marchandise à la fin : `recu` quand elle
 * revient chez nous, `livre` quand elle part chez le fournisseur.
 *
 * Le fournisseur a une étape de plus — `traite` — parce qu'entre le moment
 * où l'on a préparé et celui où il emporte, il y a une attente. Le client,
 * lui, apporte et repart : rien à attendre.
 */
export type EtatRetour =
  | 'en_attente' | 'en_traitement' | 'traite' | 'livre' | 'recu' | 'annule';

export const ETAPES_RETOUR: Record<TypeRetour, EtatRetour[]> = {
  client:      ['en_attente', 'en_traitement', 'recu'],
  fournisseur: ['en_attente', 'en_traitement', 'traite', 'livre'],
  transfert:   ['en_attente', 'en_traitement', 'recu'],
};

export const LIBELLES_ETAT_RETOUR: Record<EtatRetour, string> = {
  en_attente: 'En attente',
  en_traitement: 'En traitement',
  traite: 'Traité',
  livre: 'Livré',
  recu: 'Reçu',
  annule: 'Annulé',
};

/**
 * Qui fait avancer un retour.
 *
 * Celui qui décide ne constate pas. Le gérant ouvre le dossier, le
 * propriétaire aussi ; mais dire « la marchandise est prête », puis
 * « elle est partie », revient à celui qui la manipule. Sans cette
 * séparation, un seul homme déclarerait un retour, le ferait avancer
 * jusqu'au bout et encaisserait le remboursement d'une marchandise
 * toujours en rayon.
 *
 * `null` désigne le propriétaire : il entre partout, sauf ici.
 */
export function peutTraiter(roleSite: string | null | undefined): boolean {
  return roleSite === 'commandes';
}

/** L'étape qui fait bouger le stock : la dernière du cycle. */
export function etatFinal(type: TypeRetour): EtatRetour {
  const e = ETAPES_RETOUR[type];
  return e[e.length - 1];
}

/**
 * Ce que le retour fait de sa valeur.
 *
 * Deux façons de solder, et c'est une décision, pas un calcul : rendre la
 * marchandise ne dit pas encore ce qu'on veut en échange. Le gérant
 * choisit en ouvrant le dossier.
 *
 * `deduire` impute la valeur sur ce qu'on doit, facture par facture, de la
 * plus ancienne à la plus récente. Aucun argent ne bouge — la dette
 * diminue, voilà tout.
 *
 * `rembourser` demande l'argent. Il passe alors par la file du caissier,
 * qui seul ouvre le tiroir.
 */
export type ReglementRetour = 'deduire' | 'rembourser';

export interface LigneDossierRetour {
  /** la ligne d'origine, celle que ce retour annule en partie */
  mouvementId: string;
  produitId: string;
  designation: string;
  varianteCle?: string | null;
  quantite: number;
  emballage?: string | null;
  /**
   * Le prix du document d'origine, figé ici.
   *
   * On défait ce qui a été fait : si le bon disait 2 000 le sac, le retour
   * compte 2 000, même si le prix a monté depuis. Prendre le prix du jour
   * créerait un gain ou une perte que personne n'a décidés.
   */
  prixUnitaire: number;
  /** L'unité du produit, pour lire la quantité sans l'interpréter. */
  unite?: string | null;
  /**
   * Ce que la marchandise avait coûté, figé comme le prix.
   *
   * Une sortie se lit toujours des deux côtés : ce qu'elle rapporte et ce
   * qu'elle a coûté. Un transfert n'a pas de prix — il vaut son coût, et
   * c'est ce coût qui dit ce que le site perd en la laissant partir.
   */
  cout?: number | null;
}

export interface DossierRetour {
  id: string;
  siteId: string;
  type: TypeRetour;
  etat: EtatRetour;
  reference: string;
  date: string;

  partenaireId?: string | null;
  partenaireNom?: string | null;
  /** pour un retour de transfert : le site d'où venait la marchandise */
  siteLieId?: string | null;

  /** le dossier d'origine, celui qu'on défait en partie */
  achatId?: string | null;
  venteId?: string | null;
  transfertId?: string | null;

  lignes: LigneDossierRetour[];
  valeurTotale: number;

  reglement: ReglementRetour;
  /** ce qui a été imputé sur les dettes, rempli à la confirmation */
  deduit?: number | null;
  /** ce qui part en caisse, rempli à la confirmation */
  rembourse?: number | null;
  /** le mouvement en attente né de ce retour */
  mouvementAttenteId?: string | null;

  motif?: string | null;

  /* Qui a ouvert, qui a confirmé : deux personnes, et la trace des deux.
     C'est elle qui rend la séparation vérifiable après coup. */
  parUid: string;
  parNom?: string | null;
  confirmeParUid?: string | null;
  confirmeParNom?: string | null;
  confirmeA?: string | null;

  annuleParUid?: string | null;
  annuleParNom?: string | null;
  motifAnnulation?: string | null;

  createdAt?: any;
}

/** Les retours d'une portée, du plus récent au plus ancien. */
export async function chargerRetours(portee: Portee): Promise<DossierRetour[]> {
  const docs = await lireParSite('retours_dossiers', portee);
  return docs
    .map(d => ({ id: d.id, ...d.data() } as DossierRetour))
    .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
}

export async function chargerRetour(id: string): Promise<DossierRetour | null> {
  const s = await getDoc(doc(db, 'retours_dossiers', id));
  if (s.exists()) return { id: s.id, ...s.data() } as DossierRetour;

  /* Un retour est un document qui se désigne lui-même : si rien ne
     répond à cet identifiant, il n'y a rien à deviner. */
  return null;
}

/**
 * Ouvrir un retour.
 *
 * Rien ne bouge : ni le stock, ni l'argent, ni les dettes. Le dossier dit
 * seulement ce qu'on a l'intention de rendre, et attend qu'on le traite.
 */
export async function ouvrirRetour(saisie: {
  siteId: string;
  type: TypeRetour;
  date: string;
  lignes: LigneDossierRetour[];
  reglement: ReglementRetour;
  partenaireId?: string | null;
  partenaireNom?: string | null;
  siteLieId?: string | null;
  achatId?: string | null;
  venteId?: string | null;
  transfertId?: string | null;
  motif?: string | null;
  parUid: string;
  parNom?: string | null;
}): Promise<string> {
  if (saisie.lignes.length === 0) {
    throw new Error('Un retour sans ligne ne rend rien.');
  }
  if (saisie.lignes.some(l => l.quantite <= 0)) {
    throw new Error('Chaque ligne doit porter une quantité.');
  }
  /* Un retour de transfert ne touche à aucune dette : la marchandise
     circule entre deux de nos sites, personne ne doit rien à personne. */
  const reglement: ReglementRetour =
    saisie.type === 'transfert' ? 'deduire' : saisie.reglement;

  const valeurTotale = saisie.lignes
    .reduce((n, l) => n + l.quantite * l.prixUnitaire, 0);

  const ref = await addDoc(collection(db, 'retours_dossiers'), {
    siteId: saisie.siteId,
    type: saisie.type,
    etat: 'en_attente' as EtatRetour,
    reference: `R-${saisie.date.replace(/-/g, '')}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
    date: saisie.date,
    partenaireId: saisie.partenaireId ?? null,
    partenaireNom: saisie.partenaireNom ?? null,
    siteLieId: saisie.siteLieId ?? null,
    achatId: saisie.achatId ?? null,
    venteId: saisie.venteId ?? null,
    transfertId: saisie.transfertId ?? null,
    lignes: saisie.lignes,
    valeurTotale,
    reglement,
    deduit: null,
    rembourse: null,
    mouvementAttenteId: null,
    motif: saisie.motif?.trim() || null,
    parUid: saisie.parUid,
    parNom: saisie.parNom ?? null,
    createdAt: serverTimestamp(),
  });
  signalerAttente();
  return ref.id;
}

/**
 * Passer à l'étape suivante.
 *
 * La dernière ne se franchit pas ici : elle fait bouger le stock et
 * l'argent, et demande donc plus qu'un changement d'état. C'est
 * `confirmerRetour` qui s'en charge.
 */
export async function avancerRetour(params: {
  dossier: DossierRetour;
  parUid: string;
  parNom?: string | null;
  /** Le rôle de qui agit ; `null` désigne le propriétaire. */
  roleSite?: string | null;
}): Promise<EtatRetour> {
  const { dossier } = params;
  if (dossier.etat === 'annule') {
    throw new Error('Ce retour a été annulé.');
  }
  /* Un bouton caché n'est pas une permission : la garde tient ici. */
  if (params.roleSite !== undefined && !peutTraiter(params.roleSite)) {
    throw new Error(
      'Faire avancer un retour revient au responsable des commandes.');
  }
  const etapes = ETAPES_RETOUR[dossier.type];
  const i = etapes.indexOf(dossier.etat);
  if (i < 0) throw new Error('État inconnu pour ce retour.');
  if (i >= etapes.length - 1) {
    throw new Error('Ce retour est au bout de son cycle.');
  }
  const suivant = etapes[i + 1];
  if (suivant === etatFinal(dossier.type)) {
    throw new Error(
      'La dernière étape fait bouger le stock : passez par la confirmation.');
  }

  await updateDoc(doc(db, 'retours_dossiers', dossier.id), {
    etat: suivant,
    majParUid: params.parUid,
    majParNom: params.parNom ?? null,
  });
  signalerAttente();
  return suivant;
}

/**
 * Annuler un retour.
 *
 * Tant que la marchandise n'a pas changé de mains, il n'y a rien à défaire
 * : le dossier disait une intention, on la retire. Une fois la dernière
 * étape franchie, c'est trop tard — annuler ne ferait pas revenir ce qui
 * est parti, et il faudrait un autre geste, documenté comme tel.
 *
 * Le dossier reste au registre. Un retour annulé raconte une tentative qui
 * a eu lieu : le fournisseur a refusé ce jour-là, et c'est une chose qu'on
 * voudra savoir. On en rouvre un autre, on ne réécrit pas celui-ci.
 */
export async function annulerRetour(params: {
  dossier: DossierRetour;
  parUid: string;
  parNom?: string | null;
  motif?: string | null;
}): Promise<void> {
  const { dossier } = params;
  if (dossier.etat === 'annule') {
    throw new Error('Ce retour est déjà annulé.');
  }
  if (dossier.etat === etatFinal(dossier.type)) {
    throw new Error(
      'La marchandise a déjà changé de mains : ce retour ne s’annule plus.');
  }
  await updateDoc(doc(db, 'retours_dossiers', dossier.id), {
    etat: 'annule' as EtatRetour,
    annuleParUid: params.parUid,
    annuleParNom: params.parNom ?? null,
    motifAnnulation: params.motif?.trim() || null,
  });
  signalerAttente();
}

/** Peut-on encore annuler ce dossier ? */
export function annulable(d: DossierRetour): boolean {
  return d.etat !== 'annule' && d.etat !== etatFinal(d.type);
}

/** Le dossier attend-il encore un geste ? */
export function enCours(d: DossierRetour): boolean {
  return d.etat !== 'annule' && d.etat !== etatFinal(d.type);
}

/**
 * Confirmer un retour : la marchandise a changé de mains.
 *
 * C'est le seul endroit où quelque chose bouge vraiment, et tout y bouge
 * ensemble — le stock, les dettes, la caisse. Les séparer laisserait
 * passer une marchandise rendue dont personne ne cesse d'être redevable,
 * ou une dette éteinte pour des sacs encore en rayon.
 *
 * Ce n'est pas celui qui a ouvert le dossier qui confirme. Le gérant a
 * décidé, le responsable des commandes constate : sans cette séparation,
 * un seul homme déclarerait un retour qui n'a jamais quitté la boutique
 * et encaisserait le remboursement d'une marchandise toujours là.
 *
 * L'argent ne va jamais droit au tiroir. Selon ce qui a été choisi à
 * l'ouverture, il éteint des dettes — facture par facture, la plus
 * ancienne d'abord — ou il devient un mouvement que le caissier tranche
 * encore. Trois personnes, trois gestes, et aucune ne voit tout.
 */
/**
 * Les confirmations en cours, par dossier.
 *
 * Firestore garde un cache local : `runTransaction` y lit l'état sans
 * interroger le serveur. Deux appels partis du même onglet lisent donc le
 * même état, le jugent tous deux valide, et passent tous deux — la
 * transaction ne sérialise que les écritures venues d'ailleurs.
 *
 * La course a lieu en mémoire ; le verrou doit y être aussi. Le second
 * appel retrouve la promesse du premier et l'attend, au lieu de rembourser
 * une deuxième fois une marchandise rendue une seule.
 */
const confirmationsEnCours = new Map<string, Promise<{
  deduit: number; rembourse: number; parts: PartFacture[];
}>>();

/**
 * Ce qu'un bon vaut et ce qui a été versé dessus, en argent seulement.
 *
 * `avanceVersee` cumule l'argent reçu et ce que d'anciens retours ont
 * imputé. Pour savoir ce qui peut ressortir, seul le premier compte : on
 * ne restitue pas une dette éteinte par de la marchandise.
 */
async function lireBon(
  bonId: string, role: RoleTiers,
): Promise<{ total: number; verse: number } | null> {
  const col = role === 'fournisseur' ? 'achats' : 'ventes';
  const snap = await getDoc(doc(db, col, bonId));
  if (!snap.exists()) return null;
  const x = snap.data() as any;

  /* Ce que le bon vaut, compté comme partout ailleurs.
   *
   * Ce total se calculait ici à la main, sur `quantiteLivree` et
   * `valeurUnitaire`. Une vente ne porte ni l'un ni l'autre : elle porte
   * `quantiteRecue` et `prixVente`. Le total tombait au coût, ou à zéro,
   * et `sortieAutorisee` en concluait qu'il n'y avait rien à restituer —
   * un retour remboursé ne faisait alors bouger aucune caisse. Deux
   * façons de compter la même chose finissent toujours par se
   * contredire : on réutilise celle qui fait foi. */
  const total = role === 'fournisseur'
    ? valeurRecue(x.lignes ?? [])
    : valeurVente(x.lignes ?? []);

  /* On retire des versements ceux qui n'ont rien encaissé. */
  let parRetour = 0;
  try {
    const vers = await getDocs(query(
      collection(db, 'versements'),
      where(role === 'fournisseur' ? 'achatId' : 'venteId', '==', bonId)));
    for (const v of vers.docs) {
      const w = v.data() as any;
      if (w.motif === 'retour_marchandise') parRetour += w.montant ?? 0;
    }
  } catch {
    /* On ne sait pas ce qui a déjà été déduit.
     *
     * Répondre `verse: 0` passait pour de la prudence ; c'en était le
     * contraire. Un retour marqué « Remboursé » ne restituait alors plus
     * rien, sans un mot : l'écran annonçait un remboursement que la
     * caisse ne voyait jamais passer. Un chiffre faux n'est pas plus
     * prudent qu'un chiffre absent — il est seulement plus difficile à
     * repérer. On le dit, et l'appelant tranche. */
    throw new Error(
      'Impossible de vérifier ce qui a déjà été versé sur ce document. '
      + "Le retour n'a pas été confirmé : réessayez, ou demandez au "
      + 'gérant de le confirmer.');
  }

  return { total, verse: Math.max(0, (x.avanceVersee ?? 0) - parRetour) };
}

/**
 * Ce retour a-t-il déjà laissé une écriture ?
 *
 * Les versements qu'un règlement produit portent la référence du
 * retour : c'est par elle qu'on les retrouve. Sans ce contrôle, une
 * reprise rejouerait un règlement déjà passé et doublerait ce que le
 * retour a éteint.
 *
 * En cas de doute on répond « oui » : refuser une reprise légitime se
 * voit et se redemande, tandis qu'un double règlement s'inscrit sans
 * bruit et fausse les comptes pour de bon.
 */
async function aDejaUneEcriture(d: DossierRetour): Promise<boolean> {
  if (!d.reference) return false;
  try {
    const snap = await getDocs(query(
      collection(db, 'versements'),
      where('siteId', '==', d.siteId),
      where('reference', '==', d.reference)));
    return !snap.empty;
  } catch {
    return true;
  }
}

export async function confirmerRetour(params: {
  dossier: DossierRetour;
  parUid: string;
  parNom?: string | null;
  utilisateurFonction?: string | null;
  adminUid?: string | null;
  roleSite?: string | null;
}): Promise<{ deduit: number; rembourse: number; parts: PartFacture[] }> {
  /* Un seul passage à la fois par dossier. Le second appel n'en déclenche
     pas un autre : il attend le résultat du premier. */
  const enCours = confirmationsEnCours.get(params.dossier.id);
  if (enCours) return enCours;

  const promesse = confirmerVraiment(params)
    .finally(() => confirmationsEnCours.delete(params.dossier.id));
  confirmationsEnCours.set(params.dossier.id, promesse);
  return promesse;
}

async function confirmerVraiment(params: {
  dossier: DossierRetour;
  parUid: string;
  parNom?: string | null;
  utilisateurFonction?: string | null;
  adminUid?: string | null;
  roleSite?: string | null;
}): Promise<{ deduit: number; rembourse: number; parts: PartFacture[] }> {
  const d = params.dossier;

  if (d.etat === 'annule') throw new Error('Ce retour a été annulé.');
  /* Déjà confirmé : on refuse, sauf si le règlement n'a rien produit.
   *
   * L'état se pose avant que l'argent ne bouge, pour qu'un second appel
   * ne rembourse pas deux fois. Mais si le règlement échoue après cette
   * marque — ou s'il s'est trompé, comme quand le total du bon était
   * mal lu —, le dossier reste confirmé sans qu'aucune écriture ne
   * suive : la marchandise est rentrée, mais la dette n'a pas bougé et
   * la caisse n'a rien vu. Toute reprise se heurtait à « déjà
   * confirmé », et le retour restait faux pour toujours.
   *
   * Un retour qui n'a ni éteint ni rendu un seul franc n'a pas été
   * réglé, quoi qu'en dise son état. On le laisse repasser — le
   * règlement seul, jamais le stock : la marchandise n'est rentrée
   * qu'une fois. Dès qu'une écriture existe, la porte se referme. */
  if (d.etat === etatFinal(d.type)) {
    if (d.type === 'transfert') {
      throw new Error('Ce retour est déjà confirmé.');
    }
    /* On regarde ce qui est écrit, pas ce que le dossier en dit.
     *
     * Le garde-fou se fiait à `deduit` porté par le dossier. Un premier
     * règlement avait pourtant laissé un vrai versement tout en
     * inscrivant `deduit: 0` — le dossier se croyait vierge alors que
     * l'écriture existait, et la reprise l'a passée une seconde fois :
     * 6 500 rendus sont devenus 13 000 éteints. Un fait se vérifie là
     * où il s'inscrit, jamais sur le résumé qu'on en garde. */
    if (await aDejaUneEcriture(d)) {
      throw new Error('Ce retour est déjà réglé.');
    }
    /* Reprendre une écriture manquante n'est pas confirmer : le cycle a
       déjà été mené à son terme et la marchandise constatée. Ce qui
       manque est comptable, donc cela revient à qui répond des comptes
       — le gérant et le propriétaire —, et non au responsable des
       commandes, dont le rôle s'arrête à la marchandise. */
    const r = params.roleSite;
    if (r !== undefined && r !== null && r !== 'gerant') {
      throw new Error(
        'Reprendre le règlement d’un retour revient au gérant.');
    }
    return reglerRetour(params);
  }
  /* On ne saute pas les étapes : la confirmation clôt un dossier qu'on a
     traité, elle ne remplace pas le traitement. */
  const etapes = ETAPES_RETOUR[d.type];
  if (etapes.indexOf(d.etat) !== etapes.length - 2) {
    throw new Error('Ce retour n’est pas encore prêt à être confirmé.');
  }
  /* Jamais celui qui a décidé. C'est toute la raison d'être du cycle :
     séparées, les deux mains ne peuvent pas s'entendre. */
  if (d.parUid === params.parUid) {
    throw new Error('On ne confirme pas le retour qu’on a ouvert soi-même.');
  }
  if (params.roleSite !== undefined && !peutTraiter(params.roleSite)) {
    throw new Error(
      'Confirmer un retour revient au responsable des commandes.');
  }

  /* On pose la marque avant de toucher à quoi que ce soit.
   *
   * Les vérifications ci-dessus lisent l'état du dossier tel qu'il était
   * au chargement de l'écran. Entre elles et la fin de la confirmation, il
   * y a plusieurs allers-retours réseau — le stock, les mouvements, la
   * caisse. Deux appels lancés dans cet intervalle passaient tous les deux
   * : chacun relisait un état encore valide. Un clic répété, une connexion
   * qui rejoue, et le fournisseur était remboursé deux fois pour une seule
   * marchandise rendue.
   *
   * La transaction lit et écrit sans que rien ne s'intercale : le second
   * appel trouve l'état déjà changé et repart. Le bouton désactivé ne
   * suffisait pas — il empêche un second clic, pas un second appel. */
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'retours_dossiers', d.id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Ce retour n’existe plus.');
    const etat = snap.data().etat as EtatRetour;
    if (etat === 'annule') throw new Error('Ce retour a été annulé.');
    if (etat === etatFinal(d.type)) {
      throw new Error('Ce retour est déjà confirmé.');
    }
    if (etapes.indexOf(etat) !== etapes.length - 2) {
      throw new Error('Ce retour n’est pas encore prêt à être confirmé.');
    }
    tx.update(ref, {
      etat: etatFinal(d.type),
      confirmeParUid: params.parUid,
      confirmeParNom: params.parNom ?? null,
      confirmeA: new Date().toISOString().slice(0, 10),
    });
  });

  /* Le stock et les mouvements : on réutilise le geste qui existe déjà.
     `sansReglement` lui interdit de toucher à l'argent — c'est ici qu'on
     en décide, selon ce qui a été choisi à l'ouverture. Sans ce drapeau
     il concluait de `resteDu: 0` que tout était à rembourser, et le
     versement partait deux fois. */
  if (d.type !== 'transfert' && d.partenaireId) {
    await enregistrerRetour({
      siteId: d.siteId,
      userId: params.parUid,
      partenaireId: d.partenaireId,
      partenaireNom: d.partenaireNom ?? null,
      role: d.type === 'client' ? 'client' : 'fournisseur',
      lignes: d.lignes.map(l => ({
        mouvementId: l.mouvementId, quantite: l.quantite,
      })),
      date: d.date,
      resteDu: 0,
      sansReglement: true,
      /* Le mouvement pointera sur ce dossier : depuis l'historique, on
         ouvre le retour, pas le bon qu'il défait. */
      dossierRetourId: d.id,
      achatId: d.achatId ?? null,
      venteId: d.venteId ?? null,
      reference: d.reference,
      par: params.parUid,
      utilisateurNom: params.parNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
    });
  }

  return reglerRetour(params);
}

/**
 * Le règlement seul : ce que le retour fait à la dette et à la caisse.
 *
 * Séparé de la confirmation parce qu'il peut devoir être rejoué sans
 * elle. Le stock, lui, ne se rejoue jamais : la marchandise n'est rentrée
 * qu'une fois. Ce découpage suit cette différence.
 */
async function reglerRetour(params: {
  dossier: DossierRetour;
  parUid: string;
  parNom?: string | null;
  utilisateurFonction?: string | null;
  adminUid?: string | null;
  roleSite?: string | null;
}): Promise<{ deduit: number; rembourse: number; parts: PartFacture[] }> {
  const d = params.dossier;

  let deduit = 0;
  let rembourse = 0;
  let parts: PartFacture[] = [];

  if (d.type !== 'transfert' && d.partenaireId) {
    const role = d.type === 'client' ? 'client' : 'fournisseur';
    const bonId = d.achatId ?? d.venteId ?? null;
    const bon = bonId ? await lireBon(bonId, role) : null;

    /* Étape 1 — le retour éteint d'abord sa propre dette. Toujours.
     *
     * Ce n'est pas un choix, c'est un fait : la marchandise repart, donc
     * elle n'est plus due. Sur 20 000 dus, rendre pour 10 000 ramène la
     * dette à 10 000 — il n'y a rien à rembourser et rien à répartir,
     * parce qu'il ne reste rien.
     *
     * Le règlement choisi à l'ouverture ne portait que sur cette
     * première étape, et c'était l'erreur. « Déduire » envoyait le
     * retour sur les dettes les plus anciennes sans passer par le bon
     * qu'il défait : un retour de 10 000 pouvait éteindre une facture de
     * mars en laissant intacte la dette du bon d'origine. On ne choisit
     * plus ça. On choisit seulement ce qu'on fait du surplus. */
    const partage = bon
      ? sortieAutorisee({
          valeurRetour: d.valeurTotale,
          totalDocument: bon.total,
          verseDocument: bon.verse,
        })
      /* Un retour sans bon d'origine ne se rattache à aucune dette :
         il n'a rien à éteindre, et rien ne peut en ressortir. */
      : { eteintLaDette: d.valeurTotale, restituable: 0 };

    deduit = partage.eteintLaDette;

    if (deduit > 0 && bonId) {
      await enregistrerVersement({
        siteId: d.siteId,
        userId: params.parUid,
        partenaireId: d.partenaireId,
        partenaireNom: d.partenaireNom ?? null,
        role,
        montant: deduit,
        date: d.date,
        motif: 'retour_marchandise',
        /* Aucun argent ne bouge : la dette baisse, voilà tout. */
        sansCaisse: true,
        sens: role === 'client' ? 'sortie' : 'entree',
        ...(role === 'fournisseur'
          ? { achatId: bonId } : { venteId: bonId }),
        reference: d.reference,
        par: params.parUid,
        utilisateurNom: params.parNom ?? null,
        utilisateurFonction: params.utilisateurFonction ?? null,
        adminUid: params.adminUid ?? null,
      });
    }

    /* Étape 2 — le surplus seulement, s'il y en a un.
     *
     * `restituable` est déjà plafonné à ce que le tiers avait versé :
     * on ne rend pas sur un document plus que ce qui y est entré. Quand
     * il vaut zéro, le règlement choisi n'a plus d'objet — ni caisse,
     * ni répartition. */
    const surplus = partage.restituable;

    if (surplus > 0) {
      if (d.reglement === 'deduire') {
        /* Reporté sur les autres dettes, de la plus ancienne à la plus
           récente. Une dette ancienne inquiète ; celle d'hier attend son
           tour. Le bon d'origine est exclu : il vient d'être soldé. */
        const ouverts = (await dossiersOuverts(d.siteId, d.partenaireId, role))
          .filter(o => o.id !== bonId);
        const r = repartir(surplus, ouverts);
        parts = r.parts;

        for (const part of r.parts) {
          await enregistrerVersement({
            siteId: d.siteId,
            userId: params.parUid,
            partenaireId: d.partenaireId,
            partenaireNom: d.partenaireNom ?? null,
            role,
            montant: part.impute,
            date: d.date,
            motif: 'retour_marchandise',
            sansCaisse: true,
            sens: role === 'client' ? 'sortie' : 'entree',
            ...(role === 'fournisseur'
              ? { achatId: part.dossierId }
              : { venteId: part.dossierId }),
            reference: d.reference,
            par: params.parUid,
            utilisateurNom: params.parNom ?? null,
            utilisateurFonction: params.utilisateurFonction ?? null,
            adminUid: params.adminUid ?? null,
          });
        }
        deduit += r.impute;
        /* Ce qui ne trouve plus aucune dette à éteindre revient au tiers :
           l'abandonner ici le laisserait créancier sans qu'un écran ne le
           dise. */
        rembourse = r.surplus;
      } else {
        rembourse = surplus;
      }

      /* Le reliquat passe par la file du caissier, qui seul ouvre le
         tiroir. */
      if (rembourse > 0) await enregistrerVersement({
        siteId: d.siteId,
        userId: params.parUid,
        partenaireId: d.partenaireId,
        partenaireNom: d.partenaireNom ?? null,
        role,
        montant: rembourse,
        date: d.date,
        motif: 'remboursement',
        sens: role === 'client' ? 'sortie' : 'entree',
        reference: d.reference,
        par: params.parUid,
        utilisateurNom: params.parNom ?? null,
        utilisateurFonction: params.utilisateurFonction ?? null,
        adminUid: params.adminUid ?? null,
      });
    }
  }

  /* L'état et la signature ont été posés par la transaction, avant que
     l'argent ne bouge. Il ne reste qu'à inscrire ce que ça a donné. */
  await updateDoc(doc(db, 'retours_dossiers', d.id), {
    deduit,
    rembourse,
    imputations: parts,
  });
  signalerAttente();

  return { deduit, rembourse, parts };
}

/**
 * Ce qui est déjà engagé sur un dossier, ligne par ligne.
 *
 * Rendre huit sacs sur vingt ne laisse pas vingt sacs à rendre : il en
 * reste douze. Sans ce compte, on ouvrirait deux retours de quinze sur le
 * même bon, et le second échouerait à la confirmation — trop tard, quand
 * la marchandise est déjà sur le camion.
 *
 * Un dossier en cours compte autant qu'un dossier confirmé : la
 * marchandise est promise, même si elle n'est pas partie. Seuls les
 * annulés libèrent ce qu'ils retenaient.
 *
 * La clé est `{dossierId}:{index}` — celle que la page de création pose
 * sur chaque ligne, faute d'identifiant propre sur les lignes d'un bon.
 */
export async function dejaEngage(
  portee: Portee, dossierId: string,
): Promise<Record<string, number>> {
  const tous = await chargerRetours(portee);
  const compte: Record<string, number> = {};
  for (const d of tous) {
    if (d.etat === 'annule') continue;
    if (d.achatId !== dossierId && d.venteId !== dossierId) continue;
    for (const l of d.lignes) {
      compte[l.mouvementId] = (compte[l.mouvementId] ?? 0) + l.quantite;
    }
  }
  return compte;
}

/**
 * Les retours clients confirmés, réduits à ce qu'un tableau de bord lit.
 *
 * Un retour déclaré n'est pas un retour fait : tant que la marchandise
 * n'est pas revenue, rien n'a été rendu et il n'y a rien à retrancher des
 * ventes. Seul l'état final compte donc — celui où la marchandise a
 * changé de mains.
 *
 * Côté fournisseur, ce qu'on rend n'a jamais été vendu : l'inscrire à
 * côté des ventes mêlerait deux gestes opposés. Cet écran ne parle que de
 * ce qui est sorti puis revenu.
 */
export async function retoursClientsConfirmes(portee: Portee): Promise<
  { date: string; montant: number; siteId: string | null }[]
> {
  const dossiers = await chargerRetours(portee);
  return dossiers
    .filter(d => d.type === 'client' && d.etat === etatFinal('client'))
    .map(d => ({
      date: d.date,
      montant: d.valeurTotale ?? 0,
      siteId: d.siteId ?? null,
    }));
}
