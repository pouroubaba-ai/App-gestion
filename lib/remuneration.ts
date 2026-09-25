import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from './firebase';

/**
 * Ce que coûtent les employés d'un site, chaque mois.
 *
 * Pas ce qui a été versé — cela varie d'un mois à l'autre et ne dit rien de
 * l'engagement. C'est la somme des rémunérations configurées : ce que le site
 * doit payer, qu'il l'ait payé ou non.
 *
 * Chaque configuration porte son propre rythme — un salaire tous les 30 jours,
 * une prime tous les 7, un versement tous les 15. On les ramène au mois pour
 * pouvoir les additionner : `valeur / intervalle × 30`. Sans cette mise au
 * même dénominateur, on comparerait une semaine à un trimestre.
 *
 * Une assignation suspendue ne compte pas : le site ne la paie plus.
 */
export interface ChargeSite {
  /** employés actifs du site */
  nbEmployes: number;
  /** ce qu'ils coûtent par mois, toutes configurations actives confondues */
  remunerationMensuelle: number;
}

/**
 * La charge de plusieurs sites d'un coup.
 *
 * Firestore facture chaque requête : interroger site par site multiplierait
 * les allers-retours par le nombre de sites. On lit tout, on répartit ensuite.
 */
export async function chargesDesSites(
  siteIds: string[],
): Promise<Record<string, ChargeSite>> {
  const vide: Record<string, ChargeSite> = {};
  siteIds.forEach(id => { vide[id] = { nbEmployes: 0, remunerationMensuelle: 0 }; });
  if (siteIds.length === 0) return vide;

  /* Firestore plafonne `in` à trente valeurs : au-delà, on découpe. */
  const paquets: string[][] = [];
  for (let i = 0; i < siteIds.length; i += 30) paquets.push(siteIds.slice(i, i + 30));

  const [empSnaps, assignSnaps] = await Promise.all([
    Promise.all(paquets.map(p => getDocs(query(
      collection(db, 'employes'), where('siteId', 'in', p))))),
    Promise.all(paquets.map(p => getDocs(query(
      collection(db, 'employe_rem_assignations'), where('siteId', 'in', p))))),
  ]);

  /* Un employé parti ne coûte plus rien : seuls les actifs comptent. */
  const actifs = new Set<string>();
  empSnaps.forEach(snap => snap.docs.forEach(d => {
    const data = d.data() as any;
    if ((data.etat ?? 'actif') !== 'actif') return;
    actifs.add(d.id);
    const c = vide[data.siteId];
    if (c) c.nbEmployes += 1;
  }));

  assignSnaps.forEach(snap => snap.docs.forEach(d => {
    const data = d.data() as any;
    /* Une assignation suspendue, sans rythme, ou portée par un employé parti
       ne pèse plus sur le mois. */
    if (!data.actif || !data.intervalleJours) return;
    if (!actifs.has(data.employeId)) return;
    const c = vide[data.siteId];
    if (c) c.remunerationMensuelle += (data.valeur / data.intervalleJours) * 30;
  }));

  Object.values(vide).forEach(c => {
    c.remunerationMensuelle = Math.round(c.remunerationMensuelle);
  });
  return vide;
}
