'use client';

/**
 * Courbe ventes / bénéfice, reprise telle quelle du dashboard financier.
 * Seule différence : les points viennent des données du site au lieu d'être
 * écrits en dur, et l'échelle se calcule sur le maximum réel.
 */
export interface PointSerie {
  jour: string;
  ventes: number;
  benefice: number;
}

const WIDTH = 380;
const HEIGHT = 210;
const PADDING_LEFT = 30;
const PADDING_RIGHT = 8;
const BASELINE = 160;
const CHART_TOP = 14;
const CHART_HEIGHT = BASELINE - CHART_TOP;

function formatTick(v: number) {
  if (v === 0) return '0';
  if (v >= 1_000_000) return `${Math.round(v / 100_000) / 10}M`;
  return `${Math.round(v / 1000)}k`;
}

/** Arrondit le sommet de l'axe à une valeur ronde au-dessus du maximum. */
function echelle(max: number): number {
  if (max <= 0) return 1000;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  return Math.ceil(max / magnitude) * magnitude;
}

export default function VentesBeneficeChart({ donnees }: { donnees: PointSerie[] }) {
  const data = donnees.length > 1 ? donnees : [
    ...donnees, ...(donnees.length === 1 ? [{ ...donnees[0], jour: '' }] : []),
  ];
  if (data.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-black/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-950">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          Ventes &amp; Bénéfice
        </p>
        <p className="flex flex-1 items-center justify-center text-xs text-neutral-400">
          Aucune donnée sur la période.
        </p>
      </div>
    );
  }

  const SCALE_MAX = echelle(Math.max(...data.map(d => Math.max(d.ventes, d.benefice))));
  const TICKS = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(SCALE_MAX * f));

  const plotWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const slotWidth = plotWidth / Math.max(data.length - 1, 1);

  const points = data.map((d, i) => {
    const x = PADDING_LEFT + i * slotWidth;
    const ventesY = BASELINE - (d.ventes / SCALE_MAX) * CHART_HEIGHT;
    const beneficeY = BASELINE - (d.benefice / SCALE_MAX) * CHART_HEIGHT;
    return { ...d, x, ventesY, beneficeY };
  });

  const ticks = TICKS.map((v) => ({
    value: v,
    y: BASELINE - (v / SCALE_MAX) * CHART_HEIGHT,
  }));

  const ventesLine = points.map((p) => `${p.x},${p.ventesY}`).join(' L ');
  const beneficeLine = points.map((p) => `${p.x},${p.beneficeY}`).join(' L ');
  const ventesArea = `M ${ventesLine} L ${points[points.length - 1].x},${BASELINE} L ${points[0].x},${BASELINE} Z`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-black/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-950">
      <div className="flex shrink-0 items-center gap-4">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          Ventes &amp; Bénéfice
        </p>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-neutral-500">
          <span className="h-2 w-2 rounded-sm bg-indigo-600" /> Ventes
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <span className="h-2 w-2 rounded-sm bg-teal-500" /> Bénéfice
        </span>
      </div>

      <div className="flex min-h-0 flex-1 items-center">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full min-w-0 flex-1"
        >
          <defs>
            <linearGradient id="ventesFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4f46e5" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#4f46e5" stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticks.map((t) => (
            <line
              key={t.value}
              x1={PADDING_LEFT}
              y1={t.y}
              x2={WIDTH - PADDING_RIGHT}
              y2={t.y}
              className="stroke-neutral-100 dark:stroke-neutral-800"
              strokeWidth="1"
            />
          ))}
          {ticks.map((t) => (
            <text
              key={`label-${t.value}`}
              x={PADDING_LEFT - 6}
              y={t.y}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="8"
              className="fill-neutral-400"
            >
              {formatTick(t.value)}
            </text>
          ))}

          <path d={ventesArea} fill="url(#ventesFill)" />
          <path
            d={`M ${ventesLine}`}
            fill="none"
            stroke="#4f46e5"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={`M ${beneficeLine}`}
            fill="none"
            stroke="#14b8a6"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {points.map((p, i) => (
            <circle key={`pv-${i}`} cx={p.x} cy={p.ventesY} r="4" fill="#fff" stroke="#4f46e5" strokeWidth="2.5" />
          ))}
          {points.map((p, i) => (
            <circle key={`pb-${i}`} cx={p.x} cy={p.beneficeY} r="3.5" fill="#fff" stroke="#14b8a6" strokeWidth="2.5" />
          ))}

          {points.map((p, i) => (
            <text
              key={`lab-${i}`}
              x={p.x}
              y={HEIGHT - 6}
              textAnchor="middle"
              fontSize="8"
              className="fill-neutral-400"
            >
              {p.jour}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
