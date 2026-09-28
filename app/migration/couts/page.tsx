'use client';

/**
 * Réparer les coûts moyens écrits en monnaie d'emballage.
 *
 * Le coût se saisit dans l'emballage retenu — un carton de 25 ampoules à
 * 19 825 — et le stock se tient à l'unité. L'écriture mêlait les deux :
 * le prix du carton s'inscrivait sur des pièces. La fiche produit
 * annonçait alors 32 115 là où l'inventaire, qui reconstruit depuis les
 * mouvements, lisait 16 296.
 *
 * Le registre des mouvements, lui, n'a jamais menti : la valeur totale y
 * est écrite, et la diviser par les unités donne le coût d'une unité. On
 * recalcule donc depuis lui, et on n'écrit que la différence.
 *
 * Cet écran ne décide rien tout seul : il montre les écarts, et la main
 * tranche. Rien n'est touché tant qu'on ne l'a pas demandé.
 */

import { useEffect, useState } from 'react';
import {
  collection, query, where, getDocs, writeBatch, doc, documentId,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { etatsDepuisMouvements, etatDe } from '@/lib/cout-moyen';
import { formatMontant } from '@/lib/format';
import { Loader2, Check, AlertTriangle, Wrench } from 'lucide-react';

interface Ecart {
  detentionId: string;
  siteNom: string;
  designation: string;
  varianteCle: string | null;
  stock: number;
  ecrit: number;
  juste: number;
}

export default function ReparerCouts() {
  const { user, activite } = useAuth();
  const [loading, setLoading] = useState(false);
  const [ecarts, setEcarts] = useState<Ecart[]>([]);
  const [examine, setExamine] = useState(0);
  const [fait, setFait] = useState(false);
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);

  async function examiner() {
    if (!activite?.id) return;
    setLoading(true); setErreur('');
    try {
      const sitesSnap = await getDocs(query(
        collection(db, 'sites'), where('activiteId', '==', activite.id)));
      const sites = sitesSnap.docs.map(d => ({
        id: d.id, nom: (d.data() as any).nom as string,
      }));

      const prodSnap = await getDocs(query(
        collection(db, 'produits'), where('activiteId', '==', activite.id)));
      const noms = new Map<string, string>();
      for (const d of prodSnap.docs) {
        noms.set(d.id, (d.data() as any).designation ?? '');
      }

      const trouves: Ecart[] = [];
      let vus = 0;

      for (const s of sites) {
        const [dets, mvts] = await Promise.all([
          getDocs(query(collection(db, 'produits_site'), where('siteId', '==', s.id))),
          getDocs(query(collection(db, 'mouvements'), where('siteId', '==', s.id))),
        ]);
        const etats = etatsDepuisMouvements(mvts.docs.map(d => d.data() as any));

        for (const d of dets.docs) {
          const det = d.data() as any;
          vus++;

          /* Sans déclinaison, la détention porte son coût en propre. */
          const variantes: any[] = det.variantes ?? [];
          if (variantes.length === 0) {
            const juste = etatDe(etats, det.produitId, null).coutMoyen;
            const ecrit = det.coutMoyen ?? 0;
            /* Voir plus bas : sans mouvement, la reconstruction rend zéro
               faute de matière, et le coût en place vaut mieux. */
            if (juste <= 0 && ecrit > 0) continue;
            if (Math.abs(juste - ecrit) >= 1) {
              trouves.push({
                detentionId: d.id, siteNom: s.nom,
                designation: noms.get(det.produitId) ?? det.produitId,
                varianteCle: null,
                stock: det.stock ?? 0, ecrit, juste,
              });
            }
            continue;
          }

          /* Chaque déclinaison a son coût : elles n'héritent pas. */
          for (const v of variantes) {
            const juste = etatDe(etats, det.produitId, v.cle).coutMoyen;
            const ecrit = v.coutMoyen ?? 0;
            /* Un rayon sans mouvement ne se reconstruit pas : la
               reconstruction rend zéro faute de matière, pas parce que la
               marchandise ne vaut rien. Le coût en place est alors la
               seule chose qu'on sache — l'écraser perdrait ce savoir. */
            if (juste <= 0 && ecrit > 0) continue;
            if (Math.abs(juste - ecrit) >= 1) {
              trouves.push({
                detentionId: d.id, siteNom: s.nom,
                designation: (noms.get(det.produitId) ?? det.produitId)
                  + ' · ' + v.cle,
                varianteCle: v.cle,
                stock: v.stock ?? 0, ecrit, juste,
              });
            }
          }
        }
      }

      setExamine(vus);
      setEcarts(trouves);
    } catch (e: any) {
      setErreur(e?.message ?? 'La lecture a échoué.');
    } finally { setLoading(false); }
  }

  /**
   * Écrire les coûts justes.
   *
   * Une détention peut porter plusieurs écarts — un par déclinaison. On
   * les regroupe pour n'écrire qu'une fois par document : deux écritures
   * successives sur le même se perdraient l'une l'autre.
   */
  async function reparer() {
    if (ecarts.length === 0 || !user) return;
    setEnCours(true); setErreur('');
    try {
      const parDetention = new Map<string, Ecart[]>();
      for (const e of ecarts) {
        const l = parDetention.get(e.detentionId) ?? [];
        l.push(e);
        parDetention.set(e.detentionId, l);
      }

      /* On relit les détentions à toucher : leur liste de variantes doit
         repartir telle quelle, sauf le coût qu'on recale. */
      const ids = [...parDetention.keys()];
      const dets = new Map<string, any>();
      for (let i = 0; i < ids.length; i += 30) {
        const snap = await getDocs(query(
          collection(db, 'produits_site'),
          where(documentId(), 'in', ids.slice(i, i + 30))));
        for (const d of snap.docs) dets.set(d.id, d.data());
      }

      /* Firestore n'accepte que 500 écritures par lot. */
      for (let i = 0; i < ids.length; i += 400) {
        const lot = writeBatch(db);
        for (const id of ids.slice(i, i + 400)) {
          const liste = parDetention.get(id)!;
          const det = dets.get(id);
          if (!det) continue;

          const sansVariante = liste.find(e => e.varianteCle === null);
          if (sansVariante) {
            lot.update(doc(db, 'produits_site', id),
              { coutMoyen: sansVariante.juste });
            continue;
          }

          const majs = new Map(liste.map(e => [e.varianteCle, e.juste]));
          lot.update(doc(db, 'produits_site', id), {
            variantes: (det.variantes ?? []).map((v: any) =>
              majs.has(v.cle) ? { ...v, coutMoyen: majs.get(v.cle) } : v),
          });
        }
        await lot.commit();
      }

      setFait(true);
      await examiner();
    } catch (e: any) {
      setErreur(e?.message ?? 'L’écriture a échoué.');
    } finally { setEnCours(false); }
  }

  useEffect(() => { if (activite?.id) examiner(); }, [activite?.id]);

  return (
    <div className="min-h-screen bg-gray-50 p-4 dark:bg-gray-950 sm:p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-gray-100">
            <Wrench size={20} /> Coûts à recaler
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-gray-400">
            Le coût se saisit par emballage, le stock se tient à l’unité. Les
            écritures antérieures mêlaient les deux : le prix d’un carton
            s’inscrivait sur chaque pièce. On recalcule depuis les mouvements,
            qui portent la valeur réelle.
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <button onClick={examiner} disabled={loading || enCours}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
            Réexaminer
          </button>
          {ecarts.length > 0 && (
            <button onClick={reparer} disabled={enCours || loading}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
              {enCours ? <Loader2 size={14} className="animate-spin" />
                : <Check size={14} />}
              Recaler {ecarts.length} coût{ecarts.length > 1 ? 's' : ''}
            </button>
          )}
        </div>

        {erreur && (
          <p className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            <AlertTriangle size={14} /> {erreur}
          </p>
        )}

        {fait && ecarts.length === 0 && (
          <p className="flex items-center gap-2 rounded-xl bg-green-50 px-3 py-2 text-sm font-bold text-green-700 dark:bg-green-900/20 dark:text-green-400">
            <Check size={14} /> Tous les coûts sont recalés.
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin text-gray-300" size={24} />
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <p className="mb-3 text-sm font-bold text-gray-900 dark:text-gray-100">
              {ecarts.length === 0
                ? `${examine} détention${examine > 1 ? 's' : ''} examinée${examine > 1 ? 's' : ''} — rien à recaler`
                : `${ecarts.length} écart${ecarts.length > 1 ? 's' : ''} sur ${examine} détention${examine > 1 ? 's' : ''}`}
            </p>

            {ecarts.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-center text-sm">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="rounded-l-lg px-3 py-2.5 text-left font-medium">Produit</th>
                      <th className="px-3 py-2.5 font-medium">Site</th>
                      <th className="px-3 py-2.5 font-medium">Stock</th>
                      <th className="px-3 py-2.5 font-medium">Écrit</th>
                      <th className="rounded-r-lg px-3 py-2.5 font-medium">Juste</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {ecarts.map((e, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2.5 text-left text-gray-900 dark:text-gray-100">
                          {e.designation}
                        </td>
                        <td className="px-3 py-2.5 text-gray-500">{e.siteNom}</td>
                        <td className="px-3 py-2.5 text-gray-500">
                          {e.stock.toLocaleString('fr-FR')}
                        </td>
                        <td className="px-3 py-2.5 font-medium text-red-500">
                          {formatMontant(e.ecrit)}
                        </td>
                        <td className="px-3 py-2.5 font-bold text-green-600">
                          {formatMontant(e.juste)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
