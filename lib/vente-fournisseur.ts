/**
 * La marchandise prise chez un voisin pour être vendue tout de suite.
 *
 * En Afrique une boutique dépanne : le client demande un article qu'on
 * n'a pas, on traverse la rue le prendre chez le voisin, on le vend dans
 * la minute, et on règle le voisin après — parfois le soir, parfois dans
 * les minutes qui suivent.
 *
 * Le cycle d'achat — commandé, reçu, compté, confirmé — répond aux
 * questions que pose l'attente entre la commande et la livraison. Ici il
 * n'y a pas d'attente : le franchir une étape à la fois immobilise
 * pendant que le client est devant le comptoir.
 *
 * La tentation est de tout passer « hors stock ». Elle coûte trois
 * choses, et aucune ne se rattrape ensuite :
 *
 *   — le bénéfice de la ligne, puisque le coût n'est écrit nulle part ;
 *   — ce qu'on prend chez chaque voisin, et donc la question de savoir
 *     s'il mérite de devenir un fournisseur régulier ;
 *   — combien on a vendu de telle référence, qui devient faux pour
 *     toujours sans que rien ne le signale.
 *
 * Ici rien ne se perd. Le produit est le même produit, quelle que soit
 * la façon dont il est entré. Le voisin porte un dossier d'achat à son
 * nom, donc une dette, donc des versements — par les trois chemins
 * existants, sans qu'aucun écran ne soit à refaire.
 */
import {
  collection, doc, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  referenceFlux, type LigneFlux, type Vente, type AuteurEtape,
} from '@/lib/flux-marchandise';

/** Ce qu'un voisin a fourni sur une vente, et ce qu'on lui doit. */
export interface PriseChezUnTiers {
  fournisseurId: string;
  fournisseurNom: string;
  lignes: LigneFlux[];
  montant: number;
}

/**
 * Ce que chaque fournisseur a fourni sur cette vente.
 *
 * Un seul reçu peut mêler trois voisins : la dette n'est pas « par
 * vente » mais par fournisseur. On regroupe donc avant d'écrire, sinon
 * un voisin qui a fourni deux lignes se retrouverait avec deux dossiers
 * là où il n'a fait qu'un geste.
 */
export function prisesParFournisseur(lignes: LigneFlux[]): PriseChezUnTiers[] {
  const parId = new Map<string, PriseChezUnTiers>();

  for (const l of lignes) {
    if (!l.fournisseurId) continue;
    const qte = l.quantiteRecue ?? l.quantiteDemandee;
    if (qte <= 0) continue;

    const vu = parId.get(l.fournisseurId) ?? {
      fournisseurId: l.fournisseurId,
      fournisseurNom: l.fournisseurNom ?? 'Fournisseur',
      lignes: [],
      montant: 0,
    };
    vu.lignes.push({ ...l, quantiteDemandee: qte, quantiteRecue: qte });
    /* Ce qu'on lui doit, c'est ce que la marchandise a coûté — jamais ce
       qu'on l'a revendue. La différence est notre marge, et elle nous
       appartient. */
    vu.montant += (l.valeurUnitaire ?? 0) * qte;
    parId.set(l.fournisseurId, vu);
  }

  return [...parId.values()];
}

/**
 * Les dossiers d'achat que la vente fait naître chez les voisins.
 *
 * Un par fournisseur, déjà confirmé : il n'y a rien à attendre, la
 * marchandise est passée. Et sans mouvement de stock — `sansMouvement` —
 * parce que la livraison de la vente a déjà écrit l'entrée et la sortie.
 * Laisser cet achat entrer la marchandise une seconde fois donnerait un
 * carton reçu pour deux cartons en rayon.
 *
 * C'est le même partage que pour un ordre entre deux sites : l'achat
 * fait la dette, l'autre dossier fait la marchandise. Un seul chemin
 * pour chaque chose.
 *
 * La dette se déduit ensuite des achats confirmés, comme toutes les
 * autres : rien n'est stocké, donc rien ne peut diverger. Les
 * versements, la fiche du partenaire et les totaux marchent sans qu'une
 * ligne ait été changée ailleurs.
 */
export async function creerAchatsDeVente(params: {
  vente: Vente;
  date: string;
  userId: string;
  auteur?: AuteurEtape | null;
}): Promise<void> {
  const prises = prisesParFournisseur(params.vente.lignes);
  if (prises.length === 0) return;

  const batch = writeBatch(db);

  for (const p of prises) {
    batch.set(doc(collection(db, 'achats')), {
      reference: referenceFlux('AC', params.date),
      siteId: params.vente.siteId,
      fournisseurId: p.fournisseurId,
      fournisseurNom: p.fournisseurNom,
      /* Rien n'attend : la marchandise est prise, vendue et partie. Un
         achat qui naîtrait « en attente » demanderait de compter ce qui
         n'est déjà plus là. */
      etat: 'confirme',
      lignes: p.lignes,
      avanceVersee: 0,
      versements: [],
      frais: null,
      fraisCorrection: null,
      fraisCle: null,
      dateCommande: params.date,
      dateReception: params.date,
      dateConfirmation: params.date,
      parCommande: params.userId,
      parConfirmation: params.userId,
      auteurCommande: params.auteur ?? null,
      auteurConfirmation: params.auteur ?? null,
      note: null,
      /* La marchandise est entrée par la vente : cet achat ne porte que
         la dette. Même partage que l'achat né d'un ordre entre sites. */
      ordreSansMouvement: true,
      /* D'où il vient. Sans ce lien, une dette de six mois est un montant
         sans justification consultable : on clique, et il n'y a rien à
         ouvrir. Il mène au reçu où la marchandise est partie. */
      venteOrigineId: params.vente.id,
      venteOrigineReference: params.vente.reference,
      userId: params.userId,
      createdAt: serverTimestamp(),
    });
  }

  await batch.commit();
}
