import { enregistrerVersement } from './versements-collection';
import { dossiersOuverts, repartir, type PartFacture } from './imputation';
import { soldeTiers } from './soldes';

/**
 * Compenser deux dettes réciproques.
 *
 * Le même tiers est parfois client et fournisseur : il me doit 15 000 sur
 * ses achats, je lui dois 10 000 sur les miens. Se payer mutuellement
 * ferait sortir puis rentrer le même argent pour rien. On compense : les
 * deux dettes s'annulent à hauteur de la plus petite, et seul le reste
 * demeure — ici 5 000 qu'il me doit encore.
 *
 * Rien ne circule. C'est du papier contre du papier, et la caisse ne voit
 * donc rien passer : l'appeler « règlement » ferait croire qu'un tiroir
 * s'est ouvert.
 *
 * Ce qui reste après n'est écrit nulle part : les soldes se déduisent des
 * factures moins les versements, et le reste tombe de lui-même. Un
 * montant recopié quelque part finirait par contredire ce calcul.
 */

export interface ApercuCompensation {
  /** ce que le tiers me doit, côté client */
  creance: number;
  /** ce que je lui dois, côté fournisseur */
  dette: number;
  /** ce qui peut s'annuler : le plus petit des deux */
  compensable: number;
  /** ce qui restera, et de quel côté */
  reste: number;
  resteCote: 'client' | 'fournisseur' | null;
  /** les factures touchées de chaque côté, avant d'écrire */
  partsClient: PartFacture[];
  partsFournisseur: PartFacture[];
}

/**
 * Ce qu'une compensation ferait, sans rien écrire.
 *
 * On ne demande pas de confirmer une écriture qu'on ne voit pas : l'écran
 * montre les deux soldes, ce qui s'annule et ce qui demeure.
 */
export async function simulerCompensation(params: {
  siteId: string;
  partenaireId: string;
}): Promise<ApercuCompensation> {
  const [c, f] = await Promise.all([
    soldeTiers(params.siteId, params.partenaireId, 'client'),
    soldeTiers(params.siteId, params.partenaireId, 'fournisseur'),
  ]);

  const creance = Math.max(0, c.reste);
  const dette = Math.max(0, f.reste);
  /* On ne compense que jusqu'au plus petit des deux : au-delà, on
     créerait une dette que personne n'a contractée. */
  const compensable = Math.min(creance, dette);
  const reste = Math.abs(creance - dette);

  if (compensable <= 0) {
    return {
      creance, dette, compensable: 0, reste,
      resteCote: creance > dette ? 'client'
        : dette > creance ? 'fournisseur' : null,
      partsClient: [], partsFournisseur: [],
    };
  }

  /* La plus ancienne d'abord, des deux côtés : c'est la règle que suit
     déjà tout versement, et une compensation n'a pas de raison d'y
     déroger. */
  const [ouvertsC, ouvertsF] = await Promise.all([
    dossiersOuverts(params.siteId, params.partenaireId, 'client'),
    dossiersOuverts(params.siteId, params.partenaireId, 'fournisseur'),
  ]);

  return {
    creance, dette, compensable, reste,
    resteCote: creance > dette ? 'client'
      : dette > creance ? 'fournisseur' : null,
    partsClient: repartir(compensable, ouvertsC).parts,
    partsFournisseur: repartir(compensable, ouvertsF).parts,
  };
}

/**
 * Qui peut compenser.
 *
 * Décider que deux dettes s'annulent engage la maison des deux côtés :
 * cela revient à qui répond des comptes. Le caissier n'est pas concerné —
 * aucun tiroir ne s'ouvre.
 */
export function peutCompenser(roleSite: string | null | undefined): boolean {
  return roleSite === null || roleSite === undefined || roleSite === 'gerant';
}

/**
 * Écrire la compensation : un versement de chaque côté.
 *
 * Les deux moitiés portent le même `referenceCompensation` : c'est par
 * elle qu'on retrouve le geste entier en relisant. Chaque versement sait
 * déjà quelle facture il éteint — il porte son `achatId` ou son
 * `venteId` —, donc rien n'a besoin d'être décrit en plus.
 */
export async function compenser(params: {
  siteId: string;
  partenaireId: string;
  partenaireNom?: string | null;
  userId: string;
  date: string;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  adminUid?: string | null;
  roleSite?: string | null;
}): Promise<{ compense: number; lignes: number }> {
  /* Un bouton caché n'est pas une permission : l'écran peut être
     contourné, l'écriture non. */
  if (params.roleSite !== undefined && !peutCompenser(params.roleSite)) {
    throw new Error('Compenser revient au gérant.');
  }

  /* On relit juste avant d'écrire : l'aperçu date du moment où l'écran
     s'est ouvert, et une vente a pu être livrée depuis. */
  const apercu = await simulerCompensation({
    siteId: params.siteId,
    partenaireId: params.partenaireId,
  });

  if (apercu.compensable <= 0) {
    throw new Error(
      apercu.creance <= 0 && apercu.dette <= 0
        ? 'Ce partenaire ne doit rien et ne lui est rien dû.'
        : 'Une compensation demande une dette de chaque côté.');
  }

  const reference = `CP-${params.date.replace(/-/g, '')}`
    + `-${Date.now().toString(36).slice(-4).toUpperCase()}`;

  let lignes = 0;

  /* Côté client : ce qu'il me doit diminue. */
  for (const part of apercu.partsClient) {
    await enregistrerVersement({
      siteId: params.siteId,
      userId: params.userId,
      partenaireId: params.partenaireId,
      partenaireNom: params.partenaireNom ?? null,
      role: 'client',
      montant: part.impute,
      date: params.date,
      motif: 'compensation',
      /* Aucun franc ne circule : la caisse n'a rien à confirmer. */
      sansCaisse: true,
      sens: 'entree',
      venteId: part.dossierId,
      reference,
      par: params.userId,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      adminUid: params.adminUid ?? null,
    });
    lignes += 1;
  }

  /* Côté fournisseur : ce que je lui dois diminue d'autant. */
  for (const part of apercu.partsFournisseur) {
    await enregistrerVersement({
      siteId: params.siteId,
      userId: params.userId,
      partenaireId: params.partenaireId,
      partenaireNom: params.partenaireNom ?? null,
      role: 'fournisseur',
      montant: part.impute,
      date: params.date,
      motif: 'compensation',
      sansCaisse: true,
      sens: 'sortie',
      achatId: part.dossierId,
      reference,
      par: params.userId,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      adminUid: params.adminUid ?? null,
    });
    lignes += 1;
  }

  return { compense: apercu.compensable, lignes };
}
