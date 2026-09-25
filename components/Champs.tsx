'use client';
import { useEffect, useRef, useState } from 'react';
import { Search, X, ChevronDown, Check } from 'lucide-react';

/**
 * Champ de recherche avec effacement.
 * Le bouton n'existe que s'il y a quelque chose à effacer : un contrôle
 * inerte en permanence attire l'œil sans rien offrir.
 */
export function ChampRecherche({
  valeur, onChange, placeholder = 'Rechercher…',
  className = '', autoFocus, onKeyDown, enfants,
}: {
  valeur: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** rendu sous le champ, dans le même conteneur positionné (suggestions…) */
  enfants?: React.ReactNode;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
      <input type="text" placeholder={placeholder} value={valeur} autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full pl-9 pr-9 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      {valeur && (
        <button onClick={() => onChange('')} title="Effacer" type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
          <X size={13} />
        </button>
      )}
      {enfants}
    </div>
  );
}

/**
 * Un <input type="number"> refuse les espaces : au-delà du million, les
 * chiffres deviennent illisibles. Ce champ reste en mode texte et pose les
 * séparateurs à l'affichage, en ne rendant que le nombre au parent.
 */
export function ChampNombre({ valeur, onChange, className, min = 0, max }: {
  valeur: number;
  onChange: (n: number) => void;
  className?: string;
  min?: number;
  /**
   * Plafond appliqué à la frappe, pas seulement à la lecture.
   *
   * Le parent qui se contentait de borner dans son `onChange` ne voyait
   * rien changer à l'écran : le champ affiche sa saisie brute tant qu'on y
   * est, et gardait « 5555555 » sous les yeux alors que la valeur retenue
   * valait 5 000. Le plafond appartient donc au champ.
   */
  max?: number;
}) {
  /**
   * Effacer pour retaper est un geste ordinaire : on vide « 1 » pour écrire
   * « 32 ». Rendre le minimum dès que le champ est vide le remplit à nouveau
   * sous les doigts — et quand ce minimum vaut zéro, la ligne disparaît du
   * panier avant qu'on ait tapé le premier chiffre.
   *
   * Le champ garde donc son vide tant qu'on y est, et ne conclut qu'en le
   * quittant. `null` dit « en cours de saisie », distinct de zéro.
   */
  const [saisie, setSaisie] = useState<string | null>(null);

  /* La saisie en cours s'affiche telle qu'on la tape — séparateurs
     compris — pour qu'un grand nombre reste lisible sous les doigts. */
  const affiche = saisie !== null
    ? (saisie === '' ? '' : Number(saisie).toLocaleString('fr-FR'))
    : (valeur === 0 ? '' : valeur.toLocaleString('fr-FR'));

  return (
    <input
      type="text" inputMode="numeric"
      value={affiche}
      placeholder={String(min)}
      onChange={e => {
        /* on ne garde que les chiffres : espaces, points et virgules sautent */
        const brut = e.target.value.replace(/[^0-9]/g, '');
        /* Au-delà du plafond, on ne laisse pas la frappe filer : le champ
           se fige sur le maximum plutôt que d'afficher un nombre que le
           parent refusera de toute façon. */
        const borne = max !== undefined && brut !== '' && Number(brut) > max
          ? String(max)
          : brut;
        setSaisie(borne);
        /* Un champ vidé n'est pas une valeur : le parent garde la sienne
           jusqu'à ce qu'on ait fini d'écrire. */
        if (borne !== '') onChange(Number(borne));
      }}
      onBlur={() => {
        /* Quitter un champ vide, c'est n'avoir rien saisi : le minimum
           s'applique alors, et la ligne retrouve une quantité valable. */
        if (saisie === '') onChange(min);
        setSaisie(null);
      }}
      className={className} />
  );
}

export interface OptionSelect {
  valeur: string;
  label: string;
  /** texte secondaire affiché à droite (catégorie, solde…) */
  detail?: string;
  /**
   * Libellé une fois choisi, quand il doit être plus court que dans la liste :
   * on parcourt « Carton — 30 pièces » pour décider, on garde « Carton x 30 »
   * à l'écran. Absent, c'est `label` qui reste affiché.
   */
  labelCourt?: string;
}

/**
 * Liste déroulante cherchable, pour les choix qui peuvent devenir longs.
 * Un <select> natif oblige à parcourir des centaines d'entrées à l'œil ;
 * ici la frappe filtre, et le clavier suffit à choisir.
 */
export function SelectCherchable({
  valeur, onChange, options, placeholder = 'Choisir…', vide = 'Aucun résultat', disabled,
  compact = false,
}: {
  valeur: string;
  onChange: (v: string) => void;
  options: OptionSelect[];
  placeholder?: string;
  vide?: string;
  disabled?: boolean;
  /** dans une cellule de tableau : même hauteur que les champs voisins */
  compact?: boolean;
}) {
  const [ouvert, setOuvert] = useState(false);
  const [filtre, setFiltre] = useState('');
  const [survol, setSurvol] = useState(0);
  const boite = useRef<HTMLDivElement>(null);
  /**
   * En mode compact le champ vit dans un tableau qui défile : une liste en
   * position absolue y serait coupée par le conteneur. On la sort du flux en
   * position fixe, d'où la nécessité de mesurer le bouton.
   */
  const [ancre, setAncre] = useState<
    { x: number; y: number; w: number; hauteur: number; versLeHaut: boolean } | null>(null);

  /* Hauteur du panneau : la barre de recherche, plus la liste. */
  const HAUTEUR_MAX = 280;

  function mesurer() {
    const r = boite.current?.getBoundingClientRect();
    if (!r) return;
    /* Ce qu'il reste sous le champ, et au-dessus. Dans un modal, le bas de
       l'écran arrive vite : sans ce calcul, la liste s'ouvrait dans quelques
       pixels et on y défilait à l'aveugle. */
    const dessous = window.innerHeight - r.bottom - 12;
    const dessus = r.top - 12;
    const versLeHaut = dessous < 160 && dessus > dessous;
    setAncre({
      x: r.left,
      y: versLeHaut ? r.top : r.bottom,
      w: r.width,
      hauteur: Math.min(HAUTEUR_MAX, Math.max(versLeHaut ? dessus : dessous, 120)),
      versLeHaut,
    });
  }

  /* Un champ posé dans un conteneur qui défile — un modal, un tableau — verrait
     sa liste coupée par ce conteneur. On la sort alors du flux. */
  const [horsFlux, setHorsFlux] = useState(false);
  useEffect(() => {
    if (!ouvert) { return; }
    let n = boite.current?.parentElement ?? null;
    let trouve = false;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (/(auto|scroll|hidden)/.test(st.overflowY + st.overflow)) { trouve = true; break; }
      n = n.parentElement;
    }
    setHorsFlux(trouve);
  }, [ouvert]);

  /* un clic ailleurs referme : sinon la liste reste ouverte sur la page */
  useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: MouseEvent) => {
      if (boite.current && !boite.current.contains(e.target as Node)) setOuvert(false);
    };
    document.addEventListener('mousedown', dehors);
    /* la page peut défiler sous une liste ouverte : elle doit suivre */
    const suivre = () => mesurer();
    window.addEventListener('scroll', suivre, true);
    window.addEventListener('resize', suivre);
    return () => {
      document.removeEventListener('mousedown', dehors);
      window.removeEventListener('scroll', suivre, true);
      window.removeEventListener('resize', suivre);
    };
  }, [ouvert]);

  const q = filtre.trim().toLowerCase();
  const visibles = q
    ? options.filter(o => o.label.toLowerCase().includes(q) || (o.detail ?? '').toLowerCase().includes(q))
    : options;

  const choisie = options.find(o => o.valeur === valeur);

  function choisir(o?: OptionSelect) {
    if (!o) return;
    onChange(o.valeur);
    setOuvert(false);
    setFiltre('');
    setSurvol(0);
  }

  return (
    <div ref={boite} className="relative">
      <button type="button" disabled={disabled}
        onClick={() => { mesurer(); setOuvert(!ouvert); setFiltre(''); setSurvol(0); }}
        className={`w-full flex items-center justify-between gap-1 border border-gray-200 dark:border-gray-700 disabled:opacity-50 text-left focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
          compact
            ? 'px-1.5 py-0.5 rounded-md bg-white dark:bg-gray-900 text-xs'
            : 'px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-800 text-sm'}`}>
        <span className={`truncate ${choisie ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}>
          {choisie ? (choisie.labelCourt ?? choisie.label) : placeholder}
        </span>
        <ChevronDown size={compact ? 11 : 14} className={`shrink-0 text-gray-400 transition-transform ${ouvert ? 'rotate-180' : ''}`} />
      </button>

      {ouvert && (
        <div
          className={`z-50 flex flex-col rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900 ${
            (compact || horsFlux) ? 'fixed' : 'absolute left-0 right-0 top-full mt-1'}`}
          style={(compact || horsFlux) && ancre
            ? {
                left: ancre.x,
                ...(ancre.versLeHaut
                  ? { bottom: window.innerHeight - ancre.y + 4 }
                  : { top: ancre.y + 4 }),
                minWidth: Math.max(ancre.w, 180),
                width: compact ? undefined : ancre.w,
                maxHeight: ancre.hauteur,
              }
            : undefined}>
          <div className="shrink-0 border-b border-gray-100 p-2 dark:border-gray-800">
            <input autoFocus type="text" placeholder="Rechercher…" value={filtre}
              onChange={e => { setFiltre(e.target.value); setSurvol(0); }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSurvol(n => (n + 1) % Math.max(visibles.length, 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSurvol(n => (n - 1 + visibles.length) % Math.max(visibles.length, 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  choisir(visibles[survol]);
                } else if (e.key === 'Escape') {
                  setOuvert(false);
                }
              }}
              className="w-full px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>

          {visibles.length === 0 ? (
            <p className="px-3 py-4 text-xs text-gray-400 text-center">{vide}</p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {visibles.map((o, n) => (
                <button key={o.valeur} type="button"
                  onMouseEnter={() => setSurvol(n)}
                  onClick={() => choisir(o)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${n === survol
                    ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                    : 'text-gray-700 dark:text-gray-300'}`}>
                  <span className="truncate">{o.label}</span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {o.detail && <span className="text-xs text-gray-400">{o.detail}</span>}
                    {o.valeur === valeur && <Check size={13} className="text-indigo-500" />}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
