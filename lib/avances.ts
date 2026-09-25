export interface AvanceConfigCalc {
  assignationId: string;
  mode: 'pourcentage' | 'valeur';
  valeur: number;
  actif: boolean;
}

export interface AssignationCalc {
  id: string;
  valeur: number;
  intervalleJours: number;
}

export interface InstanceCalc {
  assignationId?: string;
  dateDebut: string;
  dateFin: string;
}

export function joursRestants(dateFin: string): number {
  const d = new Date(dateFin); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}

/** Montant prélevé à chaque échéance, plafonné à la valeur de la rémunération. */
export function montantParPrelevement(
  config: Pick<AvanceConfigCalc, 'mode' | 'valeur'>,
  assign: Pick<AssignationCalc, 'valeur'>,
): number {
  const brut = config.mode === 'pourcentage'
    ? Math.round(assign.valeur * config.valeur / 100)
    : config.valeur;
  return Math.min(brut, assign.valeur);
}

/**
 * Jours avant extinction de la dette d'avance, toutes sources confondues.
 * Simule les échéances de chaque config active dans l'ordre chronologique :
 * calculer source par source donnerait un résultat faux dès qu'il y en a plusieurs.
 * Renvoie null si rien ne prélève ou si la dette ne s'éteint pas dans 10 ans.
 */
export function joursAvantSolde(
  resteAvance: number,
  configs: AvanceConfigCalc[],
  assignations: AssignationCalc[],
  instances: InstanceCalc[],
): number | null {
  if (resteAvance <= 0) return null;

  const echeanciers = configs
    .filter(c => c.actif)
    .map(c => {
      const assign = assignations.find(a => a.id === c.assignationId);
      if (!assign) return null;
      const instancesConfig = instances
        .filter(l => l.assignationId === c.assignationId)
        .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
      const derniere = instancesConfig[instancesConfig.length - 1];
      return {
        prochain: derniere ? Math.max(joursRestants(derniere.dateFin), 0) : 0,
        intervalle: assign.intervalleJours,
        montant: montantParPrelevement(c, assign),
      };
    })
    .filter((e): e is { prochain: number; intervalle: number; montant: number } =>
      !!e && e.montant > 0 && e.intervalle > 0);

  if (echeanciers.length === 0) return null;

  let dette = resteAvance;
  let jour = 0;
  while (dette > 0 && jour <= 3650) {
    jour = Math.min(...echeanciers.map(e => e.prochain));
    for (const e of echeanciers) {
      if (e.prochain === jour) {
        dette -= e.montant;
        e.prochain += e.intervalle;
      }
    }
  }
  return dette <= 0 ? jour : null;
}
