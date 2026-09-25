'use client';
import { useEffect, useState } from 'react';
import {
  collection, query, where, getDocs, addDoc, updateDoc, doc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { ArrowLeft, Loader2, ArrowUpDown, ArrowUp, ArrowDown, ChevronDown } from 'lucide-react';
import { ChampRecherche } from '@/components/Champs';

interface LigneRemuneration {
  id: string; employeId: string; assignationId?: string;
  nomConfig: string; montant: number; verse: number; reste: number;
  dateDebut: string; dateFin: string; intervalleJours?: number;
  type: 'configure' | 'manuel'; createdAt?: any;
}

interface Versement {
  id: string; ligneId: string; montant: number; date: string;
  nomConfig: string; assignationId?: string;
  ligneType?: 'configure' | 'manuel';
  ligneNom?: string;
  ligneDate?: string;
  ligneDateFin?: string | null;
  createdAt?: any;
}

function todayStr() { return new Date().toISOString().split('T')[0]; }
function formatDate(s: string) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}
function parseMontant(s: string): number {
  return parseInt(s.replace(/[\s ]/g, ''), 10) || 0;
}

function statutLigne(l: LigneRemuneration): { label: string; color: string } {
  if (l.reste <= 0) return { label: 'Soldé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  if (l.verse > 0)  return { label: 'Partiel', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  return { label: 'Non soldé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
}

export default function ManuellePage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const siteId = params.id as string;
  const employeId = params.employeId as string;

  const [lignes, setLignes] = useState<LigneRemuneration[]>([]);
  const [versements, setVersements] = useState<Versement[]>([]);
  const [loading, setLoading] = useState(true);
  const [onglet, setOnglet] = useState<'instances' | 'versements'>('instances');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [modalVersement, setModalVersement] = useState(false);
  const [montantInput, setMontantInput] = useState('');
  const [listeDepliee, setListeDepliee] = useState(false);
  const [saving, setSaving] = useState(false);

  /* recherche + filtre instances */
  const [rechInst, setRechInst] = useState('');
  const [filtreStatut, setFiltreStatut] = useState<'tous' | 'solde' | 'partiel' | 'non_solde'>('tous');
  type ColTri = 'verse' | 'reste';
  const [colTri, setColTri] = useState<ColTri | null>(null);
  const [triDir, setTriDir] = useState<'asc' | 'desc'>('asc');

  /* recherche versements */
  const [rechNom, setRechNom] = useState('');
  const [rechJour, setRechJour] = useState('');
  const [rechMois, setRechMois] = useState('');
  const [rechAnnee, setRechAnnee] = useState('');

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const q = query(collection(db, 'employe_remunerations'), where('employeId', '==', employeId), where('type', '==', 'manuel'));
      const snap = await getDocs(q);
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() } as LigneRemuneration))
        .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
      setLignes(rows);

      const vSnap = await getDocs(query(collection(db, 'employe_versements'), where('employeId', '==', employeId)));
      const manIds = new Set(rows.map(l => l.id));
      setVersements(
        vSnap.docs
          .map(d => ({ id: d.id, ...d.data() } as Versement))
          .filter(v => manIds.has(v.ligneId))
          .sort((a, b) => b.date.localeCompare(a.date))
      );
      setLoading(false);
    };
    load();
  }, [user, employeId]);

  function toggleVersementSelection(id: string) {
    setSelection(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }

  function ouvrirVersement() {
    const nonSoldes = lignes.filter(l => l.reste > 0).map(l => l.id);
    setSelection(new Set(nonSoldes));
    setMontantInput('');
    setListeDepliee(false);
    setModalVersement(true);
  }

  async function effectuerVersement() {
    const montant = parseMontant(montantInput);
    if (!montant || montant <= 0) return;
    setSaving(true);
    try {
      let restant = montant;
      const updatedLignes = [...lignes];
      const cibles = lignes.filter(l => selection.has(l.id) && l.reste > 0).sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
      for (const l of cibles) {
        if (restant <= 0) break;
        const paiement = Math.min(restant, l.reste);
        if (paiement <= 0) continue;
        restant -= paiement;
        await updateDoc(doc(db, 'employe_remunerations', l.id), { verse: l.verse + paiement, reste: l.reste - paiement });
        await addDoc(collection(db, 'employe_versements'), {
          ligneId: l.id, employeId, siteId,
          montant: paiement, date: todayStr(),
          nomConfig: l.nomConfig,
          ligneType: 'manuel',
          ligneNom: l.nomConfig,
          ligneDate: l.dateDebut,
          ligneDateFin: null,
          createdAt: serverTimestamp(),
        });
        const idx = updatedLignes.findIndex(x => x.id === l.id);
        if (idx >= 0) updatedLignes[idx] = { ...updatedLignes[idx], verse: l.verse + paiement, reste: l.reste - paiement };
      }
      setLignes(updatedLignes);
      setModalVersement(false);
      setSelection(new Set());
      setMontantInput('');
      const vSnap = await getDocs(query(collection(db, 'employe_versements'), where('employeId', '==', employeId)));
      const manIds = new Set(updatedLignes.map(l => l.id));
      setVersements(
        vSnap.docs.map(d => ({ id: d.id, ...d.data() } as Versement))
          .filter(v => manIds.has(v.ligneId))
          .sort((a, b) => b.date.localeCompare(a.date))
      );
    } finally {
      setSaving(false);
    }
  }

  const totalDu = lignes.reduce((s, l) => s + l.montant, 0);
  const totalVerse = lignes.reduce((s, l) => s + l.verse, 0);
  const totalReste = lignes.reduce((s, l) => s + l.reste, 0);

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

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
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Diverses</h1>
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400">Manuel</span>
              </div>
              <p className="text-xs text-gray-400">{lignes.length} rémunération{lignes.length > 1 ? 's' : ''} manuelle{lignes.length > 1 ? 's' : ''}</p>
            </div>
            <button onClick={ouvrirVersement} disabled={totalReste <= 0}
              className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              Versement
            </button>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Total dû</p>
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{formatMontant(totalDu)}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Versé</p>
              <p className="text-sm font-bold text-green-600">{formatMontant(totalVerse)}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Reste</p>
              <p className="text-sm font-bold text-red-500">{formatMontant(totalReste)}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm">
          <div className="flex border-b border-gray-100 dark:border-gray-800">
            {(['instances', 'versements'] as const).map(o => (
              <button key={o} onClick={() => setOnglet(o)}
                className={`px-5 py-3 text-sm font-semibold capitalize transition-colors border-b-2 -mb-px ${onglet === o ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                {o === 'instances' ? 'Instances' : 'Versements'}
              </button>
            ))}
          </div>

          {onglet === 'instances' && (() => {
            const STATUTS = [
              { key: 'tous' as const, label: 'Tous' },
              { key: 'non_solde' as const, label: 'Non soldé' },
              { key: 'partiel' as const, label: 'Partiel' },
              { key: 'solde' as const, label: 'Soldé' },
            ];
            const lignesFiltr = lignes.filter(l => {
              if (rechInst.trim() && !l.nomConfig.toLowerCase().includes(rechInst.toLowerCase())) return false;
              const s = statutLigne(l).label;
              if (filtreStatut === 'solde' && s !== 'Soldé') return false;
              if (filtreStatut === 'partiel' && s !== 'Partiel') return false;
              if (filtreStatut === 'non_solde' && s !== 'Non soldé') return false;
              return true;
            });
            const lignesTriees = colTri
              ? [...lignesFiltr].sort((a, b) => {
                  const diff = colTri === 'verse' ? a.verse - b.verse : a.reste - b.reste;
                  return triDir === 'asc' ? diff : -diff;
                })
              : lignesFiltr;
            function toggleTri(col: ColTri) {
              if (colTri === col) setTriDir(d => d === 'asc' ? 'desc' : 'asc');
              else { setColTri(col); setTriDir('asc'); }
            }
            function IcTri({ col }: { col: ColTri }) {
              if (colTri !== col) return <ArrowUpDown size={11} className="inline ml-1 opacity-50" />;
              return triDir === 'asc'
                ? <ArrowUp size={11} className="inline ml-1" />
                : <ArrowDown size={11} className="inline ml-1" />;
            }
            const countStatut = (k: typeof filtreStatut) => {
              if (k === 'tous') return lignes.length;
              return lignes.filter(l => {
                const s = statutLigne(l).label;
                if (k === 'solde') return s === 'Soldé';
                if (k === 'partiel') return s === 'Partiel';
                return s === 'Non soldé';
              }).length;
            };
            return (
            <div className="p-4">
              {/* recherche + filtres */}
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <ChampRecherche placeholder="Rechercher…" valeur={rechInst} onChange={setRechInst} className="flex-1 min-w-36" />
                <div className="flex gap-1 flex-wrap">
                  {STATUTS.map(s => (
                    <button key={s.key} onClick={() => setFiltreStatut(s.key)}
                      className={`px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-all ${filtreStatut === s.key ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-300'}`}>
                      {s.label} ({countStatut(s.key)})
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-gray-400 mb-3">{lignesTriees.length} instance{lignesTriees.length > 1 ? 's' : ''}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="text-center px-3 py-2.5 font-medium">Rémunération</th>
                      <th className="text-center px-3 py-2.5 font-medium">Début</th>
                      <th className="text-center px-3 py-2.5 font-medium">Fin</th>
                      <th className="text-center px-3 py-2.5 font-medium">Dû</th>
                      <th className="text-center px-3 py-2.5 font-medium cursor-pointer select-none" onClick={() => toggleTri('verse')}>Versé <IcTri col="verse" /></th>
                      <th className="text-center px-3 py-2.5 font-medium cursor-pointer select-none" onClick={() => toggleTri('reste')}>Reste <IcTri col="reste" /></th>
                      <th className="text-center px-3 py-2.5 font-medium">Statut</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {lignesTriees.map(l => {
                      const s = statutLigne(l);
                      return (
                        <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                          <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">{l.nomConfig}</td>
                          <td className="px-3 py-2.5 text-center text-gray-500">{formatDate(l.dateDebut)}</td>
                          <td className="px-3 py-2.5 text-center text-gray-500">{formatDate(l.dateFin)}</td>
                          <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">{formatMontant(l.montant)}</td>
                          <td className="px-3 py-2.5 text-center text-green-600 font-medium">{l.verse > 0 ? formatMontant(l.verse) : '—'}</td>
                          <td className="px-3 py-2.5 text-center text-red-500 font-medium">{formatMontant(l.reste)}</td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.color}`}>{s.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                    {lignesTriees.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-10 text-center text-gray-400 text-sm">Aucune instance trouvée</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })()}

          {onglet === 'versements' && (() => {
            const versementsFiltres = versements.filter(v => {
              if (rechNom.trim() && !(v.ligneNom ?? v.nomConfig).toLowerCase().includes(rechNom.toLowerCase())) return false;
              const dateRef = v.ligneDate ?? v.date;
              const [y, m, d] = (dateRef || '').split('-');
              if (rechAnnee && y !== rechAnnee) return false;
              if (rechMois && m !== rechMois.padStart(2, '0')) return false;
              if (rechJour && d !== rechJour.padStart(2, '0')) return false;
              return true;
            });
            return (
              <div className="p-4">
                {/* barre de recherche */}
                <div className="flex flex-wrap gap-2 mb-3">
                  <input type="text" placeholder="Nom…" value={rechNom} onChange={e => setRechNom(e.target.value)}
                    className="flex-1 min-w-28 px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <input type="number" placeholder="Jour" min={1} max={31} value={rechJour} onChange={e => setRechJour(e.target.value)}
                    className="w-20 px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <input type="number" placeholder="Mois" min={1} max={12} value={rechMois} onChange={e => setRechMois(e.target.value)}
                    className="w-20 px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <input type="number" placeholder="Année" min={2000} max={2100} value={rechAnnee} onChange={e => setRechAnnee(e.target.value)}
                    className="w-24 px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <p className="text-xs text-gray-400 mb-3">{versementsFiltres.length} versement{versementsFiltres.length > 1 ? 's' : ''}</p>
                {versementsFiltres.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">Aucun versement trouvé</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-indigo-600 text-white">
                          <th className="text-center px-3 py-2.5 font-medium">Date versement</th>
                          <th className="text-center px-3 py-2.5 font-medium">Rémunération</th>
                          <th className="text-center px-3 py-2.5 font-medium">Date instance</th>
                          <th className="text-center px-3 py-2.5 font-medium">Montant</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                        {versementsFiltres.map(v => (
                          <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                            <td className="px-3 py-2.5 text-center text-gray-500">{formatDate(v.date)}</td>
                            <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">{v.ligneNom ?? v.nomConfig}</td>
                            <td className="px-3 py-2.5 text-center text-gray-500 text-xs">
                              {v.ligneDate ? formatDate(v.ligneDate) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-center font-bold text-green-600">{formatMontant(v.montant)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Modal versement */}
      {modalVersement && (() => {
        const nonSoldes = lignes.filter(l => l.reste > 0).sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
        const detteSelection = nonSoldes.filter(l => selection.has(l.id)).reduce((s, l) => s + l.reste, 0);
        const toutCoche = nonSoldes.length > 0 && nonSoldes.every(l => selection.has(l.id));
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5 flex flex-col max-h-[85vh] min-h-0">
              <div className="flex items-center justify-between mb-4 shrink-0">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Versement</h2>
                <button onClick={() => { setModalVersement(false); setSelection(new Set()); setMontantInput(''); }} className="text-gray-400 hover:text-gray-600 p-1 text-lg leading-none">×</button>
              </div>
              <div className={`mb-3 rounded-xl border border-gray-100 dark:border-gray-800 ${listeDepliee ? 'flex flex-col min-h-0 flex-1' : 'shrink-0'}`}>
                <button onClick={() => setListeDepliee(v => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-xl transition-colors shrink-0">
                  <ChevronDown size={14} className={`text-gray-400 shrink-0 transition-transform ${listeDepliee ? '' : '-rotate-90'}`} />
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-300 flex-1">
                    Rémunérations à verser
                    <span className="text-gray-400 font-normal ml-1.5">{selection.size}/{nonSoldes.length}</span>
                  </span>
                  <span className="text-xs font-bold text-red-500 shrink-0">{formatMontant(detteSelection)}</span>
                </button>
                {listeDepliee && (
                  <>
                    <div className="flex justify-end px-3 pb-2 shrink-0">
                      <button onClick={() => setSelection(toutCoche ? new Set() : new Set(nonSoldes.map(l => l.id)))}
                        className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">
                        {toutCoche ? 'Tout décocher' : 'Tout cocher'}
                      </button>
                    </div>
                    <div className="overflow-y-auto flex-1 min-h-0 border-t border-gray-100 dark:border-gray-800 divide-y divide-gray-50 dark:divide-gray-800">
                      {nonSoldes.map(l => {
                        const coche = selection.has(l.id);
                        return (
                          <label key={l.id} className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${coche ? 'bg-indigo-50 dark:bg-indigo-900/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                            <input type="checkbox" checked={coche} onChange={() => toggleVersementSelection(l.id)} className="rounded shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{l.nomConfig}</p>
                              <p className="text-xs text-gray-400">{formatDate(l.dateDebut)}</p>
                            </div>
                            <span className="text-xs font-bold text-red-500 shrink-0">{formatMontant(l.reste)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              <div className="shrink-0">
                <p className="text-xs text-gray-400 mb-3">Réparti du plus ancien au plus récent.</p>
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Montant à verser</p>
                <input
                  type="text"
                  value={montantInput}
                  onChange={e => {
                    const raw = e.target.value.replace(/[\s ]/g, '');
                    const num = parseInt(raw, 10);
                    setMontantInput(isNaN(num) ? '' : Math.min(num, detteSelection).toLocaleString('fr-FR'));
                  }}
                  placeholder={`Max. ${formatMontant(detteSelection)}`}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <div className="flex gap-2">
                  <button onClick={() => { setModalVersement(false); setSelection(new Set()); setMontantInput(''); }}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Annuler</button>
                  <button onClick={effectuerVersement} disabled={saving || parseMontant(montantInput) <= 0 || selection.size === 0}
                    className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50">
                    {saving ? 'En cours…' : 'Confirmer'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
