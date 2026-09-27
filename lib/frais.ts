import type { LigneFlux } from './flux-marchandise';

/**
 * Les frais d'approche d'un achat, et leur répartition.
 *
 * Ce qui compte n'est pas ce que le fournisseur a facturé, mais ce que la
 * marchandise a coûté rendue en rayon. Le transport, la douane, la
 * manutention : tout ce qu'il a fallu dépenser pour qu'elle soit
 * vendable ici.
 *
 * Les laisser dehors fausse le coût moyen — donc la marge de chaque vente
 * qui suivra. Un achat de 100 000 avec 10 000 de transport revendu
 * 110 000 ne rapporte rien ; sans le transport dans le coût, l'écran
 * annonce 10 000 de bénéfice.
 *
 * Le frais reste pourtant un service, pas de la marchandise : il n'entre
 * aucune quantité au stock. La facture le montre comme tel, le rayon n'en
 * voit que l'effet sur le coût. Le même montant, deux lectures.
 */

/** Comment un frais se partage entre les produits. */
export type CleRepartition = 'valeur' | 'quantite';

export const LIBELLES_REPARTITION: Record<CleRepartition, string> = {
  valeur: 'Au prorata de la valeur',
  quantite: 'Au prorata de la quantité',
};

export interface Frais {
  /** ce qu'on a payé en plus, et pour quoi */
  libelle: string;
  montant: number;
  /**
   * La règle de partage, du temps où chaque frais avait la sienne.
   *
   * Elle ne se saisit plus : la clé vaut pour la répartition entière.
   * Un camion qui monte trois palettes ne se partage pas autrement
   * selon qu'on regarde le transport ou la manutention — c'est le même
   * voyage, et laisser deux règles cohabiter donnait deux répartitions
   * à vérifier là où il n'y a qu'une facture.
   *
   * Le champ reste lu sur les dossiers déjà enregistrés, qui le
   * portaient ligne par ligne.
   */
  cle?: CleRepartition;
}

/**
 * La règle de partage d'un achat.
 *
 * La valeur par défaut : elle ne demande rien à saisir, ne peut pas
 * donner de résultat absurde, et garde le taux de marge cohérent d'un
 * produit à l'autre — un article cher porte plus de frais, mais il
 * rapporte plus.
 *
 * La quantité convient quand les articles se ressemblent. Sur un
 * catalogue où les prix vont de cinq cents à vingt mille, elle ferait
 * porter autant à une ampoule qu'à une balance.
 */
export const CLE_PAR_DEFAUT: CleRepartition = 'valeur';

/** Ce qu'une ligne pèse, selon la clé choisie. */
function poids(l: LigneFlux, cle: CleRepartition): number {
  const qte = l.quantiteRecue ?? l.quantiteDemandee ?? 0;
  if (qte <= 0) return 0;
  return cle === 'quantite' ? qte : qte * (l.valeurUnitaire ?? 0);
}

/**
 * Ce que chaque ligne porte des frais, dans l'ordre des lignes.
 *
 * Rien ne s'écrit sur la ligne : la part se déduit des frais et des
 * quantités, et elle se refait à l'identique à chaque lecture. L'inscrire
 * donnerait un chiffre dérivé que la première quantité corrigée
 * contredirait.
 *
 * Le dernier centime va à la ligne la plus lourde. Répartir 10 000 sur
 * trois lignes laisse un reste, et le perdre ferait que la somme des
 * parts ne fait plus le total — un écart minuscule, mais qu'aucun
 * contrôle ne pourrait expliquer.
 */
export function repartirFrais(
  lignes: LigneFlux[],
  frais: Frais[] | null | undefined,
  /** une part imposée à la main, par index de ligne */
  correction?: Record<number, number> | null,
  /**
   * La règle de partage de l'achat. Absente, on relit celle que chaque
   * frais portait — les dossiers enregistrés avant que la clé devienne
   * commune doivent rendre les mêmes parts qu'au jour de leur
   * confirmation.
   */
  cleGlobale?: CleRepartition | null,
): number[] {
  const parts = lignes.map(() => 0);
  const total = (frais ?? []).reduce((n, f) => n + (f.montant ?? 0), 0);
  if (total <= 0) return parts;

  /* Une part posée à la main l'emporte : la règle donne une base juste,
     celui qui a vu le camion garde le dernier mot. Ce qui reste se
     partage entre les autres lignes. */
  const imposees = correction ?? {};
  const restant = Math.max(0, total
    - Object.values(imposees).reduce((n, v) => n + (v ?? 0), 0));

  for (const [i, v] of Object.entries(imposees)) {
    const idx = Number(i);
    if (idx >= 0 && idx < parts.length) parts[idx] = v ?? 0;
  }

  const libres = lignes
    .map((l, i) => ({ i, p: imposees[i] != null ? 0 : 1 }))
    .filter(x => x.p > 0)
    .map(x => x.i);
  if (libres.length === 0 || restant <= 0) return parts;

  /* Chaque frais suit sa propre clé : un transport peut se partager sur
     la valeur pendant qu'une manutention se partage sur la quantité. */
  for (const f of frais ?? []) {
    const m = f.montant ?? 0;
    if (m <= 0) continue;
    const cle = cleGlobale ?? f.cle ?? CLE_PAR_DEFAUT;
    /* La part de ce frais dans ce qui reste à répartir. */
    const m2 = Math.round(m * restant / total);
    const poidsTotal = libres.reduce((n, i) => n + poids(lignes[i], cle), 0);
    if (poidsTotal <= 0) continue;

    let pose = 0;
    let plusLourde = libres[0];
    for (const i of libres) {
      const part = Math.floor(m2 * poids(lignes[i], cle) / poidsTotal);
      parts[i] += part;
      pose += part;
      if (poids(lignes[i], cle) > poids(lignes[plusLourde], cle)) plusLourde = i;
    }
    /* Le reste de l'arrondi, à la ligne la plus lourde : c'est elle qui
       l'aurait porté si on avait pu couper le franc. */
    parts[plusLourde] += m2 - pose;
  }

  return parts;
}

/**
 * La répartition tombe-t-elle juste ?
 *
 * Un frais à moitié réparti est de l'argent qui disparaît : la dette le
 * porte, le coût des produits ne le porte pas, et la marge annoncée est
 * fausse de la différence. Rien à l'écran ne le dirait — c'est
 * exactement le genre d'écart muet qu'on ne découvre jamais.
 *
 * On vérifie donc avant d'écrire. Le cas courant tombe juste tout seul,
 * puisque la règle partage la totalité ; l'écart ne peut venir que de
 * parts posées à la main.
 *
 * Deux façons de se tromper, et elles ne se disent pas pareil : imposer
 * plus que le total, ou laisser un reste sans ligne libre pour le
 * porter.
 */
export function controlerRepartition(
  lignes: LigneFlux[],
  frais: Frais[] | null | undefined,
  correction?: Record<number, number> | null,
  cleGlobale?: CleRepartition | null,
): { juste: boolean; reparti: number; total: number; motif?: string } {
  const total = totalFrais(frais);

  /* Un montant sans libellé se répartit comme les autres : il entre dans
     le coût moyen, il grossit la dette, et rien ne dit plus ce qu'on a
     payé. L'écran ferme la saisie tant que le frais n'est pas nommé,
     mais un champ fermé n'est pas une règle — la règle est ici, devant
     l'écriture. */
  const anonyme = (frais ?? []).find(
    f => (f.montant ?? 0) > 0 && !(f.libelle ?? '').trim());
  if (anonyme) {
    return {
      juste: false, reparti: 0, total,
      motif: `Un frais de ${(anonyme.montant ?? 0).toLocaleString('fr-FR')} `
        + `FCFA n'a pas de libellé : nommez-le avant de le répartir.`,
    };
  }

  if (total <= 0) return { juste: true, reparti: 0, total: 0 };

  const imposees = correction ?? {};
  const sommeImposee = Object.values(imposees)
    .reduce((n, v) => n + (v ?? 0), 0);

  if (sommeImposee > total) {
    return {
      juste: false, reparti: sommeImposee, total,
      motif: `Les parts saisies font ${sommeImposee.toLocaleString('fr-FR')} `
        + `FCFA, soit plus que les ${total.toLocaleString('fr-FR')} FCFA de frais.`,
    };
  }

  const parts = repartirFrais(lignes, frais, correction, cleGlobale);
  const reparti = parts.reduce((n, p) => n + p, 0);

  if (reparti !== total) {
    /* Le reste n'a trouvé aucune ligne pour le porter : toutes sont
       imposées, ou celles qui restent n'ont aucune quantité. */
    return {
      juste: false, reparti, total,
      motif: `${(total - reparti).toLocaleString('fr-FR')} FCFA de frais `
        + `ne se posent sur aucun produit.`,
    };
  }

  return { juste: true, reparti, total };
}

/** Le total des frais d'un achat. */
export function totalFrais(frais: Frais[] | null | undefined): number {
  return (frais ?? []).reduce((n, f) => n + (f.montant ?? 0), 0);
}

/**
 * Le coût d'une ligne, frais compris, par unité de base.
 *
 * C'est ce chiffre qui entre au stock et qui pondère le coût moyen — pas
 * le prix facturé. Une ligne sans quantité n'a pas de coût unitaire : la
 * division n'aurait pas de sens, et on rend le prix nu.
 */
export function coutAvecFrais(
  ligne: LigneFlux, partFrais: number,
): number {
  const qte = ligne.quantiteRecue ?? ligne.quantiteDemandee ?? 0;
  if (qte <= 0 || partFrais <= 0) return ligne.valeurUnitaire ?? 0;
  return (ligne.valeurUnitaire ?? 0) + partFrais / qte;
}
