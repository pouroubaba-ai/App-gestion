'use client';

/**
 * Constater un écart de caisse.
 *
 * On n'y décide rien : on dit ce que le comptage a trouvé. Le solde ne
 * bouge pas en sortant d'ici — il ne bougera que le jour où quelqu'un
 * d'autre reconnaît le constat, et ce quelqu'un n'est jamais celui qui a
 * compté.
 *
 * Deux sens, un seul fait : il y a plus dans le tiroir qu'annoncé, ou il
 * en manque. « Positif » et « négatif » diraient qu'on ajuste un chiffre ;
 * excédent et manque disent ce qu'on a vu.
 */

import { useEffect, useState } from 'react';
import { X, Loader2, TrendingUp, TrendingDown } from 'lucide-react';
import { ChampNombre } from '@/components/Champs';
import {
  declarerEcart, chargerEcarts, type SensEcart,
} from '@/lib/ecarts-caisse';
import { formatMontant } from '@/lib/format';
import type { RoleSite } from '@/lib/roles';

export default function ModalEcartCaisse({
  siteId, utilisateur, utilisateurNom, utilisateurFonction,
  roleSite = null, soldeTheorique, onFermer, onEnregistre,
}: {
  siteId: string;
  utilisateur: string;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  roleSite?: RoleSite | null;
  /** Ce que le registre annonce : l'écart se mesure contre lui. */
  soldeTheorique?: number | null;
  onFermer: () => void;
  onEnregistre?: () => void;
}) {
  const [sens, setSens] = useState<SensEcart>('manque');
  /* Ce qui est déjà constaté et attend : le plafond porte sur ce qui
     reste, non sur le solde. Trois manques de 30 000 sur une caisse de
     59 500 passent un à un, et font 90 000 ensemble. */
  const [dejaConstate, setDejaConstate] = useState(0);
  const [montant, setMontant] = useState(0);
  const [detail, setDetail] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  /* Qui tranchera, dit avant la saisie : on sait à qui l'on s'adresse en
     déclarant, et le constat n'a pas l'air de se valider tout seul. */
  const reconnaisseur = roleSite === null ? 'le responsable de caisse'
    : 'le propriétaire';

  useEffect(() => {
    let vivant = true;
    chargerEcarts(siteId)
      .then(l => {
        if (!vivant) return;
        setDejaConstate(l
          .filter(e => e.etat === 'en_attente' && e.sens === 'manque')
          .reduce((n, e) => n + e.montant, 0));
      })
      .catch(() => undefined);
    return () => { vivant = false; };
  }, [siteId]);

  /* Ce qu'on peut encore constater comme manquant. */
  const disponible = soldeTheorique != null
    ? Math.max(0, soldeTheorique - dejaConstate) : null;

  async function enregistrer() {
    if (montant <= 0) { setErreur('Le montant doit être positif.'); return; }
    setEnCours(true);
    setErreur(null);
    try {
      await declarerEcart({
        siteId, sens, montant,
        detail: detail.trim() || null,
        parUid: utilisateur,
        parNom: utilisateurNom ?? null,
        parFonction: utilisateurFonction ?? null,
        parRoleSite: roleSite,
        soldeTheorique: soldeTheorique ?? null,
      });
      onEnregistre?.();
      onFermer();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'L’enregistrement a échoué.');
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm p-0 sm:items-center sm:p-5"
      onClick={onFermer}>
      <div onClick={e => e.stopPropagation()}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl dark:bg-gray-900 sm:max-w-md sm:rounded-3xl sm:pb-5">

        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Constater un écart
          </p>
          <button onClick={onFermer}
            className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800">
            <X size={16} />
          </button>
        </div>

        {/* Ce que le registre annonce : sans lui, on saisit un écart sans
            savoir par rapport à quoi. */}
        {soldeTheorique != null && (
          <p className="mb-3 flex items-baseline justify-between gap-3 rounded-xl bg-gray-50 px-3 py-2.5 text-xs dark:bg-gray-800/50">
            <span className="text-gray-400">Le registre annonce</span>
            <span className="font-bold text-gray-900 dark:text-gray-100">
              {formatMontant(soldeTheorique)}
            </span>
          </p>
        )}

        {/* Le sens, en premier : c'est lui qui donne son sens au montant. */}
        <div className="grid grid-cols-2 gap-2">
          {([
            { cle: 'manque' as const, label: 'Il manque', Icone: TrendingDown,
              ton: 'border-red-200 bg-red-50 text-red-600 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400' },
            { cle: 'excedent' as const, label: 'Il y a en trop', Icone: TrendingUp,
              ton: 'border-green-200 bg-green-50 text-green-600 dark:border-green-800/40 dark:bg-green-900/20 dark:text-green-400' },
          ]).map(o => (
            <button key={o.cle} type="button" onClick={() => {
              setSens(o.cle);
              /* Passer de l'excédent au manque avec un montant trop grand
                 laisserait une valeur que l'enregistrement refusera. */
              if (o.cle === 'manque' && disponible != null) {
                setMontant(m => Math.min(m, disponible));
              }
            }}
              className={`flex items-center justify-center gap-1.5 rounded-xl border p-3 text-xs font-bold transition-colors ${
                sens === o.cle
                  ? o.ton
                  : 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400'}`}>
              <o.Icone size={14} />
              {o.label}
            </button>
          ))}
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            Montant de l’écart
          </label>
          {/* Le champ porte sa bordure : nu, le « 0 » passait pour du
              texte et l'on cherchait où écrire. En gros caractères parce
              que c'est la seule valeur à saisir ici. */}
          {/* Le plafond s'applique à la frappe : laisser saisir 80 000 sur
              une caisse de 59 500 pour refuser ensuite fait perdre la
              saisie au lieu de la guider. */}
          <ChampNombre valeur={montant} onChange={setMontant}
            max={sens === 'manque' && disponible != null
              ? disponible : undefined}
            className={`w-full rounded-xl border px-3 py-2.5 text-[19px] font-bold tracking-tight outline-none transition-colors focus:border-indigo-400 dark:bg-gray-800 ${
              sens === 'manque'
                ? 'border-red-200 text-red-600 dark:border-red-800/40 dark:text-red-400'
                : 'border-green-200 text-green-600 dark:border-green-800/40 dark:text-green-400'}`} />
        </div>

        {sens === 'manque' && disponible != null && (
          <p className="mt-1 text-[11px] text-gray-400">
            Au plus {formatMontant(disponible)}
            {dejaConstate > 0
              ? ` : ${formatMontant(dejaConstate)} sont déjà constatés et attendent.`
              : ' : le tiroir ne peut pas manquer plus qu’il ne contient.'}
          </p>
        )}

        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            Ce que vous avez constaté
          </label>
          {/* Un écart sans explication se relit mal : celui qui reconnaît
              n'était pas devant le tiroir. */}
          <textarea value={detail} onChange={e => setDetail(e.target.value)}
            rows={2}
            placeholder="Comptage de fin de journée, billet introuvable…"
            className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
        </div>

                {/* Une ligne, non un paragraphe : le reste se devine du seul fait
            qu'un autre nom y figure. */}
        <p className="mt-3 text-[11px] text-gray-400">
          À reconnaître par {reconnaisseur}.
        </p>

        {erreur && (
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
            {erreur}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onFermer} disabled={enCours}
            className="flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            Annuler
          </button>
          <button type="button" onClick={enregistrer} disabled={enCours || montant <= 0}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
            {enCours && <Loader2 size={15} className="animate-spin" />}
            Constater
          </button>
        </div>
      </div>
    </div>
  );
}
