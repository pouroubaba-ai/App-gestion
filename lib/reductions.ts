import {
  collection, query, where, getDocs, addDoc, deleteDoc, doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { repartirFrais } from './frais';
import type { LigneFlux } from './flux-marchandise';

/**
 * Ce qui fait bouger le prix d'une vente sans être de la marchandise.
 *
 * Deux sens, et les noms comptent : ce qui baisse la facture est une
 * **réduction**, ce qui l'augmente sont des **frais annexes**. Une
 * livraison facturée n'est pas une remise négative, et les confondre
 * empêcherait plus tard de dire ce qu'on accorde et ce qu'on facture.
 *
 * Ces montants ne restent pas à part : ils se répartissent sur les
 * lignes, et le prix qui en sort EST le prix de vente. Il n'y a pas un
 * prix catalogue amputé d'une remise quelque part — il y a le prix
 * auquel on a vendu, celui qui part dans le mouvement, dans la marge,
 * dans le tableau de bord. Rien en aval n'a besoin de connaître la
 * mécanique : c'est le document qui garde la trace du raisonnement.
 */

/** Ce que le montant fait au prix. */
export type SensMontant = 'reduction' | 'frais';

/** Une valeur fixe, ou une part du sous-total. */
export type TypeMontant = 'montant' | 'pourcentage';

export const LIBELLES_SENS: Record<SensMontant, string> = {
  reduction: 'Réduction',
  frais: 'Frais annexes',
};

/**
 * Un modèle : ce qu'on accorde ou facture souvent, prêt à rappeler.
 *
 * On le crée une fois — « Remise fidélité, 5 % » — et on l'appelle sur
 * chaque vente. Ressaisir à chaque fois laisserait des taux se
 * contredire d'un bon à l'autre, et personne ne saurait lequel est le
 * bon.
 *
 * Il préremplit, il ne contraint pas : le taux comme le montant restent
 * modifiables sur la vente. Le modèle dit l'habitude, la vente dit ce
 * qui s'est passé.
 */
export interface ModeleMontant {
  id: string;
  nom: string;
  sens: SensMontant;
  type: TypeMontant;
  /** un montant en francs, ou un taux en pourcentage selon `type` */
  valeur: number;
}

/**
 * Un montant posé sur une vente.
 *
 * Il garde le nom du modèle dont il vient, mais plus son identité : le
 * modèle peut changer ou disparaître ensuite, la vente doit continuer à
 * dire ce qui a été accordé ce jour-là. Un fait ne se relit pas à
 * travers une configuration d'aujourd'hui.
 */
export interface MontantVente {
  libelle: string;
  sens: SensMontant;
  type: TypeMontant;
  valeur: number;
}

/**
 * Ce que vaut un montant, en francs.
 *
 * Un pourcentage n'a de sens que rapporté à quelque chose : c'est le
 * sous-total de la marchandise qui sert de base, jamais un total qui
 * comprendrait déjà d'autres réductions — sinon deux remises de 10 %
 * ne feraient pas 20 % mais 19, et personne ne saurait pourquoi.
 */
export function valeurEnFrancs(m: MontantVente, sousTotal: number): number {
  if (m.type === 'pourcentage') {
    return Math.round(sousTotal * (m.valeur ?? 0) / 100);
  }
  return Math.round(m.valeur ?? 0);
}

/** Ce que les réductions retirent en tout. */
export function totalReductions(
  montants: MontantVente[] | null | undefined, sousTotal: number,
): number {
  return (montants ?? [])
    .filter(m => m.sens === 'reduction')
    .reduce((n, m) => n + valeurEnFrancs(m, sousTotal), 0);
}

/** Ce que les frais annexes ajoutent en tout. */
export function totalFraisAnnexes(
  montants: MontantVente[] | null | undefined, sousTotal: number,
): number {
  return (montants ?? [])
    .filter(m => m.sens === 'frais')
    .reduce((n, m) => n + valeurEnFrancs(m, sousTotal), 0);
}

/**
 * Une réduction ne peut pas dépasser ce qu'on vend.
 *
 * Au-delà, le client devrait de l'argent au commerçant pour être venu.
 * On borne plutôt que d'interdire : bloquer laisserait l'utilisateur
 * devant un bouton éteint sans savoir quoi corriger.
 */
export function reductionBornee(
  montants: MontantVente[] | null | undefined, sousTotal: number,
): number {
  return Math.min(totalReductions(montants, sousTotal), Math.max(0, sousTotal));
}

/**
 * Le sous-total d'origine, retrouvé depuis le total encaissé.
 *
 * Les lignes d'un document enregistré portent le prix D'APRÈS remise :
 * les additionner ne rend pas le prix catalogue mais ce qu'on a
 * encaissé. Pour réafficher « sous-total, remise, à payer », il faut
 * donc remonter.
 *
 * Avec des montants fixes, c'est une soustraction. Avec des
 * pourcentages, c'est une division : le total vaut le sous-total
 * multiplié par (1 − taux de remise + taux de frais), et l'on inverse.
 * Résoudre les pourcentages sur le total au lieu du sous-total donnerait
 * une remise plus petite que celle accordée — et le document mentirait
 * sur ce qu'on a cédé.
 */
export function sousTotalOrigine(
  total: number, montants: MontantVente[] | null | undefined,
): number {
  const liste = montants ?? [];
  if (liste.length === 0) return total;

  let fixe = 0;   // ce qui ne dépend pas du sous-total
  let taux = 1;   // le facteur qui s'y applique
  for (const m of liste) {
    const signe = m.sens === 'reduction' ? -1 : 1;
    if (m.type === 'pourcentage') taux += signe * (m.valeur ?? 0) / 100;
    else fixe += signe * (m.valeur ?? 0);
  }
  /* Une remise de 100 % annule la base : il n'y a plus rien à retrouver,
     et diviser par zéro rendrait un infini à l'écran. */
  if (taux <= 0) return total;
  return Math.round((total - fixe) / taux);
}

/* ═══════════════════ RÉPARTITION SUR LES LIGNES ═══════════════════ */

/**
 * Ce que chaque ligne porte des réductions et des frais, et le prix qui
 * en résulte.
 *
 * Un seul calcul, pour tout le monde : la saisie du cycle, le comptoir,
 * le modal de marge et ce qui s'enregistre. Deux façons de répartir le
 * même geste finiraient par se contredire, et c'est la marge affichée
 * qui mentirait.
 *
 * La réduction se partage au prorata de la MARGE, les frais au prorata
 * de la VALEUR. Ce n'est pas une symétrie manquée : une remise se cède
 * sur ce qu'on gagne — un produit vendu à prix coûtant n'a rien à
 * céder — tandis qu'une livraison se facture sur ce qu'on emporte.
 *
 * Le prix rendu EST le prix de vente. Il n'y a pas un prix catalogue
 * diminué quelque part : il y a le prix auquel on a vendu, celui qui
 * part au mouvement et dans la marge.
 */
export function prixApresMontants(
  lignes: LigneFlux[],
  montants: MontantVente[] | null | undefined,
): { parts: { reduction: number; frais: number }[]; prix: number[] } {
  const sousTotal = lignes.reduce(
    (s, l) => s + (l.quantiteDemandee ?? 0) * (l.prixVente ?? 0), 0);

  const reduction = reductionBornee(montants, sousTotal);
  const frais = totalFraisAnnexes(montants, sousTotal);

  const partsRed = reduction > 0
    ? repartirFrais(lignes, [{ libelle: '', montant: reduction }], null, 'marge')
    : lignes.map(() => 0);
  const partsFra = frais > 0
    ? repartirFrais(lignes, [{ libelle: '', montant: frais }], null, 'valeur')
    : lignes.map(() => 0);

  const parts = lignes.map((_, i) => ({
    reduction: partsRed[i] ?? 0,
    frais: partsFra[i] ?? 0,
  }));

  /* Une ligne ne se vend pas à un prix négatif : ce qu'elle ne peut pas
     absorber se reporte sur celles qui le peuvent.

     Sans ce report, l'écrêtage ferait disparaître de la réduction en
     silence — le pied annoncerait « à payer 0 » pendant que les lignes
     encaisseraient 7 740, et rien à l'écran n'expliquerait l'écart.
     Le cas ne se produit qu'aux remises extrêmes, mais un écart muet ne
     se découvre jamais. */
  let reste = 0;
  const nets = lignes.map((l, i) => {
    const brut = (l.quantiteDemandee ?? 0) * (l.prixVente ?? 0);
    const net = brut - parts[i].reduction + parts[i].frais;
    if (net < 0) { reste += -net; return 0; }
    return net;
  });

  for (let tour = 0; reste > 0 && tour < lignes.length; tour++) {
    const porteurs = nets
      .map((n, i) => ({ i, n }))
      .filter(x => x.n > 0);
    const capacite = porteurs.reduce((n, x) => n + x.n, 0);
    if (capacite <= 0) break;
    const aPoser = Math.min(reste, capacite);
    reste -= aPoser;
    for (const { i, n } of porteurs) {
      const retire = Math.min(n, Math.round(aPoser * n / capacite));
      nets[i] -= retire;
      parts[i].reduction += retire;
    }
  }

  /* Le prix unitaire, dans l'emballage vendu : la part vaut pour la
     ligne entière, le prix se lit à l'unité qu'on manipule. */
  const prix = lignes.map((l, i) => {
    const qte = l.quantiteDemandee ?? 0;
    if (qte <= 0) return l.prixVente ?? 0;
    return Math.max(0, Math.round(nets[i] / qte));
  });

  return { parts, prix };
}

/**
 * Ce que le document encaisse vraiment, et comment on y est arrivé.
 *
 * Un prix unitaire n'a pas de décimales : dix lignes arrondies ne
 * retombent pas sur le compte théorique. Le pied annoncerait
 * « 250 000 − 12 500 = 237 500 » pendant que les lignes encaissent
 * 237 490, et l'écart de dix francs n'aurait aucune explication à
 * l'écran.
 *
 * La vérité est ce que les lignes portent : c'est ce qui part au
 * mouvement, dans la caisse, dans la marge. L'arrondi se loge donc dans
 * la réduction affichée, qui est le chiffre négociable — jamais dans le
 * sous-total, qui est un fait du catalogue, ni dans le total, qui est un
 * fait de la caisse.
 */
export function piedDocument(
  sousTotal: number,
  total: number,
  montants: MontantVente[] | null | undefined,
): { sousTotal: number; reduction: number; frais: number; total: number } {
  const frais = totalFraisAnnexes(montants, sousTotal);
  /* Ce qui reste une fois la marchandise et les frais posés : c'est la
     réduction réellement consentie, arrondis compris. */
  const reduction = Math.max(0, sousTotal + frais - total);
  return { sousTotal, reduction, frais, total };
}

/* ═══════════════════════ MODÈLES ═══════════════════════ */

/** Les modèles d'un site. */
export async function modelesDuSite(siteId: string): Promise<ModeleMontant[]> {
  const snap = await getDocs(query(
    collection(db, 'vente_montants_configs'), where('siteId', '==', siteId)));
  return snap.docs.map(d => {
    const x = d.data() as any;
    return {
      id: d.id,
      nom: x.nom ?? '',
      sens: (x.sens ?? 'reduction') as SensMontant,
      type: (x.type ?? 'montant') as TypeMontant,
      valeur: x.valeur ?? 0,
    };
  }).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
}

/**
 * Deux modèles de même nom se confondraient dans la liste : celui qu'on
 * rappelle ne serait plus celui qu'on croit. La comparaison ignore la
 * casse et les espaces de bord, comme on les lit.
 */
export function nomModelePris(
  nom: string, modeles: ModeleMontant[], saufId?: string,
): boolean {
  const n = nom.trim().toLowerCase();
  if (!n) return false;
  return modeles.some(m => m.id !== saufId && m.nom.trim().toLowerCase() === n);
}

export async function creerModele(
  siteId: string, userId: string,
  params: { nom: string; sens: SensMontant; type: TypeMontant; valeur: number },
): Promise<ModeleMontant> {
  const ref = await addDoc(collection(db, 'vente_montants_configs'), {
    siteId, userId,
    nom: params.nom.trim(),
    sens: params.sens, type: params.type, valeur: params.valeur,
    createdAt: serverTimestamp(),
  });
  return {
    id: ref.id, nom: params.nom.trim(),
    sens: params.sens, type: params.type, valeur: params.valeur,
  };
}

/**
 * Supprimer un modèle n'efface rien des ventes passées : elles portent
 * leur propre copie de ce qui a été accordé. On retire une habitude, pas
 * un fait.
 */
export async function supprimerModele(id: string): Promise<void> {
  await deleteDoc(doc(db, 'vente_montants_configs', id));
}
