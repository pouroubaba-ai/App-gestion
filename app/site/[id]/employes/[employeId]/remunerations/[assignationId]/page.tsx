'use client';
import { useEffect, useState, useMemo } from 'react';
import {
  doc, getDoc, updateDoc, addDoc, collection, query,
  where, getDocs, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { ArrowLeft, Loader2, Clock, CheckCircle, Pencil, X, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

interface AssignationRemuneration {
  id: string; configId: string; nomConfig: string; valeur: number;
  intervalleJours: number; employeId: string; dateDebut: string; actif: boolean;
}

interface LigneRemuneration {
  id: string; employeId: string; assignationId?: string;
  nomConfig: string; montant: number; verse: number; reste: number;
  dateDebut: string; dateFin: string; intervalleJours?: number;
  type: 'configure' | 'manuel'; createdAt?: any;
}

interface Versement {
  id: string; ligneId: string; montant: number; date: string;
  nomConfig: string;
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

function etatLigne(l: LigneRemuneration): { label: string; color: string; icon: React.ReactNode } {
  if (l.dateFin <= todayStr()) {
    return { label: 'Passé', color: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400', icon: <Clock size={12} /> };
  }
  return { label: 'En cours', color: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400', icon: <CheckCircle size={12} /> };
}

function statutLigne(l: LigneRemuneration): { label: string; color: string } {
  if (l.reste <= 0) return { label: 'Soldé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  if (l.verse > 0)  return { label: 'Partiel', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  return { label: 'Non soldé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
}

function parseMontant(s: string): number {
  return parseInt(s.replace(/[\s ]/g, ''), 10) || 0;
}

export default function FicheRemunerationPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const siteId = params.id as string;
  const employeId = params.employeId as string;
  const assignationId = params.assignationId as string;

  const [assignation, setAssignation] = useState<AssignationRemuneration | null>(null);
  const [nomEmploye, setNomEmploye] = useState('');
  const [lignes, setLignes] = useState<LigneRemuneration[]>([]);
  const [versements, setVersements] = useState<Versement[]>([]);
  const [loading, setLoading] = useState(true);
  const [onglet, setOnglet] = useState<'instances' | 'versements'>('instances');

  /* sélection */
  const [selection, setSelection] = useState<Set<string>>(new Set());

  /* modal versement (sur sélection ou ligne cliquée) */
  const [modalVersement, setModalVersement] = useState<'selection' | null>(null);
  const [montantVersement, setMontantVersement] = useState('');
  const [savingVersement, setSavingVersement] = useState(false);

  /* filtre + tri instances */
  const [filtreStatut, setFiltreStatut] = useState<'tous' | 'solde' | 'partiel' | 'non_solde'>('tous');
  type ColTri = 'montant' | 'verse' | 'reste';
  const [colTri, setColTri] = useState<ColTri | null>(null);
  const [triDir, setTriDir] = useState<'asc' | 'desc'>('asc');

  /* recherche versements */
  const [rechJour, setRechJour] = useState('');
  const [rechMois, setRechMois] = useState('');
  const [rechAnnee, setRechAnnee] = useState('');

  /* modal édition config */
  const [modalEdit, setModalEdit] = useState(false);
  const [editValeur, setEditValeur] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => { if (user) charger(); }, [assignationId, user]);

  async function charger() {
    setLoading(true);
    try {
      const aSnap = await getDoc(doc(db, 'employe_rem_assignations', assignationId));
      if (!aSnap.exists()) { router.back(); return; }
      const a = { id: aSnap.id, ...aSnap.data() } as AssignationRemuneration;
      setAssignation(a);

      const eSnap = await getDoc(doc(db, 'employes', employeId));
      if (eSnap.exists()) setNomEmploye((eSnap.data() as any).nom || '');

      const lSnap = await getDocs(query(
        collection(db, 'employe_remunerations'),
        where('assignationId', '==', assignationId),
        where('employeId', '==', employeId),
      ));
      const ls = lSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as LigneRemuneration))
        .sort((a, b) => b.dateDebut.localeCompare(a.dateDebut));
      setLignes(ls);

      const vSnap = await getDocs(query(
        collection(db, 'employe_versements'),
        where('assignationId', '==', assignationId),
        where('employeId', '==', employeId),
      ));
      const vs = vSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as Versement))
        .sort((a, b) => b.date.localeCompare(a.date));
      setVersements(vs);
    } finally {
      setLoading(false);
    }
  }

  function toggleSelection(id: string) {
    setSelection(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  /* dette des lignes sélectionnées (ou toutes si rien sélectionné) */
  const lignesCiblees = useMemo(() => {
    const nonSoldees = lignes.filter(l => l.reste > 0);
    if (selection.size === 0) return nonSoldees;
    return nonSoldees.filter(l => selection.has(l.id));
  }, [lignes, selection]);

  const detteSelectionnee = useMemo(() => lignesCiblees.reduce((s, l) => s + l.reste, 0), [lignesCiblees]);

  async function effectuerVersement() {
    if (!user || !assignation) return;
    const montant = parseMontant(montantVersement);
    if (montant <= 0 || montant > detteSelectionnee) return;
    setSavingVersement(true);
    try {
      const cibles = [...lignesCiblees].sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
      let restant = montant;
      const mises: LigneRemuneration[] = [];
      for (const ligne of cibles) {
        if (restant <= 0) break;
        const appliquer = Math.min(restant, ligne.reste);
        const nouvelleVerse = ligne.verse + appliquer;
        const nouveauReste = ligne.montant - nouvelleVerse;
        await updateDoc(doc(db, 'employe_remunerations', ligne.id), { verse: nouvelleVerse, reste: nouveauReste });
        await addDoc(collection(db, 'employe_versements'), {
          ligneId: ligne.id, assignationId, employeId, siteId,
          userId: user.uid, nomConfig: assignation.nomConfig,
          montant: appliquer, date: todayStr(),
          ligneType: 'configure',
          ligneNom: assignation.nomConfig,
          ligneDate: ligne.dateDebut,
          ligneDateFin: ligne.dateFin,
          createdAt: serverTimestamp(),
        });
        mises.push({ ...ligne, verse: nouvelleVerse, reste: nouveauReste });
        restant -= appliquer;
      }
      setLignes(prev => prev.map(l => mises.find(m => m.id === l.id) ?? l));
      setSelection(new Set());
      setModalVersement(null);
      setMontantVersement('');
      await charger();
    } finally {
      setSavingVersement(false);
    }
  }

  async function sauvegarderConfig() {
    if (!assignation) return;
    const valeur = parseMontant(editValeur);
    if (!valeur) return;
    setSavingEdit(true);
    try {
      await updateDoc(doc(db, 'employe_rem_assignations', assignationId), { valeur });
      setAssignation(prev => prev ? { ...prev, valeur } : prev);
      setModalEdit(false);
    } finally {
      setSavingEdit(false);
    }
  }

  const totalDu    = useMemo(() => lignes.reduce((s, l) => s + l.montant, 0), [lignes]);
  const totalVerse = useMemo(() => lignes.reduce((s, l) => s + l.verse, 0), [lignes]);
  const totalReste = useMemo(() => lignes.reduce((s, l) => s + l.reste, 0), [lignes]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="animate-spin text-indigo-500" size={32} />
      </div>
    );
  }

  if (!assignation) return null;

  const lignesNonSoldees = lignes.filter(l => l.reste > 0);

  return (
    <div className="w-full p-4 sm:p-6 lg:p-8 space-y-6">

      {/* navigation */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()}
          className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div>
          <p className="text-sm text-gray-400">{nomEmploye}</p>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{assignation.nomConfig}</h1>
        </div>
      </div>

      {/* carte config */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-5 shadow-sm border border-gray-100 dark:border-gray-800">
        <div className="flex items-start justify-between mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Configuration</p>
          <button onClick={() => { setEditValeur(assignation.valeur.toLocaleString('fr-FR')); setModalEdit(true); }}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 transition-colors">
            <Pencil size={15} />
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-gray-400 mb-1">Valeur</p>
            <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{formatMontant(assignation.valeur)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Période</p>
            <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{assignation.intervalleJours} j</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Depuis</p>
            <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{formatDate(assignation.dateDebut)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">État</p>
            <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${assignation.actif ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
              {assignation.actif ? 'Actif' : 'Inactif'}
            </span>
          </div>
        </div>
        <div className="mt-5 pt-5 border-t border-gray-100 dark:border-gray-800 grid grid-cols-3 gap-4">
          <div className="text-center">
            <p className="text-xs text-gray-400 mb-1">Total dû</p>
            <p className="text-base font-bold text-gray-900 dark:text-gray-100">{formatMontant(totalDu)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-400 mb-1">Total versé</p>
            <p className="text-base font-bold text-green-600 dark:text-green-400">{formatMontant(totalVerse)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-400 mb-1">Reste</p>
            <p className="text-base font-bold text-red-500 dark:text-red-400">{formatMontant(totalReste)}</p>
          </div>
        </div>
      </div>

      {/* onglets */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm">
        <div className="flex border-b border-gray-100 dark:border-gray-800">
          {(['instances', 'versements'] as const).map(o => (
            <button key={o} onClick={() => setOnglet(o)}
              className={`px-5 py-3 text-sm font-semibold transition-colors border-b-2 -mb-px ${onglet === o ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              {o === 'instances' ? 'Instances' : 'Versements'}
              <span className="ml-1.5 text-xs text-gray-400">({o === 'instances' ? lignes.length : versements.length})</span>
            </button>
          ))}
        </div>

        {/* bouton versement */}
        {onglet === 'instances' && lignesNonSoldees.length > 0 && (
          <div className="flex justify-end px-5 pt-4">
            <button onClick={() => { setModalVersement('selection'); setMontantVersement(''); setSelection(new Set(lignesNonSoldees.map(l => l.id))); }}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 transition-colors">
              Versement
            </button>
          </div>
        )}

        {/* onglet instances */}
        {onglet === 'instances' && (() => {
          const STATUTS = [
            { key: 'tous' as const, label: 'Tous' },
            { key: 'non_solde' as const, label: 'Non soldé' },
            { key: 'partiel' as const, label: 'Partiel' },
            { key: 'solde' as const, label: 'Soldé' },
          ];
          const lignesFiltr = lignes.filter(l => {
            const s = statutLigne(l).label;
            if (filtreStatut === 'solde' && s !== 'Soldé') return false;
            if (filtreStatut === 'partiel' && s !== 'Partiel') return false;
            if (filtreStatut === 'non_solde' && s !== 'Non soldé') return false;
            return true;
          });
          const lignesTriees = colTri
            ? [...lignesFiltr].sort((a, b) => {
                const diff = colTri === 'montant' ? a.montant - b.montant : colTri === 'verse' ? a.verse - b.verse : a.reste - b.reste;
                return triDir === 'asc' ? diff : -diff;
              })
            : lignesFiltr;
          function toggleTri(col: ColTri) {
            if (colTri === col) setTriDir(d => d === 'asc' ? 'desc' : 'asc');
            else { setColTri(col); setTriDir('asc'); }
          }
          function IcTri({ col }: { col: ColTri }) {
            if (colTri !== col) return <ArrowUpDown size={11} className="inline ml-1 opacity-50" />;
            return triDir === 'asc' ? <ArrowUp size={11} className="inline ml-1" /> : <ArrowDown size={11} className="inline ml-1" />;
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
            {/* filtres statut */}
            <div className="flex gap-1 flex-wrap mb-3">
              {STATUTS.map(s => (
                <button key={s.key} onClick={() => setFiltreStatut(s.key)}
                  className={`px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-all ${filtreStatut === s.key ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-300'}`}>
                  {s.label} ({countStatut(s.key)})
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mb-3">{lignesTriees.length} instance{lignesTriees.length !== 1 ? 's' : ''}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-indigo-600 text-white text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-center px-4 py-3 font-medium">Rémunération</th>
                    <th className="text-center px-4 py-3 font-medium">Début</th>
                    <th className="text-center px-4 py-3 font-medium">Fin</th>
                    <th className="text-center px-4 py-3 font-medium">Période</th>
                    <th className="text-center px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleTri('montant')}>Dû <IcTri col="montant" /></th>
                    <th className="text-center px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleTri('verse')}>Versé <IcTri col="verse" /></th>
                    <th className="text-center px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleTri('reste')}>Reste <IcTri col="reste" /></th>
                    <th className="text-center px-4 py-3 font-medium">Statut</th>
                    <th className="text-center px-4 py-3 font-medium">État</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                  {lignesTriees.map(l => {
                    const statut = statutLigne(l);
                    const etat = etatLigne(l);
                    return (
                      <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                        <td className="px-4 py-3 text-center font-medium text-gray-900 dark:text-gray-100">{l.nomConfig}</td>
                        <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-400">{formatDate(l.dateDebut)}</td>
                        <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-400">{formatDate(l.dateFin)}</td>
                        <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-400">{l.intervalleJours ? `${l.intervalleJours} j` : '—'}</td>
                        <td className="px-4 py-3 text-center font-medium text-gray-900 dark:text-gray-100">{formatMontant(l.montant)}</td>
                        <td className="px-4 py-3 text-center text-green-600 dark:text-green-400">{formatMontant(l.verse)}</td>
                        <td className="px-4 py-3 text-center text-red-500 dark:text-red-400">{formatMontant(l.reste)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${statut.color}`}>{statut.label}</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${etat.color}`}>
                            {etat.icon}{etat.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {lignesTriees.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400 text-sm">Aucune instance trouvée</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          );
        })()}

        {/* onglet versements */}
        {onglet === 'versements' && (() => {
          const versementsFiltres = versements.filter(v => {
            const dateRef = v.ligneDate ?? v.date;
            const [y, m, d] = (dateRef || '').split('-');
            if (rechAnnee && y !== rechAnnee) return false;
            if (rechMois && m !== rechMois.padStart(2, '0')) return false;
            if (rechJour && d !== rechJour.padStart(2, '0')) return false;
            return true;
          });
          return (
            <div className="p-4">
              <div className="flex flex-wrap gap-2 mb-3">
                <input type="number" placeholder="Jour" min={1} max={31} value={rechJour} onChange={e => setRechJour(e.target.value)}
                  className="w-20 px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <input type="number" placeholder="Mois" min={1} max={12} value={rechMois} onChange={e => setRechMois(e.target.value)}
                  className="w-20 px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <input type="number" placeholder="Année" min={2000} max={2100} value={rechAnnee} onChange={e => setRechAnnee(e.target.value)}
                  className="w-24 px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <p className="text-xs text-gray-400 mb-3">{versementsFiltres.length} versement{versementsFiltres.length !== 1 ? 's' : ''}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-indigo-600 text-white text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-center px-4 py-3 font-medium">Date versement</th>
                      <th className="text-center px-4 py-3 font-medium">Période instance</th>
                      <th className="text-center px-4 py-3 font-medium">Montant</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {versementsFiltres.map(v => (
                      <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                        <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-400">{formatDate(v.date)}</td>
                        <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-400 text-xs">
                          {v.ligneDate
                            ? v.ligneDateFin
                              ? `${formatDate(v.ligneDate)} → ${formatDate(v.ligneDateFin)}`
                              : formatDate(v.ligneDate)
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-center font-bold text-green-600 dark:text-green-400">{formatMontant(v.montant)}</td>
                      </tr>
                    ))}
                    {versementsFiltres.length === 0 && (
                      <tr><td colSpan={3} className="px-4 py-10 text-center text-gray-400 text-sm">Aucun versement trouvé</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </div>

      {/* modal versement */}
      {modalVersement && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-fit min-w-80 shadow-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">Versement</h3>
              <button onClick={() => setModalVersement(null)} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400">
                <X size={16} />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              {selection.size > 0
                ? `${selection.size} instance${selection.size > 1 ? 's' : ''} sélectionnée${selection.size > 1 ? 's' : ''} — `
                : 'Toute la dette — '}
              <span className="font-bold text-red-500">{formatMontant(detteSelectionnee)}</span>
            </p>
            <div className="mb-5">
              <label className="block text-xs font-medium text-gray-500 mb-1">Montant</label>
              <input
                type="text" inputMode="numeric" autoFocus
                value={montantVersement}
                onChange={e => {
                  const raw = parseMontant(e.target.value);
                  const capped = Math.min(raw, detteSelectionnee);
                  setMontantVersement(capped > 0 ? capped.toLocaleString('fr-FR') : '');
                }}
                placeholder={`Max ${formatMontant(detteSelectionnee)}`}
                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setModalVersement(null)}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
                Annuler
              </button>
              <button onClick={effectuerVersement} disabled={savingVersement || parseMontant(montantVersement) <= 0}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2">
                {savingVersement && <Loader2 size={14} className="animate-spin" />}
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* modal édition config */}
      {modalEdit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-fit min-w-80 shadow-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">Modifier la configuration</h3>
              <button onClick={() => setModalEdit(false)} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400">
                <X size={16} />
              </button>
            </div>
            <div className="space-y-3 mb-5">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Valeur</label>
                <input
                  type="text" inputMode="numeric"
                  value={editValeur}
                  onChange={e => {
                    const raw = parseMontant(e.target.value);
                    setEditValeur(raw > 0 ? raw.toLocaleString('fr-FR') : '');
                  }}
                  placeholder="Valeur"
                  className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Intervalle (jours)</label>
                <p className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
                  {assignation.intervalleJours} jour{assignation.intervalleJours > 1 ? 's' : ''} <span className="text-xs text-gray-400 dark:text-gray-500">(non modifiable)</span>
                </p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setModalEdit(false)}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
                Annuler
              </button>
              <button onClick={sauvegarderConfig} disabled={savingEdit || !editValeur}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2">
                {savingEdit && <Loader2 size={14} className="animate-spin" />}
                Sauvegarder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
