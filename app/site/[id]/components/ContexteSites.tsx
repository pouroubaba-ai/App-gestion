'use client';
/**
 * Ce qu'un onglet sait des sites qu'il couvre.
 *
 * Le même onglet sert la fiche d'un site et la vue d'ensemble du
 * propriétaire. La différence tient à deux choses : le nom du site à
 * afficher sur chaque ligne, et le droit d'écrire — on n'enregistre pas un
 * versement dans une vue qui n'en désigne aucun.
 */
import { useMemo, useState } from 'react';
import { sitesDe, siteUnique, type Portee } from '@/lib/portee';
import FiltreDeroulant from '@/components/FiltreDeroulant';

export interface SiteConnu { id: string; nom: string }

/** Les props que tout onglet partage, quelle que soit sa portée. */
export interface PropsPortee {
  /** Un site, ou plusieurs : la vue d'ensemble en passe plusieurs. */
  siteId: Portee;
  /** Les noms, pour la colonne Site. Absent = fiche d'un seul site. */
  sites?: SiteConnu[];
  /** Le titre à porter en tête. La vue d'ensemble le nomme ; dans la fiche
      d'un site, l'onglet garde le sien. */
  titre?: string;
}

/**
 * La colonne Site et son filtre ne servent qu'à plusieurs : sur la fiche
 * d'un site, ils répéteraient la même valeur sur chaque ligne.
 */
export function useSites(siteId: Portee, sites?: SiteConnu[]) {
  /* La liste se mémorise sur son contenu, pas sur l'objet : la page
     d'ensemble reconstruit son tableau d'identifiants à chaque rendu, et
     React compare par identité. Sans cette clé, chaque clic sur une carte
     ou un filtre passait pour un changement de portée et relançait tout le
     chargement — d'où l'écran qui disparaît et revient pour un geste qui
     ne lit rien. */
  const cleSites = sitesDe(siteId).join(',');
  const ids = useMemo(
    () => sitesDe(siteId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cleSites],
  );
  const ensemble = ids.length > 1;

  const noms = useMemo(() => {
    const m: Record<string, string> = {};
    (sites ?? []).forEach(s => { m[s.id] = s.nom; });
    return m;
  }, [sites]);

  /* Le filtre du propriétaire : aucun site choisi veut dire tous. */
  const [filtre, setFiltre] = useState<string>('');

  /* Ce qu'on regarde : tout mêlé, ou site par site. La vue par site
     répartit ce qui est déjà chargé — elle ne relit rien. */
  const [vue, setVue] = useState<'ensemble' | 'sites'>('ensemble');

  /* Ce que les lectures doivent couvrir : la portée, réduite au site choisi
     quand il y en a un. Stable elle aussi : c'est elle que les `useEffect`
     de chargement surveillent. */
  const portee: Portee = useMemo(
    () => (filtre ? filtre : ids),
    [filtre, ids],
  );

  /* Les sites à dessiner en cartes : tous, ou le seul qu'on a filtré. */
  const sitesVus = (sites ?? []).filter(x => !filtre || x.id === filtre);

  return {
    ensemble,
    /** Le site où écrire, ou `null` : la vue d'ensemble n'écrit pas. */
    siteEcriture: siteUnique(portee),
    nomDe: (id?: string | null) => (id ? noms[id] ?? '—' : '—'),
    portee,
    filtre, setFiltre,
    vue, setVue,
    /** Vrai quand on regarde la répartition plutôt que le total. */
    parSite: ensemble && vue === 'sites',
    sitesVus,
    sites: sites ?? [],
  };
}

/**
 * Le choix de l'angle : le total, ou ce que chaque site y apporte.
 *
 * Un total dit combien, jamais où. La bascule ne change pas les données,
 * seulement la façon de les regrouper — elle n'a donc de sens qu'à
 * plusieurs sites.
 */
export function ToggleVue({ actif, onChange, visible = true }: {
  actif: 'ensemble' | 'sites';
  onChange: (v: 'ensemble' | 'sites') => void;
  visible?: boolean;
}) {
  if (!visible) return null;
  return (
    <div className="flex shrink-0 items-center rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
      {([
        { cle: 'ensemble' as const, label: 'Ensemble' },
        { cle: 'sites' as const, label: 'Par site' },
      ]).map(o => (
        <button key={o.cle} type="button" onClick={() => onChange(o.cle)}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${actif === o.cle
            ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
            : 'text-gray-400 hover:text-gray-600'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Une ligne de la carte d'un site : un intitulé, une valeur. */
export interface LigneCarte {
  label: string;
  /** Déjà mis en forme : l'onglet sait si c'est un montant ou un compte. */
  valeur: string;
  /** Vrai quand rien ne s'est passé : la valeur s'efface au lieu de crier. */
  vide?: boolean;
  ton?: string;
}

/**
 * Les cartes de la vue par site : une par site, même dessin partout.
 *
 * Chaque onglet dit ce que porte sa carte — fonds et mouvements ici, étapes
 * du cycle ailleurs. La forme, elle, ne change pas : on passe d'un onglet
 * à l'autre sans réapprendre à lire.
 */
export function CartesParSite({ sites, contenu, onChoisir }: {
  sites: SiteConnu[];
  /**
   * Ce que fait un clic sur la carte.
   *
   * Une carte qui résume un site invite à l'ouvrir : sans cela, il fallait
   * revenir au filtre en haut et y retrouver le nom qu'on avait sous les
   * yeux. Absent, les cartes restent de simples résumés.
   */
  onChoisir?: (siteId: string) => void;
  contenu: (siteId: string) => {
    /** Le chiffre qui résume le site, en gros. */
    titre: string;
    valeur: string;
    /** Ce qui le détaille, en dessous. */
    lignes: LigneCarte[];
    /** Vrai quand le site n'a rien à montrer sur la période. */
    dort?: boolean;
    /** Une mention à droite du nom : marge, compte, alerte. */
    badge?: { texte: string; ton: string } | null;
  };
}) {
  if (sites.length === 0) return (
    <p className="py-12 text-center text-xs text-gray-300 dark:text-gray-600">
      Aucun site.
    </p>
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {sites.map(st => {
        const c = contenu(st.id);
        /* Un bouton quand le clic mène quelque part : le clavier doit
           pouvoir l'atteindre, et le curseur l'annoncer. */
        const Balise = onChoisir ? 'button' : 'div';
        return (
          <Balise key={st.id}
            {...(onChoisir
              ? { type: 'button' as const, onClick: () => onChoisir(st.id) }
              : {})}
            className={`flex flex-col rounded-2xl border border-gray-100 bg-white p-5 text-left shadow-sm dark:border-gray-800 dark:bg-gray-900 ${
              onChoisir
                ? 'transition-colors hover:border-indigo-200 hover:bg-indigo-50/40 dark:hover:border-indigo-800 dark:hover:bg-indigo-900/10'
                : ''}`}>

            <div className="mb-4 flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-bold text-gray-900 dark:text-gray-100">
                {st.nom}
              </p>
              {c.badge && (
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${c.badge.ton}`}>
                  {c.badge.texte}
                </span>
              )}
            </div>

            {c.dort ? (
              <p className="py-6 text-center text-xs text-gray-300 dark:text-gray-600">
                Aucune activité sur la période
              </p>
            ) : (
              <>
                <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  {c.titre}
                </p>
                <p className="text-2xl font-bold leading-tight text-gray-900 dark:text-gray-100">
                  {c.valeur}
                </p>

                {c.lignes.length > 0 && (
                  <div className="mt-4 space-y-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                    {c.lignes.map(l => (
                      <div key={l.label} className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-gray-400">{l.label}</span>
                        <span className={`font-bold ${l.vide
                          ? 'text-gray-300 dark:text-gray-600'
                          : (l.ton ?? 'text-gray-900 dark:text-gray-100')}`}>
                          {l.valeur}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </Balise>
        );
      })}
    </div>
  );
}

/** Le choix d'un site, posé à côté des autres filtres de l'onglet. */
export function FiltreSite({ sites, valeur, onChange }: {
  sites: SiteConnu[];
  valeur: string;
  onChange: (v: string) => void;
}) {
  if (sites.length <= 1) return null;
  return (
    <FiltreDeroulant
      nom="Site"
      valeur={valeur}
      options={[
        { valeur: '', label: 'Tous' },
        ...sites.map(s => ({ valeur: s.id, label: s.nom })),
      ]}
      onChange={onChange}
    />
  );
}

/** La cellule d'une ligne : le site d'où elle vient. */
export function CelluleSite({ nom }: { nom: string }) {
  return (
    <td className="px-3 py-2.5 text-center">
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
        {nom}
      </span>
    </td>
  );
}
