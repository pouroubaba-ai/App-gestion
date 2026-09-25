'use client';

/** Deux séries comparées, une paire de barres verticales par intervalle. */
export function BarresVerticales({ donnees, couleurA, couleurB, labelA, labelB, format }: {
  donnees: { label: string; a: number; b: number }[];
  couleurA: string;
  couleurB: string;
  labelA: string;
  labelB: string;
  format: (n: number) => string;
}) {
  const max = donnees.reduce((m, d) => Math.max(m, d.a, d.b), 0);
  if (donnees.length === 0) {
    return <p className="text-xs text-gray-400 text-center py-8">Aucune donnée sur cette période.</p>;
  }

  return (
    <div>
      <div className="flex items-end gap-2 h-44 overflow-x-auto pb-1">
        {donnees.map((d, i) => (
          <div key={i} className="flex-1 min-w-[28px] flex flex-col items-center gap-1 h-full">
            <div className="flex-1 w-full flex items-end justify-center gap-0.5">
              {/* une hauteur nulle laisserait un vide ambigu : on garde 2px visibles */}
              <div className={`w-1/2 max-w-[14px] rounded-t ${couleurA} transition-all`}
                style={{ height: max > 0 ? `${Math.max((d.a / max) * 100, d.a > 0 ? 2 : 0)}%` : '0%' }}
                title={`${labelA} : ${format(d.a)}`} />
              <div className={`w-1/2 max-w-[14px] rounded-t ${couleurB} transition-all`}
                style={{ height: max > 0 ? `${Math.max((d.b / max) * 100, d.b > 0 ? 2 : 0)}%` : '0%' }}
                title={`${labelB} : ${format(d.b)}`} />
            </div>
            <span className="text-xs text-gray-400 whitespace-nowrap">{d.label}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-4 mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
        <span className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className={`w-2.5 h-2.5 rounded ${couleurA}`} /> {labelA}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className={`w-2.5 h-2.5 rounded ${couleurB}`} /> {labelB}
        </span>
      </div>
    </div>
  );
}

const TEINTES = ['#6366f1', '#f97316', '#14b8a6', '#e11d48', '#8b5cf6', '#eab308', '#0ea5e9', '#84cc16'];

/** Répartition en barres horizontales : on compare des longueurs, pas des angles. */
export function BarresHorizontales({ parts, format, couleur, signe }: {
  /** `teinte` fixe la couleur d'une barre ; sinon la palette s'applique */
  parts: { label: string; valeur: number; teinte?: string }[];
  format: (n: number) => string;
  /** classe Tailwind commune à toutes les barres */
  couleur?: string;
  /** préfixe le montant d'un + ou d'un − selon la barre */
  signe?: (p: { label: string; valeur: number; teinte?: string }) => '+' | '−' | '';
}) {
  const total = parts.reduce((s, p) => s + p.valeur, 0);
  if (total <= 0) {
    return <p className="text-xs text-gray-400 text-center py-8">Aucune donnée sur cette période.</p>;
  }
  const tries = [...parts].sort((a, b) => b.valeur - a.valeur);
  const max = tries[0].valeur;

  return (
    <div className="flex flex-col gap-2.5">
      {tries.map((p, i) => (
        <div key={p.label}>
          <div className="flex justify-between items-baseline mb-1">
            <span className="text-xs text-gray-600 dark:text-gray-400 truncate">{p.label}</span>
            <span className="text-xs font-medium text-gray-900 dark:text-gray-100 shrink-0 ml-2">
              {signe?.(p) ?? ''}{format(p.valeur)}
              <span className="text-gray-400 font-normal ml-1.5">{((p.valeur / total) * 100).toFixed(0)} %</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-50 dark:bg-gray-800 overflow-hidden">
            <div className={`h-full rounded-full ${p.teinte ?? couleur ?? ''}`}
              style={{
                width: `${(p.valeur / max) * 100}%`,
                ...(p.teinte || couleur ? {} : { background: TEINTES[i % TEINTES.length] }),
              }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Camembert de répartition, avec sa légende chiffrée. */
export function Camembert({ parts, format, compact = false }: {
  parts: { label: string; valeur: number }[];
  format: (n: number) => string;
  /** empile le disque et la légende au lieu de les mettre côte à côte */
  compact?: boolean;
}) {
  const total = parts.reduce((s, p) => s + p.valeur, 0);
  if (total <= 0) {
    return <p className="text-xs text-gray-400 text-center py-8">Aucune donnée sur cette période.</p>;
  }

  const tries = [...parts].sort((a, b) => b.valeur - a.valeur);
  /* un camembert au-delà de 6 parts devient illisible : le reste est regroupé */
  const visibles = tries.length > 6
    ? [...tries.slice(0, 5), { label: 'Autres', valeur: tries.slice(5).reduce((s, p) => s + p.valeur, 0) }]
    : tries;

  const R = 60, C = 70, EPAISSEUR = 22;
  let angle = -90;
  const arcs = visibles.map((p, i) => {
    const part = (p.valeur / total) * 360;
    const debut = angle;
    angle += part;
    const rad = (a: number) => (a * Math.PI) / 180;
    const x1 = C + R * Math.cos(rad(debut));
    const y1 = C + R * Math.sin(rad(debut));
    const x2 = C + R * Math.cos(rad(angle));
    const y2 = C + R * Math.sin(rad(angle));
    /* un arc de plus de 180° doit être marqué comme "grand arc" */
    const grand = part > 180 ? 1 : 0;
    return {
      d: `M ${x1} ${y1} A ${R} ${R} 0 ${grand} 1 ${x2} ${y2}`,
      couleur: TEINTES[i % TEINTES.length],
      label: p.label,
      valeur: p.valeur,
      pourcent: (p.valeur / total) * 100,
    };
  });

  return (
    <div className={compact ? 'flex flex-col items-center gap-3' : 'flex flex-wrap items-center gap-5'}>
      <svg width={compact ? 110 : 140} height={compact ? 110 : 140} viewBox="0 0 140 140" className="shrink-0">
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill="none" stroke={a.couleur} strokeWidth={EPAISSEUR} />
        ))}
      </svg>
      <div className={`flex flex-col gap-1.5 ${compact ? 'w-full' : 'flex-1 min-w-[140px]'}`}>
        {arcs.map((a, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded shrink-0" style={{ background: a.couleur }} />
            <span className="text-gray-600 dark:text-gray-400 flex-1 truncate">{a.label}</span>
            <span className="text-gray-400">{a.pourcent.toFixed(0)} %</span>
            <span className="font-medium text-gray-900 dark:text-gray-100">{format(a.valeur)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
