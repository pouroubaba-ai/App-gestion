'use client';
import { useEffect, useState } from 'react';
import { Plus, Trash2, Check, Loader2, Percent, Coins } from 'lucide-react';
import { formatMontant } from '@/lib/format';
import { ChampNombre } from '@/components/Champs';
import {
  valeurEnFrancs, reductionBornee, totalFraisAnnexes,
  modelesDuSite, creerModele, supprimerModele, nomModelePris,
  LIBELLES_SENS,
  type MontantVente, type ModeleMontant, type SensMontant, type TypeMontant,
} from '@/lib/reductions';

/**
 * Les réductions et frais annexes d'une vente.
 *
 * Une réduction baisse la facture, des frais annexes l'augmentent — et
 * les deux se répartissent ensuite sur les lignes. Le prix qui en sort
 * est le prix de vente : c'est lui qui part au mouvement et dans la
 * marge. Ce panneau ne garde que l'explication.
 *
 * Les modèles évitent de ressaisir « 5 % » à chaque client fidèle, et
 * évitent surtout que deux bons portent des taux différents pour la
 * même habitude. Ils préremplissent sans contraindre : le taux et le
 * montant restent modifiables sur la vente.
 */
export default function PanneauMontants({
  siteId, userId, montants, sousTotal, lectureSeule, onChange,
}: {
  siteId: string;
  userId: string;
  montants: MontantVente[];
  /** la marchandise seule : c'est la base des pourcentages */
  sousTotal: number;
  lectureSeule?: boolean;
  onChange?: (m: MontantVente[]) => void;
}) {
  const [modeles, setModeles] = useState<ModeleMontant[]>([]);
  const [ouvert, setOuvert] = useState(false);
  const [creation, setCreation] = useState(false);
  const [nom, setNom] = useState('');
  const [sens, setSens] = useState<SensMontant>('reduction');
  const [type, setType] = useState<TypeMontant>('pourcentage');
  const [valeur, setValeur] = useState(0);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    if (lectureSeule) return;
    modelesDuSite(siteId).then(setModeles).catch(() => {});
  }, [siteId, lectureSeule]);

  const reduction = reductionBornee(montants, sousTotal);
  const frais = totalFraisAnnexes(montants, sousTotal);
  const aPayer = Math.max(0, sousTotal - reduction + frais);

  /* Ce que les réductions demandent avant d'être bornées : au-delà de ce
     qu'on vend, le client devrait de l'argent pour être venu. */
  const demande = (montants ?? [])
    .filter(m => m.sens === 'reduction')
    .reduce((n, m) => n + valeurEnFrancs(m, sousTotal), 0);
  const depasse = demande > sousTotal;

  function poser(m: MontantVente) {
    onChange?.([...montants, m]);
    setOuvert(false);
  }

  function modifier(i: number, champ: keyof MontantVente, v: any) {
    onChange?.(montants.map((m, j) => (j === i ? { ...m, [champ]: v } : m)));
  }

  async function creer() {
    const n = nom.trim();
    if (!n) { setErreur('Donnez-lui un nom.'); return; }
    if (nomModelePris(n, modeles)) {
      setErreur('Un modèle porte déjà ce nom.');
      return;
    }
    setEnCours(true);
    try {
      const nouveau = await creerModele(siteId, userId, { nom: n, sens, type, valeur });
      setModeles(l => [...l, nouveau].sort((a, b) => a.nom.localeCompare(b.nom, 'fr')));
      poser({ libelle: n, sens, type, valeur });
      setNom(''); setValeur(0); setErreur(''); setCreation(false);
    } catch {
      setErreur('Enregistrement impossible.');
    }
    setEnCours(false);
  }

  async function retirerModele(id: string) {
    await supprimerModele(id).catch(() => {});
    setModeles(l => l.filter(m => m.id !== id));
  }

  /* Rien à dire quand rien n'est posé et qu'on ne peut rien poser. */
  if (lectureSeule && montants.length === 0) return null;

  return (
    <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Réductions et frais annexes
          </p>
          <p className="mt-0.5 text-[11px] text-gray-400">
            Répartis sur les produits — le prix qui en sort est le prix de vente.
          </p>
        </div>
        {!lectureSeule && (
          <div className="relative">
            <button type="button" onClick={() => { setOuvert(o => !o); setCreation(false); }}
              className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
              <Plus size={13} /> Ajouter
            </button>

            {ouvert && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setOuvert(false)} />
                <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                  {creation ? (
                    <div className="space-y-2 p-1.5">
                      <input type="text" value={nom} autoFocus
                        onChange={e => { setNom(e.target.value); setErreur(''); }}
                        placeholder="Ex. Remise fidélité"
                        className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />

                      {/* Ce que le montant fait au prix : baisser ou
                          augmenter. Un frais n'est pas une remise
                          négative — les confondre empêcherait de dire
                          ce qu'on accorde et ce qu'on facture. */}
                      <div className="flex rounded-lg border border-gray-200 dark:border-gray-700">
                        {(['reduction', 'frais'] as SensMontant[]).map(s => (
                          <button key={s} type="button" onClick={() => setSens(s)}
                            className={`flex-1 px-2 py-1.5 text-[11px] font-bold transition-colors first:rounded-l-lg last:rounded-r-lg ${sens === s
                              ? s === 'reduction' ? 'bg-red-500 text-white' : 'bg-indigo-600 text-white'
                              : 'text-gray-500 hover:text-gray-700'}`}>
                            {LIBELLES_SENS[s]}
                          </button>
                        ))}
                      </div>

                      {/* La bascule : le même geste s'exprime en taux ou
                          en francs selon ce qu'on a négocié. */}
                      <div className="flex items-center gap-2">
                        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700">
                          {([
                            { t: 'pourcentage' as TypeMontant, i: <Percent size={11} /> },
                            { t: 'montant' as TypeMontant, i: <Coins size={11} /> },
                          ]).map(o => (
                            <button key={o.t} type="button" onClick={() => setType(o.t)}
                              className={`px-2.5 py-1.5 transition-colors first:rounded-l-lg last:rounded-r-lg ${type === o.t
                                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                                : 'text-gray-400 hover:text-gray-600'}`}>
                              {o.i}
                            </button>
                          ))}
                        </div>
                        <ChampNombre valeur={valeur} onChange={setValeur}
                          max={type === 'pourcentage' ? 100 : undefined}
                          className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-right text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />
                        <span className="shrink-0 text-xs text-gray-400">
                          {type === 'pourcentage' ? '%' : 'FCFA'}
                        </span>
                      </div>

                      {erreur && <p className="text-[11px] font-bold text-red-500">{erreur}</p>}

                      <div className="flex gap-1.5">
                        <button type="button" onClick={() => { setCreation(false); setErreur(''); }}
                          className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-[11px] font-bold text-gray-500 dark:border-gray-700">
                          Annuler
                        </button>
                        <button type="button" onClick={creer} disabled={enCours}
                          className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2 py-1.5 text-[11px] font-bold text-white disabled:opacity-40">
                          {enCours ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                          Créer
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="max-h-56 overflow-y-auto">
                        {modeles.length === 0 ? (
                          <p className="px-2.5 py-3 text-center text-[11px] text-gray-400">
                            Aucun modèle enregistré.
                          </p>
                        ) : modeles.map(m => (
                          <div key={m.id} className="group flex items-center gap-1">
                            <button type="button"
                              onClick={() => poser({
                                libelle: m.nom, sens: m.sens, type: m.type, valeur: m.valeur,
                              })}
                              className="flex flex-1 items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
                              <span className="truncate text-xs text-gray-700 dark:text-gray-200">
                                {m.nom}
                              </span>
                              <span className={`shrink-0 text-[11px] font-bold ${m.sens === 'reduction' ? 'text-red-500' : 'text-indigo-600'}`}>
                                {m.sens === 'reduction' ? '−' : '+'}
                                {m.type === 'pourcentage'
                                  ? `${m.valeur} %`
                                  : formatMontant(m.valeur)}
                              </span>
                            </button>
                            <button type="button" onClick={() => retirerModele(m.id)}
                              title="Supprimer ce modèle"
                              className="shrink-0 rounded-lg p-1.5 text-gray-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-900/20">
                              <Trash2 size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button type="button" onClick={() => setCreation(true)}
                        className="mt-1 flex w-full items-center gap-1.5 rounded-lg border-t border-gray-100 px-2.5 py-2 text-[11px] font-bold text-indigo-600 transition-colors hover:bg-indigo-50 dark:border-gray-800 dark:hover:bg-indigo-900/20">
                        <Plus size={11} /> Nouveau modèle
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {montants.length === 0 ? (
        <p className="py-5 text-center text-xs text-gray-400">
          Aucune réduction ni frais — la vente se fait au prix du catalogue.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {montants.map((m, i) => (
              <div key={i}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-100 p-2.5 dark:border-gray-800">
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${m.sens === 'reduction'
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                  : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'}`}>
                  {LIBELLES_SENS[m.sens]}
                </span>
                <input type="text" value={m.libelle} disabled={lectureSeule}
                  onChange={e => modifier(i, 'libelle', e.target.value)}
                  className="min-w-[100px] flex-1 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:border-transparent disabled:bg-transparent dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

                {/* Le modèle a donné une base, la vente garde le dernier
                    mot : on bascule et on corrige ici aussi. */}
                {!lectureSeule && (
                  <div className="flex shrink-0 rounded-lg border border-gray-200 dark:border-gray-700">
                    {([
                      { t: 'pourcentage' as TypeMontant, i: <Percent size={11} /> },
                      { t: 'montant' as TypeMontant, i: <Coins size={11} /> },
                    ]).map(o => (
                      <button key={o.t} type="button"
                        onClick={() => modifier(i, 'type', o.t)}
                        className={`px-2 py-1.5 transition-colors first:rounded-l-lg last:rounded-r-lg ${m.type === o.t
                          ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                          : 'text-gray-400 hover:text-gray-600'}`}>
                        {o.i}
                      </button>
                    ))}
                  </div>
                )}
                <div className="w-24 shrink-0">
                  <ChampNombre valeur={m.valeur} disabled={lectureSeule}
                    max={m.type === 'pourcentage' ? 100 : undefined}
                    onChange={v => modifier(i, 'valeur', v)}
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-right text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:border-transparent disabled:bg-transparent dark:border-gray-700 dark:bg-gray-800" />
                </div>
                <span className="w-8 shrink-0 text-xs text-gray-400">
                  {m.type === 'pourcentage' ? '%' : 'F'}
                </span>
                <span className={`w-28 shrink-0 text-right text-xs font-bold tabular-nums ${m.sens === 'reduction' ? 'text-red-500' : 'text-indigo-600'}`}>
                  {m.sens === 'reduction' ? '−' : '+'}
                  {formatMontant(valeurEnFrancs(m, sousTotal))}
                </span>
                {!lectureSeule && (
                  <button type="button"
                    onClick={() => onChange?.(montants.filter((_, j) => j !== i))}
                    className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Le pied : ce que le client lit. Les produits à leur prix, ce
              qu'on accorde, ce qu'on facture, ce qu'il paie. */}
          <div className="mt-3 space-y-1 border-t border-gray-100 pt-3 text-xs dark:border-gray-800">
            <div className="flex justify-between">
              <span className="text-gray-400">Sous-total</span>
              <span className="font-medium tabular-nums text-gray-700 dark:text-gray-200">
                {formatMontant(sousTotal)}
              </span>
            </div>
            {reduction > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-400">Réduction</span>
                <span className="font-medium tabular-nums text-red-500">
                  −{formatMontant(reduction)}
                </span>
              </div>
            )}
            {frais > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-400">Frais annexes</span>
                <span className="font-medium tabular-nums text-indigo-600">
                  +{formatMontant(frais)}
                </span>
              </div>
            )}
            <div className="flex justify-between border-t border-gray-100 pt-1.5 dark:border-gray-800">
              <span className="font-bold text-gray-900 dark:text-gray-100">À payer</span>
              <span className="text-sm font-bold tabular-nums text-gray-900 dark:text-gray-100">
                {formatMontant(aPayer)}
              </span>
            </div>
          </div>

          {depasse && (
            <p className="mt-2 text-[11px] font-bold text-red-500">
              La réduction dépasse ce qu&apos;on vend : elle s&apos;arrête à{' '}
              {formatMontant(sousTotal)}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
