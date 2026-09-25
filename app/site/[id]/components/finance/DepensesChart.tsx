'use client';
import { formatMontant } from '@/lib/format';

/**
 * Anneau des dépenses, repris du dashboard financier. Le découpage se fait
 * par motif plutôt que par site : dans un site, la répartition entre sites
 * n'a pas d'objet.
 */
const CX = 70;
const CY = 70;
const R = 58;
const CIRCONFERENCE = 2 * Math.PI * R;

/* Une palette fixe, parcourue dans l'ordre : les motifs ne sont pas connus
   d'avance, mais deux lectures successives doivent donner les mêmes couleurs. */
const PALETTE = ['#4f46e5', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'];

/**
 * Montant abrégé, pour tenir au centre de l'anneau : « 100 000 000 000 FCFA »
 * fait 22 caractères, l'intérieur n'en tient que huit à taille lisible. Sur
 * un tableau de bord on lit un ordre de grandeur — les unités ne changent
 * aucune décision, et le montant exact reste dans l'onglet Fonds.
 */
function abrege(n: number): string {
  const abs = Math.abs(n);
  const signe = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${signe}${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace('.', ',')} Md`;
  if (abs >= 1e6) return `${signe}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace('.', ',')} M`;
  if (abs >= 1e4) return `${signe}${Math.round(abs / 1e3)} k`;
  return `${signe}${Math.round(abs).toLocaleString('fr-FR')}`;
}

export default function DepensesChart({
  parts, ventes,
}: {
  parts: { label: string; valeur: number }[];
  ventes: number;
}) {
  const total = parts.reduce((s, p) => s + p.valeur, 0);
  const pourcentVentes = ventes > 0 ? Math.round((total / ventes) * 100) : null;

  let offset = 0;
  const segments = parts.map((p, i) => {
    const fraction = total > 0 ? p.valeur / total : 0;
    const dasharray = `${fraction * CIRCONFERENCE} ${CIRCONFERENCE}`;
    const dashoffset = -offset * CIRCONFERENCE;
    offset += fraction;
    return {
      ...p,
      couleur: PALETTE[i % PALETTE.length],
      dasharray,
      dashoffset,
      percent: Math.round(fraction * 100),
    };
  });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-black/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-950">
      <p className="shrink-0 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
        Dépenses
      </p>

      {total === 0 ? (
        <p className="flex flex-1 items-center justify-center text-xs text-neutral-400">
          Aucune dépense sur la période.
        </p>
      ) : (
        <div className="mt-2 flex min-h-0 flex-1 items-center gap-4">
          {/* Le total vit au centre de l'anneau : coincé entre le cercle et
              la légende, il cassait sur deux lignes et volait la largeur
              dont la légende a besoin dès qu'il y a plus de deux motifs. */}
          <div className="relative aspect-square h-full max-h-[120px] min-h-0 w-auto shrink-0">
            <svg viewBox="0 0 140 140" className="h-full w-full">
              <circle cx={CX} cy={CY} r={R} fill="none"
                className="stroke-neutral-100 dark:stroke-neutral-800" strokeWidth="20" />
              {segments.map((s) => (
                <circle
                  key={s.label}
                  cx={CX}
                  cy={CY}
                  r={R}
                  fill="none"
                  stroke={s.couleur}
                  strokeWidth="20"
                  strokeDasharray={s.dasharray}
                  strokeDashoffset={s.dashoffset}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${CX} ${CY})`}
                />
              ))}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
              title={formatMontant(total)}>
              <span className="text-[15px] font-bold leading-none tracking-tight text-neutral-900 dark:text-white">
                {abrege(total)}
              </span>
              <span className="mt-0.5 text-[9px] font-medium leading-none text-neutral-400">
                FCFA
              </span>
              {/* Au-delà de 200 %, le ratio ne dit plus rien sur les dépenses :
                  il dit que les ventes de la période sont trop faibles. */}
              {pourcentVentes != null && pourcentVentes <= 200 && (
                <span className="mt-1 text-[10px] font-semibold leading-none text-red-600 dark:text-red-400">
                  {pourcentVentes}% des ventes
                </span>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
            {segments.map((s) => (
              <div key={s.label} className="min-w-0 text-left">
                <div className="flex items-center gap-1.5 text-xs font-bold text-neutral-800 dark:text-neutral-100">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: s.couleur }} />
                  <span className="truncate">{s.label}</span>
                  <span className="shrink-0 text-neutral-400">{s.percent}%</span>
                </div>
                <p className="ml-4 mt-0.5 truncate text-[11px] font-medium text-neutral-400">
                  {formatMontant(s.valeur)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
