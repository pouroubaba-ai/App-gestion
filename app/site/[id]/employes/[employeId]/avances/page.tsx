'use client';
import { useEffect, useState } from 'react';
import {
  collection, query, where, getDocs, getDoc, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { joursRestants, montantParPrelevement, joursAvantSolde } from '@/lib/avances';
import { ArrowLeft, Loader2, Plus, X, Check, Pencil, Trash2, ChevronDown } from 'lucide-react';
import { ChampRecherche } from '@/components/Champs';

interface Avance {
  id: string;
  employeId: string;
  siteId: string;
  motif?: string;
  montant: number;
  verse: number;
  reste: number;
  date: string;
}

interface Prelevement {
  id: string;
  avanceId: string;
  montant: number;
  date: string;
  type: 'remuneration' | 'hors_remuneration';
  avanceMotif?: string;
  avanceDate?: string;
  sourceNom?: string;
  sourceDebut?: string;
  sourceFin?: string;
}

interface AvanceConfig {
  id: string;
  employeId: string;
  siteId: string;
  assignationId: string;
  nomConfig: string;
  mode: 'pourcentage' | 'valeur';
  valeur: number;
  actif: boolean;
}

interface Assignation {
  id: string;
  nomConfig: string;
  valeur: number;
  intervalleJours: number;
  actif: boolean;
}

interface LigneRemuneration {
  id: string;
  assignationId?: string;
  nomConfig: string;
  montant: number;
  verse: number;
  reste: number;
  dateDebut: string;
  dateFin: string;
  type: 'configure' | 'manuel';
}

function todayStr() { return new Date().toISOString().split('T')[0]; }

function formatDate(s?: string | null) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function parseMontant(s: string): number {
  return parseInt(s.replace(/[\s ]/g, ''), 10) || 0;
}

function statutAvance(a: Avance): { label: string; color: string } {
  if (a.reste <= 0) return { label: 'Soldée', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  if (a.verse > 0)  return { label: 'Partielle', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  return { label: 'Non prélevée', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
}

export default function AvancesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const siteId = params.id as string;
  const employeId = params.employeId as string;

  const [avances, setAvances] = useState<Avance[]>([]);
  const [prelevements, setPrelevements] = useState<Prelevement[]>([]);
  const [configs, setConfigs] = useState<AvanceConfig[]>([]);
  const [assignations, setAssignations] = useState<Assignation[]>([]);
  const [lignesRem, setLignesRem] = useState<LigneRemuneration[]>([]);
  const [nomEmploye, setNomEmploye] = useState('');
  const [loading, setLoading] = useState(true);
  const [onglet, setOnglet] = useState<'avances' | 'prelevements' | 'configuration'>('avances');

  const [rechNom, setRechNom] = useState('');
  const [jour, setJour] = useState('');
  const [mois, setMois] = useState('');
  const [annee, setAnnee] = useState('');

  /* modal nouvelle avance */
  const [modalAvance, setModalAvance] = useState(false);
  const [avMotif, setAvMotif] = useState('');
  const [avMontant, setAvMontant] = useState('');
  const [avDate, setAvDate] = useState(todayStr());
  const [savingAvance, setSavingAvance] = useState(false);

  /* modal prélèvement manuel */
  const [modalPrelev, setModalPrelev] = useState(false);
  const [prelevMontant, setPrelevMontant] = useState('');
  const [prelevSelection, setPrelevSelection] = useState<Set<string>>(new Set());
  const [listeDepliee, setListeDepliee] = useState(false);
  const [savingPrelev, setSavingPrelev] = useState(false);

  /* modal config */
  const [modalConfig, setModalConfig] = useState(false);
  const [editConfig, setEditConfig] = useState<AvanceConfig | null>(null);
  const [cfgAssignId, setCfgAssignId] = useState('');
  const [cfgMode, setCfgMode] = useState<'pourcentage' | 'valeur'>('valeur');
  const [cfgValeur, setCfgValeur] = useState('');
  const [cfgActif, setCfgActif] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [erreurConfig, setErreurConfig] = useState('');
  const [suppConfig, setSuppConfig] = useState<AvanceConfig | null>(null);

  useEffect(() => { if (user) charger(); }, [user, employeId]);

  async function charger() {
    setLoading(true);
    const [empSnap, avSnap, prSnap, cfgSnap, assignSnap, remSnap] = await Promise.all([
      getDoc(doc(db, 'employes', employeId)),
      getDocs(query(collection(db, 'employe_avances'), where('employeId', '==', employeId))),
      getDocs(query(collection(db, 'employe_prelevements'), where('employeId', '==', employeId))),
      getDocs(query(collection(db, 'employe_avance_configs'), where('employeId', '==', employeId))),
      getDocs(query(collection(db, 'employe_rem_assignations'), where('employeId', '==', employeId))),
      getDocs(query(collection(db, 'employe_remunerations'), where('employeId', '==', employeId))),
    ]);
    if (empSnap.exists()) setNomEmploye(empSnap.data().nom ?? '');
    setAvances(avSnap.docs.map(d => ({ id: d.id, ...d.data() } as Avance))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')));
    setPrelevements(prSnap.docs.map(d => ({ id: d.id, ...d.data() } as Prelevement))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')));
    setConfigs(cfgSnap.docs.map(d => ({ id: d.id, ...d.data() } as AvanceConfig)));
    setAssignations(assignSnap.docs.map(d => ({ id: d.id, ...d.data() } as Assignation)));
    setLignesRem(remSnap.docs.map(d => ({ id: d.id, ...d.data() } as LigneRemuneration)));
    setLoading(false);
  }

  const totalDu = avances.reduce((s, a) => s + (a.montant ?? 0), 0);
  const totalPreleve = avances.reduce((s, a) => s + (a.verse ?? 0), 0);
  const totalReste = Math.max(totalDu - totalPreleve, 0);

  /* Configs actives dont la rémunération source existe encore. */
  const configsActives = configs
    .map(c => ({ config: c, assign: assignations.find(a => a.id === c.assignationId) }))
    .filter((x): x is { config: AvanceConfig; assign: Assignation } => !!x.assign && x.config.actif);

  const joursSolde = joursAvantSolde(totalReste, configs, assignations, lignesRem);

  async function creerAvance() {
    const montant = parseMontant(avMontant);
    if (!montant || !avDate) return;
    setSavingAvance(true);
    const ref = await addDoc(collection(db, 'employe_avances'), {
      employeId, siteId, userId: user!.uid,
      motif: avMotif.trim(),
      montant, verse: 0, reste: montant,
      date: avDate,
      createdAt: serverTimestamp(),
    });
    setAvances(prev => [{
      id: ref.id, employeId, siteId, motif: avMotif.trim(),
      montant, verse: 0, reste: montant, date: avDate,
    }, ...prev].sort((a, b) => b.date.localeCompare(a.date)));
    setSavingAvance(false);
    setModalAvance(false);
    setAvMotif(''); setAvMontant(''); setAvDate(todayStr());
  }

  /** Prélèvement manuel : l'employé rembourse hors rémunération. */
  async function effectuerPrelevementManuel() {
    const montant = parseMontant(prelevMontant);
    if (!montant) return;
    setSavingPrelev(true);

    const cibles = avances
      .filter(a => prelevSelection.has(a.id) && a.reste > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    let restant = montant;
    const majAvances: Avance[] = [];
    const nouveaux: Prelevement[] = [];

    for (const av of cibles) {
      if (restant <= 0) break;
      const appliquer = Math.min(restant, av.reste);
      const nouveauVerse = av.verse + appliquer;
      const nouveauReste = av.reste - appliquer;
      await updateDoc(doc(db, 'employe_avances', av.id), { verse: nouveauVerse, reste: nouveauReste });
      const ref = await addDoc(collection(db, 'employe_prelevements'), {
        avanceId: av.id, employeId, siteId, userId: user!.uid,
        montant: appliquer,
        date: todayStr(),
        type: 'hors_remuneration',
        avanceMotif: av.motif ?? '',
        avanceDate: av.date,
        sourceNom: null, sourceDebut: null, sourceFin: null,
        createdAt: serverTimestamp(),
      });
      nouveaux.push({
        id: ref.id, avanceId: av.id, montant: appliquer, date: todayStr(),
        type: 'hors_remuneration', avanceMotif: av.motif ?? '', avanceDate: av.date,
      });
      majAvances.push({ ...av, verse: nouveauVerse, reste: nouveauReste });
      restant -= appliquer;
    }

    setAvances(prev => prev.map(a => majAvances.find(m => m.id === a.id) ?? a));
    setPrelevements(prev => [...nouveaux, ...prev].sort((a, b) => b.date.localeCompare(a.date)));
    setSavingPrelev(false);
    setModalPrelev(false);
    setPrelevMontant('');
    setPrelevSelection(new Set());
  }

  function ouvrirNouvelleConfig() {
    setEditConfig(null);
    setCfgAssignId(''); setCfgMode('valeur'); setCfgValeur(''); setCfgActif(true);
    setErreurConfig('');
    setModalConfig(true);
  }

  function ouvrirEditionConfig(c: AvanceConfig) {
    setEditConfig(c);
    setCfgAssignId(c.assignationId); setCfgMode(c.mode);
    setCfgValeur(String(c.valeur)); setCfgActif(c.actif);
    setErreurConfig('');
    setModalConfig(true);
  }

  async function sauvegarderConfig() {
    const assign = assignations.find(a => a.id === cfgAssignId);
    if (!assign) { setErreurConfig('Choisis une rémunération source.'); return; }
    const val = parseMontant(cfgValeur);
    if (!val) { setErreurConfig('Renseigne une valeur.'); return; }
    if (cfgMode === 'pourcentage' && val > 100) { setErreurConfig('Le pourcentage ne peut pas dépasser 100 %.'); return; }
    if (cfgMode === 'valeur' && val >= assign.valeur) {
      setErreurConfig(`La valeur doit être inférieure à ${formatMontant(assign.valeur)}.`);
      return;
    }
    if (!editConfig && configs.some(c => c.assignationId === cfgAssignId)) {
      setErreurConfig('Cette rémunération a déjà une configuration.');
      return;
    }
    setErreurConfig('');
    setSavingConfig(true);

    if (editConfig) {
      await updateDoc(doc(db, 'employe_avance_configs', editConfig.id), {
        assignationId: cfgAssignId, nomConfig: assign.nomConfig,
        mode: cfgMode, valeur: val, actif: cfgActif,
      });
      setConfigs(prev => prev.map(c => c.id === editConfig.id
        ? { ...c, assignationId: cfgAssignId, nomConfig: assign.nomConfig, mode: cfgMode, valeur: val, actif: cfgActif }
        : c));
    } else {
      const ref = await addDoc(collection(db, 'employe_avance_configs'), {
        employeId, siteId, userId: user!.uid,
        assignationId: cfgAssignId, nomConfig: assign.nomConfig,
        mode: cfgMode, valeur: val, actif: cfgActif,
        createdAt: serverTimestamp(),
      });
      setConfigs(prev => [...prev, {
        id: ref.id, employeId, siteId, assignationId: cfgAssignId,
        nomConfig: assign.nomConfig, mode: cfgMode, valeur: val, actif: cfgActif,
      }]);
    }
    setSavingConfig(false);
    setModalConfig(false);
  }

  async function supprimerConfig() {
    if (!suppConfig) return;
    await deleteDoc(doc(db, 'employe_avance_configs', suppConfig.id));
    setConfigs(prev => prev.filter(c => c.id !== suppConfig.id));
    setSuppConfig(null);
  }

  async function toggleConfig(c: AvanceConfig) {
    const nouvelEtat = !c.actif;
    await updateDoc(doc(db, 'employe_avance_configs', c.id), { actif: nouvelEtat });
    setConfigs(prev => prev.map(x => x.id === c.id ? { ...x, actif: nouvelEtat } : x));
  }

  /* La déconnexion vide l'utilisateur avant que la navigation aboutisse :
     tout ce qui lit son identifiant tomberait sur du vide. */
  if (!user) return null;

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

  const filtreActif = !!(rechNom || jour || mois || annee);
  const matchDate = (d?: string) => {
    if (!jour && !mois && !annee) return true;
    const [an, m, j] = (d ?? '').split('-');
    if (jour && j !== jour.padStart(2, '0')) return false;
    if (mois && m !== mois.padStart(2, '0')) return false;
    if (annee && an !== annee) return false;
    return true;
  };

  const avancesFiltrees = avances.filter(a =>
    (!rechNom.trim() || (a.motif ?? '').toLowerCase().includes(rechNom.toLowerCase())) && matchDate(a.date));

  const prelevementsFiltres = prelevements.filter(p =>
    (!rechNom.trim()
      || (p.avanceMotif ?? '').toLowerCase().includes(rechNom.toLowerCase())
      || (p.sourceNom ?? '').toLowerCase().includes(rechNom.toLowerCase()))
    && matchDate(p.date));

  const avancesNonSoldees = avances.filter(a => a.reste > 0).sort((a, b) => a.date.localeCompare(b.date));
  const detteSelection = avancesNonSoldees.filter(a => prelevSelection.has(a.id)).reduce((s, a) => s + a.reste, 0);
  const toutCoche = avancesNonSoldees.length > 0 && avancesNonSoldees.every(a => prelevSelection.has(a.id));

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
              <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">Avances</h1>
              <p className="text-xs text-gray-400">{nomEmploye} · {avances.length} avance{avances.length > 1 ? 's' : ''}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setPrelevMontant(''); setPrelevSelection(new Set(avancesNonSoldees.map(a => a.id))); setListeDepliee(false); setModalPrelev(true); }}
                disabled={totalReste <= 0}
                className="px-4 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:border-indigo-300 hover:text-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                Prélèvement manuel
              </button>
              <button onClick={() => { setAvMotif(''); setAvMontant(''); setAvDate(todayStr()); setModalAvance(true); }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors">
                <Plus size={14} /> Augmenter l'avance
              </button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Total avancé</p>
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{formatMontant(totalDu)}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Prélevé</p>
              <p className="text-sm font-bold text-green-600">{formatMontant(totalPreleve)}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-400 mb-0.5">Reste à prélever</p>
              <p className="text-sm font-bold text-red-500">{formatMontant(totalReste)}</p>
              {totalReste > 0 && (
                configsActives.length === 0
                  ? <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Aucun prélèvement actif</p>
                  : joursSolde !== null
                    ? <p className="text-xs text-gray-400 mt-1">Soldé dans <span className="font-medium text-gray-600 dark:text-gray-300">{joursSolde} jour{joursSolde > 1 ? 's' : ''}</span></p>
                    : null
              )}
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm">
          <div className="flex border-b border-gray-100 dark:border-gray-800">
            {(['avances', 'prelevements', 'configuration'] as const).map(o => (
              <button key={o} onClick={() => setOnglet(o)}
                className={`px-5 py-3 text-sm font-semibold transition-colors border-b-2 -mb-px ${onglet === o ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                {o === 'avances' ? 'Avances' : o === 'prelevements' ? 'Prélèvements' : 'Configuration'}
              </button>
            ))}
          </div>

          <div className="p-5">
            {onglet !== 'configuration' && (
              <div className="flex flex-wrap gap-2 mb-4">
                <ChampRecherche placeholder="Rechercher…" valeur={rechNom} onChange={setRechNom} className="flex-1 min-w-[180px]" />
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
            )}

            {onglet === 'avances' && (
              avancesFiltrees.length === 0
                ? <p className="text-xs text-gray-400 text-center py-8">{avances.length === 0 ? 'Aucune avance enregistrée' : 'Aucun résultat'}</p>
                : (
                  <>
                    <p className="text-xs text-gray-400 mb-2">{avancesFiltrees.length} avance{avancesFiltrees.length > 1 ? 's' : ''}</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm whitespace-nowrap">
                        <thead>
                          <tr className="bg-indigo-600 text-white">
                            <th className="text-center px-3 py-2.5 font-medium">Motif</th>
                            <th className="text-center px-3 py-2.5 font-medium">Date</th>
                            <th className="text-center px-3 py-2.5 font-medium">Montant</th>
                            <th className="text-center px-3 py-2.5 font-medium">Prélevé</th>
                            <th className="text-center px-3 py-2.5 font-medium">Reste</th>
                            <th className="text-center px-3 py-2.5 font-medium">Statut</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                          {avancesFiltrees.map(a => {
                            const s = statutAvance(a);
                            return (
                              <tr key={a.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                                <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{a.motif || '—'}</td>
                                <td className="px-3 py-2.5 text-gray-500 text-center">{formatDate(a.date)}</td>
                                <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(a.montant)}</td>
                                <td className="px-3 py-2.5 text-green-600 font-medium text-center">{a.verse > 0 ? formatMontant(a.verse) : '—'}</td>
                                <td className="px-3 py-2.5 text-red-500 font-medium text-center">{formatMontant(a.reste)}</td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.color}`}>{s.label}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
            )}

            {onglet === 'prelevements' && (
              prelevementsFiltres.length === 0
                ? <p className="text-xs text-gray-400 text-center py-8">{prelevements.length === 0 ? 'Aucun prélèvement effectué' : 'Aucun résultat'}</p>
                : (
                  <>
                    <p className="text-xs text-gray-400 mb-2">{prelevementsFiltres.length} prélèvement{prelevementsFiltres.length > 1 ? 's' : ''}</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm whitespace-nowrap">
                        <thead>
                          <tr className="bg-indigo-600 text-white">
                            <th className="text-center px-3 py-2.5 font-medium">Avance</th>
                            <th className="text-center px-3 py-2.5 font-medium">Type</th>
                            <th className="text-center px-3 py-2.5 font-medium">Source</th>
                            <th className="text-center px-3 py-2.5 font-medium">Période source</th>
                            <th className="text-center px-3 py-2.5 font-medium">Date prélèvement</th>
                            <th className="text-center px-3 py-2.5 font-medium">Montant</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                          {prelevementsFiltres.map(p => (
                            <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                              <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{p.avanceMotif || '—'}</td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${p.type === 'remuneration'
                                  ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400'
                                  : 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'}`}>
                                  {p.type === 'remuneration' ? 'Rémunération' : 'Hors rémunération'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-gray-500 text-center">{p.sourceNom || '—'}</td>
                              <td className="px-3 py-2.5 text-gray-500 text-center">
                                {p.sourceDebut && p.sourceFin ? `${formatDate(p.sourceDebut)} → ${formatDate(p.sourceFin)}` : '—'}
                              </td>
                              <td className="px-3 py-2.5 text-gray-500 text-center">{formatDate(p.date)}</td>
                              <td className="px-3 py-2.5 text-green-600 font-bold text-center">{formatMontant(p.montant)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
            )}

            {onglet === 'configuration' && (
              <>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-gray-400">
                    {configs.length === 0 ? 'Aucune configuration' : `${configs.length} configuration${configs.length > 1 ? 's' : ''}`}
                  </p>
                  <button onClick={ouvrirNouvelleConfig}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
                    <Plus size={12} /> Nouvelle configuration
                  </button>
                </div>
                {totalReste > 0 && configsActives.length === 0 && (
                  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-xl px-3 py-2.5 mb-3">
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {configs.length === 0
                        ? `Il reste ${formatMontant(totalReste)} à prélever, mais aucun prélèvement automatique n'est configuré.`
                        : `Il reste ${formatMontant(totalReste)} à prélever, mais aucune configuration n'est active.`}
                    </p>
                  </div>
                )}
                {configs.length === 0
                  ? <p className="text-xs text-gray-400 text-center py-8">Configure un prélèvement automatique sur une rémunération.</p>
                  : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm whitespace-nowrap">
                        <thead>
                          <tr className="bg-indigo-600 text-white">
                            <th className="text-center px-3 py-2.5 font-medium">Rémunération source</th>
                            <th className="text-center px-3 py-2.5 font-medium">Prélèvement</th>
                            <th className="text-center px-3 py-2.5 font-medium">Montant / échéance</th>
                            <th className="text-center px-3 py-2.5 font-medium">Prochain prélèvement</th>
                            <th className="text-center px-3 py-2.5 font-medium">État</th>
                            <th className="px-3 py-2.5 text-center"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                          {configs.map(c => {
                            const assign = assignations.find(a => a.id === c.assignationId);
                            const parEcheance = assign ? montantParPrelevement(c, assign) : 0;

                            /* prochaine échéance = fin de la dernière instance générée pour cette assignation */
                            const instances = lignesRem
                              .filter(l => l.assignationId === c.assignationId)
                              .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
                            const derniere = instances[instances.length - 1];
                            const jrProchain = derniere ? joursRestants(derniere.dateFin) : null;

                            return (
                              <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                                <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">
                                  {c.nomConfig}
                                  {assign && <span className="text-xs font-normal text-gray-400 ml-1.5">{formatMontant(assign.valeur)} / {assign.intervalleJours}j</span>}
                                </td>
                                <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">
                                  {c.mode === 'pourcentage' ? `${c.valeur} %` : formatMontant(c.valeur)}
                                </td>
                                <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(parEcheance)}</td>
                                <td className="px-3 py-2.5 text-center">
                                  {!c.actif || jrProchain === null
                                    ? <span className="text-gray-400">—</span>
                                    : jrProchain > 0
                                      ? <span className="text-indigo-500 font-medium">{jrProchain} jour{jrProchain > 1 ? 's' : ''}</span>
                                      : <span className="text-orange-500 font-medium">Échue</span>}
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  <button onClick={() => toggleConfig(c)}
                                    className={`px-2.5 py-1 rounded-full text-xs font-bold transition-colors ${c.actif
                                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-red-50 hover:text-red-500'
                                      : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 hover:bg-green-50 hover:text-green-600'}`}>
                                    {c.actif ? 'Actif' : 'Inactif'}
                                  </button>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  <div className="flex items-center gap-1.5">
                                    <button onClick={() => ouvrirEditionConfig(c)}
                                      className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors">
                                      <Pencil size={12} />
                                    </button>
                                    <button onClick={() => setSuppConfig(c)}
                                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </>
            )}
          </div>
        </div>

        {/* Modal nouvelle avance */}
        {modalAvance && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Augmenter l'avance</h2>
                <button onClick={() => setModalAvance(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Motif</p>
              <input type="text" placeholder="Ex. Frais médicaux…" value={avMotif} onChange={e => setAvMotif(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Montant <span className="text-red-400">*</span></p>
              <input type="number" placeholder="Ex. 100 000" value={avMontant} onChange={e => setAvMontant(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Date</p>
              <input type="date" value={avDate} onChange={e => setAvDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-5 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <div className="flex gap-3">
                <button onClick={() => setModalAvance(false)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={creerAvance} disabled={savingAvance || !avMontant || !avDate}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {savingAvance ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal prélèvement manuel */}
        {modalPrelev && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5 flex flex-col max-h-[85vh] min-h-0">
              <div className="flex items-center justify-between mb-4 shrink-0">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Prélèvement manuel</h2>
                <button onClick={() => setModalPrelev(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
              <p className="text-xs text-gray-400 mb-3 shrink-0">L&apos;employé rembourse hors rémunération.</p>

              <div className={`mb-3 rounded-xl border border-gray-100 dark:border-gray-800 ${listeDepliee ? 'flex flex-col min-h-0 flex-1' : 'shrink-0'}`}>
                <button onClick={() => setListeDepliee(v => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-xl transition-colors shrink-0">
                  <ChevronDown size={14} className={`text-gray-400 shrink-0 transition-transform ${listeDepliee ? '' : '-rotate-90'}`} />
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-300 flex-1">
                    Avances à rembourser
                    <span className="text-gray-400 font-normal ml-1.5">{prelevSelection.size}/{avancesNonSoldees.length}</span>
                  </span>
                  <span className="text-xs font-bold text-red-500 shrink-0">{formatMontant(detteSelection)}</span>
                </button>
                {listeDepliee && (
                  <>
                    <div className="flex justify-end px-3 pb-2 shrink-0">
                      <button onClick={() => setPrelevSelection(toutCoche ? new Set() : new Set(avancesNonSoldees.map(a => a.id)))}
                        className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">
                        {toutCoche ? 'Tout décocher' : 'Tout cocher'}
                      </button>
                    </div>
                    <div className="overflow-y-auto flex-1 min-h-0 border-t border-gray-100 dark:border-gray-800 divide-y divide-gray-50 dark:divide-gray-800">
                      {avancesNonSoldees.map(a => {
                        const coche = prelevSelection.has(a.id);
                        return (
                          <label key={a.id} className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${coche ? 'bg-indigo-50 dark:bg-indigo-900/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                            <input type="checkbox" checked={coche}
                              onChange={() => setPrelevSelection(prev => {
                                const s = new Set(prev);
                                s.has(a.id) ? s.delete(a.id) : s.add(a.id);
                                return s;
                              })}
                              className="rounded shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{a.motif || 'Avance'}</p>
                              <p className="text-xs text-gray-400">{formatDate(a.date)}</p>
                            </div>
                            <span className="text-xs font-bold text-red-500 shrink-0">{formatMontant(a.reste)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              <div className="shrink-0">
                <p className="text-xs text-gray-400 mb-3">Réparti de la plus ancienne à la plus récente.</p>
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Montant remboursé</p>
                <input type="text" inputMode="numeric" value={prelevMontant}
                  onChange={e => {
                    const raw = parseMontant(e.target.value);
                    setPrelevMontant(raw > 0 ? Math.min(raw, detteSelection).toLocaleString('fr-FR') : '');
                  }}
                  placeholder={`Max. ${formatMontant(detteSelection)}`}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <div className="flex gap-2">
                  <button onClick={() => setModalPrelev(false)}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300">Annuler</button>
                  <button onClick={effectuerPrelevementManuel} disabled={savingPrelev || parseMontant(prelevMontant) <= 0 || prelevSelection.size === 0}
                    className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50">
                    {savingPrelev ? 'En cours…' : 'Confirmer'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Modal configuration */}
        {modalConfig && (() => {
          const assignChoisie = assignations.find(a => a.id === cfgAssignId);
          const apercu = assignChoisie && cfgValeur
            ? montantParPrelevement({ mode: cfgMode, valeur: parseMontant(cfgValeur) }, assignChoisie)
            : 0;
          const dispo = assignations.filter(a => editConfig?.assignationId === a.id || !configs.some(c => c.assignationId === a.id));
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
              <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                    {editConfig ? 'Modifier la configuration' : 'Nouvelle configuration'}
                  </h2>
                  <button onClick={() => setModalConfig(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
                </div>

                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Rémunération source</p>
                <select value={cfgAssignId} onChange={e => { setCfgAssignId(e.target.value); setErreurConfig(''); }}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">Choisir…</option>
                  {dispo.map(a => (
                    <option key={a.id} value={a.id}>{a.nomConfig} — {formatMontant(a.valeur)} / {a.intervalleJours}j</option>
                  ))}
                </select>

                <p className="text-xs font-bold text-gray-400 uppercase mb-2">Mode de prélèvement</p>
                <div className="flex gap-2 mb-4">
                  <button type="button" onClick={() => { setCfgMode('valeur'); setErreurConfig(''); }}
                    className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${cfgMode === 'valeur' ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-indigo-700 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-500'}`}>
                    Valeur fixe
                  </button>
                  <button type="button" onClick={() => { setCfgMode('pourcentage'); setErreurConfig(''); }}
                    className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${cfgMode === 'pourcentage' ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-indigo-700 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-500'}`}>
                    Pourcentage
                  </button>
                </div>

                <p className="text-xs font-bold text-gray-400 uppercase mb-1">
                  {cfgMode === 'pourcentage' ? 'Pourcentage (%)' : 'Montant par échéance'}
                </p>
                <input type="number" value={cfgValeur} onChange={e => { setCfgValeur(e.target.value); setErreurConfig(''); }}
                  placeholder={cfgMode === 'pourcentage' ? 'Ex. 20' : 'Ex. 10 000'}
                  className={`w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${erreurConfig ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
                {erreurConfig
                  ? <p className="text-xs text-red-500 mb-3">{erreurConfig}</p>
                  : apercu > 0
                    ? <p className="text-xs text-gray-400 mb-3">Prélèvement de <span className="font-bold text-indigo-600">{formatMontant(apercu)}</span> à chaque échéance.</p>
                    : <div className="mb-3" />}

                <p className="text-xs font-bold text-gray-400 uppercase mb-2">État</p>
                <div className="flex gap-2 mb-4">
                  <button type="button" onClick={() => setCfgActif(true)}
                    className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${cfgActif ? 'bg-green-50 dark:bg-green-900/20 border-green-400 text-green-700 dark:text-green-400' : 'border-gray-200 dark:border-gray-700 text-gray-500'}`}>
                    Actif
                  </button>
                  <button type="button" onClick={() => setCfgActif(false)}
                    className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${!cfgActif ? 'bg-gray-100 dark:bg-gray-800 border-gray-400 text-gray-700 dark:text-gray-300' : 'border-gray-200 dark:border-gray-700 text-gray-500'}`}>
                    Inactif
                  </button>
                </div>

                {cfgActif && (
                  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-xl px-3 py-2.5 mb-4">
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      Le prélèvement s&apos;applique automatiquement dès qu&apos;une nouvelle instance de cette rémunération est générée.
                    </p>
                  </div>
                )}

                <div className="flex gap-3">
                  <button onClick={() => setModalConfig(false)}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                  <button onClick={sauvegarderConfig} disabled={savingConfig || !cfgAssignId || !cfgValeur}
                    className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                    {savingConfig ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Modal suppression config */}
        {suppConfig && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center mb-4">
                <Trash2 size={18} className="text-red-500" />
              </div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2">Supprimer cette configuration ?</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                Le prélèvement automatique sur &ldquo;{suppConfig.nomConfig}&rdquo; sera supprimé. Les prélèvements déjà effectués ne sont pas affectés.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setSuppConfig(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={supprimerConfig}
                  className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  <Trash2 size={14} /> Supprimer
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
