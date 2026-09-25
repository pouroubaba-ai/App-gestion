'use client';
import { useState } from 'react';
import { formatMontant } from '@/lib/format';
import { X, ArrowRight } from 'lucide-react';
import { Vente, EtatVente, LIBELLES_VENTE, valeurVente } from '@/lib/flux-marchandise';

interface Props {
  ventes: Vente[];
  onFermer: () => void;
}

type Periode = 'jour' | 'semaine' | 'mois' | 'annee' | 'tout';

const PERIODES: { key: Periode; label: string }[] = [
  { key: 'jour',    label: "Aujourd'hui" },
  { key: 'semaine', label: 'Semaine' },
  { key: 'mois',    label: 'Mois' },
  { key: 'annee',   label: 'Année' },
  { key: 'tout',    label: 'Tout' },
];

function iso(d: Date): string { return d.toISOString().split('T')[0]; }

function debutPeriode(p: Periode): string {
  const d = new Date();
  if (p === 'jour') return iso(d);
  if (p === 'semaine') {
    const jour = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - jour);
    return iso(d);
  }
  if (p === 'mois') { d.setDate(1); return iso(d); }
  if (p === 'annee') { d.setMonth(0, 1); return iso(d); }
  return '';
}

/* Les cinq étapes, dans l'ordre du parcours. */
const ETAPES: EtatVente[] = ['devis', 'commande', 'preparation', 'pret', 'livre'];

/** La date à laquelle un dossier est entré dans une étape donnée. */
function dateEntree(v: Vente, e: EtatVente): string | null {
  return e === 'devis' ? (v.dateDevis ?? null)
    : e === 'commande' ? (v.dateCommande ?? null)
    : e === 'preparation' ? (v.datePreparation ?? null)
    : e === 'pret' ? (v.datePret ?? null)
    : (v.dateLivraison ?? null);
}

export default function ModalRapportVente({ ventes, onFermer }: Props) {
  const [periode, setPeriode] = useState<Periode>('mois');

  const debut = debutPeriode(periode);
  const dansPeriode = (d?: string | null) => !!d && (!debut || d >= debut);

  /**
   * Un flux, pas un stock : ce qui est ENTRÉ dans cette étape pendant la
   * période, quel que soit l'état du dossier aujourd'hui. Une commande livrée
   * hier est quand même passée par la préparation le 12.
   */
  const flux = ETAPES.map((e, i) => {
    const dossiers = ventes.filter(v => dansPeriode(dateEntree(v, e)));
    /**
     * Taux de passage : la part des dossiers entrés dans l'étape précédente
     * qui ont atteint celle-ci. On compte des dossiers, pas des montants —
     * comparer 225 millions de commandes à 44 000 de devis donnerait un
     * ratio absurde, alors que ces dossiers n'ont aucun rapport entre eux.
     */
    const precedents = i > 0
      ? ventes.filter(v => dansPeriode(dateEntree(v, ETAPES[i - 1])))
      : [];
    const passes = precedents.filter(v => !!dateEntree(v, e)).length;
    return {
      etape: e,
      n: dossiers.length,
      valeur: dossiers.reduce((s, v) => s + valeurVente(v.lignes), 0),
      taux: i > 0 && precedents.length > 0
        ? Math.round((passes / precedents.length) * 100)
        : null,
      passes,
      base: precedents.length,
    };
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-4xl my-8 p-5">

        {/* Titre, période et fermeture sur une seule ligne : trois blocs
            empilés mangeaient un tiers de la fenêtre avant le premier chiffre. */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100 shrink-0">
            Rapport du cycle de vente
          </p>
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 gap-0.5">
          {PERIODES.map(p => (
            <button key={p.key} onClick={() => setPeriode(p.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                ${periode === p.key
                  ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
              {p.label}
            </button>
          ))}
            </div>
            <button onClick={onFermer} className="p-1 text-gray-400 hover:text-gray-600 shrink-0">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* L'entonnoir. Les flèches portent le taux de passage : c'est là que
            se lit la déperdition, qu'aucune carte seule ne montre. */}
        {/* Toujours horizontal : l'entonnoir se lit de gauche à droite, c'est
            le sens du parcours. Sur petit écran il défile plutôt que de se
            replier en colonne, où les flèches ne voudraient plus rien dire. */}
        <div className="flex items-stretch gap-2 overflow-x-auto pb-2">
          {flux.map((f, i) => {
            const taux = f.taux;
            return (
              <div key={f.etape} className="flex items-stretch gap-1 flex-1 min-w-[150px]">
                {i > 0 && (
                  <div className="flex flex-col items-center justify-center gap-1 shrink-0 px-1">
                    <ArrowRight size={16} className="text-gray-300 dark:text-gray-600" />
                    <span className={`text-[11px] font-bold whitespace-nowrap ${
                      taux == null ? 'text-gray-300 dark:text-gray-600'
                        : taux >= 90 ? 'text-green-600'
                        : taux >= 60 ? 'text-amber-600'
                        : 'text-red-500'}`}
                      title={taux == null ? undefined
                        : `${f.passes} sur ${f.base} dossiers`}>
                      {taux == null ? '—' : `${taux} %`}
                    </span>
                  </div>
                )}
                {/* Une seule teinte pour les cinq : ce qui distingue les
                    étapes, c'est leur place dans la file, pas une couleur. */}
                <div className="flex-1 min-w-0 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 rounded-xl px-3 py-2.5">
                  <p className="text-[11px] font-bold text-gray-500 dark:text-gray-400 truncate">
                    {LIBELLES_VENTE[f.etape]}
                  </p>
                  {/* Jamais tronqué : un montant coupé (« 225 00… ») est pire
                      qu'un montant sur deux lignes — il devient illisible. */}
                  <p className="text-sm font-bold text-gray-900 dark:text-gray-100 leading-tight mt-1 break-words">
                    {formatMontant(f.valeur)}
                  </p>
                  <p className="text-[11px] text-gray-400">{f.n}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* La lecture d'ensemble, sur une ligne : trois cartes pour trois
            chiffres doublaient la hauteur pour rien. */}
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
          {([
            ['Proposé', flux[0].valeur],
            ['Engagé', flux[1].valeur],
            ['Réalisé', flux[4].valeur],
          ] as const).map(([label, valeur]) => (
            <span key={label} className="text-xs text-gray-400">
              {label}{' '}
              <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {formatMontant(valeur)}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
