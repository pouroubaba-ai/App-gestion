import {
  collection, addDoc, doc, getDoc, updateDoc, serverTimestamp,
  runTransaction, writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';
import { lireParSite, type Portee } from './portee';
import { ecrireLignesEnLot, enUnitesBase } from './mouvements';
import { ouvrirDetention } from './produits-site';
import { precharger } from './flux-marchandise';

/**
 * Les mouvements de stock qui ne passent par aucun dossier commercial.
 *
 * Un achat, une vente, un transfert, un retour ont chacun leur cycle : on
 * commande, on prépare, on confirme. Il reste tout le reste — le rayon
 * qu'on ouvre, la caisse de tomates pourries, l'inventaire qui ne tombe
 * pas juste. Personne n'est en face, rien ne se négocie ; il reste
 * pourtant quelque chose à contrôler.
 *
 * Car déclarer une perte, c'est décider que de la marchandise disparaît.
 * Si le même homme déclare et constate, il fait sortir ce qu'il veut sans
 * que personne ne compte. Le dossier porte donc un cycle : le gérant
 * déclare, le responsable des commandes compte et confirme. Le stock ne
 * bouge qu'à la fin, sur les quantités qu'il a vues lui-même.
 */

export type SensAjustement = 'entree' | 'sortie';

export type MotifAjustement =
  /* Entrées */
  | 'stock_initial'
  | 'correction_entree'
  | 'apport'
  | 'production'
  /* Sorties */
  | 'correction_sortie'
  | 'casse'
  | 'peremption'
  | 'vol'
  | 'usage_interne'
  | 'don';

interface Regle {
  sens: SensAjustement;
  libelle: string;
  /** Ce qu'on lit sous le motif au moment de choisir. */
  aide: string;
  /**
   * La marchandise sortie est-elle perdue ?
   *
   * Une mangue pourrie est une perte : on a payé pour rien. Une mangue
   * mangée par le vendeur est une charge : elle a servi. Les confondre
   * fausse le taux de perte, qui est justement ce qui dit si le rayon est
   * bien tenu.
   */
  perte: boolean;
}

export const MOTIFS_AJUSTEMENT: Record<MotifAjustement, Regle> = {
  stock_initial: {
    sens: 'entree',
    libelle: 'Stock initial',
    aide: 'Ce qui est déjà en rayon quand on ouvre le compte.',
    perte: false,
  },
  correction_entree: {
    sens: 'entree',
    libelle: 'Correction d’inventaire',
    aide: 'Le comptage trouve plus que ce que disait le registre.',
    perte: false,
  },
  apport: {
    sens: 'entree',
    libelle: 'Apport',
    aide: 'De la marchandise entre sans achat : un associé, un don reçu.',
    perte: false,
  },
  production: {
    sens: 'entree',
    libelle: 'Production',
    aide: 'Fabriqué ou assemblé sur place.',
    perte: false,
  },
  correction_sortie: {
    sens: 'sortie',
    libelle: 'Correction d’inventaire',
    aide: 'Le comptage trouve moins que ce que disait le registre.',
    perte: true,
  },
  casse: {
    sens: 'sortie',
    libelle: 'Casse',
    aide: 'Cassé, renversé, abîmé.',
    perte: true,
  },
  peremption: {
    sens: 'sortie',
    libelle: 'Péremption',
    aide: 'La date est passée, la marchandise ne se vend plus.',
    perte: true,
  },
  vol: {
    sens: 'sortie',
    libelle: 'Vol',
    aide: 'Manquant qu’aucun geste n’explique.',
    perte: true,
  },
  usage_interne: {
    sens: 'sortie',
    libelle: 'Usage interne',
    aide: 'Consommé par la boutique : elle en a tiré quelque chose.',
    perte: false,
  },
  don: {
    sens: 'sortie',
    libelle: 'Don',
    aide: 'Offert : échantillon, geste commercial.',
    perte: false,
  },
};

/** Les motifs d'un sens, dans l'ordre où on les propose. */
export function motifsDe(sens: SensAjustement): MotifAjustement[] {
  return (Object.keys(MOTIFS_AJUSTEMENT) as MotifAjustement[])
    .filter(m => MOTIFS_AJUSTEMENT[m].sens === sens);
}

/**
 * Les étapes du dossier.
 *
 * `declare` : le gérant a dit ce qu'il constate, rien n'a bougé.
 * `en_preparation` : le responsable est allé au rayon compter.
 * `confirme` : il a compté, et le stock bouge sur ce qu'il a vu.
 */
export type EtatAjustement =
  | 'declare' | 'en_preparation' | 'confirme' | 'annule';

export const ETAPES_AJUSTEMENT: EtatAjustement[] =
  ['declare', 'en_preparation', 'confirme'];

export const LIBELLES_ETAT_AJUSTEMENT: Record<EtatAjustement, string> = {
  declare: 'Déclaré',
  en_preparation: 'En préparation',
  confirme: 'Confirmé',
  annule: 'Annulé',
};

/**
 * Qui déclare un mouvement.
 *
 * Constater ce qui manque au rayon relève de qui répond de la boutique :
 * le gérant, le propriétaire. Le caissier tient le tiroir ; le
 * recouvrement suit les dettes.
 */
export function peutDeclarer(roleSite: string | null | undefined): boolean {
  return roleSite === null || roleSite === undefined || roleSite === 'gerant';
}

/**
 * Qui fait avancer et confirme.
 *
 * Celui qui décide ne compte pas. Dire « il manque dix sacs » et
 * constater qu'il en manque dix sont deux gestes, et ils appartiennent à
 * deux mains : sans cette séparation, un seul homme ferait disparaître ce
 * qu'il veut sans que personne n'aille voir.
 *
 * `null` désigne le propriétaire : il entre partout, sauf ici.
 */
export function peutTraiterAjustement(
  roleSite: string | null | undefined,
): boolean {
  return roleSite === 'commandes';
}

export interface LigneAjustement {
  produitId: string;
  varianteCle?: string | null;
  designation: string;
  unite?: string | null;
  /** ce que le gérant déclare */
  quantiteDeclaree: number;
  /**
   * Ce que le responsable a compté au rayon.
   *
   * `null` tant qu'il n'a pas compté. C'est cette quantité, et elle
   * seule, qui bouge le stock : déclarer dix cassés et en trouver huit,
   * c'est huit qui sortent. Le registre suit ce qu'on a vu, pas ce qu'on
   * a annoncé.
   */
  quantiteConstatee?: number | null;
  emballage?: string | null;
  /**
   * Ce que l'unité a coûté. Une entrée seulement.
   *
   * Une sortie ne porte jamais de coût saisi : elle se valorise au coût
   * moyen du rayon. Laisser saisir un coût à la sortie permettrait
   * d'inventer une perte — décider soi-même ce que valait la marchandise
   * qui disparaît.
   */
  /**
   * Ce que la ligne a coûté. Absent sur un stock initial : le
   * responsable compte ce qui est en rayon, il ne sait pas ce qu'il l'a
   * payé. Zéro dirait « gratuit », un chiffre au jugé dirait « ça a
   * coûté ça » — l'absence est la seule réponse vraie.
   */
  cout?: number | null;
  /**
   * Le prix auquel le site vend cet article, figé au moment du dossier.
   *
   * Il ne sert à rien au stock — rien ne se vend ici — mais il dit ce
   * que la maison perd vraiment quand la marchandise disparaît : le
   * coût mesure ce qu'elle a payé, le prix ce qu'elle n'encaissera pas.
   * Le lire plus tard donnerait le prix du jour, pas celui d'alors.
   */
  prixVente?: number | null;
}

export interface DossierAjustement {
  id: string;
  siteId: string;
  reference: string;
  etat: EtatAjustement;
  motif: MotifAjustement;
  sens: SensAjustement;
  date: string;
  lignes: LigneAjustement[];
  note?: string | null;

  /* Qui a déclaré, qui a confirmé : deux personnes, et la trace des deux.
     C'est elle qui rend la séparation vérifiable après coup. */
  parUid: string;
  parNom?: string | null;
  confirmeParUid?: string | null;
  confirmeParNom?: string | null;
  confirmeA?: string | null;

  annuleParUid?: string | null;
  annuleParNom?: string | null;

  createdAt?: unknown;
}

/** Un dossier encore en vie attend un geste. */
export function enCoursAjustement(d: DossierAjustement): boolean {
  return d.etat !== 'annule' && d.etat !== 'confirme';
}

/** Les dossiers d'un site, du plus récent au plus ancien. */
export async function chargerAjustements(
  portee: Portee,
): Promise<DossierAjustement[]> {
  const docs = await lireParSite('ajustements', portee);
  return docs
    .map(d => ({ id: d.id, ...d.data() } as DossierAjustement))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

/** Un dossier, par son identifiant. */
export async function lireAjustement(
  id: string,
): Promise<DossierAjustement | null> {
  const snap = await getDoc(doc(db, 'ajustements', id));
  return snap.exists()
    ? ({ id: snap.id, ...snap.data() } as DossierAjustement)
    : null;
}

/**
 * Déclarer un mouvement. Rien ne bouge encore.
 *
 * Le dossier naît, et c'est tout : le stock attend qu'on soit allé voir.
 */
export async function declarerAjustement(saisie: {
  siteId: string;
  motif: MotifAjustement;
  date: string;
  lignes: LigneAjustement[];
  note?: string | null;
  parUid: string;
  parNom?: string | null;
  roleSite?: string | null;
}): Promise<string> {
  const regle = MOTIFS_AJUSTEMENT[saisie.motif];
  if (!regle) throw new Error('Motif inconnu.');
  /* Un bouton caché n'est pas une permission : l'écran peut être
     contourné, l'écriture non. */
  if (saisie.roleSite !== undefined && !peutDeclarer(saisie.roleSite)) {
    throw new Error('Ce rôle ne déclare pas de mouvement de stock.');
  }

  const lignes = saisie.lignes.filter(l => l.quantiteDeclaree > 0);
  if (lignes.length === 0) throw new Error('Aucune quantité à déclarer.');

  const ref = await addDoc(collection(db, 'ajustements'), {
    siteId: saisie.siteId,
    reference: `M-${saisie.date.replace(/-/g, '')}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
    etat: 'declare' as EtatAjustement,
    motif: saisie.motif,
    sens: regle.sens,
    date: saisie.date,
    lignes: lignes.map(l => ({
      produitId: l.produitId,
      varianteCle: l.varianteCle ?? null,
      designation: l.designation,
      unite: l.unite ?? null,
      quantiteDeclaree: l.quantiteDeclaree,
      /* Le constat viendra du rayon, pas de la déclaration. */
      quantiteConstatee: null,
      emballage: l.emballage ?? null,
      /* Un coût absent le reste : le forcer à zéro en ferait une valeur,
         et le rayon vaudrait soudain « rien ». */
      cout: regle.sens === 'entree' ? (l.cout ?? null) : null,
    })),
    note: saisie.note ?? null,
    parUid: saisie.parUid,
    parNom: saisie.parNom ?? null,
    confirmeParUid: null,
    confirmeParNom: null,
    confirmeA: null,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/** Passer le dossier à l'étape suivante, sans toucher au stock. */
export async function avancerAjustement(params: {
  dossier: DossierAjustement;
  roleSite?: string | null;
  /** L'activité n'a qu'un compte : voir `confirmerAjustement`. */
  seulAuCommerce?: boolean;
}): Promise<void> {
  const d = params.dossier;
  if (d.etat === 'annule') throw new Error('Ce dossier a été annulé.');
  if (d.etat === 'confirme') throw new Error('Ce dossier est déjà confirmé.');
  if (!params.seulAuCommerce && params.roleSite !== undefined
    && !peutTraiterAjustement(params.roleSite)) {
    throw new Error('Faire avancer revient au responsable des commandes.');
  }
  const i = ETAPES_AJUSTEMENT.indexOf(d.etat);
  const suivant = ETAPES_AJUSTEMENT[i + 1];
  if (!suivant || suivant === 'confirme') {
    throw new Error('Cette étape se franchit par la confirmation.');
  }
  await updateDoc(doc(db, 'ajustements', d.id), { etat: suivant });
}

/** Inscrire ce qui a été compté au rayon, avant de confirmer. */
export async function constaterAjustement(params: {
  dossier: DossierAjustement;
  /** une quantité par ligne, dans l'ordre des lignes */
  quantites: number[];
  roleSite?: string | null;
  /** L'activité n'a personne d'autre : voir `confirmerAjustement`. */
  seulAuCommerce?: boolean;
}): Promise<void> {
  const d = params.dossier;
  if (d.etat !== 'en_preparation') {
    throw new Error('On ne compte qu’un dossier en préparation.');
  }
  if (!params.seulAuCommerce && params.roleSite !== undefined
    && !peutTraiterAjustement(params.roleSite)) {
    throw new Error('Compter revient au responsable des commandes.');
  }
  await updateDoc(doc(db, 'ajustements', d.id), {
    lignes: d.lignes.map((l, i) => ({
      ...l,
      quantiteConstatee: Math.max(0, params.quantites[i] ?? 0),
    })),
  });
}

/**
 * Confirmer : c'est ici, et seulement ici, que le stock bouge.
 *
 * Sur les quantités constatées, jamais sur les déclarées. Le gérant a
 * annoncé, le responsable a compté ; c'est le comptage qui fait foi.
 */
export async function confirmerAjustement(params: {
  dossier: DossierAjustement;
  parUid: string;
  parNom?: string | null;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  roleSite?: string | null;
  /**
   * L'activité n'a qu'un compte.
   *
   * La séparation des deux mains n'a alors personne à séparer : voir
   * plus bas. Se lit avec `estSeulAuCommerce`, jamais déclaré à la
   * main — les règles de la base le revérifient de leur côté.
   */
  seulAuCommerce?: boolean;
}): Promise<{ lignes: number }> {
  const d = params.dossier;
  if (d.etat === 'annule') throw new Error('Ce dossier a été annulé.');
  if (d.etat === 'confirme') throw new Error('Ce dossier est déjà confirmé.');
  if (d.etat !== 'en_preparation') {
    throw new Error('Ce dossier n’est pas encore prêt à être confirmé.');
  }
  /* Seul au commerce, on ferme soi-même ce qu'on a ouvert.
   *
   * La séparation des deux mains protège un registre que plusieurs
   * tiennent : l'un déclare, l'autre va compter, et aucun ne peut faire
   * disparaître ce qu'il veut. Elle ne protège rien quand il n'y a
   * qu'une main — elle empêche seulement de travailler, et il faudrait
   * inventer un second compte pour contourner, ce qui vaudrait moins
   * que tout.
   *
   * Ce qui reste, et qui suffit : le nom de qui a confirmé s'inscrit
   * comme toujours. L'historique dit que c'est lui, et le jour où un
   * employé arrive, la règle revient d'elle-même. */
  if (!params.seulAuCommerce) {
    if (params.roleSite !== undefined
      && !peutTraiterAjustement(params.roleSite)) {
      throw new Error('Confirmer revient au responsable des commandes.');
    }
    /* Jamais celui qui a déclaré. C'est toute la raison d'être du cycle :
       séparées, les deux mains ne peuvent pas s'entendre. */
    if (d.parUid === params.parUid) {
      throw new Error('On ne confirme pas le mouvement qu’on a déclaré.');
    }
  }

  const regle = MOTIFS_AJUSTEMENT[d.motif];
  const aEcrire = d.lignes
    .map(l => ({ ...l, quantite: l.quantiteConstatee ?? l.quantiteDeclaree }))
    .filter(l => l.quantite > 0);
  if (aEcrire.length === 0) {
    throw new Error('Aucune quantité constatée : rien à confirmer.');
  }

  /* On ne sort pas ce qu'on n'a pas.
   *
   * Le stock négatif ne veut rien dire : il ne dit pas qu'il manque de la
   * marchandise, il dit que le registre a menti quelque part. On vérifie
   * tout avant d'écrire quoi que ce soit — refuser au milieu laisserait
   * la moitié du dossier passée. */
  /* Tout ce dont les lignes auront besoin, lu d'un seul coup : la fiche
     de chaque produit et ce que le rayon en détient. Les lire une par une
     faisait attendre le serveur quatre fois par article — sur un dossier
     de reprise à cent lignes, l'attente se comptait en minutes. */
  const registre = await precharger(aEcrire.map(l => ({
    siteId: d.siteId, produitId: l.produitId,
  })));

  if (regle.sens === 'sortie') {
    for (const l of aEcrire) {
      /* Le stock vient du registre déjà lu : le relire ici doublait
         chaque ligne d'un aller-retour, pour la même réponse. */
      const det = registre.detentions.get(`${d.siteId}:${l.produitId}`);
      const enRayon = det?.data?.stock ?? 0;
      /* Le stock se tient en pieces, la ligne se compte dans son
         emballage : comparer les deux laissait passer 1 carton contre
         10 pieces en rayon, puis l'ecriture sortait les 25 pieces et le
         stock tombait sous zero. La garde doit parler la meme unite que
         ce qu'elle garde. */
      const aSortir = enUnitesBase(
        l.quantite, l.emballage ?? null,
        registre.produits.get(l.produitId)?.emballages ?? []);
      if (aSortir > enRayon) {
        throw new Error(
          `${l.designation} : ${aSortir} à sortir, ${enRayon} en stock.`);
      }
    }
  }

  /* L'état se pose avant que le stock ne bouge.
   *
   * Entre la vérification et la dernière écriture il y a plusieurs
   * allers-retours réseau. Deux appels lancés dans cet intervalle
   * passeraient tous les deux, et la marchandise sortirait deux fois
   * pour une seule perte. La transaction lit et écrit sans que rien ne
   * s'intercale : le second trouve l'état déjà changé et repart. */
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'ajustements', d.id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Ce dossier n’existe plus.');
    const etat = snap.data().etat as EtatAjustement;
    if (etat === 'annule') throw new Error('Ce dossier a été annulé.');
    if (etat === 'confirme') throw new Error('Ce dossier est déjà confirmé.');
    tx.update(ref, {
      etat: 'confirme' as EtatAjustement,
      confirmeParUid: params.parUid,
      confirmeParNom: params.parNom ?? null,
      confirmeA: new Date().toISOString().slice(0, 10),
    });
  });

  /* Le rayon qui n'existe pas encore s'ouvre avant le lot : un lot
     n'écrit que ce qu'il connaît, et une détention absente ne peut pas
     être créée au milieu. Ceux qui manquent s'ouvrent ensemble. */
  const absents = aEcrire.filter(
    l => !registre.detentions.has(`${d.siteId}:${l.produitId}`));
  if (absents.length > 0) {
    await Promise.all(absents.map(async l => {
      const id = await ouvrirDetention({
        produitId: l.produitId, siteId: d.siteId, userId: params.parUid,
      });
      registre.detentions.set(`${d.siteId}:${l.produitId}`, {
        id, data: { stock: 0, coutMoyen: 0, variantes: [] },
      });
    }));
  }

  const lignes = aEcrire.map(l => ({
    siteId: d.siteId,
    userId: params.parUid,
    produitId: l.produitId,
    varianteCle: l.varianteCle ?? null,
    sens: regle.sens,
    /* `perte` distingue ce qui est détruit de ce qui a servi : c'est ce
       mot que lit le calcul du bénéfice, pas le libellé affiché. */
    motif: regle.sens === 'sortie' && regle.perte ? 'perte' : d.motif,
    date: d.date,
    quantite: l.quantite,
    emballage: l.emballage ?? null,
    /* Une sortie n'a pas de prix ici, et jamais.
     *
     * Rien ne se vend sur ce dossier : ce qui sort est donné, cassé,
     * consommé ou recompté. Dès qu'un prix existe, c'est une vente —
     * elle a son client et sa créance, et elle sait gérer une vente à
     * perte, ce qui n'a pas de sens ici. Le coût, lui, vient du rayon. */
    valeurUnitaire: regle.sens === 'entree' ? (l.cout ?? 0) : 0,
    /* Ce que cette entrée ne dit pas.
     *
     * `valeurUnitaire` vaut zéro faute de mieux — un mouvement porte
     * toujours un nombre. Mais zéro serait lu comme « gratuit » par tout
     * ce qui additionne, et c'est faux : on ne sait pas. Ce drapeau le
     * dit, et c'est lui que le coût moyen regarde pour savoir qu'il n'a
     * rien à pondérer. */
    ...(regle.sens === 'entree' && l.cout == null ? { coutInconnu: true } : {}),
    documentId: d.id,
    utilisateurNom: params.utilisateurNom ?? null,
    utilisateurFonction: params.utilisateurFonction ?? null,
  }));

  await ecrireLignesEnLot(lignes, registre);

  return { lignes: aEcrire.length };
}

/**
 * Annuler un dossier qui n'a rien fait bouger.
 *
 * Tant que le stock n'a pas bougé, se raviser ne coûte rien. Après, le
 * fait est inscrit : on ne l'annote pas, on en déclare un autre en sens
 * inverse.
 */
export async function annulerAjustement(params: {
  dossier: DossierAjustement;
  parUid: string;
  parNom?: string | null;
  roleSite?: string | null;
}): Promise<void> {
  const d = params.dossier;
  if (d.etat === 'confirme') {
    throw new Error(
      'Ce mouvement est confirmé : le stock a bougé. Déclarez-en un autre '
      + 'en sens inverse.');
  }
  if (d.etat === 'annule') throw new Error('Ce dossier est déjà annulé.');
  /* Annuler défait une décision : cela revient à qui l'a prise. */
  if (params.roleSite !== undefined && !peutDeclarer(params.roleSite)) {
    throw new Error('Annuler un mouvement revient au gérant.');
  }
  await updateDoc(doc(db, 'ajustements', d.id), {
    etat: 'annule' as EtatAjustement,
    annuleParUid: params.parUid,
    annuleParNom: params.parNom ?? null,
  });
}
