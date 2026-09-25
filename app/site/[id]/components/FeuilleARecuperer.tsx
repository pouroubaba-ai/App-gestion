'use client';

/**
 * Ce que le porteur doit récupérer à la caisse, en feuille glissante.
 *
 * La carte au-dessus ne porte qu'un chiffre : combien il doit aller
 * chercher. Cette feuille porte l'état entier — ce qu'il a attesté, ce
 * qu'il a déjà pris, ce qui l'attend encore — et la liste des missions
 * derrière ces chiffres.
 *
 * Confirmer est un geste qui se fait devant le caissier : le porteur
 * atteste recevoir avant que le tiroir s'ouvre. C'est l'inverse qui
 * serait dangereux — le caissier délivrerait d'abord, et il existerait un
 * instant où l'argent est officiellement sorti sans que personne n'ait
 * attesté l'avoir reçu.
 */

import { useEffect, useRef, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { Check, Loader2, Wallet } from 'lucide-react';
import type { Mission } from '@/lib/missions';

interface Props {
  /** Ses missions à lui, déjà restreintes au mode porté. */
  missions: Mission[];
  /** Atteste la réception devant le caissier, mission par mission. */
  onConfirmer: (missions: Mission[]) => Promise<void>;
  /**
   * Le geste n'appartient qu'au porteur : c'est lui qui atteste recevoir.
   * Le gérant et le propriétaire ouvrent la même feuille pour surveiller
   * — ce qui dort au tiroir, ce qui est sorti, ce qui est arrivé — et
   * leur tendre le bouton leur ferait attester une réception qu'ils n'ont
   * pas faite.
   */
  peutConfirmer?: boolean;
  /**
   * La bascule entre les deux chemins de l'argent.
   *
   * Le porteur n'a qu'un chemin : ce qu'on lui confie. Qui decide en a
   * deux — ce qu'un employe emporte, et ce que le fournisseur vient
   * prendre lui-meme — et veut savoir des deux cotes ou en sont les
   * choses.
   */
  avecComptoir?: boolean;
  onFermer: () => void;
}

/** Depuis combien de jours la mission attend au tiroir. */
function joursDepuis(iso?: string | null): number {
  if (!iso) return 0;
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return 0;
  const auj = new Date();
  auj.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((auj.getTime() - d.getTime()) / 86400000));
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function FeuilleARecuperer({
  missions, onConfirmer, onFermer,
  peutConfirmer = false, avecComptoir = false,
}: Props) {
  /* Quel chemin on regarde. Le porte d'abord : c'est celui qui appelle un
     geste, le comptoir ne fait que s'attendre. */
  const [chemin, setChemin] = useState<'porte' | 'comptoir'>('porte');
  /* De combien la feuille a été tirée vers le bas : elle suit le doigt. */
  const [tire, setTire] = useState(0);
  const depart = useRef<number | null>(null);
  /* Le modal de dernière précaution : tout confirmer d'un geste engage
     plusieurs sorties à la fois, et le total mérite d'être relu. */
  const [demandeTout, setDemandeTout] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    const auClavier = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (demandeTout) setDemandeTout(false);
      else onFermer();
    };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  }, [onFermer, demandeTout]);

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
    setTire(Math.max(0, y - depart.current));
  }
  function fin() {
    if (tire > 110) onFermer();
    else setTire(0);
    depart.current = null;
  }

  /* Le detail, sous le total. Les trois premiers sont etanches — une
     mission est a confirmer, ou confirmee, ou recuperee, jamais deux a la
     fois. Le verse, lui, se lit sous le recupere : il dit ce qui est
     arrive au bout du trajet, et l'ecart entre les deux est ce qu'il
     porte encore sur lui. */
  const toutesVives = missions.filter(m => m.etat !== 'annulee');
  const auComptoir = toutesVives.filter(m => m.mode === 'comptoir');
  const vives = avecComptoir && chemin === 'comptoir'
    ? auComptoir
    : toutesVives.filter(m => !avecComptoir || m.mode === 'porte');

  /**
   * Au comptoir, le trajet n'a que deux etapes.
   *
   * Le fournisseur n'atteste rien a l'avance : il vient, ou il ne vient
   * pas. Retirer et remettre sont le meme instant, celui ou le caissier
   * ouvre le tiroir devant lui — si bien qu'une mission au comptoir ne
   * connait que `ordonnee` puis `soldee`. Lui montrer les quatre lignes
   * de l'autre onglet donnerait deux chiffres morts.
   *
   * Ce qui compte ici n'est pas un ecart, c'est le temps : un
   * fournisseur qui devait passer il y a cinq jours et qui n'est pas
   * venu, voila l'alerte.
   */
  const attendus = auComptoir.filter(m => m.etat === 'ordonnee');
  const retires = auComptoir.filter(m => m.etat === 'soldee');
  const montantAttendu = attendus.reduce((n, m) => n + m.montant, 0);
  const montantRetire2 = retires.reduce(
    (n, m) => n + (m.montantRetire ?? m.montant), 0);
  const aConfirmer = vives.filter(m => m.etat === 'ordonnee');
  const confirmees = vives.filter(m => m.etat === 'confirmee');
  const recuperees = vives.filter(
    m => m.etat === 'retiree' || m.etat === 'soldee');

  const somme = (l: Mission[]) => l.reduce((n, m) => n + m.montant, 0);
  const montantAConfirmer = somme(aConfirmer);
  const montantConfirme = somme(confirmees);
  const montantRecupere = recuperees.reduce(
    (n, m) => n + (m.montantRetire ?? m.montant), 0);
  /* Ce qui est arrive chez le fournisseur. Il se lit sous le recupere :
     l'un dit ce qui est sorti du tiroir, l'autre ce qui est arrive au
     bout — et l'ecart entre les deux, c'est ce qu'il porte encore. */
  const montantVerse = vives.reduce((n, m) => n + (m.montantRemis ?? 0), 0);
  const nbVerses = vives.filter(m => (m.montantRemis ?? 0) > 0).length;
  const montantARecuperer = avecComptoir && chemin === 'comptoir'
    ? montantAttendu
    : montantAConfirmer + montantConfirme;

  /* Ce qui attend encore un geste : confirmé ou non, tant qu'il n'a pas
     l'argent, c'est ce que la liste doit montrer en premier. */
  const enAttente = avecComptoir && chemin === 'comptoir'
    ? attendus
    : [...confirmees, ...aConfirmer];

  async function confirmerTout() {
    setEnCours(true);
    setErreur(null);
    try {
      await onConfirmer(aConfirmer);
      setDemandeTout(false);
      onFermer();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'La confirmation a échoué.');
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
      onClick={onFermer}>
      <div onClick={e => e.stopPropagation()}
        onTouchStart={e => debut(e.touches[0].clientY)}
        onTouchMove={e => bouge(e.touches[0].clientY)}
        onTouchEnd={fin}
        style={{
          transform: `translateY(${tire}px)`,
          transition: depart.current === null ? 'transform 200ms ease-out' : 'none',
        }}
        /* Hauteur fixe, non ajustee au contenu : les deux onglets n'ont
           ni le meme nombre de lignes ni la meme liste, et la feuille
           grandissait puis retrecissait a chaque bascule. Un panneau qui
           saute sous le pouce fait perdre l'endroit ou l'on regardait.
           Seule la liste defile a l'interieur. */
        className="flex h-[75vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl dark:bg-gray-900 sm:h-[560px] sm:max-w-md sm:rounded-3xl">

        {/* La poignée : elle dit que la feuille se tire, sans le nommer. */}
        <div className="flex shrink-0 justify-center pb-1 pt-3 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-3 sm:pt-5">
          {/* La question qu'on se pose en ouvrant : combien, et combien de
              fois. */}
          <div className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-900/30">
                <Wallet size={17} className="text-amber-600" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400">
                  {avecComptoir && chemin === 'comptoir'
                    ? 'Attendu au comptoir'
                    : 'À récupérer à la caisse'}
                </span>
                <span className="block truncate text-[22px] font-bold leading-7 tracking-tight text-gray-900 dark:text-gray-100">
                  {formatMontant(montantARecuperer)}
                </span>
              </span>
            </span>
            {enAttente.length > 0 && (
              <span className="shrink-0 rounded-lg bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                {enAttente.length}
              </span>
            )}
          </div>

          {/* Les deux chemins de l'argent. Un employe l'emporte, ou le
              fournisseur vient le prendre : ce sont deux trajets, deux
              questions, et les melanger empecherait de repondre a l'une
              comme a l'autre. */}
          {avecComptoir && (
            <div className="mt-4 flex gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
              {([
                { cle: 'porte' as const, label: 'Recouvreur' },
                { cle: 'comptoir' as const, label: 'Fournisseurs' },
              ]).map(o => (
                <button key={o.cle} type="button" onClick={() => setChemin(o.cle)}
                  className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    chemin === o.cle
                      ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                      : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          )}

          {/* Ce que le titre ne dit pas. « Reste à récupérer » y figurait
              aussi : c'était le chiffre d'en haut, répété à dix pixels de
              lui-même, et un total qu'on lit deux fois fait douter d'avoir
              bien lu le premier. */}
          <div className="mt-4 shrink-0 space-y-2 rounded-2xl bg-gray-50 p-3 dark:bg-gray-800/50">
            {avecComptoir && chemin === 'comptoir' ? (<>
            {/* Deux etapes, deux chiffres : il vient, ou il n'est pas
                encore venu. */}
            <p className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-gray-400">Attendu</span>
              <span className="font-bold text-gray-900 dark:text-gray-100">
                {formatMontant(montantAttendu)}
                <span className="ml-1 font-normal text-gray-400">· {attendus.length}</span>
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-gray-400">Retiré</span>
              <span className="font-bold text-green-600">
                {formatMontant(montantRetire2)}
                <span className="ml-1 font-normal text-gray-400">· {retires.length}</span>
              </span>
            </p>
            </>) : (<>
            <p className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-gray-400">Confirmé</span>
              <span className="font-bold text-violet-600 dark:text-violet-400">
                {formatMontant(montantConfirme)}
                <span className="ml-1 font-normal text-gray-400">· {confirmees.length}</span>
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-gray-400">Reste à confirmer</span>
              <span className="font-bold text-gray-900 dark:text-gray-100">
                {formatMontant(montantAConfirmer)}
                <span className="ml-1 font-normal text-gray-400">· {aConfirmer.length}</span>
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-3 border-t border-black/[0.06] pt-2 text-xs dark:border-white/10">
              <span className="text-gray-400">Récupéré</span>
              <span className="font-bold text-green-600">
                {formatMontant(montantRecupere)}
                <span className="ml-1 font-normal text-gray-400">· {recuperees.length}</span>
              </span>
            </p>
            <p className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-gray-400">Versé</span>
              <span className="font-bold text-green-600">
                {formatMontant(montantVerse)}
                <span className="ml-1 font-normal text-gray-400">· {nbVerses}</span>
              </span>
            </p>
            </>)}
          </div>

          {/* La liste derrière les chiffres : un total ne dit jamais chez
              quel fournisseur on va. */}
          {enAttente.length > 0 && (
            /* La partie variable : c'est elle qui defile, pour que le
               total en haut et le bouton en bas restent en place. */
            <div className="mt-4 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
              {enAttente.map(m => (
                <div key={m.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 p-3 dark:border-gray-800">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                      {m.partenaireNom ?? '—'}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {/* Au comptoir, l'etat ne dit rien : elles attendent
                          toutes. Ce qui parle, c'est depuis quand — un
                          fournisseur qui devait passer il y a cinq jours
                          et qui n'est pas venu, voila ce qu'on cherche en
                          ouvrant cet onglet. */}
                      {avecComptoir && chemin === 'comptoir' ? (() => {
                        const j = joursDepuis(m.date);
                        return (
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            j >= 3
                              ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                              : j >= 1
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                              : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                            {j === 0 ? "Aujourd'hui"
                              : j === 1 ? 'Depuis hier'
                              : `Depuis ${j} jours`}
                          </span>
                        );
                      })() : (
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        m.etat === 'confirmee'
                          ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                        {m.etat === 'confirmee' ? 'Confirmé' : 'À confirmer'}
                      </span>
                      )}
                      <span className="truncate text-[11px] text-gray-400">
                        Ordonné le {formatDate(m.date)}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-[15px] font-bold text-gray-900 dark:text-gray-100">
                    {formatMontant(m.montant)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {erreur && (
            <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
              {erreur}
            </p>
          )}

          {/* Tout confirmer d'un geste : une tournée, c'était autant de
              fois ouvrir et refermer. Le bouton disparaît quand il n'y a
              plus rien à attester — un bouton sans effet se cherche. */}
          {peutConfirmer && aConfirmer.length > 0 && (
            <button type="button" onClick={() => setDemandeTout(true)}
              className="mt-4 flex w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700">
              <Check size={15} />
              Tout confirmer · {aConfirmer.length}
            </button>
          )}
        </div>
      </div>

      {/* La dernière précaution. Confirmer engage le tiroir à sortir
          l'argent : relire le total avant est le seul moment où l'on peut
          encore dire non. */}
      {demandeTout && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-5 backdrop-blur-sm"
          onClick={() => !enCours && setDemandeTout(false)}>
          <div onClick={e => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-gray-900">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              Confirmer la réception ?
            </p>
            <p className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              Vous attestez recevoir {aConfirmer.length} paiement
              {aConfirmer.length > 1 ? 's' : ''} devant le caissier. Il pourra
              alors vous délivrer l’argent.
            </p>
            <p className="mt-3 flex items-baseline justify-between gap-3 rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-gray-800/50">
              <span className="text-xs text-gray-400">Total</span>
              <span className="text-[19px] font-bold leading-6 tracking-tight text-gray-900 dark:text-gray-100">
                {formatMontant(montantAConfirmer)}
              </span>
            </p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setDemandeTout(false)}
                disabled={enCours}
                className="flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
                Annuler
              </button>
              <button type="button" onClick={confirmerTout} disabled={enCours}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
                {enCours
                  ? <Loader2 size={15} className="animate-spin" />
                  : <Check size={15} />}
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
