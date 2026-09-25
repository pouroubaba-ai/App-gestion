export function formatMontant(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '— FCFA';
  return n.toLocaleString('fr-FR') + ' FCFA';
}

/**
 * Montant abrégé, pour les indicateurs où la place est comptée.
 *
 * « 20 000 000 FCFA » fait dix-huit caractères et casse sur deux lignes dès
 * qu'on le met dans une colonne étroite. Sur un indicateur on lit un ordre
 * de grandeur : le montant exact reste accessible au survol et dans les
 * écrans de détail.
 */
export function abregeMontant(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const signe = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${signe}${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace('.', ',')} Md`;
  if (abs >= 1e6) return `${signe}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace('.', ',')} M`;
  if (abs >= 1e4) return `${signe}${Math.round(abs / 1e3)} k`;
  return `${signe}${Math.round(abs).toLocaleString('fr-FR')}`;
}

export function formatDate(ts: any): string {
  if (!ts) return '—';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** La date du jour, au format des champs `type="date"`. */
export function dateDuJour(): string {
  return new Date().toISOString().split('T')[0];
}

/** La date obtenue en ajoutant un nombre de jours à aujourd'hui. */
export function dansNJours(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

/**
 * Le nombre de jours d'ici à une date.
 *
 * Jamais négatif : une échéance se promet pour plus tard, et un délai qui
 * remonterait le temps ne veut rien dire dans un champ de saisie.
 */
export function ecartJours(date: string): number {
  if (!date) return 0;
  const auj = new Date(dateDuJour()).getTime();
  return Math.max(0, Math.round((new Date(date).getTime() - auj) / 86400000));
}
