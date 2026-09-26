import {
  collection, doc, getDoc, getDocs, query, where,
  serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  ouvrirDetention, type VarianteSite,
} from '@/lib/produits-site';
import { coutMoyenApresEntree, enUnitesBase } from '@/lib/mouvements';
import { lireParSite, lireDocs, type Portee } from '@/lib/portee';

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
  preparation: 'En préparation',
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
 */
export function peutAnnulerDossier(role: Role | null): boolean {
  return role === null || role === 'admin' || role === 'gerant';
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
export function valeurEnvoyee(lignes: LigneFlux[]): number {
  return lignes.reduce((s, l) => s + valeurLigne(l, l.quantiteExpediee ?? l.quantiteDemandee), 0);
}

/** Ce que le destinataire déclare avoir reçu ; 0 tant qu'il n'a pas compté. */
export function valeurRecue(lignes: LigneFlux[]): number {
  return lignes.reduce((s, l) => s + valeurLigne(l, l.quantiteRecue), 0);
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
export function lignesEnEcart(lignes: LigneFlux[]): LigneFlux[] {
  return lignes.filter(l =>
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
export function ecartsSepares(lignes: LigneFlux[]): { positif: number; negatif: number } {
  /* Ligne à ligne, pas sur le net : un dossier où 5 000 manquent sur un
     produit et 5 000 dépassent sur un autre a deux écarts à trancher, pas
     zéro. Les solder d'avance les ferait disparaître de la vue. */
  return lignes.reduce((acc, l) => {
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
  lignes: LigneFlux[],
): { manque: number; surplus: number } {
  return lignes.reduce((acc, l) => {
    const attendu = l.quantiteExpediee ?? l.quantiteDemandee;
    const recu = l.quantiteRecue ?? 0;
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
    mouvementOrigineId?: string | null;
  },
): Promise<void> {
  const refProduit = doc(db, 'produits', params.produitId);
  const snap = await getDoc(refProduit);
  if (!snap.exists()) throw new Error(`Produit introuvable : ${params.produitId}`);
  const produit = snap.data();

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
  const detentionId = await ouvrirDetention({
    produitId: params.produitId, siteId: params.siteId, userId: params.userId,
    variantes: variantesProduit.map(v => ({
      cle: v.cle, stock: 0, coutMoyen: 0, prixVente: v.prixVente ?? null,
    })),
  });
  const refDetention = doc(db, 'produits_site', detentionId);
  const snapDet = await getDoc(refDetention);
  const detention = (snapDet.data() ?? {}) as any;
  const variantesSite: VarianteSite[] = detention.variantes ?? [];

  const variante = params.varianteCle
    ? variantesSite.find(v => v.cle === params.varianteCle)
    : undefined;
  const stockAvant = variante ? variante.stock : (detention.stock ?? 0);
  const coutAvant = variante ? variante.coutMoyen : (detention.coutMoyen ?? 0);

  const nouveauCout = params.sens === 'entree'
    ? coutMoyenApresEntree(stockAvant, coutAvant, qteUnites, params.valeurUnitaire)
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
    ...(params.sens === 'sortie' && params.motif !== 'transfert' ? {
      coutMoyenAlors: coutAvant,
      benefice: params.motif === 'perte'
        ? -coutAvant * qteUnites
        : (params.valeurUnitaire - (params.cout ?? params.valeurUnitaire))
          * params.quantite,
    } : {}),
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
  const nouveauPrix = params.sens === 'entree' ? (params.prixVente ?? null) : null;

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
              ...(nouveauPrix != null ? { prixVente: nouveauPrix } : {}),
            }
          : v)
      : [...variantesSite, {
          cle: params.varianteCle, stock: nouveauStock, coutMoyen: nouveauCout,
          prixVente: nouveauPrix ?? null,
        }];
    batch.update(refDetention, {
      variantes: maj,
      stock: maj.reduce((s, v) => s + v.stock, 0),
    });
  } else {
    batch.update(refDetention, {
      stock: nouveauStock, coutMoyen: nouveauCout,
      ...(nouveauPrix != null ? { prixVente: nouveauPrix } : {}),
    });
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
}): Promise<void> {
  const { transfert } = params;
  /* Un dossier en traitement est un dossier reçu dont les comptes divergent :
     c'est justement celui-là que la confirmation vient clore. */
  if (transfert.etat !== 'recu' && transfert.etat !== 'traitement'
    && transfert.etat !== 'a_confirmer') {
    throw new Error('Seul un transfert reçu peut être confirmé.');
  }

  const date = new Date().toISOString().split('T')[0];
  const batch = writeBatch(db);

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
    });

    await appliquerLigne(batch, {
      siteId: transfert.siteDestId, userId: params.userId,
      produitId: l.produitId, varianteCle: l.varianteCle,
      sens: 'entree', motif: 'transfert', date,
      quantite: qte, emballage: l.emballage, valeurUnitaire: l.valeurUnitaire,
      /* Le prix convenu à l'initiation prend effet ici : la marchandise
         entre dans son rayon, elle doit savoir à combien la revendre. Sans
         lui, un produit qu'elle n'avait jamais eu arriverait sans prix. */
      prixVente: l.prixVente ?? null,
      siteLieId: transfert.siteSourceId, documentId: transfert.id,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
    });
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
}): Promise<{ retourCaisse: number }> {
  const { achat } = params;
  /* Un bouton caché n'est pas une permission : la garde tient ici, pas
     à l'écran. */
  if (params.roleSite !== undefined && !peutConfirmerAchat(params.roleSite)) {
    throw new Error(
      'Confirmer une réception revient au responsable des commandes.');
  }
  /* Un achat n'a plus que deux états : on reçoit au fil des livraisons, puis
     on confirme. Le palier « reçu » séparait la saisie de l'arbitrage, deux
     gestes qui n'en font plus qu'un depuis que les réceptions s'enregistrent
     une à une. Les dossiers qui le portent encore restent confirmables. */
  if (achat.etat !== 'en_attente' && achat.etat !== 'recu'
    && achat.etat !== 'traitement') {
    throw new Error('Cet achat ne peut plus être confirmé.');
  }

  const date = new Date().toISOString().split('T')[0];
  const recu = valeurRecue(achat.lignes);
  /* l'avance non consommée revient en caisse ; jamais négatif */
  const retourCaisse = Math.max(0, (achat.avanceVersee ?? 0) - recu);

  const batch = writeBatch(db);

  for (const l of achat.lignes) {
    const qte = l.quantiteRecue ?? 0;
    if (qte <= 0) continue;

    await appliquerLigne(batch, {
      siteId: achat.siteId, userId: params.userId,
      produitId: l.produitId, varianteCle: l.varianteCle,
      sens: 'entree', motif: 'achat', date,
      quantite: qte, emballage: l.emballage, valeurUnitaire: l.valeurUnitaire,
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
    });
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

  batch.update(doc(db, 'achats', achat.id), {
    etat: 'confirme',
    dateConfirmation: date,
    parConfirmation: params.par,
    auteurConfirmation: {
      nom: params.utilisateurNom ?? null,
      fonction: params.utilisateurFonction ?? null,
    },
    retourCaisse,
  });

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
  if (vente.etat !== 'pret' && vente.etat !== 'preparation') {
    throw new Error('Seule une vente préparée peut être livrée.');
  }

  const date = new Date().toISOString().split('T')[0];
  const livre = valeurVente(vente.lignes);
  const retourCaisse = Math.max(0, (vente.avanceVersee ?? 0) - livre);

  const batch = writeBatch(db);

  for (const l of vente.lignes) {
    const qte = l.quantiteRecue ?? l.quantiteDemandee;
    if (qte <= 0) continue;

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
    });
  }

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

  await batch.commit();
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
export function valeurVente(lignes: LigneFlux[]): number {
  return lignes.reduce((s, l) =>
    s + (l.quantiteRecue ?? l.quantiteDemandee) * (l.prixVente ?? 0), 0);
}

/** Marge attendue : ce que la vente dégagerait aux prix portés par les lignes. */
export function beneficeAttendu(lignes: LigneFlux[]): number {
  return lignes.reduce((s, l) => {
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
    .sort((a, b) => (b.dateCommande ?? '').localeCompare(a.dateCommande ?? ''));
}
