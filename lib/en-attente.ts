/**
 * Ce qui attend un geste, maintenant.
 *
 * Un dossier ouvert n'appelle pas forcément une action : un devis dort tant
 * que le client n'a pas répondu, un achat confirmé est clos. Compter tout ce
 * qui n'est pas terminé donnerait un nombre qui ne descend jamais et que
 * personne ne regarderait.
 *
 * On ne compte donc que les états où quelqu'un, ici, doit faire quelque
 * chose : compter une réception, trancher un écart, charger un camion,
 * livrer une commande, réclamer une échéance échue.
 *
 * Le compte porte sur la portée regardée — un site, ou l'activité entière
 * dans la vue d'ensemble : le badge dit ce qui attend là où l'on travaille.
 */
import { lireParSite, sitesDe, type Portee } from '@/lib/portee';
import { aujourdhui } from '@/lib/planification';

/** Ce qui attend, onglet par onglet. */
export interface EnAttente {
  achats: number;
  transferts: number;
  ventes: number;
  recouvrements: number;
  /* Ce qui a été déclaré et que la caisse n'a pas encore fait entrer ou
     sortir. C'est le seul geste du caissier : sans pastille, il faudrait
     ouvrir l'onglet pour savoir s'il y a quelque chose à y faire. */
  autorisations: number;
  /* Ce que j'ai fait entrer et que la caisse n'a pas encore compté. C'est
     l'envers des autorisations : le caissier voit ce qu'il doit confirmer,
     celui qui a vendu voit ce qu'il attend. */
  remises: number;
  /* Les retours qui n'ont pas fini leur cycle, les trois types ensemble.
     Le responsable des commandes les traite tous : séparer clients,
     fournisseurs et transferts l'obligerait à ouvrir chaque onglet pour
     savoir s'il lui reste quelque chose à faire. */
  retours: number;
}

export const AUCUNE_ATTENTE: EnAttente = {
  achats: 0, transferts: 0, ventes: 0, recouvrements: 0, autorisations: 0,
  remises: 0, retours: 0,
};

/**
 * Un achat attend tant qu'il n'est pas clos : une commande passée se
 * relance, une marchandise arrivée se compte, un écart se tranche. Seul
 * `confirme` est fini — et `annule`, abandonné.
 */
const ACHATS_EN_ATTENTE = ['en_attente', 'recu', 'traitement'];

/**
 * Un transfert attend un geste, mais pas du même côté selon l'étape.
 *
 * L'expéditeur rassemble puis charge ; ensuite il n'a plus rien à faire —
 * le camion est parti, et la marchandise attend d'être accusée à l'autre
 * bout. Compter un dossier expédié du côté de l'envoi gonflerait un
 * chiffre qui ne réclame plus aucune action.
 *
 * Le badge porte sur la portée regardée : un même transfert compte donc
 * une fois si l'un des deux sites y figure, deux fois jamais.
 *
 * `a_confirmer` attend l'arbitrage d'un tiers et `confirme` est clos :
 * ni l'un ni l'autre n'appelle un geste des deux bouts.
 */
const TRANSFERTS_ENVOI = ['en_cours', 'preparation'];
const TRANSFERTS_RECEPTION = ['expedie', 'recu', 'traitement'];

/**
 * Une vente attend dès qu'elle est commandée : il faut préparer, puis
 * livrer. Un devis, lui, appartient au client — on ne le relance pas depuis
 * cet écran.
 */
const VENTES_EN_ATTENTE = ['commande', 'preparation', 'pret'];

/**
 * L'état final d'un retour, par type.
 *
 * Recopié de `ETAPES_RETOUR` : `retours-dossiers` importe déjà ce
 * fichier, et l'importer en retour formerait un cycle. La règle est
 * simple et tient en trois lignes — si elle change là-bas, elle doit
 * changer ici.
 */
const FIN_RETOUR: Record<string, string> = {
  client: 'recu', fournisseur: 'livre', transfert: 'recu',
};

/**
 * Compte ce qui attend sur une portée.
 *
 * Les quatre lectures partent ensemble : séparées, le sidebar s'animerait
 * par à-coups pendant que chacune arrive.
 */
export async function compterEnAttente(
  portee: Portee,
  /* Qui regarde. Le porteur ne compte pas les echeances du site : elles
     disent ce que la maison doit recouvrir, quand lui n'a que les
     missions qu'on lui confie. Absent, on compte comme avant. */
  porteurUid?: string | null,
  /* Qui regarde : une remise n'attend que celui qui l'a faite. */
  monUid?: string | null,
): Promise<EnAttente> {
  if (sitesDe(portee).length === 0) return AUCUNE_ATTENTE;

  const jour = aujourdhui();

  /* Un transfert concerne deux sites : celui qui envoie et celui qui
     reçoit. Chacun agit à son tour — on lit donc les deux bouts, en ne
     retenant de chacun que les étapes qui lui réclament un geste, et sans
     compter deux fois un dossier dont les deux sites sont dans la portée. */
  const [achats, sortants, entrants, ventes, echeances, attente, missions,
    retoursDocs] =
    await Promise.all([
      lireParSite('achats', portee),
      lireParSite('transferts', portee, 'siteSourceId'),
      lireParSite('transferts', portee, 'siteDestId'),
      lireParSite('ventes', portee),
      lireParSite('recouvrement_journal', portee),
      lireParSite('mouvements_attente', portee),
      /* Elles servent au compte du porteur : ce qu'on lui a confié à
         emporter, et qui n'est ni soldé ni annulé. */
      lireParSite('missions_paiement', portee),
      lireParSite('retours_dossiers', portee),
    ]);

  /* Un retour attend tant qu'il n'a pas atteint son dernier état. Annulé,
     il ne réclame plus rien. Les trois types se comptent ensemble : c'est
     la même personne qui les traite. */
  const retours = retoursDocs.filter(d => {
    const r = d.data() as any;
    return r.etat !== 'annule' && r.etat !== FIN_RETOUR[r.type];
  }).length;

  const transfertsVus = new Set<string>();
  for (const d of sortants) {
    if (TRANSFERTS_ENVOI.includes((d.data() as any).etat)) transfertsVus.add(d.id);
  }
  for (const d of entrants) {
    if (TRANSFERTS_RECEPTION.includes((d.data() as any).etat)) transfertsVus.add(d.id);
  }

  return {
    achats: achats.filter(d => ACHATS_EN_ATTENTE.includes((d.data() as any).etat)).length,
    transferts: transfertsVus.size,
    ventes: ventes.filter(d => VENTES_EN_ATTENTE.includes((d.data() as any).etat)).length,
    /* Une échéance appelle un geste le jour où elle tombe, et tous les
       jours suivants tant qu'elle n'est pas soldée. Celle de demain
       attendra demain. */
    recouvrements: porteurUid
      ? missions.filter(d => {
          const m = d.data() as any;
          return m.mode === 'porte'
            && m.etat !== 'soldee' && m.etat !== 'annulee'
            && (!m.porteurUid || m.porteurUid === porteurUid);
        }).length
      : echeances.filter(d => {
          const e = d.data() as any;
          return (e.reste ?? 0) > 0 && (e.date ?? '') <= jour;
        }).length,
    /* Ce qui a été tranché est passé au registre : il ne reste ici que
       ce qui demande encore d'ouvrir le tiroir. */
    /* Les missions ne se comptent plus ici : l'écran des autorisations ne
       les montre plus, et une pastille qui annonce trois gestes là où la
       page n'en propose qu'un envoie chercher ce qui n'y est pas. */
    autorisations: attente.filter(
      d => (d.data() as any).etat === 'en_attente').length,
    /* Les miennes, et seulement tant qu'elles attendent : une fois
       confirmée ou refusée, la vente est tranchée. */
    remises: monUid
      ? attente.filter(d => {
          const m = d.data() as any;
          return m.userId === monUid && m.etat === 'en_attente';
        }).length
      : 0,
    retours,
  };
}

/**
 * Dit au reste de l'app que ce qui attend a changé.
 *
 * Les pastilles vivent dans la barre de navigation, qui n'est le parent
 * d'aucun écran : elle est à côté. Quand le caissier autorise un
 * mouvement, rien ne l'en informe — son compteur se relit à la navigation,
 * et l'onglet gardait son « 2 » devant une file déjà vide.
 *
 * Un événement de fenêtre plutôt qu'un contexte : émetteur et récepteur
 * n'ont pas d'ancêtre commun qui aurait eu autre chose à faire que de
 * transporter ce signal.
 */
export const SIGNAL_ATTENTE = 'ibd:attente-changee';

/** À appeler après toute écriture qui vide ou remplit une file. */
export function signalerAttente(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SIGNAL_ATTENTE));
}
