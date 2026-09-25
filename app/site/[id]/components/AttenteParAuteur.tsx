'use client';

/**
 * Ce qui attend, regroupé par celui qui l'a déclaré.
 *
 * Un porteur revient de sa tournée avec cinq recouvrements. Ce qu'il remet
 * au caissier, c'est une somme et un sac — pas cinq gestes séparés. La vue
 * par mouvement oblige pourtant à ouvrir cinq fois le même écran pour une
 * seule remise.
 *
 * Ici, une carte par personne : combien elle apporte, en combien de
 * lignes. Un bouton les autorise toutes.
 *
 * Mais chaque mouvement reste autorisé pour lui-même : le lot est un
 * geste, pas une écriture. Le registre garde ses cinq lignes, chacune avec
 * son motif et son partenaire — sans quoi il ne saurait plus dire d'où
 * vient chaque franc.
 */

import { useState } from 'react';
import { formatMontant } from '@/lib/format';
import {
  Loader2, Check, ChevronRight, ArrowDownLeft, ArrowUpRight, X,
} from 'lucide-react';
import { LIBELLES_MOTIF_CAISSE } from '@/lib/caisse';
import { autoriserLot, type MouvementAttente } from '@/lib/attente-caisse';
import FeuilleMouvement from './FeuilleMouvement';

interface Props {
  /** Déjà filtrés sur le sens ouvert. */
  mouvements: MouvementAttente[];
  sens: 'entree' | 'sortie';
  /** Seul le responsable de la caisse autorise. */
  peutAutoriser: boolean;
  parUid: string;
  parNom?: string | null;
  /** Relire : la caisse et la file ont bougé. */
  onChange: () => void;
  /* Ouvrir un mouvement seul, pour le compter. Absent quand celui qui
     regarde n'autorise pas : la ligne montre alors son détail, sans mener
     au tiroir. */
  onOuvrir?: (m: MouvementAttente) => void;
}

/** Ce qu'une personne apporte, et en combien de lignes. */
interface Lot {
  /** L'identifiant du compte : deux personnes peuvent porter le même nom. */
  cle: string;
  nom: string;
  fonction: string | null;
  mouvements: MouvementAttente[];
  total: number;
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Regroupe par auteur, du plus gros porteur au plus petit. */
function parAuteur(liste: MouvementAttente[]): Lot[] {
  const lots = new Map<string, Lot>();
  for (const m of liste) {
    /* L'identifiant prime sur le nom : deux homonymes ne se confondent
       pas, et un nom absent ne fond pas tout le monde en un seul lot. */
    const cle = m.userId || m.utilisateurNom || '—';
    const lot = lots.get(cle) ?? {
      cle,
      nom: m.utilisateurNom || '—',
      fonction: m.utilisateurFonction ?? null,
      mouvements: [],
      total: 0,
    };
    lot.mouvements.push(m);
    lot.total += m.montant;
    lots.set(cle, lot);
  }
  return [...lots.values()].sort((a, b) => b.total - a.total);
}

export default function AttenteParAuteur({
  mouvements, sens, peutAutoriser, parUid, parNom, onChange, onOuvrir,
}: Props) {
  /* Le lot qu'on s'apprête à autoriser. Le modal dit combien de mouvements
     sont concernés avant d'agir : « autoriser » au pluriel ne se devine
     pas depuis un bouton. */
  const [aConfirmer, setAConfirmer] = useState<Lot | null>(null);
  /* Le lot déplié : on veut parfois voir ce qu'il contient avant de le
     prendre en bloc. */
  const [deplie, setDeplie] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  /* Le mouvement qu'on lit, quand on ne peut pas l'autoriser : la ligne
     reste ouvrable, elle ne mène simplement pas au comptage. */
  const [detail, setDetail] = useState<MouvementAttente | null>(null);

  const lots = parAuteur(mouvements);
  const entree = sens === 'entree';

  async function valider() {
    if (!aConfirmer) return;
    /* La garde tient aussi ici : cacher un bouton ne ferme pas l'écriture
       qu'il déclenche. */
    if (!peutAutoriser) return;
    setEnCours(true); setErreur('');
    try {
      const { autorises, echecs } = await autoriserLot({
        mouvements: aConfirmer.mouvements, parUid, parNom,
      });
      if (echecs > 0 && autorises === 0) {
        setErreur('Aucun mouvement n’a pu être autorisé.');
        setEnCours(false);
        return;
      }
      /* Un échec partiel ne se tait pas : ce qui reste est encore dans la
         file, et le caissier doit savoir qu'il lui reste un geste. */
      if (echecs > 0) {
        setErreur(`${autorises} autorisé${autorises > 1 ? 's' : ''}, `
          + `${echecs} en échec — ils restent dans la file.`);
        setEnCours(false);
        onChange();
        return;
      }
      setAConfirmer(null);
      onChange();
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec de l’autorisation.');
    } finally { setEnCours(false); }
  }

  if (lots.length === 0) return null;

  return (
    <>
      <div className="space-y-2">
        {lots.map(lot => {
          const ouvert = deplie === lot.cle;
          return (
            <div key={lot.cle}
              className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">

              {/* L'en-tête : qui, combien, en combien de lignes. */}
              <button type="button"
                onClick={() => setDeplie(ouvert ? null : lot.cle)}
                className="flex w-full items-center justify-between gap-3 p-3 text-left transition-colors active:bg-gray-50 dark:active:bg-gray-800/50 sm:p-4">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    entree
                      ? 'bg-green-100 dark:bg-green-900/30'
                      : 'bg-red-100 dark:bg-red-900/30'}`}>
                    {entree
                      ? <ArrowDownLeft size={16} className="text-green-600" />
                      : <ArrowUpRight size={16} className="text-red-500" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                      {lot.nom}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                      {lot.fonction ? `${lot.fonction} · ` : ''}
                      {lot.mouvements.length} mouvement{lot.mouvements.length > 1 ? 's' : ''}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className={`text-[15px] font-bold ${
                    entree ? 'text-green-600' : 'text-red-500'}`}>
                    {formatMontant(lot.total)}
                  </span>
                  <ChevronRight size={15}
                    className={`text-gray-300 transition-transform ${ouvert ? 'rotate-90' : ''}`} />
                </span>
              </button>

              {/* Le détail du lot : ce qu'on prend en bloc reste lisible
                  ligne par ligne, sinon on autorise sans savoir quoi. */}
              {ouvert && (
                <div className="border-t border-gray-100 dark:border-gray-800">
                  {lot.mouvements.map(m => (
                    <button key={m.id} type="button"
                      onClick={() => (onOuvrir ? onOuvrir(m) : setDetail(m))}
                      className="flex w-full items-center justify-between gap-3 border-b border-gray-50 px-3 py-2.5 text-left last:border-0 transition-colors active:bg-gray-50 dark:border-gray-800/50 dark:active:bg-gray-800/50 sm:px-4">
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] font-medium text-gray-700 dark:text-gray-300">
                          {LIBELLES_MOTIF_CAISSE[m.motif]}
                          {m.sousMotif && (
                            <span className="font-normal text-gray-400"> · {m.sousMotif}</span>
                          )}
                        </span>
                        {m.detail && (
                          <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                            {m.detail}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-[12px] font-bold text-gray-600 dark:text-gray-400">
                        {formatMontant(m.montant)}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {peutAutoriser && (
                <div className="border-t border-gray-100 p-2.5 dark:border-gray-800 sm:px-4">
                  <button onClick={() => { setAConfirmer(lot); setErreur(''); }}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
                    <Check size={14} />
                    {entree ? 'Tout faire entrer' : 'Tout faire sortir'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Sans le droit d'autoriser, la ligne ouvre son détail : lire ce
          qui attend n'est pas le valider. */}
      {detail && (
        <FeuilleMouvement mouvement={detail}
          peutConfirmer={false}
          onFermer={() => setDetail(null)} />
      )}

      {/* Ce qu'on s'apprête à faire, dit avant de le faire : un bouton
          « tout autoriser » ne dit ni combien ni pour quelle somme. */}
      {aConfirmer && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
          onClick={() => !enCours && setAConfirmer(null)}>
          <div onClick={e => e.stopPropagation()}
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl dark:bg-gray-900 sm:max-w-md sm:rounded-3xl sm:pb-5">

            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-bold text-gray-900 dark:text-gray-100">
                  {entree ? 'Faire entrer' : 'Faire sortir'} {formatMontant(aConfirmer.total)}
                </p>
                <p className="mt-0.5 text-xs text-gray-400">
                  {aConfirmer.mouvements.length} mouvement{aConfirmer.mouvements.length > 1 ? 's' : ''}
                  {' '}déclaré{aConfirmer.mouvements.length > 1 ? 's' : ''} par {aConfirmer.nom}
                </p>
              </div>
              <button onClick={() => setAConfirmer(null)} disabled={enCours}
                className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800">
                <X size={18} />
              </button>
            </div>

            {/* La liste de ce qui sera écrit : on autorise des lignes
                nommées, pas un total. */}
            <div className="max-h-56 overflow-y-auto rounded-xl border border-gray-100 dark:border-gray-800">
              {aConfirmer.mouvements.map(m => (
                <div key={m.id}
                  className="flex items-center justify-between gap-3 border-b border-gray-50 px-3 py-2 last:border-0 dark:border-gray-800/50">
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-gray-700 dark:text-gray-300">
                      {LIBELLES_MOTIF_CAISSE[m.motif]}
                      {m.sousMotif && (
                        <span className="font-normal text-gray-400"> · {m.sousMotif}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                      {m.detail ? `${m.detail} · ` : ''}{formatDate(m.date)} {m.heure}
                    </span>
                  </span>
                  <span className="shrink-0 text-[12px] font-bold text-gray-900 dark:text-gray-100">
                    {formatMontant(m.montant)}
                  </span>
                </div>
              ))}
            </div>

            {/* Le lot prend les montants annoncés : dire ce qu'on ne fait
                pas évite de croire qu'on a compté. */}
            <p className="mt-3 rounded-xl bg-gray-50 px-3 py-2.5 text-[11px] text-gray-500 dark:bg-gray-800/50 dark:text-gray-400">
              Chaque mouvement sera autorisé pour le montant déclaré, et
              écrit au registre séparément. Si un compte ne tombe pas juste,
              ouvrez ce mouvement seul.
            </p>

            {erreur && <p className="mt-3 text-xs text-red-500">{erreur}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setAConfirmer(null)} disabled={enCours}
                className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800">
                Fermer
              </button>
              <button onClick={valider} disabled={enCours}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Autoriser les {aConfirmer.mouvements.length}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
