'use client';
import { Plus, Trash2, Info } from 'lucide-react';
import { formatMontant } from '@/lib/format';
import { ChampNombre } from '@/components/Champs';
import {
  repartirFrais, totalFrais, controlerRepartition,
  LIBELLES_REPARTITION, type Frais, type CleRepartition,
} from '@/lib/frais';
import type { LigneFlux } from '@/lib/flux-marchandise';

/**
 * Les frais d'approche d'un achat : ce qu'il a fallu payer en plus pour
 * que la marchandise arrive.
 *
 * Ils se lisent ici comme des services — un transport, une douane, avec
 * leur montant. Ce qu'ils deviennent sur les produits se lit juste en
 * dessous, ligne par ligne : c'est la même somme vue autrement, et voir
 * les deux côte à côte est ce qui rend la répartition vérifiable.
 *
 * En lecture seule, le panneau montre sans rien laisser changer : après
 * la confirmation, le coût moyen porte la trace de ces frais et les
 * toucher réécrirait des marges déjà figées.
 */
export default function PanneauFrais({
  frais, lignes, correction, lectureSeule, onChange, onCorriger,
}: {
  frais: Frais[];
  lignes: LigneFlux[];
  correction?: Record<number, number> | null;
  lectureSeule?: boolean;
  onChange?: (f: Frais[]) => void;
  onCorriger?: (c: Record<number, number> | null) => void;
}) {
  const total = totalFrais(frais);
  const parts = repartirFrais(lignes, frais, correction);
  const controle = controlerRepartition(lignes, frais, correction);
  const imposees = correction ?? {};

  /* Les lignes qui reçoivent quelque chose : une ligne sans quantité ne
     porte rien, et l'afficher à zéro ferait chercher une erreur. */
  const servies = lignes
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => ((l.quantiteRecue ?? l.quantiteDemandee ?? 0) > 0));

  function modifier(i: number, champ: keyof Frais, valeur: any) {
    if (!onChange) return;
    onChange(frais.map((f, j) => (j === i ? { ...f, [champ]: valeur } : f)));
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
                {/* La clé décide qui porte quoi : sur un catalogue aux
                    prix très écartés, la quantité ferait porter autant à
                    une ampoule qu'à une balance. */}
                <select value={f.cle} disabled={lectureSeule}
                  onChange={e => modifier(i, 'cle', e.target.value as CleRepartition)}
                  className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 px-2 py-2 text-xs font-medium text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-transparent disabled:border-transparent dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {(Object.keys(LIBELLES_REPARTITION) as CleRepartition[]).map(c => (
                    <option key={c} value={c}>{LIBELLES_REPARTITION[c]}</option>
                  ))}
                </select>
                {!lectureSeule && (
                  <button type="button" onClick={() => retirer(i)}
                    className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Ce que chaque produit porte. Sans cette vue, on saisit un
              montant sans jamais voir où il tombe — et une répartition
              qu'on ne voit pas est une répartition qu'on ne vérifie
              pas. */}
          {total > 0 && servies.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-center text-xs">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    <th className="rounded-l-lg px-3 py-2 text-left font-bold">Produit</th>
                    <th className="px-3 py-2 font-bold">Quantité</th>
                    <th className="px-3 py-2 font-bold">Prix d&apos;achat</th>
                    <th className="px-3 py-2 font-bold">Part des frais</th>
                    <th className="rounded-r-lg px-3 py-2 font-bold">Coût réel</th>
                  </tr>
                </thead>
                <tbody>
                  {servies.map(({ l, i }) => {
                    const qte = l.quantiteRecue ?? l.quantiteDemandee ?? 0;
                    const part = parts[i] ?? 0;
                    const impose = imposees[i] != null;
                    /* Le coût rendu en rayon : c'est lui qui pondérera le
                       coût moyen, pas le prix facturé. */
                    const cout = qte > 0
                      ? (l.valeurUnitaire ?? 0) + part / qte
                      : (l.valeurUnitaire ?? 0);
                    return (
                      <tr key={i}
                        className="border-b border-gray-50 last:border-0 dark:border-gray-800">
                        <td className="px-3 py-2.5 text-left text-gray-900 dark:text-gray-100">
                          {l.designation}
                          {l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''}
                        </td>
                        <td className="px-3 py-2.5 text-gray-500">{qte}</td>
                        <td className="px-3 py-2.5 text-gray-500">
                          {formatMontant(l.valeurUnitaire ?? 0)}
                        </td>
                        <td className="px-3 py-2.5">
                          {lectureSeule ? (
                            <span className="font-medium text-gray-900 dark:text-gray-100">
                              {formatMontant(part)}
                            </span>
                          ) : (
                            <div className="mx-auto w-32">
                              <ChampNombre valeur={part}
                                onChange={v => onCorriger?.({ ...imposees, [i]: v })}
                                className={`w-full rounded-lg border px-2 py-1.5 text-right text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${impose
                                  ? 'border-indigo-300 bg-indigo-50 font-bold text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300'
                                  : 'border-transparent bg-transparent text-gray-500'}`} />
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-bold text-gray-900 dark:text-gray-100">
                          {formatMontant(Math.round(cout))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

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
