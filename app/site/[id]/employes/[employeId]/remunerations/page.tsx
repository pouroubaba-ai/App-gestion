'use client';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs, getDoc, doc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { ChampRecherche } from '@/components/Champs';

interface Versement {
  id: string;
  ligneId: string;
  montant: number;
  date: string;
  nomConfig: string;
  ligneType?: 'configure' | 'manuel';
  ligneNom?: string;
  ligneDate?: string;
  ligneDateFin?: string | null;
}

function formatDate(s?: string | null) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function RemunerationsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const siteId = params.id as string;
  const employeId = params.employeId as string;

  const [versements, setVersements] = useState<Versement[]>([]);
  const [nomEmploye, setNomEmploye] = useState('');
  const [loading, setLoading] = useState(true);

  const [rechNom, setRechNom] = useState('');
  const [jour, setJour] = useState('');
  const [mois, setMois] = useState('');
  const [annee, setAnnee] = useState('');

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      const [empSnap, vSnap] = await Promise.all([
        getDoc(doc(db, 'employes', employeId)),
        getDocs(query(collection(db, 'employe_versements'), where('employeId', '==', employeId))),
      ]);
      if (empSnap.exists()) setNomEmploye(empSnap.data().nom ?? '');
      setVersements(
        vSnap.docs
          .map(d => ({ id: d.id, ...d.data() } as Versement))
          .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      );
      setLoading(false);
    };
    load();
  }, [user, employeId]);

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

  const filtres = versements.filter(v => {
    if (rechNom.trim()) {
      const nom = v.ligneType === 'manuel' ? 'diverses' : (v.ligneNom ?? v.nomConfig ?? '');
      if (!nom.toLowerCase().includes(rechNom.toLowerCase())) return false;
    }
    if (jour || mois || annee) {
      const [a, m, j] = (v.date ?? '').split('-');
      if (jour && j !== jour.padStart(2, '0')) return false;
      if (mois && m !== mois.padStart(2, '0')) return false;
      if (annee && a !== annee) return false;
    }
    return true;
  });

  const totalFiltre = filtres.reduce((s, v) => s + v.montant, 0);
  const totalGlobal = versements.reduce((s, v) => s + v.montant, 0);
  const filtreActif = !!(rechNom || jour || mois || annee);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="w-full p-4 sm:p-6 lg:p-8">

        <button onClick={() => router.back()} className="flex items-center gap-2 mb-6 group">
          <ArrowLeft size={15} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
          <span className="text-sm font-medium text-gray-600 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">Retour</span>
        </button>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">Versements de rémunération</h1>
              <p className="text-xs text-gray-400">{nomEmploye}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Total versé</p>
              <p className="text-sm font-bold text-green-600">{formatMontant(totalGlobal)}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Versements</p>
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{versements.length}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
          <div className="flex flex-wrap gap-2 mb-4">
            <ChampRecherche placeholder="Rechercher une rémunération…" valeur={rechNom} onChange={setRechNom} className="flex-1 min-w-[180px]" />
            <input type="number" placeholder="Jour" value={jour} onChange={e => setJour(e.target.value)}
              className="w-24 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <input type="number" placeholder="Mois" value={mois} onChange={e => setMois(e.target.value)}
              className="w-24 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <input type="number" placeholder="Année" value={annee} onChange={e => setAnnee(e.target.value)}
              className="w-28 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            {filtreActif && (
              <button onClick={() => { setRechNom(''); setJour(''); setMois(''); setAnnee(''); }}
                className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-xs font-bold text-gray-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors">
                Effacer
              </button>
            )}
          </div>

          {filtres.length === 0
            ? <p className="text-xs text-gray-400 text-center py-8">{versements.length === 0 ? 'Aucun versement effectué' : 'Aucun résultat'}</p>
            : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-400">{filtres.length} versement{filtres.length > 1 ? 's' : ''}</p>
                  {filtreActif && <p className="text-xs text-gray-400">Total filtré <span className="font-bold text-green-600">{formatMontant(totalFiltre)}</span></p>}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-3 py-2.5 font-medium">Rémunération</th>
                        <th className="text-center px-3 py-2.5 font-medium">Type</th>
                        <th className="text-center px-3 py-2.5 font-medium">Instance</th>
                        <th className="text-center px-3 py-2.5 font-medium">Date versement</th>
                        <th className="text-center px-3 py-2.5 font-medium">Montant</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {filtres.map(v => (
                        <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">
                            {v.ligneType === 'manuel' ? 'Diverses' : (v.ligneNom ?? v.nomConfig)}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${v.ligneType === 'manuel'
                              ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'
                              : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                              {v.ligneType === 'manuel' ? 'Manuel' : 'Configuré'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-gray-500 text-center">
                            {v.ligneType === 'manuel'
                              ? `${v.ligneNom ?? v.nomConfig}${v.ligneDate ? ` · ${formatDate(v.ligneDate)}` : ''}`
                              : v.ligneDate && v.ligneDateFin
                                ? `${formatDate(v.ligneDate)} → ${formatDate(v.ligneDateFin)}`
                                : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-gray-500 text-center">{formatDate(v.date)}</td>
                          <td className="px-3 py-2.5 text-green-600 font-bold text-center">{formatMontant(v.montant)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          }
        </div>
      </div>
    </div>
  );
}
