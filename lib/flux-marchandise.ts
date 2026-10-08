import {
  collection, doc, getDoc, getDocs, query, where, documentId,
  serverTimestamp, writeBatch, runTransaction,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  ouvrirDetention, type VarianteSite,
} from '@/lib/produits-site';
import { coutMoyenApresEntree, enUnitesBase } from '@/lib/mouvements';
import { lireParSite, lireDocs, type Portee } from '@/lib/portee';
import {
  repartirFrais, totalFrais, controlerRepartition,
  type Frais, type CleRepartition,
} from '@/lib/frais';
import type { MontantVente } from '@/lib/reductions';

/**
 * Transferts et achats partagent le même automate : un engagement est pris,
 * la marchandise circule, elle est reçue, et l'écart éventuel se règle.
 * Ce qui les distingue tient en deux points :
 *  - un transfert oppose deux sites internes, un achat un site à un tiers ;
 *  - le stock ne bouge qu'à la toute fin, jamais pendant le trajet.
 */

/* ═══════════════════════ ÉTATS ═══════════════════════ */

/**
 * En cours   : l'admin a donné l'instruction, rien n'a bougé.
 * En préparation : la source rassemble la marchandise. Rien n'a bougé.
 * Expédié    : le site source a chargé ; la marchandise n'est nulle part.
 * Reçu       : le destinataire a compté et déclaré.
 * En traitement : le compté ne correspond pas à l'envoyé. L'état existe
 *              parce qu'un écart n'est pas une erreur de saisie à corriger :
 *              c'est un désaccord entre deux sites, qui demande un tiers.
 * En attente de confirmation : les comptes sont arrêtés, plus personne ne
 *              les discute, mais le stock n'a pas encore bougé. Le dossier
 *              attend la main qui le clot — attendre n'est pas être clos.
 * Confirmé   : le stock est appliqué des deux côtés, le dossier est clos.
 * Annulé     : abandonné avant toute application de stock.
 */
export type EtatTransfert =
  | 'en_cours' | 'preparation' | 'expedie' | 'recu' | 'traitement'
  | 'a_confirmer' | 'confirme' | 'annule';

/** L'ordre du cycle. Un état n'est atteint que parce que le précédent est fait. */
export const ETAPES_TRANSFERT: EtatTransfert[] = [
  'en_cours', 'preparation', 'expedie', 'recu', 'traitement',
  'a_confirmer', 'confirme',
];

/**
 * Qui peut faire avancer un transfert, et depuis quel côté.
 *
 * Un transfert appartient à deux sites, et chacun ne répond que de ce qu'il
 * a en main. La source rassemble et charge — elle ne peut pas déclarer ce
 * qu'elle n'a pas vu arriver. Le destinataire compte et traite l'écart — il
 * ne peut pas dire qu'un colis est parti.
 *
 * La confirmation n'appartient à aucun des deux : elle clot un dossier où un
 * écart oppose deux sites, et personne n'arbitre son propre écart.
 */
export type CoteTransfert = 'source' | 'destination' | 'arbitre';

export const COTE_QUI_AGIT: Record<EtatTransfert, CoteTransfert | null> = {
  /* la source rassemble ce qu'elle doit envoyer */
  en_cours: 'source',
  /* puis elle charge : la marchandise quitte ses murs */
  preparation: 'source',
  /* le destinataire compte ce qui est arrivé */
  expedie: 'destination',
  /* à lui de dire si l'écart se traite ou si le compte est bon */
  recu: 'destination',
  /* un écart n'est pas tranché par celui qui le déclare */
  traitement: 'arbitre',
  /* les comptes sont arrêtés : il ne reste qu'à clore */
  a_confirmer: 'arbitre',
  confirme: null,
  annule: null,
};

/**
 * En attente : commandé et payé d'avance, rien n'est arrivé.
 * Reçu       : la marchandise est arrivée. Rien n'est encore compté : on
 *              constate qu'elle est là, pas ce qu'elle contient.
 * En traitement : on la traite — on compte, on vérifie, on confronte au
 *              commandé. C'est là qu'un écart apparaît, s'il y en a un, et
 *              qu'on décide quoi en faire : réclamer, accepter le manque, ou
 *              ne payer que le livré. Le fournisseur n'étant pas dans l'app,
 *              personne n'arbitre à la place de celui qui reçoit.
 * Confirmé   : accepté. Le stock entre dans le site, l'achat existe au nom
 *              du fournisseur.
 * Annulé     : abandonné avant réception.
 */
export type EtatAchat =
  'en_attente' | 'recu' | 'traitement' | 'confirme' | 'annule';

/** L'ordre du cycle. Un état n'est atteint que parce que le précédent est fait. */
export const ETAPES_ACHAT: EtatAchat[] = [
  'en_attente', 'recu', 'traitement', 'confirme',
];

/**
 * Le cycle de vente, du côté client. Deux entrées possibles : un devis, ou
 * directement une commande — un habitué qui connaît les prix ne demande pas
 * de proposition.
 *
 * Devis      : une proposition de prix. N'engage que celui qui l'émet, et
 *              seulement le temps de sa validité. Ne porte aucun versement :
 *              payer sur un devis, c'est l'accepter, donc le transformer.
 * Commande   : le client s'est engagé. Rien n'est encore préparé.
 * Préparation: on rassemble la marchandise.
 * Prêt       : elle attend de partir. État distinct parce qu'il pose une
 *              question qu'aucun autre ne pose : qu'est-ce qui est immobilisé
 *              en attendant un client qui ne vient pas ?
 * Livré      : la marchandise a changé de mains. Le stock sort ici, et
 *              nulle part avant — comme pour l'achat et le transfert.
 * Annulé     : abandonné avant livraison. Au-delà, on ne peut plus annuler
 *              seul : la marchandise appartient au client, il faut un retour.
 */
export type EtatVente = 'devis' | 'commande' | 'preparation' | 'pret' | 'livre' | 'annule';

export const LIBELLES_VENTE: Record<EtatVente, string> = {
  devis: 'Devis',
  commande: 'Commande',
  /* « En traitement », comme l'achat et l'importation au même moment du
     cycle : on rassemble et l'on compte avant de conclure. Le même
     travail portait trois noms selon l'écran, et il fallait apprendre
     trois vocabulaires pour une seule étape. L'état reste `preparation`
     dans la base — renommer un libellé ne renomme pas ce qui est
     écrit. */
  preparation: 'En traitement',
  pret: 'Prêt',
  /* « Livré / Récupéré » : le même fait, que le client vienne ou qu'on aille */
  livre: 'Livré',
  annule: 'Annulé',
};

/** L'ordre du cycle : on ne saute pas d'étape, un état n'est atteint que
    parce que le travail de l'état précédent a été fait. */
export const SUITE_VENTE: Record<EtatVente, EtatVente | null> = {
  devis: 'commande',
  commande: 'preparation',
  preparation: 'pret',
  pret: 'livre',
  livre: null,
  annule: null,
};

/**
 * Un même état, deux points de vue.
 *
 * `expedie` se dit « Transféré » quand on l'a expédié : c'est le geste
 * qu'on vient de faire. Vu du site qui attend, ce n'est pas un transfert
 * mais une annonce — un autre site déclare lui avoir envoyé quelque chose,
 * et rien n'est encore arrivé ni compté.
 *
 * Les autres états ne changent pas de sens selon le bout : recevoir,
 * compter, arbitrer se disent pareil des deux côtés.
 */
export const LIBELLES_RECEPTION: Partial<Record<EtatTransfert, string>> = {
  expedie: 'Annoncé',
};

/** Le libellé d'un état, du point de vue de celui qui regarde. */
export function libelleTransfert(
  etat: EtatTransfert, sens: 'envoi' | 'reception' = 'envoi',
): string {
  return (sens === 'reception' && LIBELLES_RECEPTION[etat])
    || LIBELLES_TRANSFERT[etat];
}

export const LIBELLES_TRANSFERT: Record<EtatTransfert, string> = {
  en_cours: 'En attente',
  preparation: 'En préparation',
  expedie: 'Transféré',
  recu: 'Reçu',
  /* un écart sépare l'envoyé du compté : il attend l'arbitrage d'un tiers */
  traitement: 'En traitement',
  /* les comptes sont arrêtés ; le stock attend la main qui clot */
  a_confirmer: 'En attente de confirmation',
  /* le stock a bougé des deux côtés : le dossier est clos */
  confirme: 'Confirmé',
  annule: 'Annulé',
};

export const LIBELLES_ACHAT: Record<EtatAchat, string> = {
  en_attente: 'En attente',
  /* la marchandise est là ; ce qu'elle contient reste à vérifier */
  recu: 'Reçu',
  /* on compte et on confronte au commandé */
  traitement: 'En traitement',
  /* le stock est entré : le dossier est clos */
  confirme: 'Confirmé',
  annule: 'Annulé',
};

/* ═══════════════════════ RÔLES ═══════════════════════ */

/**
 * Les rôles n'existent pas encore côté comptes. Les gardes sont écrites ici
 * pour qu'il n'y ait qu'un seul endroit à brancher le jour venu : tant que
 * `role` vaut null, tout est permis et l'app se comporte comme aujourd'hui.
 */
export type Role = 'admin' | 'gerant' | 'recouvrement' | 'commandes';

export function peutInitierTransfert(role: Role | null): boolean {
  return role === null || role === 'admin';
}

/** Seul un tiers sans intérêt dans le litige peut trancher un écart. */
export function peutArbitrerEcart(role: Role | null): boolean {
  return role === null || role === 'admin';
}

/* Charger un camion, c'est manier de la marchandise, pas décider d'une
   dépense : le responsable des commandes le fait aux deux bouts — il charge
   ce qui part, il compte ce qui arrive. */
export function peutExpedier(role: Role | null): boolean {
  return role === null || role === 'admin' || role === 'gerant'
    || role === 'commandes';
}

export function peutRecevoir(role: Role | null): boolean {
  return role === null || role === 'admin' || role === 'gerant' || role === 'commandes';
}

export function peutCommander(role: Role | null): boolean {
  return role === null || role === 'admin' || role === 'commandes';
}

/**
 * Annuler un dossier — achat, bon de commande ou transfert.
 *
 * Annuler n'est pas corriger : cela revient sur un engagement pris envers
 * un tiers, libère ce qui était réservé, et referme un dossier que
 * quelqu'un attend peut-être à l'autre bout. C'est une décision, pas un
 * geste de manutention.
 *
 * Le responsable des commandes ne crée pas de dossier ; il n'en détruit pas
 * davantage. Il fait avancer ce qui existe. Corriger une réception ou une
 * préparation mal comptée reste son travail : là il rectifie sa propre
 * saisie, il ne défait pas l'engagement.
 *
 */
export function peutAnnulerDossier(role: Role | null): boolean {
  return role === null || role === 'admin' || role === 'gerant';
}

/**
 * Annuler un transfert : le propriétaire, et lui seul.
 *
 * Un achat ou un bon de commande n'engagent que le site qui les porte :
 * le gérant les a ouverts, il peut les refermer. Un transfert relie deux
 * sites, et le gérant n'en tient qu'un. L'annuler fait reculer un
 * engagement pris envers l'autre bout — qui attendait une marchandise
 * qui ne viendra plus, décidé par quelqu'un qui ne répond pas de lui.
 *
 * Celui qui répond des deux tranche.
 */
export function peutAnnulerTransfert(role: Role | null): boolean {
  return role === null || role === 'admin';
}

/* ═══════════════════════ LIGNES ═══════════════════════ */

/**
 * Une ligne porte trois quantités successives, jamais écrasées : ce qui a été
 * demandé, ce que la source déclare avoir envoyé, ce que le destinataire
 * déclare avoir reçu. L'écart est leur différence, et il ne se recalcule pas
 * après coup — c'est la trace du désaccord.
 */
export interface LigneFlux {
  produitId: string;
  designation: string;
  varianteCle?: string | null;
  varianteLibelle?: string | null;
  /**
   * Unité de compte du produit (pièce, kilo…). Elle ne change jamais :
   * un carton de 25 kg reste compté en kilos. L'emballage dit seulement
   * combien d'unités il contient.
   */
  unite?: string | null;
  emballage?: string | null;
  /** quantité voulue à l'initiation, dans l'emballage choisi */
  quantiteDemandee: number;
  /** déclarée par la source ; null tant qu'elle n'a pas expédié */
  quantiteExpediee?: number | null;
  /** déclarée par le destinataire ; null tant qu'il n'a pas reçu */
  quantiteRecue?: number | null;
  /** unités de base réellement appliquées au stock, figées à la confirmation */
  quantiteUnites?: number;
  /** coût moyen de la source à l'expédition : le receveur en hérite */
  valeurUnitaire: number;
  /**
   * Prix de vente pratiqué sur cette ligne. Distinct du coût : il ne sert
   * pas à valoriser l'entrée mais à fixer d'avance la marge attendue.
   * Absent = le produit garde le prix qu'il a déjà.
   */
  prixVente?: number | null;
  /**
   * Cette ligne ne sait pas ce qu'elle a coûté.
   *
   * Déclaré à l'ouverture d'un compte, référence par référence : on a la
   * facture de certaines, pas des autres. `valeurUnitaire` vaut alors
   * zéro faute de mieux, et ce drapeau empêche de le lire comme
   * « gratuit ». La première entrée réelle posera le coût.
   */
  coutInconnu?: boolean;
  /**
   * Cette quantité n'était pas à nous.
   *
   * On la prend chez un voisin au moment où le client la demande, on la
   * vend dans la minute, et on règle le voisin après. Entre les deux, la
   * marchandise n'a pas dormi chez nous : elle a traversé.
   *
   * Le cycle d'achat — commandé, reçu, compté, confirmé — répond aux
   * questions que pose l'attente. Ici il n'y a pas d'attente, et le
   * franchir une étape à la fois immobilise pendant que le client est
   * devant le comptoir.
   *
   * Ce que ces deux champs ne font pas perdre, et que « hors stock »
   * aurait perdu : le bénéfice de la ligne — le coût est su —, ce qu'on
   * prend chez chaque voisin — la dette porte son nom —, et combien on a
   * vendu de cette référence — le produit est le même produit, quelle
   * que soit la façon dont il est entré.
   *
   * À la confirmation de la vente, la ligne écrit une entrée au coût du
   * fournisseur puis sa sortie habituelle. Le stock passe par zéro net
   * et le coût moyen ne bouge pas — non pas qu'on l'évite, mais qu'une
   * entrée aussitôt annulée par sa sortie ne déplace aucune moyenne. Le
   * registre, lui, est complet : dix savons entrent, dix sortent, et la
   * trace dit d'où ils venaient.
   */
  fournisseurId?: string | null;
  fournisseurNom?: string | null;
}

export interface Transfert {
  id: string;
  reference: string;
  siteSourceId: string;
  siteSourceNom: string;
  siteDestId: string;
  siteDestNom: string;
  etat: EtatTransfert;
  lignes: LigneFlux[];
  dateInitiation: string;
  dateExpedition?: string | null;
  dateReception?: string | null;
  dateConfirmation?: string | null;
  /** qui a fait quoi : sans ça l'écart ne désigne personne */
  parInitiation?: string | null;
  parExpedition?: string | null;
  parReception?: string | null;
  parConfirmation?: string | null;
  /* Le nom et la fonction de qui a franchi l'étape, à côté de l'identifiant. */
  auteurInitiation?: AuteurEtape | null;
  auteurExpedition?: AuteurEtape | null;
  auteurReception?: AuteurEtape | null;
  auteurConfirmation?: AuteurEtape | null;
  note?: string | null;
  /** commentaire de l'arbitre, exigé quand il tranche un écart */
  noteArbitrage?: string | null;
  userId: string;
  createdAt?: any;
}

/** Un paiement daté sur un achat, avant ou pendant sa réception. */
export interface VersementAchat {
  date: string;
  montant: number;
  /**
   * Avance : payé avant que la marchandise n'arrive, l'argent est en dépôt.
   * Règlement : payé sur une marchandise déjà reçue, la dette s'éteint.
   * Figé à la saisie : un versement fait avant livraison reste une avance.
   */
  motif?: 'avance' | 'reglement';
  /** qui a payé : la trace compte autant que le montant */
  par?: string | null;
  note?: string | null;
}

/**
 * Un document d'entrée ou de sortie du nouveau système.
 *
 * Entrées et sorties partagent la même collection, séparées par leur `sens` —
 * comme les mouvements, dont le document est l'en-tête. L'ancienne collection
 * `documents_stock` reste celle de l'ancien système et n'est pas touchée.
 *
 * Le document ne porte pas ses lignes : elles vivent dans `mouvements`, qui
 * les relie par `achatId` ou `venteId`. Les recopier ici en ferait une
 * seconde vérité sur les quantités, et les deux finiraient par diverger.
 */
/**
 * La nature d'un document, indépendante de son sens.
 *
 * Le sens dit si la marchandise entre ou sort ; le motif dit pourquoi. Une
 * sortie peut être une vente, un transfert, une perte ou un don — les
 * confondre rendrait l'historique illisible, et fausserait toute lecture du
 * chiffre d'affaires.
 */
export type MotifDocument =
  | 'achat' | 'vente' | 'transfert' | 'reajustement'
  | 'perte' | 'don' | 'avarie' | 'usage_interne' | 'retour';

export const LIBELLES_MOTIF_DOCUMENT: Record<MotifDocument, string> = {
  achat: 'Achat',
  vente: 'Vente',
  transfert: 'Transfert',
  reajustement: 'Réajustement',
  perte: 'Perte',
  don: 'Don',
  avarie: 'Produit abîmé',
  usage_interne: 'Usage interne',
  retour: 'Retour',
};

/**
 * Ce qui a produit une ligne de mouvement.
 *
 * Un retour est un mouvement comme un autre : il porte sa quantité, sa date
 * et le lien vers la ligne qu'il annule. Le noter comme un champ de la ligne
 * d'origine reviendrait à écraser son histoire — qui l'a rendu, quand, et en
 * combien de fois.
 */
export type MotifMouvement = 'achat' | 'vente' | 'retour';

/**
 * Qui a franchi une étape.
 *
 * L'identifiant d'un compte ne dit rien : il faut ouvrir la fiche pour le
 * traduire, et si l'employé est parti elle n'existe plus. Le nom et la
 * fonction sont donc recopiés au moment du geste, comme sur les versements
 * et les documents. C'est la seule donnée qu'on recopie volontairement :
 * elle n'a pas à se recalculer, elle atteste.
 */
export interface AuteurEtape {
  nom: string | null;
  fonction: string | null;
}

export interface DocumentFlux {
  id: string;
  /** numéro du document commercial dont il découle */
  reference: string;
  siteId: string;
  sens: 'entree' | 'sortie';
  /** pourquoi la marchandise bouge ; `achat` ou `vente` par défaut */
  motif: MotifDocument;
  /* Qui a fait le geste, recopié au moment où il a lieu. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /** le transfert d'origine, quand le motif est `transfert` */
  transfertId?: string | null;
  /** l'autre site d'un transfert */
  siteLieId?: string | null;
  /** l'acte qui l'a produit ; seul l'un des deux est renseigné */
  achatId?: string | null;
  venteId?: string | null;
  partenaireId?: string | null;
  partenaireNom: string;
  date: string;
  /** valeur du document : au coût pour une entrée, au prix pour une sortie */
  valeur: number;
  /** combien de lignes de mouvement en sont nées */
  lignes: number;
  userId: string;
  par?: string | null;
  createdAt?: any;
}

export interface Achat {
  id: string;
  reference: string;
  siteId: string;
  fournisseurId?: string | null;
  fournisseurNom: string;
  etat: EtatAchat;
  lignes: LigneFlux[];
  /** total payé d'avance ; somme des `versements` */
  avanceVersee: number;
  /**
   * Le détail des versements : un montant seul ne dit pas quand ni combien
   * de fois on a payé. Un fournisseur réglé en trois fois n'est pas dans la
   * même situation qu'un fournisseur réglé d'un coup.
   */
  versements?: VersementAchat[];
  /** rendu en caisse à la confirmation quand l'avance dépasse le reçu */
  retourCaisse?: number;
  /**
   * Ce qu'il a fallu payer en plus pour que la marchandise arrive :
   * transport, douane, manutention.
   *
   * Dû au même fournisseur — il livre et facture ensemble. Le montant
   * s'ajoute donc à ce qu'on lui doit, et se répartit sur les produits
   * pour entrer dans leur coût. Un service, pas de la marchandise :
   * aucune quantité n'entre au stock.
   *
   * Modifiable jusqu'à la confirmation. Après, le coût moyen en porte la
   * trace et le changer réécrirait des marges déjà figées.
   */
  frais?: Frais[] | null;
  /**
   * Une part imposée à la main, par index de ligne.
   *
   * La règle donne une base juste ; celui qui a vu le camion sait qu'une
   * tôle encombre plus qu'un carton d'ampoules de même valeur. Ce qui
   * reste se partage entre les autres lignes.
   */
  fraisCorrection?: Record<number, number> | null;
  /**
   * La règle de partage des frais, commune à tout l'achat.
   *
   * Elle est enregistrée avec le dossier : relire une facture confirmée
   * doit rendre exactement les parts qui ont pondéré les coûts moyens,
   * et non celles qu'un réglage changé depuis donnerait.
   */
  fraisCle?: CleRepartition | null;
  dateCommande: string;
  dateReception?: string | null;
  dateConfirmation?: string | null;
  parCommande?: string | null;
  parReception?: string | null;
  auteurCommande?: AuteurEtape | null;
  auteurReception?: AuteurEtape | null;
  auteurConfirmation?: AuteurEtape | null;
  /**
   * Quand on a demande comment cette dette serait reglee.
   *
   * Un fait, pas une deduction : sans lui, on ne saurait pas distinguer
   * « pas encore demande » de « demande, et l'utilisateur a repondu plus
   * tard ». Le cycle de recouvrement ne le dit pas — poser une regle sans
   * la demarrer aujourd'hui n'ouvre aucune echeance.
   */
  planifieLe?: string | null;
  note?: string | null;
  userId: string;
  createdAt?: any;
}

/**
 * Une vente en cours de cycle. Miroir de l'achat, dans l'autre sens.
 *
 * Elle ne porte pas de créance : la dette naît à la livraison et vit sur le
 * compte du partenaire, comme la dette fournisseur naît à la confirmation
 * d'un achat. Le cycle suit la marchandise ; l'argent se suit ailleurs.
 */
export interface Vente {
  id: string;
  reference: string;
  siteId: string;
  clientId?: string | null;
  clientNom: string;
  etat: EtatVente;
  lignes: LigneFlux[];
  /** total encaissé d'avance ; somme des `versements` */
  avanceVersee: number;
  versements?: VersementAchat[];
  /** rendu au client à la livraison quand l'avance dépasse le livré */
  retourCaisse?: number;
  /**
   * Les réductions et frais annexes du document.
   *
   * Ils sont déjà répartis : les lignes portent le prix d'après remise,
   * et c'est lui qui part au mouvement et dans la marge. Ceci ne sert
   * qu'à expliquer comment on y est arrivé — relire une vente six mois
   * plus tard sans savoir qu'une remise a joué laisserait croire à un
   * prix catalogue plus bas qu'il n'était.
   */
  montants?: MontantVente[] | null;
  /**
   * La marchandise au prix du catalogue, avant remise.
   *
   * Il s'enregistre plutôt que de se déduire : les lignes portent le
   * prix d'après remise, et remonter à l'envers à travers les arrondis
   * des prix unitaires rendait un sous-total faux de quelques francs.
   * Un document doit dire exactement ce qui s'est passé, pas à peu près.
   */
  sousTotalOrigine?: number | null;
  /** le devis dont cette vente est née ; absent si elle a commencé en commande.
      Posé au moment de la transformation : sans ce geste, aucun lien n'existe
      et le taux de devis aboutis ne veut plus rien dire. */
  devisId?: string | null;
  /** au-delà, le prix proposé n'engage plus. Facultatif : beaucoup de
      commerces ne bornent pas leurs devis. */
  validiteDevis?: string | null;
  /** Devis accepté : il reste un devis — le ranger avec les annulés
      mélangerait les réussites et les refus, et le taux de transformation
      ne voudrait plus rien dire. */
  accepte?: boolean;
  dateAcceptation?: string | null;
  /** la commande née de ce devis, pour aller la consulter */
  commandeId?: string | null;
  dateDevis?: string | null;
  dateCommande?: string | null;
  /**
   * Date promise au client. Facultative : un client qui vient chercher sa
   * commande quand il peut n'en a pas. Quand elle existe, c'est elle qui dit
   * si un dossier est en retard — l'ancienneté seule ne le dit pas.
   */
  dateLivraisonPrevue?: string | null;
  datePreparation?: string | null;
  datePret?: string | null;
  dateLivraison?: string | null;
  /** livré au client, ou récupéré par lui : le même fait, deux modes */
  modeRemise?: 'livraison' | 'retrait' | null;
  parDevis?: string | null;
  parCommande?: string | null;
  parPreparation?: string | null;
  parLivraison?: string | null;
  auteurDevis?: AuteurEtape | null;
  auteurCommande?: AuteurEtape | null;
  auteurPreparation?: AuteurEtape | null;
  auteurLivraison?: AuteurEtape | null;
  /** Quand on a demandé comment cette créance serait recouvrée. */
  planifieLe?: string | null;
  note?: string | null;
  userId: string;
  createdAt?: any;
}

/* ═══════════════════════ CALCULS ═══════════════════════ */

/** Valeur d'une quantité au coût porté par la ligne. */
function valeurLigne(l: LigneFlux, quantite: number | null | undefined): number {
  return (quantite ?? 0) * l.valeurUnitaire;
}

/** Ce que la source déclare avoir envoyé, à défaut ce qui a été demandé. */
export function valeurEnvoyee(lignes: LigneFlux[] | null | undefined): number {
  return (lignes ?? []).reduce(
    (s, l) => s + valeurLigne(l, l.quantiteExpediee ?? l.quantiteDemandee), 0);
}

/** Ce que le destinataire déclare avoir reçu ; 0 tant qu'il n'a pas compté. */
export function valeurRecue(lignes: LigneFlux[] | null | undefined): number {
  return (lignes ?? []).reduce((s, l) => s + valeurLigne(l, l.quantiteRecue), 0);
}

/**
 * Ce qu'un achat doit au fournisseur : la marchandise et ce qui l'a
 * amenée.
 *
 * Le transport est dû au même fournisseur — il livre et facture
 * ensemble. Le laisser hors du total ferait afficher une dette inférieure
 * à ce qu'on doit vraiment, et un dossier soldé alors qu'il reste le
 * transport à payer.
 *
 * Toute lecture de ce que coûte un achat passe par ici : la fiche, les
 * soldes, l'imputation d'un versement. Deux façons de compter la même
 * chose finissent toujours par se contredire.
 */
export function totalAchat(achat: {
  lignes?: LigneFlux[] | null;
  frais?: Frais[] | null;
}): number {
  return valeurRecue(achat.lignes ?? []) + totalFrais(achat.frais);
}

/**
 * Écart = envoyé − reçu, en valeur. Zéro est le cas normal : la carte ne sert
 * pas à afficher un chiffre, elle sert à ce qu'un chiffre non nul saute aux yeux.
 * L'écart est informationnel : aucune perte n'est constatée, la marchandise
 * non reçue est simplement restée chez l'expéditeur.
 */
export function ecartValeur(lignes: LigneFlux[]): number {
  return valeurEnvoyee(lignes) - valeurRecue(lignes);
}

/** Un écart ligne à ligne, pour montrer où le désaccord se situe. */
export function lignesEnEcart(lignes: LigneFlux[] | null | undefined): LigneFlux[] {
  return (lignes ?? []).filter(l =>
    l.quantiteRecue != null &&
    (l.quantiteExpediee ?? l.quantiteDemandee) !== l.quantiteRecue
  );
}

export function aUnEcart(lignes: LigneFlux[]): boolean {
  return lignesEnEcart(lignes).length > 0;
}

/**
 * L'écart se lit dans deux sens opposés qu'il ne faut pas compenser :
 * un fournisseur qui livre systématiquement moins ne pose pas le même
 * problème qu'un qui livre trop. Additionnés, les deux s'annuleraient
 * et un partenaire irrégulier passerait pour exact.
 */
export function ecartsSepares(
  lignes: LigneFlux[] | null | undefined,
): { positif: number; negatif: number } {
  /* Ligne à ligne, pas sur le net : un dossier où 5 000 manquent sur un
     produit et 5 000 dépassent sur un autre a deux écarts à trancher, pas
     zéro. Les solder d'avance les ferait disparaître de la vue. */
  return (lignes ?? []).reduce((acc, l) => {
    /* Rien reçu vaut zéro, pas « autant que commandé » : une commande sans
       livraison manque entièrement, elle n'est pas conforme. */
    const e = valeurLigne(l, l.quantiteDemandee) - valeurLigne(l, l.quantiteRecue ?? 0);
    return {
      positif: acc.positif + Math.max(0, e),
      negatif: acc.negatif + Math.max(0, -e),
    };
  }, { positif: 0, negatif: 0 });
}

/**
 * Combien de produits manquent, combien dépassent.
 *
 * Pendant d'`ecartsSepares`, en nombre de lignes plutôt qu'en francs. Qui
 * fait avancer les dossiers sans répondre des recettes n'a que faire du
 * montant : ce qu'il lui faut, c'est savoir sur combien de produits porter
 * une réclamation.
 */
export function produitsEnEcart(
  lignes: LigneFlux[] | null | undefined,
): { manque: number; surplus: number } {
  return (lignes ?? []).reduce((acc, l) => {
    /* Une ligne sans quantité reçue n'a pas d'écart : rien n'a été compté
       dessus. La lire « reçu zéro » inventerait un manque total — c'est ce
       qui faisait passer un transfert conforme (dont le stock a bougé sans
       que la ligne ait figé le reçu) pour un dossier entièrement manquant.
       Même règle que `lignesEnEcart` : pas de compte, pas d'écart. */
    if (l.quantiteRecue == null) return acc;
    const attendu = l.quantiteExpediee ?? l.quantiteDemandee;
    const recu = l.quantiteRecue;
    if (recu === attendu) return acc;
    return recu < attendu
      ? { ...acc, manque: acc.manque + 1 }
      : { ...acc, surplus: acc.surplus + 1 };
  }, { manque: 0, surplus: 0 });
}

/**
 * Un transfert expédié et pas encore reçu : la marchandise est dans le camion,
 * absente des deux stocks. C'est un état réel, pas un artifice comptable.
 */
export function estEnRoute(t: Pick<Transfert, 'etat'>): boolean {
  return t.etat === 'expedie';
}

/** Référence lisible, unique par jour et par site. */
export function referenceFlux(prefixe: string, date: string): string {
  const compact = date.replace(/-/g, '').slice(2);
  const alea = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefixe}${compact}-${alea}`;
}

/* ═══════════════════════ APPLICATION DU STOCK ═══════════════════════ */

interface VarianteStock {
  cle: string;
  stock: number;
  coutMoyen: number;
  [k: string]: any;
}

/**
 * Applique une ligne au stock d'un site, dans un lot déjà ouvert.
 * Une entrée repondère le coût moyen ; une sortie le laisse intact.
 * Un transfert ne dégage ni bénéfice ni perte : la valeur se déplace sans
 * se réaliser, et le receveur hérite du coût réel pour que ses futures
 * ventes affichent une marge exacte.
 */
/**
 * Ce qu'il faut savoir avant d'écrire, lu d'un seul coup.
 *
 * Écrire une ligne demande deux choses : le produit — ses emballages, ses
 * variantes — et ce que le site en détient. Les lire ligne par ligne
 * faisait attendre le serveur quatre fois par article, l'une après
 * l'autre : un bon de dix lignes payait quarante allers-retours avant que
 * le bouton ne réponde. Sur une connexion lente, l'attente se comptait en
 * secondes.
 *
 * Ici on les lit tous ensemble, en deux requêtes parallèles, puis chaque
 * ligne se sert dans ce qui est déjà là. Le nombre d'attentes ne dépend
 * plus du nombre d'articles.
 *
 * Le registre est vivant : `appliquerLigne` y réécrit le stock qu'elle
 * vient de changer. C'est ce qui permet à deux lignes du même produit —
 * un transfert qui sort ici et entre là — de se voir l'une l'autre, ce
 * que des lectures séparées ne faisaient pas.
 */
export interface RegistreLignes {
  produits: Map<string, any>;
  /** la détention, par `${siteId}:${produitId}` */
  detentions: Map<string, { id: string; data: any }>;
}

/** Découpe en paquets : Firestore n'accepte que 30 valeurs par `in`. */
function paquets<T>(liste: T[], taille: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += taille) out.push(liste.slice(i, i + taille));
  return out;
}

/**
 * Charge d'avance les produits et les détentions de plusieurs lignes.
 *
 * Un site peut détenir une marchandise qu'il n'a jamais achetée : sa
 * détention n'existe alors pas encore. On ne la crée pas ici — c'est
 * `appliquerLigne` qui s'en charge, au moment où elle sait qu'il y a
 * vraiment quelque chose à écrire.
 */
export async function precharger(
  lignes: { siteId: string; produitId: string }[],
): Promise<RegistreLignes> {
  const produitIds = [...new Set(lignes.map(l => l.produitId).filter(Boolean))];
  const siteIds = [...new Set(lignes.map(l => l.siteId).filter(Boolean))];

  const registre: RegistreLignes = { produits: new Map(), detentions: new Map() };
  if (produitIds.length === 0) return registre;

  /* Les deux familles de requêtes partent ensemble : elles ne dépendent
     pas l'une de l'autre. */
  const [snapsProduits, snapsDetentions] = await Promise.all([
    Promise.all(paquets(produitIds, 30).map(lot => getDocs(query(
      collection(db, 'produits'), where(documentId(), 'in', lot))))),
    /* Par produit, et non par site.
     *
     * Lire tout un site tenait en une requête, ce qui semblait économe :
     * un commerce de cinquante références n'en souffrait pas. Après une
     * reprise de catalogue il y en a trois cents, et confirmer un bon de
     * deux lignes en téléchargeait trois cents pour en garder deux. Le
     * reste partait à la poubelle quelques lignes plus bas.
     *
     * On ne demande plus que ce dont le bon a besoin. Firestore limite
     * un « in » à trente valeurs : au-delà, on découpe — et même
     * découpé, cela reste une fraction de ce qu'un site entier pèse. */
    Promise.all(siteIds.flatMap(s =>
      paquets(produitIds, 30).map(lot => getDocs(query(
        collection(db, 'produits_site'),
        where('siteId', '==', s),
        where('produitId', 'in', lot)))))),
  ]);

  for (const snap of snapsProduits) {
    for (const d of snap.docs) registre.produits.set(d.id, d.data());
  }
  const voulus = new Set(produitIds);
  for (const snap of snapsDetentions) {
    for (const d of snap.docs) {
      const x = d.data() as any;
      /* On ne garde que ce qui servira : la détention d'un produit absent
         du bon n'a rien à faire en mémoire. */
      if (!voulus.has(x.produitId)) continue;
      registre.detentions.set(`${x.siteId}:${x.produitId}`,
        { id: d.id, data: x });
    }
  }

  return registre;
}

async function appliquerLigne(
  batch: ReturnType<typeof writeBatch>,
  params: {
    siteId: string; userId: string; produitId: string; varianteCle?: string | null;
    sens: 'entree' | 'sortie'; motif: string; date: string;
    quantite: number; emballage?: string | null; valeurUnitaire: number;
    partenaireId?: string | null; partenaireNom?: string | null;
    siteLieId?: string | null; documentId: string;
    /* Ce que portait l'ancienne collection `mouvements` : le versant
       commercial du même geste. Les deux décrivaient la même ligne et
       devaient rester cohérentes à la main ; une seule écriture ne peut
       plus diverger d'elle-même. */
    designation?: string; unite?: string | null;
    utilisateurNom?: string | null; utilisateurFonction?: string | null;
    /**
     * Ce que la marchandise a coûté, quand il diffère de `valeurUnitaire`.
     * Exprimé dans l'emballage vendu, comme le prix et la quantité.
     */
    cout?: number;
    role?: 'client' | 'fournisseur' | null;
    type?: 'achat' | 'vente' | null;
    prixVente?: number | null;
    reference?: string | null;
    achatId?: string | null; venteId?: string | null;
    /* Cette écriture sert-elle une vente d'ordre ? Seule celle-là écrit
       chez un autre site et a besoin du marqueur `venteOuvrante`. Une
       vente au comptoir écrit chez elle : pas de marqueur, pas de lecture
       de règle gaspillée. */
    venteDOrdre?: boolean;
    mouvementOrigineId?: string | null;
    /**
     * Cette entree ne sait pas ce qu'elle a coute.
     *
     * Une ligne a zero n'est pas une ligne gratuite : c'est une ligne
     * dont le prix n'a jamais ete su. La difference compte — un cout de
     * zero fait du chiffre d'affaires entier un benefice.
     */
    coutInconnu?: boolean;
  },
  /**
   * Ce qui a été lu d'avance, quand l'appelant a préchargé.
   *
   * Absent, la fonction lit elle-même : un appel isolé n'a rien à
   * précharger, et on ne l'oblige pas à le faire.
   */
  registre?: RegistreLignes,
): Promise<void> {
  /* Ce qui autorise d'ecrire sur la detention d'un AUTRE site.
   *
     Les regles Firestore ne devinent pas qu'un transfert ou un ordre
     relie deux sites : il faut le leur dire, en posant sur la detention
     l'identifiant du dossier qui la fait bouger. Elles vont alors le
     lire et verifier que ce dossier existe et relie bien ces deux
     sites-la.
   *
     `mouvements.ts` le faisait deja ; ici on ne le faisait pas — et
     c'est ici qu'un transfert et une livraison d'ordre ecrivent. Toute
     ecriture chez le site d'en face etait donc refusee, sauf au
     proprietaire, qui passe par un autre chemin : en pratique un gerant
     ne pouvait pas livrer un ordre. */
  /* Le marqueur n'existe que pour une écriture chez un AUTRE site.
   *
     Un transfert et la livraison d'un ordre écrivent la détention d'un
     site où l'opérateur ne travaille pas : les règles ne l'autorisent
     qu'en lisant le dossier qui relie les deux sites, d'où `transfertOuvrant`
     / `venteOuvrante` posés sur la détention pour qu'elles le trouvent.
   *
     Une vente au comptoir, elle, écrit chez SON propre site. Elle n'a
     besoin d'aucun marqueur — et en poser un était un piège : la règle,
     voyant `venteOuvrante`, appelait `venteDOrdre(...)` qui lit la vente
     pour vérifier que c'est un ordre. Ce n'en est pas un, mais la lecture
     était faite, et combinée aux autres branches elle épuisait le plafond
     de dix lectures d'une règle AVANT d'atteindre `travailleSurLUnDes`.
     Firestore répondait alors « permission-denied », le lot de livraison
     échouait en entier, et la vente restait « livrée » sans stock sorti —
     une demi-vente que le gérant rejouait, doublant la dette.
   *
     On ne pose donc `venteOuvrante` que pour une vente d'ordre, la seule
     qui écrive réellement chez un autre site. */
  const marque: Record<string, string> =
    params.motif === 'transfert' && params.documentId
      ? { transfertOuvrant: params.documentId }
      : (params.motif === 'vente' && params.venteId && params.venteDOrdre === true
        ? { venteOuvrante: params.venteId }
        : {});

  const dejaLu = registre?.produits.get(params.produitId);
  const produit = dejaLu ?? (await (async () => {
    const snap = await getDoc(doc(db, 'produits', params.produitId));
    if (!snap.exists()) throw new Error(`Produit introuvable : ${params.produitId}`);
    return snap.data();
  })());
  if (!produit) throw new Error(`Produit introuvable : ${params.produitId}`);

  /* Le produit dit ce qu'est la marchandise — ses emballages, ses
     variantes ; la détention dit ce que CE site en a. Les confondre
     faisait entrer chez l'un le stock qui sortait de l'autre : un
     transfert écrivait ses deux mouvements sur la même fiche, et la
     marchandise n'arrivait jamais à destination. */
  const emballages = produit.emballages ?? [];
  const variantesProduit: VarianteStock[] = produit.variantes ?? [];
  const qteUnites = enUnitesBase(params.quantite, params.emballage, emballages);
  if (qteUnites <= 0) return;

  /* Un site peut recevoir une marchandise qu'il n'a jamais achetée : sa
     détention s'ouvre alors à cet instant, à zéro. */
  const cle = `${params.siteId}:${params.produitId}`;
  const enMemoire = registre?.detentions.get(cle);

  let refDetention;
  let detention: any;
  if (enMemoire) {
    refDetention = doc(db, 'produits_site', enMemoire.id);
    detention = enMemoire.data;
  } else {
    const detentionId = await ouvrirDetention({
      produitId: params.produitId, siteId: params.siteId, userId: params.userId,
      variantes: variantesProduit.map(v => ({
        cle: v.cle, stock: 0, coutMoyen: 0, prixVente: v.prixVente ?? null,
      })),
      /* Un produit que le destinataire n'avait jamais detenu : sa fiche
         de rayon nait ici, et les regles veulent savoir au nom de quel
         dossier on ecrit chez lui. */
      marqueOuvrante: marque,
    });
    refDetention = doc(db, 'produits_site', detentionId);
    /* Une détention qui vient de naître est à zéro : la relire ne
       montrerait que ce qu'on vient d'écrire. Sinon on la lit. */
    detention = ((await getDoc(refDetention)).data() ?? {}) as any;
    /* Elle rejoint le registre : la ligne suivante sur ce produit la
       trouvera, au lieu de la relire. */
    registre?.detentions.set(cle, { id: refDetention.id, data: detention });
  }
  const variantesSite: VarianteSite[] = detention.variantes ?? [];

  const variante = params.varianteCle
    ? variantesSite.find(v => v.cle === params.varianteCle)
    : undefined;
  /* Une variante demandee mais absente du rayon n'a rien en stock.
   *
     Le code retombait alors sur le total de la detention — la somme de
     toutes les variantes. Prelever du « rouge » que le rayon n'a jamais
     eu puisait donc dans le bleu et le vert : la garde laissait passer,
     le stock global baissait, et aucune variante ne savait laquelle
     avait maigri. Une variante demandee repond pour elle seule, meme
     quand sa reponse est zero. */
  const cibleVariante = !!params.varianteCle;
  const stockAvant = cibleVariante
    ? (variante?.stock ?? 0)
    : (detention.stock ?? 0);
  const coutAvant = cibleVariante
    ? (variante?.coutMoyen ?? 0)
    : (detention.coutMoyen ?? 0);
  /* Le rayon sait-il ce qu'il a payé ? Lu sur la détention qu'on tient
     déjà : un stock initial entre en quantité sans valeur, et ce qu'il
     ignore ne doit pas peser dans une moyenne. */
  const inconnuAvant: boolean = variante
    ? !!(variante as any).coutInconnu
    : !!detention.coutInconnu;

  /* Une entree qui porte un cout leve l'ignorance : son prix vaut pour
     tout le stock, faute de mieux a attribuer aux unites d'origine.
   *
     Mais une entree PEUT ne rien savoir — une marchandise transferee
     depuis un rayon qui ignorait deja son cout, par exemple. La regle
     disait `false` sans condition : le destinataire heritait alors d'un
     cout « connu » de zero, et le tableau de bord comptait tout son
     chiffre d'affaires en benefice. Le doute se transmet, il ne
     disparait pas en changeant de site.
   *
     Trois situations, les memes qu'a l'ecriture d'un mouvement : un
     rayon vierge qui recoit sans cout reste ignorant ; un rayon qui
     savait ne le redevient jamais ; une entree chiffree leve tout. */
  const entreeSansCout = params.sens === 'entree'
    && (!!params.coutInconnu || params.valeurUnitaire <= 0);
  const rayonVierge = stockAvant <= 0 && coutAvant <= 0;
  const inconnuApres = params.sens === 'entree'
    ? (inconnuAvant || rayonVierge) && entreeSansCout
    : inconnuAvant;

  /* Le coût se saisit dans l'emballage retenu, le stock se tient à
     l'unité : un carton de 25 ampoules à 19 825 vaut 793 la pièce. Les
     mêler écrivait le prix du carton sur des pièces — la fiche produit
     annonçait 32 115 là où l'inventaire, qui reconstruit depuis les
     mouvements, lisait 16 296. Deux chiffres pour un seul coût. */
  const coutUnite = params.quantite > 0
    ? (params.valeurUnitaire * params.quantite) / qteUnites
    : params.valeurUnitaire;

  const nouveauCout = params.sens === 'entree'
    ? coutMoyenApresEntree(
        stockAvant, coutAvant, qteUnites, coutUnite, inconnuAvant)
    : coutAvant;
  const nouveauStock = stockAvant + (params.sens === 'entree' ? 1 : -1) * qteUnites;

  batch.set(doc(collection(db, 'mouvements')), {
    siteId: params.siteId,
    userId: params.userId,
    produitId: params.produitId,
    varianteCle: params.varianteCle ?? null,
    sens: params.sens,
    motif: params.motif,
    date: params.date,
    quantite: params.quantite,
    emballage: params.emballage ?? null,
    quantiteUnites: qteUnites,
    /* `valeurUnitaire` porte le prix de ce qu'on a vendu — un carton si c'est
       un carton qui est parti. Le multiplier par les unités de base
       facturerait vingt-huit cartons pour un seul : le total se prend sur la
       quantité qui correspond à l'unité du prix. */
    valeurUnitaire: params.valeurUnitaire,
    valeurTotale: params.valeurUnitaire * params.quantite,
    /* Ce que la ligne a dégagé, figé au moment du geste.
       Il se déduit du prix et du coût — mais le coût moyen bouge à chaque
       entrée : recalculer la marge d'une vente de septembre avec le coût de
       décembre la ferait mentir. D'où ce chiffre écrit une fois.
       Un transfert déplace de la valeur sans la réaliser : ni bénéfice ni
       perte. Une perte détruit le stock : elle coûte son coût moyen. */
    ...(params.sens === 'sortie' && params.motif !== 'transfert' ? (
      /* Une sortie prise sur un rayon au coût inconnu n'a pas de marge.
         Zéro en ferait un bénéfice égal au prix de vente — l'inverse de
         ce qu'on cherche. Le drapeau dit qu'on ne sait pas, et le
         tableau de bord compte la vente sans compter son bénéfice. */
      /* Le drapeau du rayon ne suffit pas : il peut dire « je sais » et
         porter zero. Un rayon jamais approvisionne, un stock pose a la
         main, une reprise qui n'a pas saisi les couts — le coutMoyen
         vaut 0 et `coutInconnu` n'a jamais ete leve. La vente comptait
         alors 100 % de benefice : une marchandise payee 70 000 et
         revendue 70 000 apparaissait comme 70 000 de marge pure.
         Un cout nul sur une sortie ne veut pas dire « gratuit », il veut
         dire « on ne sait pas ». */
      (inconnuAvant || coutAvant <= 0)
        ? { coutMoyenAlors: null, benefice: null, margeInconnue: true }
        : {
          coutMoyenAlors: coutAvant,
          benefice: params.motif === 'perte'
            ? -coutAvant * qteUnites
            : (params.valeurUnitaire - (params.cout ?? params.valeurUnitaire))
              * params.quantite,
        }
    ) : {}),
    partenaireId: params.partenaireId ?? null,
    partenaireNom: params.partenaireNom ?? null,
    siteLieId: params.siteLieId ?? null,
    documentId: params.documentId,
    /* Le versant commercial de la même ligne : sans le prix de vente à côté
       du coût, la marge devrait être reconstituée ailleurs. */
    produit: params.designation ?? null,
    unite: params.unite ?? null,
    role: params.role ?? null,
    type: params.type ?? null,
    emballageContenu: params.emballage
      ? enUnitesBase(1, params.emballage, emballages)
      : 1,
    /* Sur une sortie, `valeurUnitaire` porte le prix obtenu ; le coût, lui,
       est celui que la marchandise avait coûté. Les confondre effacerait la
       marge.

       Les deux se disent dans l'unité de la quantité : si un carton est
       parti, le prix est celui du carton, et le coût aussi. C'est à la ligne
       du dossier de les tenir ainsi — convertir ici les multiplierait une
       seconde fois. */
    cout: params.cout ?? params.valeurUnitaire,
    prixVente: params.prixVente ?? 0,
    reference: params.reference ?? null,
    achatId: params.achatId ?? null,
    venteId: params.venteId ?? null,
    mouvementOrigineId: params.mouvementOrigineId ?? null,
    utilisateurNom: params.utilisateurNom ?? null,
    utilisateurFonction: params.utilisateurFonction ?? null,
    createdAt: serverTimestamp(),
  });

  /* Le prix de vente saisi à l'achat devient celui du produit : c'est là
     qu'on décide à combien la marchandise repartira, en connaissant ce
     qu'elle vient de coûter.
     Le champ arrive pré-rempli au prix en place ; ne pas y toucher le
     reconduit tel quel. C'est précisément le risque : un coût moyen qui
     monte peut passer au-dessus de ce prix reconduit, et la marchandise
     repartirait à perte. L'alerte à la confirmation est là pour ça. */
  /* Le prix suit la même règle que le coût : saisi par carton, il se
     stocke à la pièce. Sans cela, un carton de 25 vendu 625 000 inscrivait
     625 000 sur chaque ampoule. */
  const nouveauPrix = params.sens === 'entree'
    ? (params.prixVente != null && params.quantite > 0
        ? Math.round((params.prixVente * params.quantite) / qteUnites)
        : (params.prixVente ?? null))
    : null;

  /* Le stock s'inscrit chez le site qui détient la marchandise, jamais
     sur le produit : celui-ci appartient à toute l'activité. */
  if (params.varianteCle) {
    /* La variante peut manquer à la détention quand elle est née après
       elle : on l'y ajoute plutôt que de perdre le mouvement. */
    const connue = variantesSite.some(v => v.cle === params.varianteCle);
    const maj = connue
      ? variantesSite.map(v => v.cle === params.varianteCle
          ? {
              ...v, stock: nouveauStock, coutMoyen: nouveauCout,
              coutInconnu: inconnuApres,
              ...(nouveauPrix != null ? { prixVente: nouveauPrix } : {}),
            }
          : v)
      : [...variantesSite, {
          cle: params.varianteCle, stock: nouveauStock, coutMoyen: nouveauCout,
          coutInconnu: inconnuApres,
          prixVente: nouveauPrix ?? null,
        }];
    const total = maj.reduce((s, v) => s + v.stock, 0);
    batch.update(refDetention, { variantes: maj, stock: total, ...marque });
    /* Le registre suit ce que le lot écrira.
     *
     * Deux lignes du même produit — le même article compté deux fois sur
     * un bon — doivent s'enchaîner : la seconde part du stock que la
     * première a laissé. Sans cette mise à jour, chacune repartirait de
     * la même valeur et la dernière écrasserait l'autre. */
    if (enMemoire || registre?.detentions.has(cle)) {
      registre?.detentions.set(cle, {
        id: refDetention.id,
        data: { ...detention, variantes: maj, stock: total },
      });
    }
  } else {
    batch.update(refDetention, {
      stock: nouveauStock, coutMoyen: nouveauCout,
      coutInconnu: inconnuApres,
      ...(nouveauPrix != null ? { prixVente: nouveauPrix } : {}),
      ...marque,
    });
    if (enMemoire || registre?.detentions.has(cle)) {
      registre?.detentions.set(cle, {
        id: refDetention.id,
        data: {
          ...detention, stock: nouveauStock, coutMoyen: nouveauCout,
          coutInconnu: inconnuApres,
          ...(nouveauPrix != null ? { prixVente: nouveauPrix } : {}),
        },
      });
    }
  }
}

/**
 * Clôt un transfert : sortie du site source, entrée du site destination,
 * à la même valeur et pour la quantité réellement reçue.
 * Ce qui n'a pas été reçu n'a jamais quitté la source — aucune perte
 * n'est constatée, la marchandise manquante est restée chez l'expéditeur.
 */
export async function confirmerTransfert(params: {
  transfert: Transfert;
  userId: string;
  par: string;
  /* Le nom et la fonction de qui agit, recopiés sur le document : une
     archive doit dire qui a fait le geste, même des mois après, quand la
     fiche de l'employé a changé ou disparu. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  noteArbitrage?: string | null;
  /* Le role de qui clot. Un dossier « a confirmer » porte un ecart que le
     receveur a trouve : seul le proprietaire l'arbitre, jamais celui qui
     l'a declare. La garde est ici, pas qu'a l'ecran — un bouton cache ne
     protege pas la base. */
  roleSite?: Role | null;
}): Promise<void> {
  const { transfert } = params;
  if (transfert.etat === 'a_confirmer'
    && params.roleSite !== undefined && !peutArbitrerEcart(params.roleSite)) {
    throw new Error("Trancher un ecart revient au proprietaire.");
  }
  /* Un dossier en traitement est un dossier reçu dont les comptes divergent :
     c'est justement celui-là que la confirmation vient clore. */
  /* Un ordre ne passe pas par là.
   *
   * « Expédié », « reçu », « en traitement » décrivent une marchandise
   * qui voyage et qu'on compte à l'arrivée. Sur un ordre, elle ne voyage
   * pas : le client l'emporte depuis la source, et le site qui facture
   * ne verra jamais le colis. Lui demander de confirmer une réception
   * serait lui demander d'attester ce qu'il n'a pas vu.
   *
   * Le transfert se clôt donc depuis `preparation`, au moment où la
   * source remet la marchandise — et c'est bien cette remise, un geste
   * réel et constaté, qui autorise l'écriture des mouvements. */
  const estOrdre = (transfert as any).ordre === true;
  const depuisPreparation = estOrdre
    && (transfert.etat === 'preparation' || transfert.etat === 'en_cours');
  if (!depuisPreparation
    && transfert.etat !== 'recu' && transfert.etat !== 'traitement'
    && transfert.etat !== 'a_confirmer') {
    throw new Error('Seul un transfert reçu peut être confirmé.');
  }

  /* L'etat se relit sur la base, pas sur l'ecran.
   *
     Un transfert confirme deux fois sort la marchandise deux fois du
     site source et la fait entrer deux fois chez le destinataire : deux
     rayons fausses d'un coup, et le cout moyen des deux cotes avec eux.
     La verification ci-dessus porte sur l'objet charge a l'affichage, et
     ne voit rien d'un second appel lance entre-temps. */
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'transferts', transfert.id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Ce transfert n'existe plus.");
    const etat = snap.data().etat as EtatTransfert;
    if (etat === 'confirme') throw new Error('Ce transfert est déjà confirmé.');
    if (etat === 'annule') throw new Error('Ce transfert a été annulé.');
    tx.update(ref, { etat: 'confirme' as EtatTransfert });
  });

  const date = new Date().toISOString().split('T')[0];
  const batch = writeBatch(db);

  /* Tout ce que les lignes vont demander, lu d'un coup : la marchandise
     sort d'un site et entre dans l'autre, donc les deux détentions sont
     préchargées. */
  const registre = await precharger(transfert.lignes.flatMap(l => [
    { siteId: transfert.siteSourceId, produitId: l.produitId },
    { siteId: transfert.siteDestId, produitId: l.produitId },
  ]));

  for (const l of transfert.lignes) {
    /* la quantité qui bouge est celle que le destinataire a comptée */
    const qte = l.quantiteRecue ?? 0;
    if (qte <= 0) continue;

    await appliquerLigne(batch, {
      siteId: transfert.siteSourceId, userId: params.userId,
      produitId: l.produitId, varianteCle: l.varianteCle,
      sens: 'sortie', motif: 'transfert', date,
      quantite: qte, emballage: l.emballage, valeurUnitaire: l.valeurUnitaire,
      siteLieId: transfert.siteDestId, documentId: transfert.id,
      /* Qui a confirmé : c'est à cet instant que le stock bouge, pas à
         l'initiation du dossier. */
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
    }, registre);

    /* Le doute voyage avec la marchandise.
     *
       Si le rayon de la source ignore ce que coute ce produit, ce qui en
       part l'ignore aussi : le destinataire ne peut pas en savoir plus
       que celui qui lui envoie. Sans cela il heritait d'un cout « connu »
       de zero, et son tableau de bord comptait chaque vente en benefice
       entier. */
    const detSource = registre.detentions
      .get(`${transfert.siteSourceId}:${l.produitId}`);
    const sourceIgnore = !!detSource?.data?.coutInconnu
      || (l.valeurUnitaire ?? 0) <= 0;

    await appliquerLigne(batch, {
      siteId: transfert.siteDestId, userId: params.userId,
      produitId: l.produitId, varianteCle: l.varianteCle,
      sens: 'entree', motif: 'transfert', date,
      quantite: qte, emballage: l.emballage, valeurUnitaire: l.valeurUnitaire,
      coutInconnu: sourceIgnore,
      /* Le prix convenu à l'initiation prend effet ici : la marchandise
         entre dans son rayon, elle doit savoir à combien la revendre. Sans
         lui, un produit qu'elle n'avait jamais eu arriverait sans prix. */
      prixVente: l.prixVente ?? null,
      siteLieId: transfert.siteSourceId, documentId: transfert.id,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
    }, registre);
  }

  /* Un transfert produit deux documents, un par site : la marchandise sort
     ici et entre là-bas. N'en écrire aucun laissait l'historique des entrées
     et sorties aveugle à un mouvement qui en est pourtant un. */
  const valeur = valeurRecue(transfert.lignes);
  const nbLignes = transfert.lignes.filter(l => (l.quantiteRecue ?? 0) > 0).length;
  for (const [siteId, sens, siteLie] of [
    [transfert.siteSourceId, 'sortie', transfert.siteDestId],
    [transfert.siteDestId, 'entree', transfert.siteSourceId],
  ] as const) {
    batch.set(doc(collection(db, 'documents')), {
      reference: transfert.reference,
      siteId,
      sens,
      motif: 'transfert' as MotifDocument,
      achatId: null,
      venteId: null,
      transfertId: transfert.id,
      /* un transfert oppose deux sites internes, jamais un tiers */
      partenaireId: null,
      partenaireNom: null,
      siteLieId: siteLie,
      date,
      valeur,
      lignes: nbLignes,
      userId: params.userId,
      par: params.par ?? null,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      createdAt: serverTimestamp(),
    });
  }

  batch.update(doc(db, 'transferts', transfert.id), {
    etat: 'confirme',
    /* Les lignes figées, reçu compris, se gravent sur le document.
     *
       Le stock bougeait bien — il se lit sur ces mêmes lignes en mémoire —
       mais la mise à jour n'y réécrivait que l'état : le reçu comptté
       restait dans l'appelant et n'atteignait jamais la base. La fiche
       confirmée relisait alors un `quantiteRecue` nul, montrait « — » en
       reçu et un écart faux. On les inscrit ici : ce qui a fait bouger le
       stock est aussi ce que le dossier garde. */
    lignes: transfert.lignes,
    dateConfirmation: date,
    parConfirmation: params.par,
    auteurConfirmation: {
      nom: params.utilisateurNom ?? null,
      fonction: params.utilisateurFonction ?? null,
    },
    noteArbitrage: params.noteArbitrage ?? null,
  });

  await batch.commit();
}

/**
 * Clôt un achat : la marchandise reçue entre en stock au coût d'achat.
 * L'achat naît ici et pas avant — payer ne fait entrer aucune marchandise.
 * Si l'avance versée dépasse le reçu, la différence retourne en caisse :
 * la laisser chez le fournisseur en ferait une dette à suivre, or l'app
 * gère une activité, pas des créances sur des tiers.
 */
/**
 * Qui conclut un achat.
 *
 * Confirmer fait entrer la marchandise en stock et naître la dette : ce
 * geste constate un fait, il ne le décide pas. Il revient au responsable
 * des commandes, qui n'a pas passé la commande — celui qui décide d'une
 * dépense ne doit pas être celui qui atteste l'avoir reçue.
 *
 * Le propriétaire garde la main : sur un site sans responsable des
 * commandes, personne d'autre ne pourrait conclure, et les achats
 * s'empileraient sans issue.
 */
export function peutConfirmerAchat(roleSite: string | null | undefined): boolean {
  return roleSite === 'commandes' || roleSite === null || roleSite === undefined;
}

export async function confirmerAchat(params: {
  achat: Achat;
  userId: string;
  par: string;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /** Le rôle de qui agit ; `null` désigne le propriétaire. */
  roleSite?: string | null;
  /**
   * Où vit le dossier. Une importation est un achat par le stock qu'elle
   * fait entrer, mais elle a sa propre collection et sa propre suite
   * d'états : c'est elle qui pose `confirme`. Le marquer ici écrirait
   * dans `achats` un identifiant qui n'y est pas.
   */
  marquerDossier?: boolean;
  /**
   * Ce que la réception a constaté, posé dans le même lot.
   *
   * L'écran l'écrivait d'abord par un `updateDoc` à lui, puis appelait
   * cette fonction : deux allers-retours là où un suffit. Depuis
   * Brazzaville chacun coûte un demi-tour de réseau qu'on attend les bras
   * ballants — et les deux écritures portaient sur le même document.
   * Elles voyagent maintenant ensemble.
   */
  reception?: {
    dateReception: string;
    parReception: string;
    auteurReception: { nom: string; fonction: string } | null;
  } | null;
}): Promise<{ retourCaisse: number }> {
  const { achat } = params;
  /* Un bouton caché n'est pas une permission : la garde tient ici, pas
     à l'écran. */
  if (params.roleSite !== undefined && !peutConfirmerAchat(params.roleSite)) {
    throw new Error(
      'Confirmer une réception revient au responsable des commandes.');
  }
  /* L'achat né d'un ordre ne fait pas entrer de marchandise.
   *
   * Elle entre par la confirmation du transfert, qui pose déjà son coût
   * chez le destinataire. Le confirmer ici écrirait une seconde entrée :
   * un carton reçu, deux cartons en rayon. Cet achat n'existe que pour
   * porter la dette envers le site source, et c'est le transfert qui le
   * mène — il se confirme avec lui, pas par ce bouton. */
  if ((achat as any).ordreSansMouvement === true) {
    throw new Error(
      "Cet achat suit le transfert qui l'a créé : il se confirme avec lui.");
  }
  /* Un achat n'a plus que deux états : on reçoit au fil des livraisons, puis
     on confirme. Le palier « reçu » séparait la saisie de l'arbitrage, deux
     gestes qui n'en font plus qu'un depuis que les réceptions s'enregistrent
     une à une. Les dossiers qui le portent encore restent confirmables. */
  if (achat.etat !== 'en_attente' && achat.etat !== 'recu'
    && achat.etat !== 'traitement') {
    throw new Error('Cet achat ne peut plus être confirmé.');
  }

  /* L'etat se relit sur la base, pas sur l'ecran.
   *
     La verification ci-dessus porte sur l'objet charge a l'affichage.
     Entre ce chargement et l'ecriture il y a plusieurs allers-retours :
     un second poste, un onglet oublie ou une connexion qui rejoue
     trouvait le meme etat et confirmait aussi. La marchandise entrait
     deux fois en stock, et la dette fournisseur naissait deux fois.
   *
     La transaction relit et reserve. Le second appel trouve `confirme`
     et repart. `marquerDossier: false` designe l'importation, qui tient
     son propre cycle dans une autre collection : il n'y a rien a
     reserver dans `achats`. */
  if (params.marquerDossier !== false) {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'achats', achat.id);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("Cet achat n'existe plus.");
      const etat = snap.data().etat as EtatAchat;
      if (etat === 'confirme') throw new Error('Cet achat est déjà confirmé.');
      if (etat !== 'en_attente' && etat !== 'recu' && etat !== 'traitement') {
        throw new Error('Cet achat ne peut plus être confirmé.');
      }
      tx.update(ref, { etat: 'confirme' as EtatAchat });
    });
  }

  /* Les frais se posent entièrement, ou le dossier ne se confirme pas.
   *
   * Un frais à moitié réparti fait disparaître de l'argent : la dette le
   * porte, le coût des produits ne le porte pas, et la marge annoncée
   * est fausse de la différence. Rien à l'écran ne le dirait.
   *
   * La garde est ici et pas seulement sur le bouton : un écran peut être
   * contourné, l'écriture non. */
  const controle = controlerRepartition(
    achat.lignes, achat.frais, achat.fraisCorrection, achat.fraisCle);
  if (!controle.juste) {
    throw new Error(controle.motif ?? 'Les frais ne se répartissent pas en entier.');
  }

  const date = new Date().toISOString().split('T')[0];
  const recu = valeurRecue(achat.lignes);
  /* l'avance non consommée revient en caisse ; jamais négatif */
  const retourCaisse = Math.max(0, (achat.avanceVersee ?? 0) - recu);

  const batch = writeBatch(db);

  const registre = await precharger(achat.lignes.map(l => ({
    siteId: achat.siteId, produitId: l.produitId,
  })));

  /* Ce que chaque ligne porte du transport, de la douane, de la
     manutention. La part se déduit des frais et des quantités reçues —
     elle n'est écrite nulle part, sinon la première quantité corrigée la
     contredirait. */
  const parts = repartirFrais(
    achat.lignes, achat.frais, achat.fraisCorrection, achat.fraisCle);

  for (const [i, l] of achat.lignes.entries()) {
    const qte = l.quantiteRecue ?? 0;
    if (qte <= 0) continue;

    /* Le coût qui entre au rayon, frais compris.
     *
     * C'est lui qui pondère le coût moyen, pas le prix facturé : une
     * marchandise achetée 100 000 et transportée pour 10 000 a coûté
     * 110 000. Revendue 110 000 elle ne rapporte rien — et sans les
     * frais dans le coût, l'écran annoncerait 10 000 de bénéfice.
     *
     * La part est exprimée en unités de base ; `valeurUnitaire` est dans
     * l'emballage saisi. On divise donc par la quantité dans ce même
     * emballage, pour que les deux s'additionnent. */
    const part = parts[i] ?? 0;
    const coutLigne = part > 0
      ? l.valeurUnitaire + part / qte
      : l.valeurUnitaire;

    await appliquerLigne(batch, {
      siteId: achat.siteId, userId: params.userId,
      produitId: l.produitId, varianteCle: l.varianteCle,
      sens: 'entree', motif: 'achat', date,
      quantite: qte, emballage: l.emballage, valeurUnitaire: coutLigne,
      partenaireId: achat.fournisseurId ?? null,
      partenaireNom: achat.fournisseurNom,
      documentId: achat.id,
      /* Le versant commercial de la même ligne : sans `role` et `type`, les
         vues des partenaires ne savent pas de quel côté ranger l'opération. */
      designation: l.designation + (l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''),
      unite: l.unite ?? 'unité',
      role: 'fournisseur', type: 'achat',
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      prixVente: l.prixVente ?? 0,
      reference: achat.reference,
      achatId: achat.id,
    }, registre);
  }

  /**
   * L'achat prend corps chez le fournisseur : une ligne de mouvement par
   * produit, visible dans sa fiche. Sans elle, la marchandise entrerait en
   * stock sans qu'aucune trace ne relie l'opération à celui qui l'a livrée.
   */
  /* La dette du fournisseur ne s'écrit nulle part : elle est la somme des
     restes de ses achats confirmés, et se déduit à la lecture. L'écrire sur
     sa fiche créait un nombre qui survivait à la suppression de l'achat,
     sans que rien ne signale qu'il ne correspondait plus à rien. */

  if (params.marquerDossier !== false) {
    batch.update(doc(db, 'achats', achat.id), {
      /* Les lignes telles que la réception les a figées, quand l'appelant
         les confie : elles n'ont plus besoin de leur propre écriture. */
      ...(params.reception
        ? { lignes: achat.lignes, ...params.reception } : {}),
      etat: 'confirme',
      dateConfirmation: date,
      parConfirmation: params.par,
      auteurConfirmation: {
        nom: params.utilisateurNom ?? null,
        fonction: params.utilisateurFonction ?? null,
      },
      retourCaisse,
    });
  }

  /* Le document d'entrée : l'en-tête de ce qui vient de rentrer. Sans lui,
     une réception n'existait que dans ses lignes de mouvement, et rien ne
     permettait de lister les entrées du site. */
  batch.set(doc(collection(db, 'documents')), {
    reference: achat.reference,
    siteId: achat.siteId,
    sens: 'entree',
    motif: 'achat' as MotifDocument,
    achatId: achat.id,
    venteId: null,
    partenaireId: achat.fournisseurId ?? null,
    partenaireNom: achat.fournisseurNom,
    date,
    valeur: recu,
    lignes: achat.lignes.filter(l => (l.quantiteRecue ?? 0) > 0).length,
    userId: params.userId,
    par: params.par ?? null,
    utilisateurNom: params.utilisateurNom ?? null,
    utilisateurFonction: params.utilisateurFonction ?? null,
    createdAt: serverTimestamp(),
  });

  await batch.commit();
  return { retourCaisse };
}

/**
 * Livre une vente : la marchandise change de mains, et c'est seulement ici
 * que quelque chose devient irréversible. Avant, on annule sans rien défaire ;
 * après, on ne peut plus qu'enregistrer un retour — la marchandise appartient
 * au client, et on ne défait pas seul ce qu'on a fait à deux.
 *
 * Si l'avance dépasse le livré, la différence revient au client par la caisse :
 * la garder en ferait une dette envers lui, or l'app gère une activité, pas
 * des créances sur des tiers.
 */
export async function livrerVente(params: {
  vente: Vente;
  userId: string;
  par: string;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  mode?: 'livraison' | 'retrait';
}): Promise<{ retourCaisse: number }> {
  const { vente } = params;

  /* L'etat se relit sur la base, pas sur l'ecran.
   *
     Il etait verifie sur l'objet charge a l'affichage : entre ce
     chargement et l'ecriture, la vente a pu etre livree par quelqu'un
     d'autre — un second poste, un onglet oublie, une connexion qui
     rejoue. Les deux appels trouvaient `pret` et sortaient chacun la
     marchandise : un seul client servi, deux fois le stock parti et deux
     creances nees.
   *
     La transaction lit et ecrit sans que rien ne s'intercale. Elle pose
     `livre` tout de suite : le second appel trouve l'etat deja change et
     repart. Le stock suit, hors transaction — Firestore n'en accepte pas
     d'aussi longue — mais la course est fermee a l'endroit ou elle se
     jouait. */
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'ventes', vente.id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Cette vente n'existe plus.");
    const etat = snap.data().etat as EtatVente;
    if (etat === 'livre') throw new Error('Cette vente est déjà livrée.');
    if (etat !== 'pret' && etat !== 'preparation') {
      throw new Error('Seule une vente préparée peut être livrée.');
    }
    tx.update(ref, { etat: 'livre' as EtatVente });
  });

  const date = new Date().toISOString().split('T')[0];
  const livre = valeurVente(vente.lignes);
  const retourCaisse = Math.max(0, (vente.avanceVersee ?? 0) - livre);

  const batch = writeBatch(db);

  /* TRACE TEMPORAIRE — diagnostic demi-vente comptoir. À retirer. */
  const _trace = (etape: string, e?: any) => {
    // eslint-disable-next-line no-console
    console.error('[LIVRER_VENTE]', etape, vente.reference,
      e ? `-> ${e?.code ?? ''} ${e?.message ?? e}` : '');
  };

  let registre;
  try {
    registre = await precharger(vente.lignes.map(l => ({
      siteId: vente.siteId, produitId: l.produitId,
    })));
    _trace('precharger OK');
  } catch (e) { _trace('precharger ECHEC', e); throw e; }

  try {
  for (const l of vente.lignes) {
    const qte = l.quantiteRecue ?? l.quantiteDemandee;
    if (qte <= 0) continue;

    /* La marchandise prise chez un voisin entre avant de sortir.
     *
       Elle n'a jamais dormi chez nous, mais le registre doit la voir
       passer : sans cette entree, un audit du rayon trouve dix savons
       vendus et aucune sortie correspondante — un trou qu'il faut aller
       expliquer dans la fiche de vente.
     *
       Les deux mouvements se posent au meme instant, et le stock passe
       par zero net. Le cout moyen ne bouge donc pas : une entree
       aussitot annulee par sa sortie ne deplace aucune moyenne. */
    if (l.fournisseurId) {
      await appliquerLigne(batch, {
        siteId: vente.siteId, userId: params.userId,
        produitId: l.produitId, varianteCle: l.varianteCle,
        sens: 'entree', motif: 'achat', date,
        quantite: qte, emballage: l.emballage,
        valeurUnitaire: l.valeurUnitaire,
        partenaireId: l.fournisseurId,
        partenaireNom: l.fournisseurNom ?? null,
        documentId: vente.id,
        designation: l.designation + (l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''),
        unite: l.unite ?? 'unité',
        role: 'fournisseur', type: 'achat',
        utilisateurNom: params.utilisateurNom ?? null,
        utilisateurFonction: params.utilisateurFonction ?? null,
        reference: vente.reference,
        venteId: vente.id,
      }, registre);
    }

    await appliquerLigne(batch, {
      siteId: vente.siteId, userId: params.userId,
      produitId: l.produitId, varianteCle: l.varianteCle,
      sens: 'sortie', motif: 'vente', date,
      quantite: qte, emballage: l.emballage,
      /* une sortie se valorise au prix obtenu : c'est lui qui, face au coût
         moyen, fige le bénéfice de la ligne */
      valeurUnitaire: l.prixVente ?? 0,
      partenaireId: vente.clientId ?? null,
      partenaireNom: vente.clientNom,
      documentId: vente.id,
      /* Le coût diffère de `valeurUnitaire` sur une sortie : celui-ci porte
         le prix obtenu, celui-là ce que la marchandise avait coûté. */
      cout: l.valeurUnitaire,
      designation: l.designation + (l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''),
      unite: l.unite ?? 'unité',
      role: 'client', type: 'vente',
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      prixVente: l.prixVente ?? 0,
      reference: vente.reference,
      venteId: vente.id,
    }, registre);
  }
  _trace('appliquerLigne (toutes lignes) OK');
  } catch (e) { _trace('appliquerLigne ECHEC', e); throw e; }

  /* La vente prend corps chez le client : une ligne par produit dans sa fiche.
     Sans elle, le stock sortirait sans que rien ne relie l'opération à celui
     qui l'a emportée. */
  /* La créance se déduit des ventes livrées non soldées, comme la dette des
     achats : aucun chiffre stocké, donc rien qui puisse diverger. */

  batch.update(doc(db, 'ventes', vente.id), {
    etat: 'livre',
    dateLivraison: date,
    parLivraison: params.par,
    auteurLivraison: {
      nom: params.utilisateurNom ?? null,
      fonction: params.utilisateurFonction ?? null,
    },
    modeRemise: params.mode ?? 'livraison',
    retourCaisse,
  });

  /* Le document de sortie, pendant du document d'entrée : même collection,
     même forme, seul le sens change. Sa valeur est au prix de vente — c'est
     ce qui est sorti de l'activité, pas ce qu'il avait coûté. */
  batch.set(doc(collection(db, 'documents')), {
    reference: vente.reference,
    siteId: vente.siteId,
    sens: 'sortie',
    motif: 'vente' as MotifDocument,
    achatId: null,
    venteId: vente.id,
    partenaireId: vente.clientId ?? null,
    partenaireNom: vente.clientNom,
    date,
    valeur: livre,
    lignes: vente.lignes.filter(l => (l.quantiteRecue ?? l.quantiteDemandee) > 0).length,
    userId: params.userId,
    par: params.par ?? null,
    utilisateurNom: params.utilisateurNom ?? null,
    utilisateurFonction: params.utilisateurFonction ?? null,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    _trace('batch.commit OK');
  } catch (e) { _trace('batch.commit ECHEC', e); throw e; }

  /* Ce qu'on doit aux voisins qui ont dépanné.
   *
     Un dossier d'achat par fournisseur, déjà confirmé et sans mouvement :
     la marchandise vient d'entrer et de sortir ci-dessus. L'achat ne
     porte que la dette, et tout ce qui la lit — la fiche du partenaire,
     les versements, les totaux — marche sans qu'une ligne ait changé.
   *
     Après le commit : si cette écriture échoue, la vente est livrée et
     la dette manque — un défaut réparable, qui se voit. L'inverse
     laisserait une dette envers un voisin pour une vente qui n'a pas
     abouti, et celui-là ne se voit pas. */
  /* Import tardif : `vente-fournisseur` lit les types d'ici, et
     l'importer en tête formerait un cycle. */
  try {
    const { creerAchatsDeVente } = await import('@/lib/vente-fournisseur');
    await creerAchatsDeVente({
      vente, date, userId: params.userId,
      auteur: params.utilisateurNom
        ? { nom: params.utilisateurNom, fonction: params.utilisateurFonction ?? '' }
        : null,
    });
    _trace('creerAchatsDeVente OK');
  } catch (e) { _trace('creerAchatsDeVente ECHEC', e); throw e; }

  return { retourCaisse };
}

/** Convertit une quantité saisie dans un emballage vers l'unité de base. */
async function unitesDeBase(
  produitId: string, quantite: number, emballage?: string | null,
): Promise<number> {
  if (!emballage) return quantite;
  const snap = await getDoc(doc(db, 'produits', produitId));
  if (!snap.exists()) return quantite;
  return enUnitesBase(quantite, emballage, snap.data().emballages ?? []);
}

/* ═══════════════════════ LECTURE ═══════════════════════ */

/**
 * Un transfert appartient à deux sites : un seul document, deux lectures.
 * Le dupliquer par site ferait diverger les deux copies au premier écart.
 * Firestore ne sait pas faire un OU sur deux champs, d'où les deux requêtes.
 */
export async function chargerTransfertsDuSite(siteId: Portee): Promise<Transfert[]> {
  const [sortants, entrants] = await Promise.all([
    lireParSite('transferts', siteId, 'siteSourceId'),
    lireParSite('transferts', siteId, 'siteDestId'),
  ]);
  const parId = new Map<string, Transfert>();
  [...sortants, ...entrants].forEach(d => {
    parId.set(d.id, { id: d.id, ...d.data() } as Transfert);
  });
  return [...parId.values()].sort((a, b) =>
    (b.dateInitiation ?? '').localeCompare(a.dateInitiation ?? ''));
}

/**
 * Valeur d'une vente, au prix de vente et non au coût.
 * Sur une vente, `valeurUnitaire` porte le coût du produit — il sert à figer
 * le bénéfice à la sortie. Ce que le client doit, c'est `prixVente`.
 */
export function valeurVente(lignes: LigneFlux[] | null | undefined): number {
  /* Un dossier peut arriver sans ses lignes — un document de test, une
     vente interrompue. Le tableau vide vaut zero, la ou `undefined`
     faisait tomber toute la fiche. */
  return (lignes ?? []).reduce((s, l) =>
    s + (l.quantiteRecue ?? l.quantiteDemandee) * (l.prixVente ?? 0), 0);
}

/** Marge attendue : ce que la vente dégagerait aux prix portés par les lignes. */
export function beneficeAttendu(lignes: LigneFlux[] | null | undefined): number {
  return (lignes ?? []).reduce((s, l) => {
    const qte = l.quantiteRecue ?? l.quantiteDemandee;
    return s + qte * ((l.prixVente ?? 0) - l.valeurUnitaire);
  }, 0);
}

/** Un devis dont la validité est passée n'engage plus sur ses prix. */
export function devisExpire(v: Pick<Vente, 'etat' | 'validiteDevis'>): boolean {
  if (v.etat !== 'devis' || !v.validiteDevis) return false;
  return v.validiteDevis < new Date().toISOString().split('T')[0];
}

/**
 * Jours restants avant l'échéance du dossier, négatif s'il est dépassé.
 *
 * Chaque étape a sa propre échéance : un devis court vers son expiration, une
 * commande vers sa date de livraison promise. Compter les jours écoulés depuis
 * l'ouverture ne dirait rien — dix jours sont normaux si la livraison est
 * prévue dans trois semaines, et graves si elle était prévue hier.
 *
 * `null` quand le dossier n'a pas d'échéance : un devis sans date de validité,
 * une commande sans date promise, un dossier clos.
 */
export function joursRestants(v: Vente): number | null {
  const echeance = v.etat === 'devis' ? v.validiteDevis
    : (v.etat === 'commande' || v.etat === 'preparation' || v.etat === 'pret')
      ? v.dateLivraisonPrevue
      : null;
  if (!echeance) return null;
  const jour = 86400000;
  const auj = new Date(new Date().toISOString().split('T')[0]).getTime();
  return Math.round((new Date(echeance).getTime() - auj) / jour);
}

/**
 * Un dossier est-il encore vivant, au sens de l'écran de travail ?
 *
 * L'onglet ne montre pas l'histoire, il montre ce qui demande une action.
 * Un dossier clos ou mort n'y a plus sa place : il s'archive et se consulte
 * par le rapport, qui lui regarde une période.
 *
 * Un devis expiré tient un jour de plus : l'expiration arrive sans que
 * personne n'ait agi, et il faut la voir avant qu'elle ne disparaisse.
 */
export function venteActive(v: Vente): boolean {
  if (v.etat === 'annule') return false;
  /* un devis transformé n'attend plus rien : sa commande a pris le relais */
  if (v.etat === 'devis' && v.accepte) return false;

  const auj = new Date().toISOString().split('T')[0];

  if (v.etat === 'devis') {
    if (!v.validiteDevis) return true;
    /* expiré depuis plus d'un jour : il s'archive */
    return (joursRestants(v) ?? 0) >= -1;
  }

  /* Ce qui est livré appartient au passé, sauf ce qui l'a été aujourd'hui :
     c'est encore le travail du jour. */
  if (v.etat === 'livre') return v.dateLivraison === auj;

  /* Commande, préparation, prêt : vivants tant qu'on n'a pas agi. Une
     échéance dépassée ne les tue pas — c'est justement ce qu'il faut voir. */
  return true;
}

/** Le cycle est ouvert tant que la marchandise n'a pas changé de mains. */
export function venteEnCours(v: Pick<Vente, 'etat'>): boolean {
  return v.etat !== 'livre' && v.etat !== 'annule';
}

export async function chargerVentesDuSite(siteId: Portee): Promise<Vente[]> {
  return (await lireDocs<Vente>('ventes', siteId))
    /* Voir `chargerAchatsDuSite` : une ouverture n'est pas une vente. */
    .filter(v => !(v as any).ouverture)
    /* Un dossier sans marchandise.
     *
     * La collection ne porte pas que des ventes complètes : des soldes
     * d'ouverture y vivent, et un document interrompu avant sa première
     * ligne y reste. Le type promet `lignes`, la base ne le garantit
     * pas — et treize endroits de l'écran le lisent sans le demander.
     * Une liste entière tombait sur `v.lignes.length` pour un seul
     * document mal formé.
     *
     * Le tableau vide dit la vérité : ce dossier ne porte rien. Mieux
     * vaut une ligne à zéro produit qu'un écran qui ne s'ouvre pas. */
    .map(v => v.lignes ? v : { ...v, lignes: [] })
    .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
}

/**
 * Les documents d'entrée et de sortie d'un site, du plus récent au plus
 * ancien. Le `sens` se filtre à la lecture : deux collections séparées
 * auraient obligé chaque écran qui veut les deux à faire deux requêtes.
 */
export async function chargerDocumentsDuSite(
  siteId: Portee,
  sens?: 'entree' | 'sortie',
): Promise<DocumentFlux[]> {
  return (await lireDocs<DocumentFlux>('documents', siteId))
    .filter(d => !sens || d.sens === sens)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

export async function chargerAchatsDuSite(siteId: Portee): Promise<Achat[]> {
  return (await lireDocs<Achat>('achats', siteId))
    /* Les soldes d'ouverture vivent dans cette collection pour que les
       dettes les comptent, mais ce ne sont pas des achats : aucune
       marchandise n'a été commandée, et il n'y a rien à recevoir. Les
       laisser ici les ferait attendre une réception qui ne viendra
       jamais. Ils se lisent sur la fiche du partenaire. */
    .filter(a => !(a as any).ouverture)
    /* Même précaution que pour les ventes : le type promet `lignes`, la
       base ne le garantit pas, et un seul dossier mal formé fait tomber
       la liste entière. */
    .map(a => a.lignes ? a : { ...a, lignes: [] })
    .sort((a, b) => (b.dateCommande ?? '').localeCompare(a.dateCommande ?? ''));
}
