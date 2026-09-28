import {
  collection, addDoc, doc, updateDoc, getDoc, getDocs, query, where,
  serverTimestamp, writeBatch, runTransaction,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ouvrirDetention, detentionDe, type VarianteSite } from '@/lib/produits-site';

export type SensMouvement = 'entree' | 'sortie';

export type MotifEntree = 'stock_initial' | 'achat' | 'transfert' | 'retour_client' | 'reajustement';
export type MotifSortie = 'vente' | 'transfert' | 'retour_fournisseur' | 'perte' | 'reajustement';

export interface Mouvement {
  id: string;
  siteId: string;
  produitId: string;
  /** clé de la variante concernée, absente si le produit n'en a pas */
  varianteCle?: string | null;
  sens: SensMouvement;
  motif: string;
  date: string;
  /** quantité telle que saisie, dans l'emballage choisi */
  quantite: number;
  emballage?: string | null;
  /** quantité convertie en unités de base : c'est elle qui bouge le stock */
  quantiteUnites: number;
  /** coût unitaire pour une entrée, prix unitaire pour une sortie */
  valeurUnitaire: number;
  /** valeurUnitaire × quantiteUnites */
  valeurTotale: number;
  /**
   * Sorties uniquement : figé à l'instant de la vente.
   * Un achat ultérieur change le coût moyen ; sans ce figeage,
   * le bénéfice des ventes passées serait réécrit rétroactivement.
   *
   * `null` quand le rayon ignorait ce qu'il avait payé : il n'y avait
   * aucun coût à figer.
   */
  coutMoyenAlors?: number | null;
  /**
   * Cette entrée n'apporte aucun coût — un stock de départ dont on
   * ignore le prix d'achat. `valeurUnitaire` vaut zéro faute de mieux,
   * et ce drapeau empêche de le lire comme « gratuit ».
   */
  coutInconnu?: boolean;
  /**
   * Cette sortie n'a pas de marge : elle a été prise sur un rayon dont
   * le coût n'était pas connu. Elle compte en chiffre d'affaires, pas en
   * bénéfice — zéro en ferait un gain égal au prix de vente.
   */
  margeInconnue?: boolean;
  benefice?: number | null;
  partenaireId?: string | null;
  partenaireNom?: string | null;
  /** site d'origine ou de destination pour un transfert */
  siteLieId?: string | null;
  /** facture ou bon auquel la ligne appartient */
  documentId?: string | null;
  /* Qui a fait le geste, recopié à l'instant où il a lieu : la fiche de
     l'employé changera, l'archive doit rester vraie. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  createdAt?: any;
}

interface Variante {
  cle: string;
  stock: number;
  coutMoyen: number;
  [k: string]: any;
}

/**
 * Nouveau coût moyen pondéré après une entrée.
 * (ancien stock × ancien coût + entrée × coût d'entrée) ÷ stock total.
 * Un stock nul ou négatif ne peut pas pondérer : on prend le coût d'entrée.
 *
 * Un stock dont le coût est inconnu ne pondère pas davantage. Le stock
 * initial entre en quantité sans valeur : le responsable sait ce qu'il a
 * en rayon, pas ce qu'il l'a payé. Le moyenner avec un chiffre posé au
 * jugé donnerait un coût dont la plus grande part serait inventée — sur
 * 922 unités d'origine et 375 achetées, l'invention garderait 71 % du
 * poids, et ne s'effacerait qu'au rythme des ventes.
 *
 * La première entrée réelle pose donc le coût entier, et il vaut pour
 * tout le stock : c'est le seul chiffre qu'on possède sur ce produit.
 * La part qui couvre les unités d'origine reste une estimation, mais
 * fondée sur une facture plutôt que sur une impression.
 */
export function coutMoyenApresEntree(
  stockActuel: number, coutActuel: number,
  quantiteEntree: number, coutEntree: number,
  coutInconnu?: boolean,
): number {
  if (quantiteEntree <= 0) return coutActuel;
  if (stockActuel <= 0) return coutEntree;
  if (coutInconnu) return coutEntree;
  return Math.round(
    (stockActuel * coutActuel + quantiteEntree * coutEntree) / (stockActuel + quantiteEntree)
  );
}

/**
 * Un conditionnement : le nom sous lequel la marchandise se groupe, et
 * combien d'unités il contient.
 *
 * `variantes` dit à quelles déclinaisons il s'applique. Vide ou absent,
 * il vaut pour tout le produit — c'est le cas courant, et c'est ce que
 * portaient tous les emballages avant que la distinction existe.
 */
export interface Emballage {
  nom: string;
  quantite: number;
  /** les clés de variantes concernées ; vide = commun à toutes */
  variantes?: string[] | null;
}

/**
 * Les conditionnements proposés pour une déclinaison donnée.
 *
 * Un carton d'ampoules 10W n'en contient pas le même nombre qu'un carton
 * de 30W. Montrer tous les conditionnements du produit à chaque variante
 * obligeait le vendeur à savoir lequel valait pour ce qu'il tient en
 * main — et une erreur là-dessus fait sortir du stock qui n'existe pas.
 *
 * Une variante reçoit donc les conditionnements communs, plus les siens.
 * Sans aucun des deux, elle se vend à la pièce : un produit qui n'a pas
 * de conditionnement n'en a pas, ce n'est pas un manque à combler.
 */
export function emballagesDe(
  emballages: Emballage[] | null | undefined,
  varianteCle?: string | null,
): Emballage[] {
  const tous = emballages ?? [];
  /* Sans variante choisie, on montre tout : c'est la fiche du produit,
     pas une ligne de vente. */
  if (!varianteCle) return tous;
  return tous.filter(e => {
    const liees = e.variantes ?? [];
    return liees.length === 0 || liees.includes(varianteCle);
  });
}

/**
 * Deux conditionnements peuvent-ils porter le même nom ?
 *
 * Oui, tant qu'ils ne se rencontrent jamais. « Carton » vaut 10 pièces
 * pour le 10W et 6 pour le 30W : c'est le même mot parce que c'est le
 * même objet, seul son contenu change. Interdire le doublon obligeait à
 * l'appeler « Carton 30W », ce qui répète dans le nom ce que la colonne
 * des déclinaisons dit déjà.
 *
 * Ce qui reste interdit, c'est qu'une même déclinaison voie deux
 * « Carton » de contenus différents : le vendeur ne saurait pas lequel
 * il tient. Un conditionnement commun se heurte donc à tous, et deux
 * conditionnements réservés ne se heurtent que s'ils partagent une
 * déclinaison.
 */
export function nomDejaPris(
  emballages: Emballage[] | null | undefined,
  nom: string,
  variantes: string[] | null | undefined,
): boolean {
  const cherche = nom.trim().toLowerCase();
  if (!cherche) return false;
  const miennes = variantes ?? [];

  return (emballages ?? []).some(e => {
    if (e.nom.trim().toLowerCase() !== cherche) return false;
    const siennes = e.variantes ?? [];
    /* L'un des deux vaut pour tout le produit : il croise forcément
       l'autre, quelle que soit sa portée. */
    if (miennes.length === 0 || siennes.length === 0) return true;
    return miennes.some(v => siennes.includes(v));
  });
}

/** Convertit une quantité exprimée dans un emballage en unités de base. */
export function enUnitesBase(
  quantite: number, nomEmballage: string | null | undefined,
  emballages: { nom: string; quantite: number }[],
): number {
  if (!nomEmballage) return quantite;
  const emb = emballages.find(e => e.nom === nomEmballage);
  return quantite * (emb ? emb.quantite : 1);
}

export interface SaisieMouvement {
  siteId: string;
  userId: string;
  produitId: string;
  varianteCle?: string | null;
  sens: SensMouvement;
  motif: string;
  date: string;
  quantite: number;
  emballage?: string | null;
  valeurUnitaire: number;
  /**
   * Cette entrée n'apporte aucun coût : elle compte de la marchandise
   * sans savoir ce qu'elle a coûté. `valeurUnitaire` vaut zéro faute de
   * mieux — un mouvement porte toujours un nombre — et ce drapeau
   * empêche de le lire comme « gratuit ».
   */
  coutInconnu?: boolean;
  partenaireId?: string | null;
  partenaireNom?: string | null;
  siteLieId?: string | null;
  documentId?: string | null;
  /* Qui fait le geste : son nom et sa fonction se figent sur le mouvement,
     la fiche de l'employé pourra changer sans réécrire l'archive. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}

/**
 * Enregistre un mouvement et met à jour le produit dans la foulée.
 * Une entrée recalcule le coût moyen ; une sortie fige le bénéfice.
 * Tout passe par un lot d'écritures : soit les deux réussissent, soit aucune.
 */
/**
 * Écrit plusieurs lignes en une seule fois.
 *
 * Le stock de dix produits, c'était dix fois le même aller-retour : lire
 * la fiche, chercher le rayon, le relire, écrire — et recommencer. Sur un
 * dossier de reprise à cent lignes, l'attente se comptait en minutes.
 *
 * Ici tout se lit d'un coup, tout se calcule en mémoire, tout s'écrit
 * dans un seul lot. Le nombre d'attentes ne dépend plus du nombre
 * d'articles.
 *
 * Et le lot passe entier ou pas du tout. Dix écritures séparées pouvaient
 * s'interrompre à la septième : sept mouvements inscrits, trois perdus, un
 * stock faux et rien pour dire lequel. Un fait s'enregistre ; une
 * livraison à moitié écrite n'est pas un fait.
 *
 * Firestore borne un lot à 500 opérations, et chaque ligne en coûte deux :
 * au-delà de 250 lignes on écrit en plusieurs lots. La garantie du tout ou
 * rien vaut alors par lot — sur un dossier de cette taille, c'est le prix
 * à payer pour qu'il passe.
 */
export async function ecrireLignesEnLot(
  lignes: SaisieMouvement[],
  registre: {
    produits: Map<string, any>;
    detentions: Map<string, { id: string; data: any }>;
  },
): Promise<number> {
  if (lignes.length === 0) return 0;

  const MAX_LIGNES = 250;
  let ecrites = 0;

  for (let debut = 0; debut < lignes.length; debut += MAX_LIGNES) {
    const tranche = lignes.slice(debut, debut + MAX_LIGNES);
    const batch = writeBatch(db);

    for (const saisie of tranche) {
      const produit = registre.produits.get(saisie.produitId);
      if (!produit) throw new Error(`Produit introuvable : ${saisie.produitId}`);

      const cle = `${saisie.siteId}:${saisie.produitId}`;
      const det = registre.detentions.get(cle);
      if (!det) {
        /* Le rayon n'existe pas encore pour cet article. On ne le crée pas
           ici : ouvrir une détention est une écriture, et elle doit être
           faite avant que le lot ne se forme. */
        throw new Error(
          `Détention absente pour ${saisie.produitId} sur ${saisie.siteId}.`);
      }

      const emballages = produit.emballages ?? [];
      const qteUnites = enUnitesBase(saisie.quantite, saisie.emballage, emballages);
      if (qteUnites <= 0) continue;

      const variantesSite: VarianteSite[] = det.data.variantes ?? [];
      const variante = saisie.varianteCle
        ? variantesSite.find(v => v.cle === saisie.varianteCle)
        : undefined;
      const stockAvant = variante ? variante.stock : (det.data.stock ?? 0);
      const coutAvant = variante ? variante.coutMoyen : (det.data.coutMoyen ?? 0);
      /* Le rayon sait-il ce qu'il a payé ? Lu sur la détention, qu'on
         tient déjà en main : pas une lecture de plus. */
      const inconnuAvant: boolean = variante
        ? !!variante.coutInconnu
        : !!det.data.coutInconnu;

      /* Une entrée sans coût n'apprend rien : le rayon reste dans son
         ignorance. Une entrée qui en porte un la lève — et son coût vaut
         alors pour tout le stock, faute de mieux à attribuer aux unités
         d'origine. */
      const entreeSansCout = saisie.sens === 'entree' && !!saisie.coutInconnu;
      /* Trois situations, et elles ne se confondent pas.

         Le rayon n'a jamais rien su — ni coût, ni stock : une entrée
         sans coût le laisse ignorant, et c'est ainsi qu'un produit naît
         avec son stock de départ.

         Le rayon ignorait déjà : il continue d'ignorer.

         Le rayon savait : ce qu'on a appris ne se désapprend pas, même
         si le stock est passé par zéro entre-temps — sinon un produit
         perdrait sa valeur chaque fois qu'il se vide. */
      const rayonVierge = stockAvant <= 0 && coutAvant <= 0;
      const inconnuApres = saisie.sens === 'entree'
        ? (inconnuAvant || rayonVierge) && entreeSansCout
        : inconnuAvant;

      /* Le coût se saisit dans l'emballage, le stock se tient à l'unité :
         les mêler écrirait le prix du carton sur chaque pièce. */
      const coutUnite = saisie.quantite > 0
        ? (saisie.valeurUnitaire * saisie.quantite) / qteUnites
        : saisie.valeurUnitaire;

      const nouveauCout = saisie.sens === 'entree'
        ? (entreeSansCout
            ? coutAvant
            : coutMoyenApresEntree(
                stockAvant, coutAvant, qteUnites, coutUnite,
                inconnuAvant))
        : coutAvant;
      const nouveauStock = stockAvant + (saisie.sens === 'entree' ? 1 : -1) * qteUnites;

      batch.set(doc(collection(db, 'mouvements')), {
        siteId: saisie.siteId,
        userId: saisie.userId,
        produitId: saisie.produitId,
        varianteCle: saisie.varianteCle ?? null,
        sens: saisie.sens,
        motif: saisie.motif,
        date: saisie.date,
        quantite: saisie.quantite,
        emballage: saisie.emballage ?? null,
        quantiteUnites: qteUnites,
        valeurUnitaire: saisie.valeurUnitaire,
        valeurTotale: saisie.valeurUnitaire * qteUnites,
        /* La même règle qu'à l'unité : une perte coûte son coût moyen, une
           sortie sans prix ne réalise rien. La réécrire ici la ferait
           diverger le jour où l'une des deux changerait. */
        /* Une entrée qui ne sait pas ce qu'elle a coûté le dit. */
        ...(entreeSansCout ? { coutInconnu: true } : {}),
        /* Une sortie prise sur un rayon au coût inconnu n'a pas de marge.
           Écrire zéro en ferait un bénéfice égal au prix de vente — pire
           que le chiffre inventé qu'on cherchait à éviter. Le drapeau dit
           qu'on ne sait pas, et le tableau de bord compte la vente en
           chiffre d'affaires sans la compter en bénéfice. */
        ...(saisie.sens === 'sortie' && saisie.motif !== 'transfert' ? (
          inconnuAvant
            ? { coutMoyenAlors: null, benefice: null, margeInconnue: true }
            : {
              coutMoyenAlors: coutAvant,
              benefice: saisie.motif === 'perte'
                ? -coutAvant * qteUnites
                : saisie.valeurUnitaire <= 0
                ? 0
                : (saisie.valeurUnitaire - coutAvant) * qteUnites,
            }
        ) : {}),
        partenaireId: saisie.partenaireId ?? null,
        partenaireNom: saisie.partenaireNom ?? null,
        siteLieId: saisie.siteLieId ?? null,
        documentId: saisie.documentId ?? null,
        utilisateurNom: saisie.utilisateurNom ?? null,
        utilisateurFonction: saisie.utilisateurFonction ?? null,
        createdAt: serverTimestamp(),
      });

      const refDetention = doc(db, 'produits_site', det.id);
      if (saisie.varianteCle) {
        const connue = variantesSite.some(v => v.cle === saisie.varianteCle);
        const maj: VarianteSite[] = connue
          ? variantesSite.map(v => v.cle === saisie.varianteCle
              ? { ...v, stock: nouveauStock, coutMoyen: nouveauCout,
                  coutInconnu: inconnuApres }
              : v)
          : [...variantesSite, {
              cle: saisie.varianteCle, stock: nouveauStock, coutMoyen: nouveauCout,
              coutInconnu: inconnuApres,
            }];
        const total = maj.reduce((n, v) => n + (v.stock ?? 0), 0);
        batch.update(refDetention, { variantes: maj, stock: total });
        registre.detentions.set(cle, {
          id: det.id, data: { ...det.data, variantes: maj, stock: total },
        });
      } else {
        batch.update(refDetention, {
          stock: nouveauStock, coutMoyen: nouveauCout,
          coutInconnu: inconnuApres,
        });
        /* Le rayon suit ce que le lot écrira : deux lignes du même article
           s'enchaînent au lieu de repartir du même stock. Le drapeau les
           suit aussi — sinon la seconde ligne d'un même produit croirait
           encore le coût inconnu alors que la première vient de le
           poser. */
        registre.detentions.set(cle, {
          id: det.id,
          data: { ...det.data, stock: nouveauStock, coutMoyen: nouveauCout,
                  coutInconnu: inconnuApres },
        });
      }

      ecrites += 1;
    }

    await batch.commit();
  }

  return ecrites;
}

export async function enregistrerMouvement(saisie: SaisieMouvement): Promise<Mouvement> {
  const refProduit = doc(db, 'produits', saisie.produitId);
  const snap = await getDoc(refProduit);
  if (!snap.exists()) throw new Error('Produit introuvable');
  const produit = snap.data();

  const emballages = produit.emballages ?? [];
  const qteUnites = enUnitesBase(saisie.quantite, saisie.emballage, emballages);
  const signe = saisie.sens === 'entree' ? 1 : -1;

  /* Le produit dit ce qu'est la marchandise, la détention ce que CE site
     en a : le stock appartient au site, jamais à l'activité. */
  const detentionId = await ouvrirDetention({
    produitId: saisie.produitId, siteId: saisie.siteId, userId: saisie.userId,
  });
  const refDetention = doc(db, 'produits_site', detentionId);
  const detention = ((await getDoc(refDetention)).data() ?? {}) as any;
  const variantesSite: VarianteSite[] = detention.variantes ?? [];

  const variante = saisie.varianteCle
    ? variantesSite.find(v => v.cle === saisie.varianteCle)
    : undefined;
  const stockAvant = variante ? variante.stock : (detention.stock ?? 0);
  const coutAvant = variante ? variante.coutMoyen : (detention.coutMoyen ?? 0);
  /* La même règle qu'en lot : un rayon qui ignore ce qu'il a payé ne
     pondère rien, et ce qu'il a appris ne se désapprend pas. */
  const inconnuAvant: boolean = variante
    ? !!variante.coutInconnu
    : !!detention.coutInconnu;
  const entreeSansCout = saisie.sens === 'entree' && !!saisie.coutInconnu;
  /* La même règle qu'en lot : un rayon vierge peut devenir ignorant, un
     rayon qui savait ne le redevient jamais. */
  const rayonVierge = stockAvant <= 0 && coutAvant <= 0;
  const inconnuApres = saisie.sens === 'entree'
    ? (inconnuAvant || rayonVierge) && entreeSansCout
    : inconnuAvant;

  /* Même règle qu'en lot : le coût saisi est celui de l'emballage. */
  const coutUnite = saisie.quantite > 0
    ? (saisie.valeurUnitaire * saisie.quantite) / qteUnites
    : saisie.valeurUnitaire;

  const nouveauCout = saisie.sens === 'entree'
    ? (entreeSansCout
        ? coutAvant
        : coutMoyenApresEntree(
            stockAvant, coutAvant, qteUnites, coutUnite,
            inconnuAvant))
    : coutAvant;
  const nouveauStock = stockAvant + signe * qteUnites;

  const mouvement: Omit<Mouvement, 'id'> = {
    siteId: saisie.siteId,
    produitId: saisie.produitId,
    varianteCle: saisie.varianteCle ?? null,
    sens: saisie.sens,
    motif: saisie.motif,
    date: saisie.date,
    quantite: saisie.quantite,
    emballage: saisie.emballage ?? null,
    quantiteUnites: qteUnites,
    valeurUnitaire: saisie.valeurUnitaire,
    valeurTotale: saisie.valeurUnitaire * qteUnites,
    /* Un transfert déplace de la valeur sans la réaliser : ni bénéfice ni perte.
       Une perte détruit le stock : elle coûte son coût moyen.
       Une vente réalise la marge entre le prix obtenu et le coût moyen.
       Une sortie sans prix — un don, un usage interne — ne réalise rien :
       la marchandise a servi, elle n'est pas perdue. La formule de la
       marge lui donnait pourtant `0 − coût`, soit exactement le calcul
       d'une perte : la distinction s'effondrait à l'écriture, et tout ce
       qui sortait gratuitement grevait le bénéfice. */
    ...(entreeSansCout ? { coutInconnu: true } : {}),
    ...(saisie.sens === 'sortie' && saisie.motif !== 'transfert' ? (
      inconnuAvant
        ? { coutMoyenAlors: null, benefice: null, margeInconnue: true }
        : {
          coutMoyenAlors: coutAvant,
          benefice: saisie.motif === 'perte'
            ? -coutAvant * qteUnites
            : saisie.valeurUnitaire <= 0
            ? 0
            : (saisie.valeurUnitaire - coutAvant) * qteUnites,
        }
    ) : {}),
    partenaireId: saisie.partenaireId ?? null,
    partenaireNom: saisie.partenaireNom ?? null,
    siteLieId: saisie.siteLieId ?? null,
    documentId: saisie.documentId ?? null,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
    createdAt: serverTimestamp(),
  };

  const batch = writeBatch(db);
  const refMouvement = doc(collection(db, 'mouvements'));
  batch.set(refMouvement, { ...mouvement, userId: saisie.userId });

  if (saisie.varianteCle) {
    const connue = variantesSite.some(v => v.cle === saisie.varianteCle);
    const majVariantes: VarianteSite[] = connue
      ? variantesSite.map(v => v.cle === saisie.varianteCle
          ? { ...v, stock: nouveauStock, coutMoyen: nouveauCout }
          : v)
      : [...variantesSite, {
          cle: saisie.varianteCle, stock: nouveauStock, coutMoyen: nouveauCout,
        }];
    batch.update(refDetention, {
      variantes: majVariantes,
      stock: majVariantes.reduce((s, v) => s + (v.stock ?? 0), 0),
    });
  } else {
    batch.update(refDetention, { stock: nouveauStock, coutMoyen: nouveauCout });
  }

  await batch.commit();
  return { id: refMouvement.id, ...mouvement } as Mouvement;
}

/**
 * Mouvement d'ouverture posé à la création d'un produit.
 * Sans lui, le stock existerait sans qu'aucune entrée ne l'explique et la
 * différence entrées/sorties ne correspondrait plus au stock réel.
 * Le produit portant déjà son stock, on écrit seulement les mouvements.
 */
export async function enregistrerStockInitial(params: {
  siteId: string;
  userId: string;
  produitId: string;
  date: string;
  /** une ligne par variante, ou une seule ligne sans varianteCle */
  lignes: {
    varianteCle?: string | null;
    quantite: number; quantiteUnites: number;
    emballage?: string | null;
    cout: number;
    /* Le coût saisi vaut zéro parce qu'on l'ignore, pas parce que la
       marchandise est gratuite. */
    coutInconnu?: boolean;
  }[];
  /* Qui déclare ce stock de départ : c'est un fait comme un autre. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}): Promise<void> {
  const aEcrire = params.lignes.filter(l => l.quantiteUnites > 0);
  if (aEcrire.length === 0) return;

  /* Le mouvement seul ne suffit pas : il dit ce qui est entré, le rayon
     dit ce qu'on a. Les écrire séparément laissait un produit naître en
     rupture alors que son stock de départ était déclaré — l'historique
     le montrait, l'inventaire l'ignorait.

     `ecrireLignesEnLot` fait les deux d'un geste, et porte la règle du
     coût inconnu : un seul chemin, une seule vérité. */
  /* Un seul produit, un seul site : le registre se monte ici plutôt que
     d'importer `precharger` — `flux-marchandise` importe déjà ce
     fichier, et le cycle empêcherait les deux de se charger. */
  const [snapProduit, detention] = await Promise.all([
    getDoc(doc(db, 'produits', params.produitId)),
    detentionDe(params.siteId, params.produitId),
  ]);
  if (!snapProduit.exists()) throw new Error('Produit introuvable.');

  const idDetention = detention?.id ?? await ouvrirDetention({
    produitId: params.produitId, siteId: params.siteId, userId: params.userId,
  });
  const registre = {
    produits: new Map([[params.produitId, snapProduit.data()]]),
    detentions: new Map([[
      `${params.siteId}:${params.produitId}`,
      { id: idDetention, data: detention ?? { stock: 0, coutMoyen: 0, variantes: [] } },
    ]]),
  };

  await ecrireLignesEnLot(aEcrire.map(l => ({
    siteId: params.siteId,
    userId: params.userId,
    produitId: params.produitId,
    varianteCle: l.varianteCle ?? null,
    sens: 'entree' as const,
    motif: 'stock_initial',
    date: params.date,
    quantite: l.quantite,
    emballage: l.emballage ?? null,
    valeurUnitaire: l.cout,
    ...(l.coutInconnu ? { coutInconnu: true } : {}),
    utilisateurNom: params.utilisateurNom ?? null,
    utilisateurFonction: params.utilisateurFonction ?? null,
  })), registre);
}
