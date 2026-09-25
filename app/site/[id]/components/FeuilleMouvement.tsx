'use client';

/**
 * Le détail d'un mouvement en attente, en feuille glissante.
 *
 * Une carte de liste ne peut pas tout porter : le sous-motif, le détail,
 * l'auteur, sa fonction, l'heure exacte. Les y entasser rendrait la liste
 * illisible, et les omettre obligerait à ouvrir un autre écran pour savoir
 * ce qu'on autorise.
 *
 * La feuille part du bas parce que c'est là qu'est le pouce : un panneau
 * centré met ses boutons au milieu de l'écran, où la main doit se
 * replacer. Elle se ferme au glissement vers le bas, comme partout
 * ailleurs sur un téléphone — viser une croix de seize pixels est un geste
 * de souris, pas de pouce.
 */

import { useEffect, useRef, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { ArrowDownLeft, ArrowUpRight, Check } from 'lucide-react';
import { LIBELLES_MOTIF_CAISSE } from '@/lib/caisse';
import type { MouvementAttente } from '@/lib/attente-caisse';

interface Props {
  mouvement: MouvementAttente;
  /** Le nom du site ; absent sur la fiche d'un seul site. */
  nomDuSite?: string | null;
  /** Seul le responsable de la caisse voit le bouton. */
  peutConfirmer?: boolean;
  /** Ouvre la confirmation : compter, puis autoriser. */
  onConfirmer?: () => void;
  onFermer: () => void;
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function FeuilleMouvement({
  mouvement: m, nomDuSite, peutConfirmer = false, onConfirmer, onFermer,
}: Props) {
  const entree = m.sens === 'entree';
  /* De combien la feuille a été tirée vers le bas. Elle suit le doigt :
     un panneau qui ne bouge pas sous la main ne dit pas qu'il peut
     s'ouvrir, et on finit par chercher la croix. */
  const [tire, setTire] = useState(0);
  const depart = useRef<number | null>(null);

  /* Fermer à l'échappement : la feuille est modale, elle prend la main
     entière, et il faut pouvoir la rendre sans viser. */
  useEffect(() => {
    const auClavier = (e: KeyboardEvent) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  }, [onFermer]);

  /* Le fond ne défile plus derrière : sans cela, le doigt qui tire la
     feuille emporte la page avec lui. */
  useEffect(() => {
    const avant = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = avant; };
  }, []);

  function debut(y: number) { depart.current = y; }
  function bouge(y: number) {
    if (depart.current === null) return;
    /* Vers le haut, rien : la feuille ne grandit pas, elle se referme. */
    setTire(Math.max(0, y - depart.current));
  }
  function fin() {
    /* Un quart de la hauteur courante, ou un geste franc : en deçà, c'est
       un frôlement, et refermer sur un frôlement se paie d'un retour. */
    if (tire > 110) onFermer();
    else setTire(0);
    depart.current = null;
  }

  const lignes: { label: string; valeur: string }[] = [
    { label: 'Motif', valeur: LIBELLES_MOTIF_CAISSE[m.motif] },
    ...(m.sousMotif ? [{ label: 'Sous-motif', valeur: m.sousMotif }] : []),
    ...(m.detail ? [{ label: 'Détail', valeur: m.detail }] : []),
    ...(nomDuSite ? [{ label: 'Site', valeur: nomDuSite }] : []),
    { label: 'Auteur', valeur: m.utilisateurNom || '—' },
    { label: 'Fonction', valeur: m.utilisateurFonction || 'Système' },
    { label: 'Date', valeur: formatDate(m.date) },
    { label: 'Heure', valeur: m.heure || '—' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
      onClick={onFermer}>
      <div onClick={e => e.stopPropagation()}
        onTouchStart={e => debut(e.touches[0].clientY)}
        onTouchMove={e => bouge(e.touches[0].clientY)}
        onTouchEnd={fin}
        style={{
          transform: `translateY(${tire}px)`,
          /* Pendant le geste, la feuille colle au doigt ; relâchée, elle
             rejoint sa place. Une transition constante donnerait un
             glissement en retard sur la main. */
          transition: depart.current === null ? 'transform 200ms ease-out' : 'none',
        }}
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl dark:bg-gray-900 sm:max-w-md sm:rounded-3xl">

        {/* La poignée : elle dit que la feuille se tire, sans le nommer. */}
        <div className="flex justify-center pb-1 pt-3 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
        </div>

        <div className="px-5 pb-5 pt-3 sm:pt-5">
          {/* Le sens et le montant en tête : c'est la question qu'on se pose
              en ouvrant — combien, et dans quel sens. */}
          <div className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                entree
                  ? 'bg-green-100 dark:bg-green-900/30'
                  : 'bg-red-100 dark:bg-red-900/30'}`}>
                {entree
                  ? <ArrowDownLeft size={17} className="text-green-600" />
                  : <ArrowUpRight size={17} className="text-red-500" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400">
                  {entree ? 'À faire entrer' : 'À faire sortir'}
                </span>
                <span className={`block truncate text-[22px] font-bold leading-7 tracking-tight ${
                  entree ? 'text-green-600' : 'text-red-500'}`}>
                  {formatMontant(m.montant)}
                </span>
              </span>
            </span>
          </div>

          {/* Ce que la carte ne montrait pas. Chaque fait sur sa ligne :
              mêlés, on relit trois fois pour trouver l'auteur. */}
          <dl className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
            {lignes.map(l => (
              <div key={l.label} className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="shrink-0 text-[13px] text-gray-400">{l.label}</dt>
                <dd className="min-w-0 text-right text-[13px] font-medium text-gray-900 dark:text-gray-100">
                  {l.valeur}
                </dd>
              </div>
            ))}
          </dl>

          {peutConfirmer ? (
            <button onClick={onConfirmer}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700">
              <Check size={16} /> Confirmer
            </button>
          ) : (
            /* Sans le droit d'autoriser, dire pourquoi : un écran qui se
               ferme sans rien proposer se relit comme une panne. */
            <p className="mt-5 rounded-xl bg-gray-50 px-3 py-2.5 text-center text-xs text-gray-400 dark:bg-gray-800/50">
              Seul le responsable de la caisse peut l&apos;autoriser.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
