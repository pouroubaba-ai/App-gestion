'use client';
import { Plus, Trash2, Info } from 'lucide-react';
import { formatMontant } from '@/lib/format';
import { ChampNombre } from '@/components/Champs';
import {
  totalFrais, controlerRepartition, type Frais, type CleRepartition,
} from '@/lib/frais';
import type { LigneFlux } from '@/lib/flux-marchandise';

/**
 * Les frais d'approche d'un achat : ce qu'il a fallu payer en plus pour
 * que la marchandise arrive.
 *
 * Ils se lisent ici comme des services — un transport, une douane, avec
 * leur montant. Ce qu'ils deviennent sur les produits se lit sur la
 * marchandise elle-même, ligne par ligne, à côté du prix d'achat et du
 * prix de vente : c'est là que se juge ce que le transport fait à une
 * marge, et un tableau à part obligeait à lire deux fois la même ligne
 * pour comprendre une seule vente.
 *
 * En lecture seule, le panneau montre sans rien laisser changer : après
 * la confirmation, le coût moyen porte la trace de ces frais et les
 * toucher réécrirait des marges déjà figées.
 */
export default function PanneauFrais({
  frais, lignes, correction, cle, lectureSeule, onChange, onCorriger,
}: {
  frais: Frais[];
  lignes: LigneFlux[];
  correction?: Record<number, number> | null;
  /**
   * La règle de partage de l'achat. Elle ne se règle pas ici : le
   * panneau dit ce qu'on a payé, la marchandise dit comment ça se
   * repartit. Le contrôle en a pourtant besoin pour savoir si la somme
   * tombe juste.
   */
  cle?: CleRepartition | null;
  lectureSeule?: boolean;
  onChange?: (f: Frais[]) => void;
  onCorriger?: (c: Record<number, number> | null) => void;
}) {
  const total = totalFrais(frais);
  const controle = controlerRepartition(lignes, frais, correction, cle);
  const imposees = correction ?? {};

  function modifier(i: number, champ: keyof Frais, valeur: any) {
    if (!onChange) return;
    onChange(frais.map((f, j) => {
      if (j !== i) return f;
      const majeur = { ...f, [champ]: valeur };
      /* Le montant appartient au libellé : effacer le nom remet le
         montant à zéro.
         Le garder laissait un montant orphelin — saisi sous un nom,
         gardé sans lui, et toujours compté dans le total des frais.
         Le contrôle le refusait bien, mais l'argent restait à l'écran
         et il suffisait de retaper n'importe quel nom pour le faire
         passer sous une étiquette qui n'était pas la sienne. */
      if (champ === 'libelle' && !String(valeur ?? '').trim()) majeur.montant = 0;
      return majeur;
    }));
    /* Une part posée à la main désignait une répartition qui n'existe
       plus dès que le montant change de taille. */
    if (champ === 'libelle' && !String(valeur ?? '').trim()) onCorriger?.(null);
  }

  function retirer(i: number) {
    if (!onChange) return;
    onChange(frais.filter((_, j) => j !== i));
    /* Les parts imposées ne survivent pas au frais qui les portait :
       elles désigneraient une somme qui n'existe plus. */
    onCorriger?.(null);
  }

  return (
    <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Frais d&apos;approche
          </p>
          <p className="mt-0.5 text-[11px] text-gray-400">
            Transport, douane, manutention — répartis sur les produits,
            ils entrent dans leur coût.
          </p>
        </div>
        {!lectureSeule && (
          <button type="button"
            onClick={() => onChange?.([...frais, {
              libelle: '', montant: 0, cle: 'valeur' as CleRepartition,
            }])}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            <Plus size={13} /> Ajouter des frais
          </button>
        )}
      </div>

      {frais.length === 0 ? (
        <p className="py-6 text-center text-xs text-gray-400">
          Aucun frais — la marchandise ne coûte que son prix d&apos;achat.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {frais.map((f, i) => (
              <div key={i}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-100 p-2.5 dark:border-gray-800">
                <input type="text" value={f.libelle} disabled={lectureSeule}
                  onChange={e => modifier(i, 'libelle', e.target.value)}
                  placeholder="Ex. Transport"
                  className="min-w-[120px] flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-transparent disabled:border-transparent dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                {/* Le montant attend le nom. Un frais anonyme se
                    répartit quand même sur les coûts : le chiffre part
                    dans le CUMP et plus personne ne peut dire ce qu'on a
                    payé. Nommer d'abord, c'est la seule trace qui
                    restera de la dépense. */}
                <div className="w-32 shrink-0">
                  <ChampNombre valeur={f.montant}
                    disabled={lectureSeule || !f.libelle.trim()}
                    onChange={v => modifier(i, 'montant', v)}
                    placeholder={f.libelle.trim() ? undefined : 'Nommez d’abord'}
                    className={`w-full rounded-lg border px-3 py-2 text-right text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:border-transparent disabled:bg-transparent dark:bg-gray-800 ${!lectureSeule && !f.libelle.trim()
                      ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-300 placeholder:text-[10px] dark:border-gray-700 dark:text-gray-600'
                      : 'border-gray-200 bg-gray-50 text-gray-900 dark:border-gray-700 dark:text-gray-100'}`} />
                </div>
                {!lectureSeule && (
                  <button type="button" onClick={() => retirer(i)}
                    className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Ce qui est posé contre ce qui est dû. Un frais à moitié
              réparti fait disparaître de l'argent sans que rien ne le
              dise — le contrôle le dit. */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
            <div className="min-w-0 text-xs">
              {controle.juste ? (
                <span className="text-gray-400">
                  {total > 0
                    ? `${formatMontant(total)} répartis en entier.`
                    : 'Aucun montant à répartir.'}
                </span>
              ) : (
                <span className="font-bold text-red-500">{controle.motif}</span>
              )}
              {Object.keys(imposees).length > 0 && !lectureSeule && (
                <button type="button" onClick={() => onCorriger?.(null)}
                  className="ml-2 font-bold text-indigo-600 hover:underline">
                  Revenir au calcul
                </button>
              )}
            </div>
            <p className="shrink-0 text-sm">
              <span className="text-gray-400">Total des frais </span>
              <span className="font-bold text-gray-900 dark:text-gray-100">
                {formatMontant(total)}
              </span>
            </p>
          </div>

          {!lectureSeule && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-gray-400">
              <Info size={12} className="mt-0.5 shrink-0" />
              Ces frais sont dus au fournisseur et s&apos;ajoutent à ce qu&apos;on
              lui doit. Modifiables jusqu&apos;à la confirmation — après, le
              coût moyen en porte la trace.
            </p>
          )}
        </>
      )}
    </div>
  );
}
