import {
  collection, query, where, getDocs, updateDoc, doc,
} from 'firebase/firestore';
import { db } from './firebase';
import { conclu } from './soldes';
import { valeurDossier } from './ouverture';
import { enregistrerVersement } from './versements-collection';
import { ecrireEnCaisse } from './ecrire-caisse';

export type RoleTiers = 'client' | 'fournisseur';

/**
 * Verser sur le compte d'un tiers.
 *
 * Un versement traverse trois niveaux, et c'est pour cela qu'il vit ici
 * plutôt que dans l'écran qui le déclenche :
 *
 *  - les **échéances** de recouvrement, qui disent quand l'argent devait
 *    venir. Il comble les plus anciennes d'abord, et jamais les échues :
 *    celles-là témoignent d'un calendrier non tenu, les remplir après coup
 *    effacerait cette trace.
 *  - les **documents**, qui disent sur quoi il s'impute. Sans cette part,
 *    la colonne « Versé » d'un achat ou d'une vente ne bougerait jamais.
 *  - le **solde du tiers**, qui n'est que la somme des deux précédents.
 *
 * Le même argent traverse les trois ; les séparer les ferait diverger.
 */

export interface EcheanceOuverte {
  id: string; date: string; verse: number; reste: number;
}

export interface DocumentOuvert {
  id: string; reference: string; total: number; verse: number; date: string;
}

export interface CouvertureTiers {
  /** ce que le tiers doit aujourd'hui */
  du: number;
  /** ce que les échéances encore ouvertes promettent d'encaisser */
  planifie: number;
  /** la part du dû qu'aucune échéance ne couvre */
  reste: number;
  echeances: EcheanceOuverte[];
  documents: DocumentOuvert[];
}

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

/**
 * Ce qu'on peut verser à un tiers, et sur quoi cela s'imputera.
 *
 * Une échéance passée en est exclue : elle n'attend plus l'argent, elle
 * atteste qu'à sa date il n'est pas venu.
 */
export async function couvertureTiers(
  siteId: string, partenaireId: string, role: RoleTiers, du: number,
): Promise<CouvertureTiers> {
  const jour = aujourdhui();

  const [jSnap, dSnap] = await Promise.all([
    getDocs(query(
      collection(db, 'recouvrement_journal'),
      where('siteId', '==', siteId),
      where('partenaireId', '==', partenaireId))),
    getDocs(query(
      collection(db, role === 'fournisseur' ? 'achats' : 'ventes'),
      where('siteId', '==', siteId),
      where(role === 'fournisseur' ? 'fournisseurId' : 'clientId', '==', partenaireId))),
  ]);

  const echeances = jSnap.docs
    .map(d => ({ id: d.id, ...d.data() } as any))
    .filter(e => e.role === role && (e.reste ?? 0) > 0 && (e.date ?? '') >= jour)
    .map(e => ({ id: e.id, date: e.date, verse: e.verse ?? 0, reste: e.reste ?? 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const documents = dSnap.docs
    /* Meme regle qu'a l'imputation : seuls les dossiers conclus doivent
       de l'argent. Un devis, une commande pas encore livree ou une vente
       annulee n'ont rien a recevoir, et les proposer au reglement fait
       partir l'argent sur un dossier qui n'est plus rien. */
    .filter(d => conclu(d.data(), role))
    .map(d => {
      const x = d.data() as any;
      const total = valeurDossier(x, role);
      return {
        id: d.id,
        reference: x.reference ?? '—',
        total,
        verse: x.avanceVersee ?? 0,
        date: x.dateConfirmation ?? x.dateLivraison ?? x.dateCommande ?? '',
      };
    })
    .filter(d => d.total - d.verse > 0)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  const planifie = echeances.reduce((s, e) => s + e.reste, 0);
  return { du, planifie, reste: Math.max(0, du - planifie), echeances, documents };
}

/** Ce qu'un montant donné comblerait, avant de l'écrire. */
export function repartition(montant: number, c: CouvertureTiers) {
  let reste = montant;
  const parEcheance = c.echeances
    .map(e => { const part = Math.min(reste, e.reste); reste -= part; return { e, part }; })
    .filter(x => x.part > 0);

  let aImputer = montant;
  const parDocument = c.documents
    .map(d => { const part = Math.min(aImputer, d.total - d.verse); aImputer -= part; return { d, part }; })
    .filter(x => x.part > 0);

  return { parEcheance, parDocument, horsEcheance: reste };
}

/**
 * Enregistre le versement : échéances, documents, solde du tiers.
 * Rend le montant réellement imputé, plafonné à ce qui est dû.
 */
export async function verserAuTiers(params: {
  siteId: string; userId: string;
  partenaireId: string; partenaireNom?: string | null;
  role: RoleTiers;
  montant: number;
  couverture: CouvertureTiers;
  /* Qui encaisse : recopié sur chaque versement, pour que l'historique le
     dise même quand la fiche de l'employé a changé. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /* L'argent a été encaissé dehors : il attend d'être remis au responsable
     de la caisse, qui seul peut le faire entrer au registre. Sans ce
     drapeau, c'est le rôle de celui qui agit qui décide. */
  parRemise?: boolean;
  /* L'admin de l'activité : il n'a pas de rôle de site, on le reconnaît
     à son identifiant. */
  adminUid?: string | null;
  /**
   * L'argent ne vient pas du tiroir.
   *
   * Le propriétaire règle parfois un fournisseur de sa main — un
   * virement, un retrait déjà fait. La dette s'éteint, mais la caisse
   * du site n'a rien vu passer : l'y inscrire ferait mentir le solde,
   * et l'on chercherait un argent sorti d'un tiroir où il n'est jamais
   * entré.
   *
   * Ne vaut que pour un fournisseur : un client qui paie fait entrer
   * de l'argent, et cet argent-là va quelque part. S'il reste en main,
   * c'est une remise, et la remise a son propre chemin.
   */
  horsCaisse?: boolean;
}): Promise<number> {
  const { siteId, userId, partenaireId, role, couverture } = params;
  const total = Math.min(params.montant, couverture.du);
  if (total <= 0) return 0;

  const { parEcheance, parDocument } = repartition(total, couverture);
  const jour = aujourdhui();

  /* Les échéances comblées : elles disent quand l'argent devait venir, et
     gardent trace de ce qui les a honorées. */
  await Promise.all(parEcheance.map(({ e, part }) => updateDoc(
    doc(db, 'recouvrement_journal', e.id), {
      verse: e.verse + part, reste: e.reste - part,
    })));

  /* Un versement par dossier réglé, dans la collection : c'est là qu'il
     vit, et c'est lui qui fait bouger la caisse et le total du dossier.
     Une échéance honorée en même temps le motive et s'y rattache. */
  /* Les échéances se consomment au même rythme que les documents : chaque
     part rattachée à celle qu'elle honore réellement, et non à la première
     de la liste. */
  const file = parEcheance.map(x => ({ id: x.e.id, reste: x.part }));
  function prochaineEcheance(montant: number): string | null {
    let pris = 0;
    let id: string | null = null;
    for (const e of file) {
      if (pris >= montant || e.reste <= 0) continue;
      if (!id) id = e.id;
      const p = Math.min(e.reste, montant - pris);
      e.reste -= p;
      pris += p;
    }
    return id;
  }

  /* Encaisser et remettre sont deux faits. Celui qui va chercher l'argent
     chez le client éteint la dette — le client a payé, c'est acquis — mais
     les billets sont dans sa poche : la caisse ne peut pas les compter
     avant qu'il les ait remis. L'argent passe alors en attente, au nom de
     celui qui le porte, et le responsable de la caisse le fait entrer
     quand il le reçoit.
     Quand c'est le caissier lui-même qui encaisse, il n'y a rien à
     attendre : l'argent va dans le tiroir au même instant. */
  /* Une seule écriture de caisse pour tout le versement : l'argent sort une
     fois, quel que soit le nombre de dossiers qu'il règle. Chaque mouvement
     coûtait une transaction sur le compteur, en série — c'est ce qui rendait
     un versement multiple si lent. */
  /* Les lignes se préparent avant d'écrire quoi que ce soit : selon que
     l'argent entre au tiroir ou attend le caissier, elles partiront
     maintenant ou plus tard, mais elles sont les mêmes. */
  let restant = total;
  const aEcrire: Parameters<typeof enregistrerVersement>[0][] = [];
  for (const { d, part } of parDocument) {
    const echeanceId = prochaineEcheance(part);
    aEcrire.push({
      siteId, userId,
      date: jour,
      montant: part,
      sens: role === 'client' ? 'entree' : 'sortie',
      motif: echeanceId ? 'recouvrement' : 'reglement',
      partenaireId,
      partenaireNom: params.partenaireNom ?? null,
      role,
      achatId: role === 'fournisseur' ? d.id : null,
      venteId: role === 'client' ? d.id : null,
      echeanceId,
      reference: d.reference,
      par: userId,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      sansCaisse: true,
      mouvementCaisseId: null,
    });
    restant -= part;
  }

  /* Ce qui dépasse les dossiers ouverts reste un versement à part entière :
     l'argent est entré, il doit se voir en caisse même sans document à
     imputer. */
  if (restant > 0) {
    aEcrire.push({
      siteId, userId,
      date: jour,
      montant: restant,
      sens: role === 'client' ? 'entree' : 'sortie',
      motif: file.some(e => e.reste > 0) ? 'recouvrement' : 'avance',
      partenaireId,
      partenaireNom: params.partenaireNom ?? null,
      role,
      echeanceId: prochaineEcheance(restant),
      par: userId,
      utilisateurNom: params.utilisateurNom ?? null,
      utilisateurFonction: params.utilisateurFonction ?? null,
      sansCaisse: true,
      mouvementCaisseId: null,
    });
  }

  /* Hors caisse, rien n'entre ni ne sort du tiroir : les versements
     s'écrivent seuls, sans mouvement de caisse à leur rattacher. */
  const horsCaisse = params.horsCaisse === true && role === 'fournisseur';
  const ecriture = horsCaisse ? null : await ecrireEnCaisse({
    siteId,
    sens: role === 'client' ? 'entree' : 'sortie',
    motif: role === 'client' ? 'client' : 'fournisseur',
    /* Les colonnes du registre, dès la déclaration : le motif dit de quoi
       il s'agit, le sous-motif à quel titre, le détail nomme qui. */
    sousMotif: parEcheance.length > 0 ? 'Recouvrement' : 'Règlement',
    detail: params.partenaireNom ?? null,
    montant: total,
    date: jour,
    utilisateur: userId,
    utilisateurNom: params.utilisateurNom ?? null,
    utilisateurFonction: params.utilisateurFonction ?? null,
    partenaireId,
  }, userId, params.adminUid ?? null, {
    forcerAttente: params.parRemise,
  });

  /* La dette tombe quand le client paie, pas quand la caisse compte.
   *
   * Ce sont deux faits distincts et ils n'ont pas le même sujet. Le
   * client a payé : sa dette est éteinte, l'échéance est soldée, et rien
   * de ce qui suit ne le concerne plus. L'argent, lui, est en route vers
   * le tiroir — c'est l'affaire de celui qui le porte et du caissier qui
   * le recevra.
   *
   * Les faire dépendre l'un de l'autre laissait un client réclamé pour
   * une somme qu'il avait réglée, parce qu'un caissier n'avait pas encore
   * ouvert son écran. La créance n'est pas une question de caisse.
   *
   * Ce qui attend, c'est le mouvement de caisse — et lui seul. Le
   * versement porte `mouvementCaisseId` quand l'argent est entré, `null`
   * tant qu'il attend : c'est là que se lit la différence. */
  await Promise.all(aEcrire.map(v => enregistrerVersement({
    ...v,
    mouvementCaisseId: ecriture && ecriture.applique ? ecriture.id : null,
    /* L'origine voyage avec la ligne : on doit pouvoir dire, des mois
       plus tard, d'où l'argent est parti. */
    ...(horsCaisse ? { origine: 'admin' as const } : {}),
  })));

  /* La dette n'est plus écrite sur le partenaire : elle se déduit des
     dossiers non soldés, et tombe d'elle-même quand ils sont réglés. */
  return total;
}
