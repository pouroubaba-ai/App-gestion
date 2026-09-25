/**
 * Le seul chemin par lequel un mouvement atteint la caisse.
 *
 * Toute opération qui touche l'argent — une vente au comptant, un
 * recouvrement, le règlement d'un fournisseur, une rémunération — passe
 * par ici plutôt que d'écrire au registre directement. C'est cette
 * fonction qui décide si l'écriture entre tout de suite ou si elle attend.
 *
 * Elle attend dès que le site a un responsable de la caisse, et que ce
 * n'est pas lui qui agit : décider d'un mouvement et ouvrir le tiroir sont
 * deux gestes, et le second lui appartient. Quand le caissier encaisse
 * lui-même, il n'y a rien à attendre — il est déjà devant la caisse.
 *
 * Sans caissier sur le site, rien ne change : l'argent entre comme avant.
 * Un site qui n'a personne pour tenir sa caisse ne peut pas se bloquer en
 * attendant une autorisation que nul ne peut donner.
 */

import {
  enregistrerMouvementCaisse, type SaisieCaisse,
} from './caisse';
import { mettreEnAttente } from './attente-caisse';
import { aUnCaissier, roleSurSite } from './roles';

export interface ResultatEcriture {
  /** L'identifiant du mouvement écrit, ou de la demande en attente. */
  id: string;
  /** L'argent a-t-il vraiment bougé ? */
  applique: boolean;
}

/**
 * Écrit au registre, ou met en file d'attente.
 *
 * `parUid` dit qui agit : c'est son rôle sur le site qui décide. Absent, on
 * écrit directement — un acte sans auteur connu ne peut pas être attribué,
 * et le bloquer arrêterait des écritures techniques.
 */
export async function ecrireEnCaisse(
  saisie: SaisieCaisse,
  parUid?: string | null,
  adminUid?: string | null,
  options?: {
    /* L'argent a été encaissé dehors : même le caissier ne l'a pas dans
       son tiroir tant qu'on ne le lui a pas remis. Encaisser et remettre
       sont deux faits, et seul le second fait entrer l'argent. */
    forcerAttente?: boolean;
  },
): Promise<ResultatEcriture> {
  /* Une annulation naît du registre lui-même : la faire attendre
     demanderait d'autoriser une correction d'écriture, ce qui n'a pas de
     sens — elle contre-passe une ligne déjà autorisée.

     Le réajustement, lui, ne passe ici que porté par le caissier : c'est
     l'écart qu'il constate en comptant. Venu d'ailleurs, il attendrait
     comme le reste — sinon il suffirait de déclarer un « réajustement »
     pour sortir de l'argent sans que personne n'ouvre le tiroir. */
  const technique = saisie.motif === 'annulation';

  if (!options?.forcerAttente && (!parUid || technique)) {
    const id = await enregistrerMouvementCaisse(saisie);
    return { id, applique: true };
  }

  const [role, caissier] = await Promise.all([
    parUid
      ? roleSurSite(parUid, saisie.siteId, adminUid).catch(() => null)
      : Promise.resolve(null),
    aUnCaissier(saisie.siteId).catch(() => false),
  ]);

  /* Le caissier écrit directement : il est le tiroir. Sans caissier sur le
     site, tout le monde écrit — sinon plus rien ne rentrerait.
     Sauf si l'argent a été encaissé dehors : il attend d'être remis,
     quel que soit le rôle de celui qui le porte. */
  if (!options?.forcerAttente && (!caissier || role === 'caissier')) {
    const id = await enregistrerMouvementCaisse(saisie);
    return { id, applique: true };
  }

  const id = await mettreEnAttente({
    siteId: saisie.siteId,
    userId: parUid ?? '',
    sens: saisie.sens,
    motif: saisie.motif,
    sousMotif: saisie.sousMotif ?? null,
    detail: saisie.detail ?? null,
    montant: saisie.montant,
    date: saisie.date,
    partenaireId: saisie.partenaireId ?? null,
    documentId: saisie.documentId ?? null,
    documentType: saisie.documentType ?? null,
    utilisateurNom: saisie.utilisateurNom ?? null,
    utilisateurFonction: saisie.utilisateurFonction ?? null,
  });
  return { id, applique: false };
}
