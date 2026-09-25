'use client';

/**
 * Les écarts qui attendent d'être reconnus.
 *
 * Un écart n'est pas une demande : personne ne réclame rien, l'argent
 * n'est déjà plus là — ou il y en a plus qu'annoncé. Ce qu'on attend ici
 * n'est pas une autorisation mais une reconnaissance : quelqu'un d'autre
 * que celui qui a compté dit « je vois cet écart, je l'accepte comme
 * tel ».
 *
 * Deux sens, séparés : un excédent et un manque ne se lisent pas
 * ensemble. Les mêler dans une même liste ferait chercher le signe à
 * chaque ligne.
 */

import { useEffect, useRef, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { Check, Loader2, TrendingDown, TrendingUp, X } from 'lucide-react';
import {
  reconnaitreEcart, rejeterEcart, peutReconnaitre, quiReconnait,
  type EcartCaisse,
} from '@/lib/ecarts-caisse';
import type { RoleSite } from '@/lib/roles';

interface Props {
  ecarts: EcartCaisse[];
  /** Qui regarde : la reconnaissance dépend de qui a constaté. */
  roleSite: RoleSite | null;
  uid: string;
  nom?: string | null;
  /**
   * Le nom du site, en vue d'ensemble.
   *
   * Un manque de 2 500 ne dit rien sans savoir quel tiroir : deux
   * boutiques peuvent constater le même montant le même jour, et c'est
   * l'une des deux qu'on va reconnaître. Absent sur la fiche d'un site.
   */
  nomDuSite?: ((id?: string | null) => string) | null;
  onChange?: () => void;
  onFermer: () => void;
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function FeuilleEcarts({
  ecarts, roleSite, uid, nom, nomDuSite, onChange, onFermer,
}: Props) {
  const [sens, setSens] = useState<'manque' | 'excedent'>('manque');
  const [tire, setTire] = useState(0);
  const depart = useRef<number | null>(null);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    const auClavier = (e: KeyboardEvent) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  }, [onFermer]);

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

  const manques = ecarts.filter(e => e.sens === 'manque');
  const excedents = ecarts.filter(e => e.sens === 'excedent');
  const liste = sens === 'manque' ? manques : excedents;
  const somme = (l: EcartCaisse[]) => l.reduce((n, e) => n + e.montant, 0);

  async function trancher(e: EcartCaisse, reconnaitre: boolean) {
    setEnCours(e.id);
    setErreur(null);
    try {
      if (reconnaitre) {
        await reconnaitreEcart({ ecart: e, parUid: uid, parNom: nom ?? null, roleSite });
      } else {
        await rejeterEcart({ ecart: e, parUid: uid, parNom: nom ?? null, roleSite });
      }
      onChange?.();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : 'L’opération a échoué.');
    } finally {
      setEnCours(null);
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
        /* Hauteur fixe : les deux sens n'ont pas le même nombre de lignes,
           et le panneau sautait sous le pouce à chaque bascule. */
        className="flex h-[75vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl dark:bg-gray-900 sm:h-[560px] sm:max-w-md sm:rounded-3xl">

        <div className="flex shrink-0 justify-center pb-1 pt-3 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-3 sm:pt-5">
          <p className="shrink-0 text-sm font-bold text-gray-900 dark:text-gray-100">
            Écarts à confirmer
          </p>

          {/* Les deux sens, avec leur compte : un onglet vide se voit avant
              d'être ouvert. */}
          <div className="mt-3 flex shrink-0 gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
            {([
              { cle: 'manque' as const, label: 'Manques', n: manques.length },
              { cle: 'excedent' as const, label: 'Excédents', n: excedents.length },
            ]).map(o => (
              <button key={o.cle} type="button" onClick={() => setSens(o.cle)}
                className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  sens === o.cle
                    ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                    : 'text-gray-400 dark:text-gray-500'}`}>
                {o.label} ({o.n})
              </button>
            ))}
          </div>

          <p className="mt-3 flex shrink-0 items-baseline justify-between gap-3 rounded-xl bg-gray-50 px-3 py-2.5 text-xs dark:bg-gray-800/50">
            <span className="text-gray-400">Total {sens === 'manque' ? 'manquant' : 'en trop'}</span>
            <span className={`text-[17px] font-bold leading-6 tracking-tight ${
              sens === 'manque' ? 'text-red-500' : 'text-green-600'}`}>
              {formatMontant(somme(liste))}
            </span>
          </p>

          {erreur && (
            <p className="mt-2 shrink-0 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
              {erreur}
            </p>
          )}

          {/* La partie variable : elle seule défile. */}
          <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
            {liste.length === 0 ? (
              <p className="py-10 text-center text-xs text-gray-400">
                Aucun {sens === 'manque' ? 'manque' : 'excédent'} à confirmer.
              </p>
            ) : liste.map(e => {
              /* Le bouton n'apparaît que pour qui peut trancher : celui qui
                 a constaté ne reconnaît jamais son propre constat. */
              const autorise = peutReconnaitre(e, roleSite, uid);
              return (
                <div key={e.id}
                  className="rounded-xl border border-gray-100 p-3 dark:border-gray-800">
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                        e.sens === 'manque'
                          ? 'bg-red-100 dark:bg-red-900/30'
                          : 'bg-green-100 dark:bg-green-900/30'}`}>
                        {e.sens === 'manque'
                          ? <TrendingDown size={15} className="text-red-500" />
                          : <TrendingUp size={15} className="text-green-600" />}
                      </span>
                      <span className="min-w-0">
                        {/* Qui a compté, et à quel titre : un écart se relit
                            des mois plus tard. */}
                        <span className="block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                          {e.parNom ?? '—'}
                        </span>
                        <span className="block truncate text-[11px] text-gray-400">
                          {e.parFonction || 'Système'} · {formatDate(e.date)} · {e.heure}
                        </span>
                        {/* Quel tiroir : deux boutiques peuvent constater
                            le même montant le même jour. */}
                        {nomDuSite && (
                          <span className="mt-1 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                            {nomDuSite(e.siteId)}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className={`shrink-0 text-[15px] font-bold ${
                      e.sens === 'manque' ? 'text-red-500' : 'text-green-600'}`}>
                      {formatMontant(e.montant)}
                    </span>
                  </div>

                  {e.detail && (
                    <p className="mt-2 rounded-lg bg-gray-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-gray-600 dark:bg-gray-800/50 dark:text-gray-300">
                      {e.detail}
                    </p>
                  )}

                  {autorise ? (
                    <div className="mt-2.5 flex gap-1.5">
                      <button type="button" onClick={() => trancher(e, false)}
                        disabled={enCours === e.id}
                        className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-gray-200 px-2.5 py-2 text-xs font-bold text-gray-600 transition-colors disabled:opacity-40 dark:border-gray-700 dark:text-gray-300">
                        <X size={12} /> Contester
                      </button>
                      <button type="button" onClick={() => trancher(e, true)}
                        disabled={enCours === e.id}
                        className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-2 text-xs font-bold text-white transition-colors disabled:opacity-40">
                        {enCours === e.id
                          ? <Loader2 size={12} className="animate-spin" />
                          : <Check size={12} />}
                        Reconnaître
                      </button>
                    </div>
                  ) : (
                    /* Dire pourquoi le geste manque vaut mieux que ne rien
                       montrer : sans cela on cherche un bouton absent. */
                    <p className="mt-2 text-[11px] text-gray-400">
                      {e.parUid === uid
                        ? 'Votre constat : un autre doit le reconnaître.'
                        : quiReconnait(e.parRoleSite ?? null) === 'caissier'
                        ? 'En attente du responsable de caisse.'
                        : 'En attente du propriétaire.'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
