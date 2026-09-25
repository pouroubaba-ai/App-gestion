'use client';

/**
 * Les missions qui attendent au tiroir, et le geste qui les délivre.
 *
 * Un paiement porté n'est pas un mouvement ordinaire. L'argent sort, mais
 * il ne va nulle part : il passe dans une poche. Si le caissier validait
 * seul, il écrirait « sorti 200 000 » sans que personne n'atteste l'avoir
 * reçu — et le porteur pourrait dire le soir qu'il n'a rien eu.
 *
 * D'où l'ordre : le porteur confirme d'abord, devant le caissier, puis le
 * caissier délivre. Les deux sont ensemble, la contestation est immédiate
 * ou elle n'a pas lieu. Et la confirmation expire, sinon le caissier
 * pourrait valider deux heures plus tard, hors de sa présence.
 */

import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { ChampNombre } from '@/components/Champs';
import {
  Loader2, Check, X, ArrowUpRight, Clock, ShieldCheck,
} from 'lucide-react';
import {
  confirmerReception, retirerConfirmation, marquerRetiree,
  confirmationValide, type Mission,
} from '@/lib/missions';
import { ecrireEnCaisse } from '@/lib/ecrire-caisse';

interface Props {
  missions: Mission[];
  /** Qui regarde : le caissier délivre, le porteur confirme. */
  estCaissier: boolean;
  estPorteur: boolean;
  parUid: string;
  parNom?: string | null;
  adminUid?: string | null;
  /** Ce que la caisse peut encore laisser sortir. */
  disponible?: number | null;
  onChange: () => void;
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function MissionsAuTiroir({
  missions, estCaissier, estPorteur, parUid, parNom, adminUid,
  disponible, onChange,
}: Props) {
  /* La mission qu'on délivre : le caissier saisit ce qu'il donne. */
  const [ouverte, setOuverte] = useState<Mission | null>(null);
  const [montant, setMontant] = useState(0);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  /* Fait battre l'écran : une confirmation qui expire doit se voir
     expirer, sans quoi le bouton reste actif sur un délai écoulé. */
  const [, setBattement] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setBattement(n => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  const aTraiter = missions.filter(
    m => m.etat === 'ordonnee' || m.etat === 'confirmee');
  if (aTraiter.length === 0) return null;

  const total = aTraiter.reduce((n, m) => n + m.montant, 0);

  async function confirmer(m: Mission) {
    setEnCours(true); setErreur('');
    try {
      await confirmerReception({
        mission: m, porteurUid: parUid, porteurNom: parNom ?? null,
      });
      onChange();
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec de la confirmation.');
    } finally { setEnCours(false); }
  }

  async function annulerConfirmation(m: Mission) {
    setEnCours(true); setErreur('');
    try {
      await retirerConfirmation(m);
      onChange();
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec.');
    } finally { setEnCours(false); }
  }

  function ouvrir(m: Mission) {
    setOuverte(m);
    setMontant(m.montant);
    setErreur('');
  }

  async function delivrer() {
    if (!ouverte) return;
    setEnCours(true); setErreur('');
    try {
      /* L'argent sort pour de bon : une écriture de caisse au motif du
         fournisseur, avec le porteur nommé au détail. Le registre doit
         dire chez qui l'argent est parti, pas seulement qu'il est parti. */
      const { id } = await ecrireEnCaisse({
        siteId: ouverte.siteId,
        sens: 'sortie',
        motif: 'fournisseur',
        sousMotif: 'Remise à un porteur',
        detail: `${ouverte.partenaireNom ?? '—'} · porté par ${ouverte.porteurNom ?? '—'}`,
        montant,
        date: new Date().toISOString().split('T')[0],
        utilisateur: parUid,
        utilisateurNom: parNom ?? null,
        partenaireId: ouverte.partenaireId,
      }, parUid, adminUid ?? null);

      await marquerRetiree({
        mission: ouverte, montantRetire: montant,
        mouvementCaisseId: id, parUid, parNom,
      });
      setOuverte(null);
      onChange();
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec de la remise.');
    } finally { setEnCours(false); }
  }

  const depasse = ouverte != null && disponible != null && montant > disponible;

  return (
    <>
      <div className="rounded-2xl border border-violet-200 bg-violet-50 p-3 dark:border-violet-800/30 dark:bg-violet-900/10 sm:p-4">
        <p className="flex items-start gap-2 text-xs text-violet-700 dark:text-violet-400">
          <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-violet-500" />
          {estCaissier
            ? 'Un porteur confirme devant vous avant que vous délivriez ; un fournisseur reçoit directement.'
            : estPorteur
              ? 'Confirmez devant le caissier que vous recevez l’argent.'
              : 'Paiements à porter, en attente du tiroir.'}
        </p>

        <div className="mt-3 space-y-2">
          {aTraiter.map(m => {
            /* Au comptoir, le fournisseur reçoit de la main du caissier :
               personne d'autre à faire attester, rien qui transite. Le
               bouton est ouvert tout de suite. */
            const auComptoir = m.mode === 'comptoir';
            const fraiche = auComptoir || confirmationValide(m);
            const attendConfirmation = !auComptoir
              && (m.etat === 'ordonnee' || !confirmationValide(m));
            /* Une mission nommée ne se prend pas par un autre. */
            const aMoi = !m.porteurUid || m.porteurUid === parUid;
            return (
              <div key={m.id}
                className="rounded-xl bg-white p-3 dark:bg-gray-900">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold text-gray-900 dark:text-gray-100">
                      {m.partenaireNom ?? '—'}
                    </span>
                    {/* Par où l'argent passe, avant tout le reste : c'est ce
                        qui décide du geste que le caissier va faire. */}
                    <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                      {auComptoir
                        ? '🏪 Il vient le prendre'
                        : `👤 ${m.porteurNom ?? 'Un porteur'}`}
                      {m.parNom ? ` · ordonné par ${m.parNom}` : ''}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                      {formatDate(m.date)} {m.heure}
                    </span>
                  </span>
                  <span className="shrink-0 text-[15px] font-bold text-red-500">
                    {formatMontant(m.montant)}
                  </span>
                </div>

                {/* Ce que chacun peut faire, et rien d'autre. */}
                {estPorteur && attendConfirmation && aMoi && (
                  <button onClick={() => confirmer(m)} disabled={enCours}
                    className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-violet-700 disabled:opacity-40">
                    <Check size={13} /> Je confirme recevoir
                  </button>
                )}

                {!auComptoir && m.etat === 'confirmee' && confirmationValide(m) && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-green-50 px-2.5 py-1.5 text-[11px] font-bold text-green-700 dark:bg-green-900/20 dark:text-green-400">
                      <ShieldCheck size={12} className="shrink-0" />
                      <span className="truncate">
                        {m.porteurNom ?? 'Le porteur'} confirme recevoir
                      </span>
                    </span>
                    {estPorteur && aMoi && (
                      <button onClick={() => annulerConfirmation(m)} disabled={enCours}
                        className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:text-red-500">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )}

                {/* La confirmation vieillit : le dire, sinon le caissier
                    clique sur un bouton qui refusera. */}
                {!auComptoir && m.etat === 'confirmee' && !confirmationValide(m) && (
                  <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-500">
                    <Clock size={12} className="shrink-0" />
                    Confirmation expirée — à redemander
                  </p>
                )}

                {estCaissier && (
                  <button onClick={() => ouvrir(m)}
                    disabled={!fraiche || enCours}
                    title={fraiche ? undefined : 'Le porteur doit confirmer devant vous'}
                    className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
                    <Check size={13} /> Délivrer
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {erreur && <p className="mt-2 text-xs text-red-500">{erreur}</p>}

        <p className="mt-2.5 border-t border-violet-200 pt-2 text-[11px] font-bold text-violet-700 dark:border-violet-800/40 dark:text-violet-400">
          {aTraiter.length} à porter · {formatMontant(total)}
        </p>
      </div>

      {/* Délivrer : le caissier saisit ce qu'il donne réellement. */}
      {ouverte && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
          onClick={() => !enCours && setOuverte(null)}>
          <div onClick={e => e.stopPropagation()}
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl dark:bg-gray-900 sm:max-w-md sm:rounded-3xl">

            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-bold text-gray-900 dark:text-gray-100">
                  {ouverte.mode === 'comptoir'
                    ? `Délivrer à ${ouverte.partenaireNom ?? '—'}`
                    : `Délivrer à ${ouverte.porteurNom ?? 'le porteur'}`}
                </p>
                <p className="mt-0.5 truncate text-xs text-gray-400">
                  {ouverte.mode === 'comptoir'
                    ? `Le fournisseur vient le prendre · ordonné ${formatMontant(ouverte.montant)}`
                    : `Pour ${ouverte.partenaireNom ?? '—'} · ordonné ${formatMontant(ouverte.montant)}`}
                </p>
              </div>
              <button onClick={() => setOuverte(null)} disabled={enCours}
                className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800">
                <X size={18} />
              </button>
            </div>

            <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
              {ouverte.mode === 'comptoir' ? 'Montant remis au fournisseur' : 'Montant remis au porteur'}
            </label>
            <ChampNombre valeur={montant} onChange={setMontant} max={ouverte.montant} />

            {depasse && (
              <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
                La caisse ne peut laisser sortir que {formatMontant(disponible ?? 0)}.
              </p>
            )}

            <p className="mt-3 rounded-xl bg-gray-50 px-3 py-2.5 text-[11px] text-gray-500 dark:bg-gray-800/50 dark:text-gray-400">
              {ouverte.mode === 'comptoir'
                ? 'L’argent passe de la main à la main : la dette s’éteint dans ce geste.'
                : 'L’argent sort du tiroir et passe à la charge du porteur. Il ne soldera la dette du fournisseur qu’une fois remis.'}
            </p>

            {erreur && <p className="mt-3 text-xs text-red-500">{erreur}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setOuverte(null)} disabled={enCours}
                className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800">
                Fermer
              </button>
              <button onClick={delivrer} disabled={enCours || montant <= 0 || depasse}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Délivrer {formatMontant(montant)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
