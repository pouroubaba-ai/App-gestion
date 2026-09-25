'use client';

/**
 * Ce que le porteur détient, et le compte qu'il en rend.
 *
 * L'argent est sorti du tiroir : le caissier l'a délivré, le porteur a
 * confirmé le recevoir. Entre cet instant et la remise au fournisseur, la
 * somme est à sa charge — elle n'est ni en caisse, ni chez le créancier.
 *
 * C'est le chiffre qui n'existe nulle part ailleurs, et c'est celui qui
 * compte : un porteur qui garde une mission ouverte depuis trois jours se
 * voit ici, sans que personne ait à l'accuser de quoi que ce soit.
 *
 * Ce qu'il rapporte revient au tiroir par une entrée déclarée : l'argent
 * rendu est un fait, pas une remise qui n'aurait pas eu lieu.
 */

import { useState } from 'react';
import { formatMontant } from '@/lib/format';
import { ChampNombre } from '@/components/Champs';
import { Loader2, Check, X, Wallet } from 'lucide-react';
import { declarerRemise, enPoche, type Mission } from '@/lib/missions';
import { ecrireEnCaisse } from '@/lib/ecrire-caisse';

interface Props {
  missions: Mission[];
  /** Ne montrer que les siennes ; absent, on les voit toutes. */
  porteurUid?: string | null;
  parUid: string;
  parNom?: string | null;
  adminUid?: string | null;
  onChange: () => void;
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function MesMissions({
  missions, porteurUid, parUid, parNom, adminUid, onChange,
}: Props) {
  const [ouverte, setOuverte] = useState<Mission | null>(null);
  const [remis, setRemis] = useState(0);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  const siennes = missions.filter(m => m.etat === 'retiree'
    && (!porteurUid || m.porteurUid === porteurUid));
  if (siennes.length === 0) return null;

  const t = enPoche(siennes);

  function ouvrir(m: Mission) {
    setOuverte(m);
    /* Le montant porté est proposé : dans le cas courant, il remet tout. */
    setRemis(m.montantRetire ?? m.montant);
    setErreur('');
  }

  async function valider() {
    if (!ouverte) return;
    setEnCours(true); setErreur('');
    try {
      const enMain = ouverte.montantRetire ?? ouverte.montant;
      const rendu = Math.max(0, enMain - remis);

      await declarerRemise({ mission: ouverte, montantRemis: remis, montantRendu: rendu });

      /* Ce qui revient au tiroir rentre par une écriture à part : le
         fondre dans la remise ferait disparaître le fait que l'argent est
         sorti puis revenu. */
      if (rendu > 0) {
        await ecrireEnCaisse({
          siteId: ouverte.siteId,
          sens: 'entree',
          motif: 'reajustement',
          sousMotif: 'Retour de mission',
          detail: `Non remis à ${ouverte.partenaireNom ?? '—'}`
            + ` · rapporté par ${ouverte.porteurNom ?? parNom ?? '—'}`,
          montant: rendu,
          date: new Date().toISOString().split('T')[0],
          utilisateur: parUid,
          utilisateurNom: parNom ?? null,
          partenaireId: ouverte.partenaireId,
        }, parUid, adminUid ?? null).catch(() => undefined);
      }

      setOuverte(null);
      onChange();
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec de la déclaration.');
    } finally { setEnCours(false); }
  }

  const enMain = ouverte ? (ouverte.montantRetire ?? ouverte.montant) : 0;
  const rendu = Math.max(0, enMain - remis);

  return (
    <>
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/30 dark:bg-amber-900/10 sm:p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            <Wallet size={14} className="shrink-0 text-amber-500" />
            En poche
          </p>
          <p className="text-[17px] font-bold text-amber-700 dark:text-amber-400">
            {formatMontant(t.total)}
          </p>
        </div>
        <p className="mt-0.5 text-[11px] text-amber-700/80 dark:text-amber-400/80">
          {siennes.length} paiement{siennes.length > 1 ? 's' : ''} à remettre
        </p>

        <div className="mt-3 space-y-2">
          {siennes.map(m => (
            <button key={m.id} type="button" onClick={() => ouvrir(m)}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-white p-3 text-left transition-colors active:bg-gray-50 dark:bg-gray-900 dark:active:bg-gray-800/50">
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                  {m.partenaireNom ?? '—'}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                  Retiré le {formatDate(m.retireA)}
                  {m.retireParNom ? ` · par ${m.retireParNom}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-[15px] font-bold text-amber-600 dark:text-amber-500">
                {formatMontant(m.montantRetire ?? m.montant)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Déclarer la remise : c'est ce geste qui éteint la dette. */}
      {ouverte && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
          onClick={() => !enCours && setOuverte(null)}>
          <div onClick={e => e.stopPropagation()}
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl dark:bg-gray-900 sm:max-w-md sm:rounded-3xl">

            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-bold text-gray-900 dark:text-gray-100">
                  Remis à {ouverte.partenaireNom ?? '—'}
                </p>
                <p className="mt-0.5 text-xs text-gray-400">
                  Vous portez {formatMontant(enMain)}
                </p>
              </div>
              <button onClick={() => setOuverte(null)} disabled={enCours}
                className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800">
                <X size={18} />
              </button>
            </div>

            <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
              Montant remis
            </label>
            <ChampNombre valeur={remis} onChange={setRemis} max={enMain} />

            {rendu > 0 && (
              <div className="mt-3 rounded-xl bg-blue-50 px-3 py-2.5 dark:bg-blue-900/10">
                <p className="text-xs font-bold text-blue-700 dark:text-blue-400">
                  {formatMontant(rendu)} à rapporter
                </p>
                <p className="mt-0.5 text-[11px] text-blue-600 dark:text-blue-400/80">
                  Cette somme rentrera en caisse. Remettez-la au responsable
                  de la caisse.
                </p>
              </div>
            )}

            <p className="mt-3 rounded-xl bg-gray-50 px-3 py-2.5 text-[11px] text-gray-500 dark:bg-gray-800/50 dark:text-gray-400">
              Le fournisseur recevra un message indiquant ce montant. La
              dette ne s’éteint qu’une fois cette déclaration faite.
            </p>

            {erreur && <p className="mt-3 text-xs text-red-500">{erreur}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setOuverte(null)} disabled={enCours}
                className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800">
                Fermer
              </button>
              <button onClick={valider} disabled={enCours || remis < 0}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Déclarer {formatMontant(remis)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
