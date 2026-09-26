import {
  collection, getDocs, query, where,
} from 'firebase/firestore';
import { db } from './firebase';
import type { RoleTiers } from './soldes';
import { valeurRecue, valeurVente } from './flux-marchandise';

/**
 * Répartir un versement sur les factures, de la plus ancienne à la plus
 * récente.
 *
 * On règle ce qu'on doit depuis le plus longtemps. C'est l'usage entre
 * commerçants, et ce n'est pas qu'une politesse : une dette ancienne
 * inquiète, une dette d'hier attend son tour. Laisser le versement flotter
 * sans imputation donnerait un solde juste et des dossiers tous à moitié
 * réglés, dont aucun ne se solde jamais.
 *
 * Le versement peut couvrir plusieurs factures, ou n'en couvrir qu'une
 * partie : on descend la liste jusqu'à épuisement, et la dernière touchée
 * reçoit le reliquat.
 */

export interface PartFacture {
  /** le dossier touché */
  dossierId: string;
  reference: string | null;
  date: string | null;
  /** ce qui restait dû avant ce versement */
  restait: number;
  /** ce que ce versement y impute */
  impute: number;
}

/** Ce qu'un dossier doit encore, et depuis quand. */
interface Ouvert {
  id: string;
  reference: string | null;
  date: string | null;
  reste: number;
}

/**
 * Ce qu'un document vaut, exactement comme le reste de l'app le compte.
 *
 * Cette fonction cherchait `quantiteLivree` sur une vente et valorisait
 * tout à `valeurUnitaire`. Les documents, eux, portent `quantiteRecue`
 * et le prix dans `prixVente` : le total tombait à zéro, et l'écran
 * annonçait qu'un client ne devait rien alors qu'il devait. Deux façons
 * de compter la même chose finissent toujours par se contredire — on
 * réutilise celles qui font foi.
 */
function valeurLignes(lignes: any[], role: RoleTiers): number {
  return role === 'fournisseur'
    ? valeurRecue(lignes ?? [])
    : valeurVente(lignes ?? []);
}

/**
 * Les dossiers d'un tiers qui doivent encore quelque chose, les plus
 * anciens d'abord.
 *
 * Un dossier sans date se range en dernier : on ne peut pas le dire plus
 * vieux qu'un autre, et le mettre en tête ferait passer un dossier de
 * provenance inconnue avant une dette datée.
 */
export async function dossiersOuverts(
  siteId: string, partenaireId: string, role: RoleTiers,
): Promise<Ouvert[]> {
  const col = role === 'fournisseur' ? 'achats' : 'ventes';
  const champ = role === 'fournisseur' ? 'fournisseurId' : 'clientId';
  const snap = await getDocs(query(
    collection(db, col),
    where('siteId', '==', siteId),
    where(champ, '==', partenaireId)));

  return snap.docs
    .map(d => {
      const x = d.data() as any;
      const total = valeurLignes(x.lignes ?? [], role);
      const reste = Math.max(0, total - (x.avanceVersee ?? 0));
      const date = role === 'fournisseur'
        ? (x.dateConfirmation ?? x.dateReception ?? x.dateCommande ?? null)
        : (x.dateLivraison ?? x.dateCommande ?? null);
      return {
        id: d.id,
        reference: x.reference ?? x.numero ?? null,
        date,
        reste,
      };
    })
    .filter(o => o.reste > 0)
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });
}

/**
 * Ce qu'un retour peut faire ressortir d'un document.
 *
 * On ne rend jamais plus qu'on n'a reçu. Si un bon de 20 000 a été payé
 * 5 000 et qu'on en rend pour 10 000, la dette de 15 000 tombe à 5 000 et
 * il ne sort rien : le tiers doit encore. C'est seulement quand le retour
 * dépasse ce qui restait dû que l'argent déjà versé redevient disponible
 * — et jamais au-delà de ce versement.
 *
 * Sans ce plafond, un tiers qui avait versé une avance repartait avec la
 * valeur entière de sa marchandise : le site lui rendait de l'argent
 * qu'il n'avait jamais reçu.
 */
export function sortieAutorisee(params: {
  /** la valeur de ce qui revient */
  valeurRetour: number;
  /** ce que le document valait */
  totalDocument: number;
  /** ce qui a réellement été versé dessus, en argent */
  verseDocument: number;
}): { eteintLaDette: number; restituable: number } {
  const du = Math.max(0, params.totalDocument - params.verseDocument);
  /* Le retour éteint d'abord ce qui reste dû. */
  const eteintLaDette = Math.min(params.valeurRetour, du);
  /* Ce qui dépasse ne peut ressortir qu'à hauteur de ce qui est entré. */
  const surplus = Math.max(0, params.valeurRetour - du);
  return {
    eteintLaDette,
    restituable: Math.min(surplus, params.verseDocument),
  };
}

/**
 * Comment un montant se répartit sur des dossiers ouverts.
 *
 * Fonction pure : elle ne lit ni n'écrit rien, ce qui la rend vérifiable
 * seule. Ce qui dépasse la somme des dettes n'est imputé nulle part — au
 * moins une facture est alors entièrement soldée, et le surplus regarde
 * l'appelant.
 */
export function repartir(montant: number, ouverts: Ouvert[]): {
  parts: PartFacture[];
  impute: number;
  surplus: number;
} {
  let reste = Math.max(0, montant);
  const parts: PartFacture[] = [];

  for (const o of ouverts) {
    if (reste <= 0) break;
    const part = Math.min(reste, o.reste);
    parts.push({
      dossierId: o.id,
      reference: o.reference,
      date: o.date,
      restait: o.reste,
      impute: part,
    });
    reste -= part;
  }

  return {
    parts,
    impute: Math.max(0, montant) - reste,
    surplus: reste,
  };
}

/**
 * Ce qu'un montant réglerait chez ce tiers, sans rien écrire.
 *
 * Sert à montrer le détail avant de valider : « vos 10 000 solderont la
 * facture de mars et la moitié de celle d'avril ». On ne demande pas de
 * confirmer une imputation qu'on ne voit pas.
 */
export async function simulerImputation(params: {
  siteId: string;
  partenaireId: string;
  role: RoleTiers;
  montant: number;
}): Promise<{ parts: PartFacture[]; impute: number; surplus: number }> {
  const ouverts = await dossiersOuverts(
    params.siteId, params.partenaireId, params.role);
  return repartir(params.montant, ouverts);
}
