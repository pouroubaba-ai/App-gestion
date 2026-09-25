'use client';
/**
 * Comment cette dette sera réglée.
 *
 * Demandé au moment où elle naît, pas après : c'est là qu'on le sait, et
 * revenir le poser dans Recouvrements est un geste qu'on ne fait pas.
 *
 * Trois chemins, présentés comme trois onglets parce qu'ils ne se comparent
 * pas — on sait lequel on veut avant d'ouvrir :
 *
 *  - Date fixe     : une échéance seule, plafonnée par cette facture.
 *  - Ce partenaire : sa règle à lui, qu'on lit et qu'on modifie.
 *  - Modèle        : le patron de l'activité, recopié tel quel sur lui.
 */
import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { ChampNombre } from '@/components/Champs';
import {
  Loader2, Check, X, Repeat, CalendarDays, Layers, AlertTriangle,
} from 'lucide-react';
import {
  lireChoix, dateParDefaut, aujourdhui,
  type ChoixPlanification, type Planification, type RoleRecouvrement,
} from '@/lib/planification';

/* Le meme jour, dit de deux facons : « le 28/09 » et « dans 7 jours ».
   L'une se calcule depuis l'autre, sans jamais stocker les deux. */
function joursJusqua(date: string): number {
  const d = new Date(date + 'T00:00:00');
  const h = new Date(aujourdhui() + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.round((d.getTime() - h.getTime()) / 86400000));
}

function dateDans(jours: number): string {
  const d = new Date(aujourdhui() + 'T00:00:00');
  d.setDate(d.getDate() + jours);
  /* Composantes locales : `toISOString` basculerait en UTC et rendrait la
     veille des qu'on depasse midi sous un fuseau en avance. */
  const mois = String(d.getMonth() + 1).padStart(2, '0');
  const jour = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mois}-${jour}`;
}

type Onglet = 'date' | 'config' | 'modele';

export default function ModalPlanification({
  siteId, partenaireId, partenaireNom, role, montant,
  onFermer, onValider,
}: {
  siteId: string;
  partenaireId: string;
  partenaireNom: string;
  role: RoleRecouvrement;
  /** Ce que cette facture laisse dû : plafond d'une échéance ponctuelle. */
  montant: number;
  onFermer: () => void;
  onValider: (plan: Planification) => void;
}) {
  const [choix, setChoix] = useState<ChoixPlanification | null>(null);
  const [onglet, setOnglet] = useState<Onglet>('date');

  /* Date fixe. Le delai ne se stocke pas : il se lit sur la date, seule
     verite. Le saisir revient donc a poser la date correspondante. */
  const [date, setDate] = useState(dateParDefaut());
  const [valeur, setValeur] = useState(montant);
  const delai = joursJusqua(date);

  /* Règle du partenaire : pré-remplie par la sienne, ou par le modèle. */
  const [rythme, setRythme] = useState(0);
  const [jours, setJours] = useState(30);

  /* Quand un nouveau rythme prend effet, et ce qu'il faut annoncer avant
     d'écraser celui qui court. */
  const [desMaintenant, setDesMaintenant] = useState(false);
  const [aConfirmer, setAConfirmer] = useState<Planification | null>(null);

  useEffect(() => {
    lireChoix(siteId, partenaireId, role)
      .then(c => {
        setChoix(c);
        if (c.config) {
          setRythme(c.config.valeur);
          setJours(c.config.intervalleJours);
        } else if (c.modele) {
          setRythme(c.modele.valeur);
          setJours(c.modele.intervalleJours);
        }
      })
      .catch(() => setChoix({
        config: null, modele: null, cycleEnCours: false,
        prochaine: null, duTotal: montant,
      }));
  }, [siteId, partenaireId, role, montant]);

  if (!choix) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="rounded-2xl bg-white p-8 dark:bg-gray-900">
        <Loader2 size={22} className="animate-spin text-indigo-500" />
      </div>
    </div>
  );

  const estClient = role === 'client';
  const libelleRole = estClient ? 'créance' : 'dette';

  /* Un rythme qui en remplace un autre efface une décision déjà prise, et
     peut-être annoncée au partenaire : on ne l'écrase pas en silence. Sans
     règle en place, il n'y a rien à perdre. */
  function engager(plan: Planification) {
    if ((plan.mode === 'config' || plan.mode === 'modele') && choix!.config) {
      setAConfirmer(plan);
      return;
    }
    onValider(plan);
  }

  function valider() {
    if (onglet === 'date') return onValider({ mode: 'date', date, valeur });

    if (onglet === 'modele') {
      const m = choix!.modele!;
      return engager({
        mode: 'modele',
        valeur: m.valeur, intervalleJours: m.intervalleJours, desMaintenant,
      });
    }

    /* Inchangée, la règle du partenaire n'a pas à être réécrite : c'est
       « comme d'habitude », et le cycle poursuit son cours. */
    const inchangee = choix!.config
      && choix!.config.valeur === rythme
      && choix!.config.intervalleJours === jours;
    if (inchangee && !desMaintenant) return onValider({ mode: 'continuer' });

    return engager({
      mode: 'config', valeur: rythme, intervalleJours: jours, desMaintenant,
    });
  }

  const ONGLETS: { cle: Onglet; libelle: string; icone: React.ElementType }[] = [
    { cle: 'date', libelle: 'Date fixe', icone: CalendarDays },
    { cle: 'config', libelle: 'Ce partenaire', icone: Repeat },
    { cle: 'modele', libelle: 'Modèle', icone: Layers },
  ];

  const bloque =
    onglet === 'date' ? !(valeur > 0)
      : onglet === 'config' ? !(rythme > 0 && jours > 0)
        : !choix.modele;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 sm:p-6 dark:bg-gray-900">

        <div className="mb-1 flex items-start justify-between gap-3">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Règlement de la {libelleRole}
          </p>
          <button onClick={onFermer} className="p-1 text-gray-400 hover:text-gray-600">
            <X size={16} />
          </button>
        </div>
        <p className="mb-4 text-xs text-gray-400">{partenaireNom}</p>

        {/* Deux montants, deux portées : ce document, et la relation
            entière. Le premier plafonne, le second situe. */}
        <div className="mb-4 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-gray-200 p-3 text-center dark:border-gray-700">
            <p className="mb-0.5 text-[11px] font-medium text-gray-400">
              Cette facture
            </p>
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              {formatMontant(montant)}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 p-3 text-center dark:border-gray-700">
            <p className="mb-0.5 text-[11px] font-medium text-gray-400">
              {estClient ? 'Créance totale' : 'Dette totale'}
            </p>
            <p className={`text-sm font-bold ${estClient ? 'text-emerald-600' : 'text-orange-600'}`}>
              {formatMontant(choix.duTotal)}
            </p>
          </div>
        </div>

        <div className="mb-4 flex items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
          {ONGLETS.map(o => {
            const Icone = o.icone;
            const actif = onglet === o.cle;
            return (
              <button key={o.cle} type="button" onClick={() => setOnglet(o.cle)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-bold transition-colors ${actif
                  ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-900 dark:text-indigo-400'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}>
                <Icone size={13} className="shrink-0" />
                <span className="truncate">{o.libelle}</span>
              </button>
            );
          })}
        </div>

        {onglet === 'date' && (
          <div>
            <p className="mb-3 text-[11px] text-gray-400">
              Une échéance seule, qui n’entraîne aucune suivante.
            </p>
            {/* Les trois sur une ligne, mais pas a parts egales : la date
                porte dix caracteres et son icone, les jours deux ou trois
                chiffres. Des colonnes egales coupaient l'annee et laissaient
                un champ jours a moitie vide. */}
            <div className="grid grid-cols-[minmax(0,7fr)_minmax(0,3fr)_minmax(0,5fr)] gap-2">
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                  Date
                </label>
                <input type="date" value={date} min={aujourdhui()}
                  onChange={e => setDate(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                  Jours
                </label>
                {/* On pense parfois « dans trente jours » plutot qu'a un
                    jour du calendrier : les deux disent la meme echeance,
                    et chacun recalcule l'autre. */}
                <ChampNombre valeur={delai} onChange={n => setDate(dateDans(n))} min={0}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-center text-sm dark:border-gray-700 dark:bg-gray-800" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                  Montant
                </label>
                {/* On ne planifie pas plus que ce que cette facture laisse
                    dû : au-delà, on promettrait un recouvrement sans objet.
                    Le reste de la relation se règle par son propre rythme. */}
                <ChampNombre valeur={valeur} onChange={setValeur}
                  min={0} max={montant}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-center text-sm dark:border-gray-700 dark:bg-gray-800" />
                {valeur >= montant && (
                  <p className="mt-1 text-center text-[11px] text-gray-400">
                    Plafonné à cette facture.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {onglet === 'config' && (
          <div>
            {choix.config ? (
              <div className="mb-3 rounded-xl bg-gray-50 p-3 dark:bg-gray-800/60">
                <p className="text-xs font-bold text-gray-600 dark:text-gray-300">
                  {formatMontant(choix.config.valeur)} tous les {choix.config.intervalleJours} jours
                </p>
                <p className="mt-0.5 text-[11px] text-gray-400">
                  {choix.prochaine
                    ? `Prochain recouvrement le ${choix.prochaine.date} · ${formatMontant(choix.prochaine.reste)}`
                    : 'Aucun recouvrement en cours.'}
                </p>
              </div>
            ) : (
              <p className="mb-3 text-[11px] text-gray-400">
                Ce partenaire n’a pas encore de règle. Elle naîtra d’ici.
              </p>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                  Montant
                </label>
                {/* Un rythme couvre la relation, pas ce document : il n'est
                    pas plafonné par la facture. */}
                <ChampNombre valeur={rythme} onChange={setRythme} min={0}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-center text-sm dark:border-gray-700 dark:bg-gray-800" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
                  Tous les (jours)
                </label>
                <ChampNombre valeur={jours} onChange={setJours} min={1}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-center text-sm dark:border-gray-700 dark:bg-gray-800" />
              </div>
            </div>
          </div>
        )}

        {onglet === 'modele' && (
          choix.modele ? (
            <div>
              <div className="mb-3 rounded-xl bg-gray-50 p-3 dark:bg-gray-800/60">
                <p className="text-xs font-bold text-gray-600 dark:text-gray-300">
                  {formatMontant(choix.modele.valeur)} tous les {choix.modele.intervalleJours} jours
                </p>
                <p className="mt-0.5 text-[11px] text-gray-400">
                  Le modèle de l’activité, recopié sur ce partenaire.
                </p>
              </div>
              {choix.config && (
                <p className="text-[11px] text-orange-600">
                  Remplacera sa règle actuelle
                  ({formatMontant(choix.config.valeur)} / {choix.config.intervalleJours} j).
                </p>
              )}
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-gray-400">
              Aucun modèle enregistré pour cette activité.
            </p>
          )
        )}

        {/* Poser un rythme quand un recouvrement court déjà : le nouveau
            part-il d’aujourd’hui, ou attend-il son tour ? Sans cycle en
            cours la question ne se pose pas — il commence aujourd’hui. */}
        {onglet !== 'date' && choix.cycleEnCours && (
          <div className="mt-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <p className="mb-2 text-xs font-bold text-gray-500 dark:text-gray-400">
              À partir de quand ?
            </p>
            {([
              {
                v: false, titre: 'Au prochain recouvrement',
                pied: 'L’échéance en cours suit son cours ; le nouveau rythme prend la suite.',
              },
              {
                v: true, titre: 'Dès aujourd’hui',
                pied: 'Une échéance naît au nouveau rythme. Celle en cours garde sa date et son montant, mais cesse d’entraîner les suivantes.',
              },
            ]).map(o => (
              <button key={String(o.v)} type="button" onClick={() => setDesMaintenant(o.v)}
                className={`mb-1 block w-full rounded-lg px-3 py-2 text-left transition-colors ${
                  desMaintenant === o.v
                    ? 'bg-indigo-50 dark:bg-indigo-900/20'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                <span className={`block text-xs font-bold ${desMaintenant === o.v
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-gray-600 dark:text-gray-300'}`}>
                  {o.titre}
                </span>
                <span className="block text-[11px] text-gray-400">{o.pied}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          {/* On peut confirmer sans rien planifier : la dette existe, et
              l'échéancier se posera plus tard si on le veut. */}
          <button onClick={() => onValider({ mode: 'aucun' })}
            className="flex-1 rounded-xl py-2.5 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
            Plus tard
          </button>
          <button onClick={valider} disabled={bloque}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
            <Check size={14} /> Valider
          </button>
        </div>

        {/* Écraser une règle, c'est effacer une décision déjà prise : on
            montre ce qu'on perd avant de le faire. */}
        {aConfirmer && choix.config
          && (aConfirmer.mode === 'config' || aConfirmer.mode === 'modele') && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-black/40 p-4">
            <div className="w-full max-w-xs rounded-2xl bg-white p-5 dark:bg-gray-900">
              <div className="mb-3 flex items-center gap-2">
                <AlertTriangle size={16} className="shrink-0 text-orange-500" />
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                  Remplacer la règle ?
                </p>
              </div>
              <div className="mb-4 space-y-1.5 text-xs">
                <p className="text-gray-400">
                  Actuelle ·{' '}
                  <span className="font-bold text-gray-500 line-through">
                    {formatMontant(choix.config.valeur)} / {choix.config.intervalleJours} j
                  </span>
                </p>
                <p className="text-gray-400">
                  Nouvelle ·{' '}
                  <span className="font-bold text-indigo-600 dark:text-indigo-400">
                    {formatMontant(aConfirmer.valeur)} / {aConfirmer.intervalleJours} j
                  </span>
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setAConfirmer(null)}
                  className="flex-1 rounded-xl py-2 text-xs font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
                  Annuler
                </button>
                <button onClick={() => { const p = aConfirmer; setAConfirmer(null); onValider(p); }}
                  className="flex-1 rounded-xl bg-orange-600 py-2 text-xs font-bold text-white transition-colors hover:bg-orange-700">
                  Remplacer
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
