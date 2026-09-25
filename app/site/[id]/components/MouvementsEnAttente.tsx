'use client';

/**
 * Les mouvements que la caisse n'a pas encore autorisés.
 *
 * Le gérant et le propriétaire lisent cette file : ils doivent savoir ce
 * qui pèse sur la caisse. Mais ils ne l'autorisent pas — c'est le
 * responsable de la caisse qui ouvre le tiroir, et une caisse dont le
 * décideur signe ses propres écritures ne prouve plus rien.
 *
 * Les colonnes sont celles du registre : motif, sous-motif, détail,
 * montant, date, auteur et sa fonction. On lit ici ce qu'on relira
 * là-bas — « Recouvrement · Client · Ibrahim » se comprend des deux côtés.
 */

import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { ChampNombre } from '@/components/Champs';
import {
  Loader2, HandCoins, X, Check, ArrowDownLeft, ArrowUpRight, ChevronRight,
} from 'lucide-react';
import FeuilleMouvement from './FeuilleMouvement';
import { LIBELLES_MOTIF_CAISSE } from '@/lib/caisse';
import {
  autoriser, refuser, totauxEnAttente, type MouvementAttente,
} from '@/lib/attente-caisse';

interface Props {
  mouvements: MouvementAttente[];
  /** Qui regarde : seul le caissier voit les boutons. */
  peutAutoriser: boolean;
  parUid: string;
  parNom?: string | null;
  /** Relire : la caisse et la file ont bougé. */
  onChange: () => void;
  /* Ouvrir droit sur ce mouvement, sans passer par la liste : la feuille
     de détail y envoie après qu'on a déjà choisi lequel. */
  ouvertDabord?: MouvementAttente | null;
  /* Le compte et les totaux en tête. À taire quand l'écran les affiche
     déjà au-dessus : deux fois le même chiffre est une occasion de se
     contredire, et sur un téléphone cela pousse la liste hors de vue. */
  entete?: boolean;
  /* Fermé sans rien valider : l'appelant reprend la main, sinon il croit
     l'écran encore ouvert et n'en rouvre aucun autre. */
  onFerme?: () => void;
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function MouvementsEnAttente({
  mouvements, peutAutoriser, parUid, parNom, onChange,
  ouvertDabord, onFerme, entete = true,
}: Props) {
  const [ouvert, setOuvert] = useState<MouvementAttente | null>(null);
  /* Le mouvement dont on lit le détail. Il précède le comptage : on
     regarde ce qu'on autorise avant de dire combien on a compté. */
  const [detail, setDetail] = useState<MouvementAttente | null>(null);
  const [montant, setMontant] = useState(0);
  const [constat, setConstat] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  const enAttente = mouvements.filter(m => m.etat === 'en_attente');

  const t = totauxEnAttente(mouvements);

  /* On ouvre ce qu'on nous désigne. La dépendance porte sur
     l'identifiant : l'objet se reconstruit à chaque rendu du parent, et
     comparer les références relancerait l'effet sans fin. */
  useEffect(() => {
    if (ouvertDabord) ouvrir(ouvertDabord);
  }, [ouvertDabord?.id]);

  function ouvrir(m: MouvementAttente) {
    /* Un formulaire qu'on remplit pour rien est pire qu'un écran absent :
       le montant compté ne se saisit que par qui ouvre le tiroir. */
    if (!peutAutoriser) return;
    setOuvert(m);
    /* Le montant déclaré est proposé : dans le cas courant il est juste. */
    setMontant(m.montant);
    setConstat('');
    setErreur('');
  }

  async function valider() {
    if (!ouvert) return;
    /* La garde tient aussi ici : cacher un bouton ne ferme pas l'écriture
       qu'il déclenche, et plus d'un chemin mène à cet écran. */
    if (!peutAutoriser) return;
    setEnCours(true); setErreur('');
    try {
      await autoriser({
        mouvement: ouvert, montantAutorise: montant,
        constat: constat.trim() || null, parUid, parNom,
      });
      setOuvert(null);
      onChange();
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec de l’autorisation.');
    } finally { setEnCours(false); }
  }

  async function rejeter() {
    if (!ouvert) return;
    if (!peutAutoriser) return;
    if (!constat.trim()) {
      setErreur('Dites pourquoi : sans motif, le refus ne s’explique pas.');
      return;
    }
    setEnCours(true); setErreur('');
    try {
      await refuser({ mouvement: ouvert, constat, parUid, parNom });
      setOuvert(null);
      onChange();
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec du refus.');
    } finally { setEnCours(false); }
  }

  const ecart = ouvert ? ouvert.montant - montant : 0;

  return (
    <>
      {/* Sans bandeau quand l'appelant vise un mouvement précis : il a déjà
          sa liste, et la redoubler ici afficherait deux fois la même
          chose. */}
      {!ouvertDabord && enAttente.length > 0 && (
      <div className={`rounded-2xl border border-amber-200 bg-amber-50 dark:border-amber-800/30 dark:bg-amber-900/10 ${
        entete ? 'mt-4 p-5' : 'p-3 sm:p-4'}`}>
        {/* Le compte et les totaux ne se répètent que si personne ne les a
            déjà dits : dans l'onglet du caissier, les deux cartes au-dessus
            portent l'un et l'autre, et le bandeau les redisait mot pour
            mot. Reste la consigne, qu'aucune carte ne porte. */}
        {entete ? (
          <div className="flex items-start gap-2">
            <HandCoins size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
                {/* L'espace se pose dans l'expression : collée derrière une
                    accolade en fin de ligne, JSX la mange et on lisait
                    « 2 mouvementsen attente ». */}
                {t.nb} mouvement{t.nb > 1 ? 's' : ''}{' '}
                en attente d&apos;autorisation
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-amber-700 dark:text-amber-400">
                {t.entrees > 0 && <span>Entrées {formatMontant(t.entrees)}</span>}
                {t.sorties > 0 && <span>Sorties {formatMontant(t.sorties)}</span>}
              </p>
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {peutAutoriser
                  ? 'Comptez l’argent, puis autorisez ce qui est réellement passé par le tiroir.'
                  : 'Seul le responsable de la caisse peut les autoriser.'}
              </p>
            </div>
          </div>
        ) : (
          <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
            <HandCoins size={14} className="mt-0.5 shrink-0 text-amber-500" />
            {peutAutoriser
              ? 'Comptez l’argent, puis autorisez ce qui est réellement passé par le tiroir.'
              : 'Seul le responsable de la caisse peut les autoriser.'}
          </p>
        )}

        {/* Tablette et bureau : les colonnes du registre. */}
        <div className="mt-3 hidden overflow-x-auto sm:block">
          <table className="w-full whitespace-nowrap text-sm">
            <thead>
              <tr className="bg-indigo-600 text-white">
                <th className="px-3 py-2.5 text-center font-medium">Motif</th>
                <th className="px-3 py-2.5 text-center font-medium">Sous-motif</th>
                <th className="px-3 py-2.5 text-center font-medium">Détail</th>
                <th className="px-3 py-2.5 text-center font-medium">Montant</th>
                <th className="px-3 py-2.5 text-center font-medium">Date</th>
                <th className="px-3 py-2.5 text-center font-medium">Auteur</th>
                {peutAutoriser && <th className="sticky right-0 bg-indigo-600 px-3 py-2.5" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 bg-white dark:divide-gray-800 dark:bg-gray-900">
              {enAttente.map(m => (
                /* La ligne ouvre le détail, comme la carte : le bouton
                   reste pour aller droit au comptage. */
                <tr key={m.id} onClick={() => setDetail(m)}
                  className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-3 py-2.5 text-center">
                    <Sens m={m} />
                  </td>
                  <td className="px-3 py-2.5 text-center text-gray-500">
                    {m.sousMotif ?? '—'}
                  </td>
                  <td className="px-3 py-2.5 text-center text-gray-600 dark:text-gray-400">
                    {m.detail ?? '—'}
                  </td>
                  <td className={`px-3 py-2.5 text-center font-bold ${
                    m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
                    {formatMontant(m.montant)}
                  </td>
                  <td className="px-3 py-2.5 text-center text-gray-500">
                    {formatDate(m.date)} <span className="text-gray-400">{m.heure}</span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className="text-gray-900 dark:text-gray-100">
                      {m.utilisateurNom ?? '—'}
                    </span>
                    {m.utilisateurFonction && (
                      <span className="block text-[11px] text-gray-400">
                        {m.utilisateurFonction}
                      </span>
                    )}
                  </td>
                  {peutAutoriser && (
                    <td className="sticky right-0 border-l border-gray-100 bg-white px-3 py-2.5 dark:border-gray-800 dark:bg-gray-900">
                      <button onClick={e => { e.stopPropagation(); ouvrir(m); }}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
                        <Check size={12} /> Autoriser
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Téléphone : une carte par mouvement, réduite à ce qu'on lit d'un
            coup d'œil. Le reste — sous-motif, détail, fonction, heure —
            s'ouvre en feuille, d'où part aussi l'autorisation : entassé sur
            la carte, il fallait quatre lignes et un bouton par mouvement
            pour une liste qu'on parcourt. */}
        <div className="mt-3 space-y-2 sm:hidden">
          {enAttente.map(m => (
            <button key={m.id} type="button" onClick={() => setDetail(m)}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-white p-3 text-left transition-colors active:bg-gray-50 dark:bg-gray-900 dark:active:bg-gray-800/50">
              <span className="flex min-w-0 items-center gap-2">
                {m.sens === 'entree'
                  ? <ArrowDownLeft size={14} className="shrink-0 text-green-600" />
                  : <ArrowUpRight size={14} className="shrink-0 text-red-500" />}
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                    {LIBELLES_MOTIF_CAISSE[m.motif]}
                  </span>
                  {/* Qui a déclaré, pour ne pas ouvrir chaque feuille à la
                      recherche d'un nom. */}
                  <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                    {m.utilisateurNom ?? '—'} · {formatDate(m.date)}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className={`text-[15px] font-bold ${
                  m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
                  {formatMontant(m.montant)}
                </span>
                <ChevronRight size={15} className="text-gray-300" />
              </span>
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Le détail au complet. Confirmer y enchaîne sur le comptage, qui
          est l'écran suivant. */}
      {detail && !ouvert && (
        <FeuilleMouvement mouvement={detail}
          peutConfirmer={peutAutoriser}
          onConfirmer={() => { ouvrir(detail); setDetail(null); }}
          onFermer={() => setDetail(null)} />
      )}

      {ouvert && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
          onClick={() => { if (!enCours) { setOuvert(null); onFerme?.(); } }}>
          <div onClick={e => e.stopPropagation()}
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl dark:bg-gray-900 sm:max-w-md sm:rounded-3xl">

            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-bold text-gray-900 dark:text-gray-100">
                  {ouvert.sens === 'entree' ? 'Faire entrer' : 'Faire sortir'}
                </p>
                <p className="mt-0.5 truncate text-xs text-gray-400">
                  {LIBELLES_MOTIF_CAISSE[ouvert.motif]}
                  {ouvert.sousMotif && ` · ${ouvert.sousMotif}`}
                  {ouvert.detail && ` · ${ouvert.detail}`}
                </p>
                <p className="mt-0.5 text-xs text-gray-400">
                  {ouvert.utilisateurNom ?? '—'} déclare {formatMontant(ouvert.montant)}
                </p>
              </div>
              <button onClick={() => { setOuvert(null); onFerme?.(); }} disabled={enCours}
                className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800">
                <X size={18} />
              </button>
            </div>

            <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
              {ouvert.sens === 'entree' ? 'Montant reçu' : 'Montant sorti'}
            </label>
            <ChampNombre valeur={montant} onChange={setMontant} max={ouvert.montant} />

            {ecart !== 0 && (
              <div className="mt-3 rounded-xl bg-orange-50 px-3 py-2.5 dark:bg-orange-900/10">
                <p className="text-xs font-bold text-orange-700 dark:text-orange-400">
                  {formatMontant(Math.abs(ecart))} d&apos;écart
                </p>
                <p className="mt-0.5 text-[11px] text-orange-600 dark:text-orange-400/80">
                  La caisse n&apos;enregistrera que {formatMontant(montant)}. L&apos;écart
                  sera inscrit au registre avec votre constat.
                </p>
              </div>
            )}

            <label className="mb-1.5 mt-3 block text-xs font-bold text-gray-500 dark:text-gray-400">
              Constat {ecart === 0 && <span className="font-normal text-gray-400">(facultatif)</span>}
            </label>
            <input type="text" value={constat} onChange={e => setConstat(e.target.value)}
              placeholder="Ce que vous avez constaté…"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

            {erreur && <p className="mt-3 text-xs text-red-500">{erreur}</p>}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button onClick={rejeter} disabled={enCours}
                className="rounded-xl px-4 py-2 text-sm font-bold text-red-500 transition-colors hover:bg-red-50 disabled:opacity-40 dark:hover:bg-red-900/20">
                Refuser
              </button>
              <button onClick={valider} disabled={enCours || montant < 0}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Autoriser {formatMontant(montant)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Le motif, avec le sens qu'il prend : ce qui entre, ce qui sort. */
function Sens({ m }: { m: MouvementAttente }) {
  const entree = m.sens === 'entree';
  return (
    <span className="inline-flex items-center gap-1.5">
      {entree
        ? <ArrowDownLeft size={13} className="shrink-0 text-green-600" />
        : <ArrowUpRight size={13} className="shrink-0 text-red-500" />}
      <span className="font-medium text-gray-900 dark:text-gray-100">
        {LIBELLES_MOTIF_CAISSE[m.motif]}
      </span>
    </span>
  );
}
