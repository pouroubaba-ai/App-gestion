/**
 * Un transfert qui sert une commande, et les deux dossiers qu'il entraîne.
 *
 * Un partenaire commande à son site et paye à son site : cela ne se
 * déplace pas. La marchandise, elle, peut venir d'ailleurs — d'un autre
 * site de l'activité, ou d'un fournisseur. Jusqu'ici l'app ne savait
 * écrire que la seconde moitié : l'admin faisait le transfert, puis
 * appelait le site destinataire pour lui dire de facturer tel client. Le
 * gérant resaisissait ce que l'admin venait d'écrire — mêmes produits,
 * mêmes quantités, mêmes prix — et c'est là que naissaient les erreurs,
 * sur un prix retapé ou une quantité mal relue.
 *
 * L'admin désigne donc le partenaire au moment du transfert, et trois
 * dossiers naissent ensemble :
 *
 *  - chez la source, un bon de commande : c'est elle qui prépare et qui
 *    remet, elle a besoin d'un dossier à faire avancer ;
 *  - le transfert lui-même, qui déplace la valeur — sans lui, le site
 *    destinataire vendrait une marchandise qu'il ne détient pas, et sa
 *    marge se calculerait sur un coût qu'il n'a jamais porté ;
 *  - chez le destinataire, la commande du client, qui porte la facture
 *    et la dette.
 *
 * Aucun des trois ne se suffit à lui-même, et c'est pourquoi ils sont
 * trois : le premier fait travailler, le deuxième fait les comptes entre
 * sites, le troisième fait la créance.
 *
 * Les deux premiers portent `ordre: true`. Ils ne sont pas nés d'une
 * demande qui leur est propre mais d'une commande reçue ailleurs, et cela
 * se voit à l'écran : sans cette marque, le responsable de la source
 * lirait un transfert ordinaire et chercherait à qui il correspond.
 */

import {
  collection, addDoc, doc, writeBatch, serverTimestamp, getDoc, updateDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  referenceFlux, type LigneFlux, type AuteurEtape,
  livrerVente,
} from './flux-marchandise';
import { ligneDepuisVente, synchroniserLignes } from './lignes-vente';

/** Ce que les trois dossiers partagent, et qui les relie. */
export interface LienOrdre {
  /** le transfert, pivot des trois */
  transfertId: string;
  /** le bon de commande du site qui expédie */
  commandeSourceId: string;
  /** la commande du client, chez le site qui facture */
  venteDestId: string;
}

/**
 * Écrit les trois dossiers en une fois.
 *
 * Un seul lot : trois écritures séparées pourraient s'interrompre au
 * milieu, et il resterait un transfert sans sa commande, ou une créance
 * sans la marchandise qui la justifie. Personne ne saurait alors lequel
 * des trois dit vrai.
 *
 * Les identifiants sont réservés avant d'écrire, parce que chaque dossier
 * doit porter ceux des deux autres : on ne peut pas les apprendre après
 * coup sans une seconde passe.
 */
export async function creerOrdreTransfert(params: {
  siteSourceId: string;
  siteSourceNom: string;
  siteDestId: string;
  siteDestNom: string;
  /** le client du site destinataire, qui recevra la facture */
  partenaireId: string;
  partenaireNom: string;
  lignes: LigneFlux[];
  /* Les emballages de chaque produit, pour convertir les cartons en
     unités. Sans eux, une commande de 3 cartons se lirait 3 pièces
     partout où le stock se compte. */
  emballagesParProduit: Record<string, { nom: string; quantite: number }[]>;
  date: string;
  note?: string | null;
  userId: string;
  auteur?: AuteurEtape | null;
}): Promise<LienOrdre> {
  if (params.lignes.length === 0) {
    throw new Error('Un ordre porte de la marchandise.');
  }
  if (!params.partenaireId) {
    throw new Error('Un ordre désigne le client qui recevra la facture.');
  }

  const batch = writeBatch(db);
  const refTransfert = doc(collection(db, 'transferts'));
  const refCommande = doc(collection(db, 'ventes'));
  const refVente = doc(collection(db, 'ventes'));

  const lien: LienOrdre = {
    transfertId: refTransfert.id,
    commandeSourceId: refCommande.id,
    venteDestId: refVente.id,
  };

  /* Le transfert. Il naît en attente comme tout transfert : c'est la
     source qui le fera avancer, puisque c'est elle qui tient la
     marchandise. */
  batch.set(refTransfert, {
    reference: referenceFlux('TR', params.date),
    siteSourceId: params.siteSourceId,
    siteSourceNom: params.siteSourceNom,
    siteDestId: params.siteDestId,
    siteDestNom: params.siteDestNom,
    etat: 'en_cours',
    lignes: params.lignes,
    dateInitiation: params.date,
    parInitiation: params.userId,
    auteurInitiation: params.auteur ?? null,
    note: params.note?.trim() || null,
    /* La marque. Elle dit que ce dossier obéit à une commande reçue
       ailleurs, et porte de quoi la retrouver. */
    ordre: true,
    ordreLien: lien,
    ordrePartenaireId: params.partenaireId,
    ordrePartenaireNom: params.partenaireNom,
    ordreSiteFactureId: params.siteDestId,
    /* Le nom à côté de l'identifiant, comme pour la source : la fiche
       doit dire où part la marchandise sans aller le chercher. */
    ordreSiteFactureNom: params.siteDestNom,
    userId: params.userId,
    createdAt: serverTimestamp(),
  });

  /* Le bon de commande de la source.
   *
   * Il n'a pas de client : le sien n'existe pas ici, il appartient au
   * site destinataire. Le champ porte tout de même son nom, pour que le
   * responsable sache à qui il remet — mais sans `clientId`, de sorte
   * qu'aucun solde ne se constitue de ce côté. La dette est à l'autre
   * bout, et une créance écrite ici la compterait deux fois. */
  batch.set(refCommande, {
    reference: referenceFlux('CV', params.date),
    siteId: params.siteSourceId,
    /* Pas de `clientId` : voir ci-dessus. */
    clientId: null,
    clientNom: params.partenaireNom,
    etat: 'commande',
    lignes: params.lignes,
    montants: [],
    sousTotalOrigine: params.lignes.reduce(
      (s, l) => s + l.quantiteDemandee * (l.prixVente ?? 0), 0),
    avanceVersee: 0,
    versements: [],
    devisId: null,
    validiteDevis: null,
    dateDevis: null,
    dateCommande: params.date,
    dateLivraisonPrevue: null,
    parCommande: params.userId,
    auteurCommande: params.auteur ?? null,
    note: params.note?.trim() || null,
    ordre: true,
    ordreLien: lien,
    ordrePartenaireId: params.partenaireId,
    ordrePartenaireNom: params.partenaireNom,
    ordreSiteFactureId: params.siteDestId,
    /* Le nom à côté de l'identifiant, comme pour la source : la fiche
       doit dire où part la marchandise sans aller le chercher. */
    ordreSiteFactureNom: params.siteDestNom,
    userId: params.userId,
    createdAt: serverTimestamp(),
  });

  /* La commande du client, chez le site qui facture.
   *
   * Celle-ci porte le `clientId` : c'est elle qui fait la créance, et
   * c'est à ce guichet que le partenaire paiera. */
  batch.set(refVente, {
    reference: referenceFlux('CV', params.date),
    siteId: params.siteDestId,
    clientId: params.partenaireId,
    clientNom: params.partenaireNom,
    etat: 'commande',
    lignes: params.lignes,
    montants: [],
    sousTotalOrigine: params.lignes.reduce(
      (s, l) => s + l.quantiteDemandee * (l.prixVente ?? 0), 0),
    avanceVersee: 0,
    versements: [],
    devisId: null,
    validiteDevis: null,
    dateDevis: null,
    dateCommande: params.date,
    dateLivraisonPrevue: null,
    parCommande: params.userId,
    auteurCommande: params.auteur ?? null,
    note: params.note?.trim() || null,
    /* Elle ne porte pas `ordre` : pour ce site, c'est une commande
       ordinaire — son client a commandé, il paiera ici. Ce qui lui est
       particulier, c'est seulement que sa marchandise vient d'ailleurs,
       et le lien le dit. */
    ordreLien: lien,
    ordreSiteSourceId: params.siteSourceId,
    /* Le nom, pas seulement l'identifiant : la fiche doit dire qui a
       servi la marchandise, et aller le chercher à chaque ouverture
       coûterait une lecture pour un mot qui ne change pas. */
    ordreSiteSourceNom: params.siteSourceNom,
    userId: params.userId,
    createdAt: serverTimestamp(),
  });

  await batch.commit();

  /* Les produits promis entrent dans leur collection.
   *
   * Une vente ordinaire le fait en s'enregistrant ; les deux commandes
   * d'un ordre naissent ici, et l'oublier les laissait sans lignes. Tout
   * ce qui part du produit plutôt que du dossier s'en trouvait faussé —
   * la préparation, le besoin par référence, et les retours, qui
   * cherchent la ligne d'origine pour savoir ce qui revient.
   *
   * C'est aussi là que le carton devient des pièces : la ligne garde sa
   * quantité telle qu'elle a été commandée, et porte à côté ce qu'elle
   * vaut en unités de base. Sans cette conversion, trois cartons se
   * lisaient trois pièces dès qu'un écran comptait du stock. */
  const lignesDe = (venteId: string, siteId: string,
    clientId: string | null, clientNom: string | null) =>
    params.lignes.map((l, i) => ligneDepuisVente({
      siteId, venteId, ligneIndex: i, ligne: l,
      emballages: params.emballagesParProduit[l.produitId] ?? [],
      clientId, clientNom,
    }));

  await Promise.all([
    synchroniserLignes({
      neuve: true, venteId: refCommande.id,
      lignes: lignesDe(refCommande.id, params.siteSourceId,
        /* Pas de client sur le bon de commande de la source : la
           créance est à l'autre bout. */
        null, params.partenaireNom),
    }),
    synchroniserLignes({
      neuve: true, venteId: refVente.id,
      lignes: lignesDe(refVente.id, params.siteDestId,
        params.partenaireId, params.partenaireNom),
    }),
  ]);

  return lien;
}

/** Ce dossier obéit-il à une commande reçue ailleurs ? */
export function estOrdre(dossier: any): boolean {
  return dossier?.ordre === true;
}

/** Ce dossier est-il l'un des trois d'un ordre, quel qu'il soit ? */
export function dansUnOrdre(dossier: any): boolean {
  return !!dossier?.ordreLien;
}

/**
 * Fait suivre une étape aux deux autres dossiers de l'ordre.
 *
 * C'est la source qui pilote : elle tient la marchandise, c'est elle qui
 * la rassemble, la prépare et la remet. Les deux autres dossiers n'ont
 * rien à décider — ils constatent. Les faire avancer à la main aurait
 * rendu au destinataire le travail qu'on venait de lui retirer, et deux
 * dossiers qu'on pousse séparément finissent toujours par se contredire.
 *
 * Le transfert suit un cycle raccourci. Ses étapes `expedie`, `recu` et
 * `traitement` existent pour une marchandise qui voyage et qu'on compte
 * à l'arrivée : ici elle ne voyage pas — le client l'emporte depuis la
 * source. La faire passer par « transféré » puis « reçu » demanderait au
 * destinataire de compter un colis qu'il ne verra jamais. Le transfert
 * va donc de `preparation` à `confirme` d'un trait, au moment où la
 * source remet la marchandise.
 *
 * Ce qui reste vrai, et qui est la raison d'être du transfert : la
 * valeur se déplace. Elle entre au stock du destinataire et en ressort
 * aussitôt par sa vente. Rien ne bouge physiquement, mais chaque site
 * porte ce qui lui revient — sans quoi la source perdrait de la
 * marchandise sans contrepartie, et le destinataire facturerait une
 * marge calculée sur un coût qu'il n'a jamais payé.
 */
/**
 * Clôt un ordre : la marchandise est remise au client.
 *
 * Un seul chemin pour la marchandise, et c'est le transfert qui le
 * trace : elle sort de la source, elle entre chez le destinataire, et
 * la vente de celui-ci l'en fait ressortir. Trois mouvements, un par
 * geste réel.
 *
 * Le bon de commande de la source, lui, n'écrit rien dans le stock.
 * C'est un ordre de travail : il dit au magasinier quoi rassembler et à
 * qui remettre. Le faire livrer comme une vente ordinaire ferait sortir
 * la marchandise une seconde fois — la source en perdrait deux pour un
 * seul ventilateur remis, et son coût moyen resterait faux pour
 * toujours.
 *
 * Il n'a pas de client non plus, et c'est voulu : la créance appartient
 * au site qui facture. Deux dossiers portant la même dette la
 * réclameraient deux fois.
 */
export async function remettreOrdre(params: {
  lien: LienOrdre;
  lignes: LigneFlux[];
  userId: string;
  date: string;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}): Promise<void> {
  const batch = writeBatch(db);

  /* Le bon de commande de la source : livré, sans mouvement. Ce qu'il
     avait à faire — faire préparer, faire remettre — est fait. */
  batch.update(doc(db, 'ventes', params.lien.commandeSourceId), {
    etat: 'livre',
    dateLivraison: params.date,
    parLivraison: params.userId,
    auteurLivraison: {
      nom: params.utilisateurNom ?? null,
      fonction: params.utilisateurFonction ?? null,
    },
    /* La marque qui dit pourquoi ce dossier n'a pas de mouvement : sans
       elle, un audit chercherait longtemps la sortie manquante. */
    ordreSansMouvement: true,
  });

  /* Le transfert porte les quantités réellement remises : c'est lui qui
     écrira les mouvements, et il ne peut le faire que sur ce qu'il sait
     être parti. */
  batch.update(doc(db, 'transferts', params.lien.transfertId), {
    lignes: params.lignes.map(l => ({
      ...l,
      /* Expédié et reçu valent le demandé : la quantité est celle qui a
         été dite, et elle était disponible — il n'y a pas de route où
         quelque chose pourrait se perdre, donc pas d'écart possible. */
      quantiteExpediee: l.quantiteDemandee,
      quantiteRecue: l.quantiteDemandee,
    })),
  });

  await batch.commit();
}

export async function propagerEtapeOrdre(params: {
  lien: LienOrdre;
  /** l'état que la source vient d'atteindre */
  etat: 'preparation' | 'pret' | 'livre' | 'annule';
  userId: string;
  date: string;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /* À la remise, le transfert a déjà été clos par `confirmerTransfert`,
     qui seul sait écrire les mouvements. Le repousser ici le ferait
     repasser par un état franchi, et son garde le refuserait. */
  transfertDejaClos?: boolean;
}): Promise<void> {
  const { lien, etat, date } = params;
  const batch = writeBatch(db);

  /* La commande du client suit pas pour pas : son gérant voit avancer ce
     qu'il n'a pas à pousser, et peut dire à son client où en est sa
     commande sans appeler l'autre site. */
  const champDate = etat === 'preparation' ? 'datePreparation'
    : etat === 'pret' ? 'datePret'
    : etat === 'livre' ? 'dateLivraison' : 'dateAnnulation';

  /* Livrer n'est pas changer d'état.
   *
   * La marchandise entre chez le destinataire par le transfert, et sa
   * vente doit l'en faire ressortir : c'est cette sortie qui fige la
   * marge et vide le rayon. En n'écrivant que l'état, le dossier se
   * disait livré pendant que les savons restaient en stock — facturés
   * au client, et pourtant encore vendables une seconde fois. La marge,
   * elle, ne se calculait sur rien.
   *
   * On passe donc par la même porte qu'une vente ordinaire. Les
   * quantités reçues sont posées d'abord : `livrerVente` sort ce qui a
   * été constaté, et sans elles il sortirait le demandé. */
  if (etat === 'livre') {
    const snap = await getDoc(doc(db, 'ventes', lien.venteDestId));
    if (snap.exists()) {
      const v = { id: snap.id, ...snap.data() } as any;
      await updateDoc(doc(db, 'ventes', lien.venteDestId), {
        etat: 'pret',
        datePret: v.datePret ?? date,
        datePreparation: v.datePreparation ?? date,
        lignes: (v.lignes ?? []).map((l: LigneFlux) => ({
          ...l, quantiteRecue: l.quantiteRecue ?? l.quantiteDemandee,
        })),
      });
      const frais = await getDoc(doc(db, 'ventes', lien.venteDestId));
      await livrerVente({
        vente: { id: frais.id, ...frais.data() } as any,
        userId: params.userId, par: params.userId,
        utilisateurNom: params.utilisateurNom ?? null,
        utilisateurFonction: params.utilisateurFonction ?? null,
      });
    }
  } else {
    batch.update(doc(db, 'ventes', lien.venteDestId), {
      etat,
      [champDate]: date,
      ordreAvanceLe: serverTimestamp(),
    });
  }

  /* Le transfert, à son rythme plus court. Il n'a que deux pas à faire :
     il se prépare quand la source prépare, et il se clôt quand elle
     remet. Entre les deux, rien — il n'y a pas de route. */
  const etatTransfert = etat === 'preparation' ? 'preparation'
    : etat === 'livre' ? 'confirme'
    : etat === 'annule' ? 'annule'
    : null;
  if (etatTransfert && !params.transfertDejaClos) {
    batch.update(doc(db, 'transferts', lien.transfertId), {
      etat: etatTransfert,
      ...(etatTransfert === 'preparation'
        ? { dateExpedition: date, parExpedition: params.userId }
        : {}),
      ...(etatTransfert === 'confirme'
        ? { dateConfirmation: date, parConfirmation: params.userId,
            /* Reçu et confirmé le même jour, par le même geste : la
               marchandise n'a pas attendu d'arriver, elle est partie
               avec le client. */
            dateReception: date, parReception: params.userId }
        : {}),
    });
  }

  await batch.commit();
}
