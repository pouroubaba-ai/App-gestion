'use client';
import { useState } from 'react';
import { addDoc, deleteDoc, doc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatMontant } from '@/lib/format';
import { X, Plus, Check, ChevronDown, Trash2, Loader2 } from 'lucide-react';

export interface ConfigRem {
  id: string;
  nom: string;
  valeur: number;
  intervalleJours: number;
}

interface Props {
  siteId: string;
  userId: string;
  configs: ConfigRem[];
  /** IDs des configs déjà assignées à cet employé (pour bloquer re-assignation) */
  dejaAssignesIds?: string[];
  onClose: () => void;
  /** Appelé après confirmation : reçoit les valeurs choisies */
  onAssigner: (params: {
    configId: string;
    nomConfig: string;
    valeur: number;
    intervalleJours: number;
    actif: boolean;
  }) => void;
  /** Appelé quand un nouveau modèle est créé (pour mettre à jour la liste parente) */
  onConfigCree?: (config: ConfigRem) => void;
  /** Appelé quand un modèle est supprimé */
  onConfigSupprime?: (configId: string) => void;
  saving?: boolean;
}

export default function ModalAssignation({
  siteId, userId, configs: configsProp,
  dejaAssignesIds = [],
  onClose, onAssigner, onConfigCree, onConfigSupprime,
  saving = false,
}: Props) {
  const [configs, setConfigs] = useState<ConfigRem[]>(configsProp);

  /* sélection */
  const [configSelectId, setConfigSelectId] = useState('');
  const [assignValeur, setAssignValeur] = useState('');
  const [assignIntervalle, setAssignIntervalle] = useState('');
  const [assignActif, setAssignActif] = useState(true);
  const [showDropdown, setShowDropdown] = useState(false);
  const [rechercheModele, setRechercheModele] = useState('');

  /* suppression modèle */
  const [suppModele, setSuppModele] = useState<ConfigRem | null>(null);
  const [supprimant, setSupprimant] = useState(false);

  /* nouveau modèle */
  const [modalNouveau, setModalNouveau] = useState(false);
  const [nouveauNom, setNouveauNom] = useState('');
  const [nouvelleValeur, setNouvelleValeur] = useState('');
  const [nouvelIntervalle, setNouvelIntervalle] = useState('');
  const [savingNouveau, setSavingNouveau] = useState(false);
  const [erreurNouveau, setErreurNouveau] = useState('');

  async function creerModele() {
    const nom = nouveauNom.trim();
    const valeur = parseInt(nouvelleValeur);
    const intervalleJours = parseInt(nouvelIntervalle);
    if (!nom || !valeur || !intervalleJours) return;
    if (configs.some(c => c.nom.toLowerCase() === nom.toLowerCase())) {
      setErreurNouveau('Un modèle avec ce nom existe déjà.');
      return;
    }
    setSavingNouveau(true);
    const ref = await addDoc(collection(db, 'employe_rem_configs'), {
      siteId, userId, nom, valeur, intervalleJours, createdAt: serverTimestamp(),
    });
    const nouveau: ConfigRem = { id: ref.id, nom, valeur, intervalleJours };
    setConfigs(prev => [...prev, nouveau]);
    setConfigSelectId(ref.id);
    setAssignValeur(String(valeur));
    setAssignIntervalle(String(intervalleJours));
    onConfigCree?.(nouveau);
    setSavingNouveau(false);
    setNouveauNom(''); setNouvelleValeur(''); setNouvelIntervalle(''); setErreurNouveau('');
    setModalNouveau(false);
  }

  async function supprimerModele() {
    if (!suppModele) return;
    setSupprimant(true);
    await deleteDoc(doc(db, 'employe_rem_configs', suppModele.id));
    setConfigs(prev => prev.filter(c => c.id !== suppModele.id));
    if (configSelectId === suppModele.id) { setConfigSelectId(''); setAssignValeur(''); setAssignIntervalle(''); }
    onConfigSupprime?.(suppModele.id);
    setSupprimant(false);
    setSuppModele(null);
  }

  const configsFiltrees = configs.filter(c =>
    c.nom.toLowerCase().includes(rechercheModele.toLowerCase())
  );

  /* — Modal confirmation suppression — */
  if (suppModele) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
          <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center mb-4">
            <Trash2 size={18} className="text-red-500" />
          </div>
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2">Supprimer &ldquo;{suppModele.nom}&rdquo; ?</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">Ce modèle sera supprimé. Les assignations existantes ne sont pas affectées.</p>
          <div className="flex gap-3">
            <button onClick={() => setSuppModele(null)}
              className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
            <button onClick={supprimerModele} disabled={supprimant}
              className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
              {supprimant ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Supprimer
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* — Modal nouveau modèle — */
  if (modalNouveau) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouveau modèle</h2>
            <button onClick={() => setModalNouveau(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
          </div>
          <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom</p>
          <input type="text" placeholder="Ex. Salaire mensuel, Prime…" value={nouveauNom}
            onChange={e => { setNouveauNom(e.target.value); setErreurNouveau(''); }}
            className={`w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${erreurNouveau ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
          {erreurNouveau ? <p className="text-xs text-red-500 mb-3">{erreurNouveau}</p> : <div className="mb-3" />}
          <p className="text-xs font-bold text-gray-400 uppercase mb-1">Valeur</p>
          <input type="number" placeholder="Ex. 150 000" value={nouvelleValeur} onChange={e => setNouvelleValeur(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <p className="text-xs font-bold text-gray-400 uppercase mb-1">Intervalle (jours)</p>
          <input type="number" placeholder="Ex. 30" value={nouvelIntervalle} onChange={e => setNouvelIntervalle(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-5 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <div className="flex gap-3">
            <button onClick={() => setModalNouveau(false)}
              className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
            <button onClick={creerModele} disabled={savingNouveau || !nouveauNom.trim() || !nouvelleValeur || !nouvelIntervalle}
              className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
              {savingNouveau ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Créer
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* — Modal principal assignation — */
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Assigner une rémunération</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
        </div>

        <p className="text-xs font-bold text-gray-400 uppercase mb-2">Modèle</p>
        <div className="relative mb-4">
          <button type="button" onClick={() => setShowDropdown(v => !v)}
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-left flex items-center justify-between text-gray-900 dark:text-gray-100">
            <span className={configSelectId ? '' : 'text-gray-400'}>
              {configSelectId
                ? (() => { const c = configs.find(x => x.id === configSelectId); return c ? `${c.nom} — ${formatMontant(c.valeur)} / ${c.intervalleJours}j` : 'Modèle…'; })()
                : 'Choisir un modèle…'}
            </span>
            <ChevronDown size={14} className="text-gray-400 shrink-0" />
          </button>
          {showDropdown && (
            <div className="absolute z-20 w-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden">
              <div className="p-2 border-b border-gray-100 dark:border-gray-800">
                <input autoFocus type="text" placeholder="Rechercher…" value={rechercheModele}
                  onChange={e => setRechercheModele(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div className="max-h-40 overflow-y-auto">
                {configsFiltrees.length === 0
                  ? <p className="text-xs text-gray-400 px-4 py-3">Aucun modèle trouvé</p>
                  : configsFiltrees.map(c => {
                      const dejaAssigne = dejaAssignesIds.includes(c.id);
                      return (
                        <div key={c.id}
                          className={`flex items-center transition-colors ${dejaAssigne ? 'opacity-50 cursor-not-allowed' : configSelectId === c.id ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                          <button type="button"
                            disabled={dejaAssigne}
                            onClick={() => {
                              if (dejaAssigne) return;
                              setConfigSelectId(c.id);
                              setAssignValeur(String(c.valeur));
                              setAssignIntervalle(String(c.intervalleJours));
                              setShowDropdown(false);
                              setRechercheModele('');
                            }}
                            className={`flex-1 text-left px-4 py-2.5 text-sm ${dejaAssigne ? 'cursor-not-allowed' : ''} ${configSelectId === c.id ? 'text-indigo-700 dark:text-indigo-300 font-medium' : 'text-gray-700 dark:text-gray-300'}`}>
                            <span className="font-medium">{c.nom}</span>
                            <span className="text-gray-400 ml-2 text-xs">{formatMontant(c.valeur)} · {c.intervalleJours}j</span>
                            {dejaAssigne && <span className="ml-2 text-xs text-gray-400 italic">déjà assigné</span>}
                          </button>
                          <button type="button"
                            onClick={e => { e.stopPropagation(); setShowDropdown(false); setSuppModele(c); }}
                            className="p-2 pr-3 text-gray-400 hover:text-red-500 transition-colors">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      );
                    })
                }
              </div>
              <button type="button"
                onClick={() => {
                  setShowDropdown(false);
                  setRechercheModele('');
                  setNouveauNom(''); setNouvelleValeur(''); setNouvelIntervalle(''); setErreurNouveau('');
                  setModalNouveau(true);
                }}
                className="w-full text-left px-4 py-2.5 text-xs font-bold text-indigo-600 border-t border-gray-100 dark:border-gray-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 flex items-center gap-1.5">
                <Plus size={12} /> Créer un nouveau modèle
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Valeur</p>
            <input type="number" placeholder="Ex. 150 000" value={assignValeur} onChange={e => setAssignValeur(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Intervalle (jours)</p>
            <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400">
              {assignIntervalle ? `${assignIntervalle} jour${parseInt(assignIntervalle) > 1 ? 's' : ''}` : '—'}
            </p>
          </div>
        </div>

        <p className="text-xs font-bold text-gray-400 uppercase mb-2">État</p>
        <div className="flex gap-2 mb-4">
          <button type="button" onClick={() => setAssignActif(true)}
            className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${assignActif ? 'bg-green-50 dark:bg-green-900/20 border-green-400 text-green-700 dark:text-green-400' : 'border-gray-200 dark:border-gray-700 text-gray-500'}`}>
            Actif
          </button>
          <button type="button" onClick={() => setAssignActif(false)}
            className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${!assignActif ? 'bg-gray-100 dark:bg-gray-800 border-gray-400 text-gray-700 dark:text-gray-300' : 'border-gray-200 dark:border-gray-700 text-gray-500'}`}>
            Inactif
          </button>
        </div>

        {assignActif && (
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-xl px-3 py-2.5 mb-4">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              En enregistrant comme <span className="font-bold">Active</span>, une première instance sera créée automatiquement à partir d&apos;aujourd&apos;hui.
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <button type="button" onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
            Annuler
          </button>
          <button type="button"
            disabled={saving || !configSelectId || !assignValeur || !assignIntervalle}
            onClick={() => {
              const config = configs.find(c => c.id === configSelectId);
              if (!config) return;
              onAssigner({
                configId: config.id,
                nomConfig: config.nom,
                valeur: parseInt(assignValeur),
                intervalleJours: parseInt(assignIntervalle),
                actif: assignActif,
              });
            }}
            className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Assigner
          </button>
        </div>
      </div>
    </div>
  );
}
