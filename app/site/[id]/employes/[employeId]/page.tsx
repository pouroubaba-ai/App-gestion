'use client';
import { useEffect, useState, useMemo } from 'react';
import {
  doc, getDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, getDocs, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from '../../components/finance/font';
import { ArrowLeft, Loader2, Pencil, Trash2, Check, X, Calendar, Phone, Clock, Plus, Settings, ChevronDown } from 'lucide-react';
import ModalAssignation from '@/app/site/[id]/components/ModalAssignation';
import { ChampRecherche } from '@/components/Champs';

type EtatEmploye = 'actif' | 'inactif' | 'conge' | 'suspendu';

/** Seuls 'actif' et 'inactif' sont proposés ; les autres restent pour afficher d'anciens enregistrements. */
const ETATS: { key: EtatEmploye; label: string; color: string }[] = [
  { key: 'actif',    label: 'Actif',    color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  { key: 'inactif',  label: 'Inactif',  color: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
  { key: 'conge',    label: 'Congé',    color: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' },
  { key: 'suspendu', label: 'Suspendu', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' },
];

interface Employe {
  id: string; nom: string; fonction?: string; contact?: string;
  etat: EtatEmploye; remunerationConfiguree?: number; dateEmbauche?: string; siteId: string;
}

interface Stats {
  totalRemuneration: number; verseRemuneration: number; resteRemuneration: number;
  totalAvance: number; verseAvance: number; resteAvance: number;
}

interface ConfigRemuneration {
  id: string; nom: string; valeur: number; intervalleJours: number; siteId: string;
}

interface AssignationRemuneration {
  id: string; configId: string; nomConfig: string; valeur: number;
  intervalleJours: number; employeId: string; dateDebut: string; actif: boolean;
}

interface LigneRemuneration {
  id: string;
  employeId: string;
  assignationId?: string;   // undefined si manuel
  nomConfig: string;
  montant: number;
  verse: number;
  reste: number;
  dateDebut: string;        // début de la période
  dateFin: string;          // fin de la période = dateDebut + intervalleJours
  intervalleJours?: number;
  type: 'configure' | 'manuel';
  createdAt?: any;
}

interface Avance {
  id: string;
  employeId: string;
  siteId: string;
  motif?: string;
  montant: number;
  verse: number;
  reste: number;
  date: string;
  createdAt?: any;
}

interface AvanceConfig {
  id: string;
  assignationId: string;
  nomConfig: string;
  mode: 'pourcentage' | 'valeur';
  valeur: number;
  actif: boolean;
}

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

function todayStr() { return new Date().toISOString().split('T')[0]; }

function addJours(dateStr: string, jours: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + jours);
  return d.toISOString().split('T')[0];
}

function joursRestants(dateFin: string): number {
  const diff = new Date(dateFin).getTime() - new Date(todayStr()).getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function anciennete(dateEmbauche?: string): string {
  if (!dateEmbauche) return '—';
  const debut = new Date(dateEmbauche);
  const now = new Date();
  let annees = now.getFullYear() - debut.getFullYear();
  let mois = now.getMonth() - debut.getMonth();
  let jours = now.getDate() - debut.getDate();
  if (jours < 0) { mois--; jours += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); }
  if (mois < 0) { annees--; mois += 12; }
  const parts: string[] = [];
  if (annees > 0) parts.push(`${annees} an${annees > 1 ? 's' : ''}`);
  if (mois > 0)   parts.push(`${mois} mois`);
  if (parts.length === 0) parts.push(`${jours} jour${jours > 1 ? 's' : ''}`);
  return parts.join(' et ');
}

function statutLigne(l: LigneRemuneration): { label: string; color: string } {
  if (l.reste <= 0) return { label: 'Soldé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  if (l.verse > 0)  return { label: 'Partiel', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  return { label: 'Non soldé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
}

/* Génère les prochaines lignes manquantes pour une assignation.
   Règle : une nouvelle instance démarre quand dateFin de la dernière est <= aujourd'hui,
   peu importe si elle est soldée ou non. */
/**
 * Une génération à la fois, par employé.
 *
 * La fiche se charge deux fois — `user` s'initialise après le premier
 * rendu, et React monte deux fois en développement. Les deux passages
 * lisaient zéro ligne existante et créaient chacun la première
 * rémunération : l'employé devait 200 000 pour un salaire de 100 000.
 *
 * Le second appel retrouve ici la promesse du premier et l'attend, au
 * lieu de générer à son tour.
 */
const generationsEnCours = new Map<string, Promise<LigneRemuneration[]>>();

function genererLignesManquantes(
  assignation: AssignationRemuneration,
  lignesExistantes: LigneRemuneration[],
  employeId: string, siteId: string, userId: string,
  contexteAvance?: {
    config: AvanceConfig;
    avances: Avance[];
  },
): Promise<LigneRemuneration[]> {
  const cle = `${employeId}:${assignation.id}`;
  const enCours = generationsEnCours.get(cle);
  if (enCours) return enCours;
  const promesse = genererVraiment(
    assignation, lignesExistantes, employeId, siteId, userId, contexteAvance,
  ).finally(() => generationsEnCours.delete(cle));
  generationsEnCours.set(cle, promesse);
  return promesse;
}

async function genererVraiment(
  assignation: AssignationRemuneration,
  lignesExistantes: LigneRemuneration[],
  employeId: string, siteId: string, userId: string,
  contexteAvance?: {
    config: AvanceConfig;
    avances: Avance[];   // muté au fil des prélèvements pour suivre le reste
  },
): Promise<LigneRemuneration[]> {
  const today = todayStr();
  const lignesDeCetteConfig = lignesExistantes
    .filter(l => l.assignationId === assignation.id)
    .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));

  /* date de début de la prochaine instance */
  let prochainDebut: string;
  if (lignesDeCetteConfig.length === 0) {
    prochainDebut = assignation.dateDebut;
  } else {
    prochainDebut = lignesDeCetteConfig[lignesDeCetteConfig.length - 1].dateFin;
  }

  const nouvelles: LigneRemuneration[] = [];

  /* génère toutes les instances dont la date de début est <= aujourd'hui */
  while (prochainDebut <= today) {
    const dateFin = addJours(prochainDebut, assignation.intervalleJours);

    /* prélèvement d'avance appliqué dès la création de l'instance */
    let preleve = 0;
    if (contexteAvance) {
      const { config, avances } = contexteAvance;
      const souhaite = config.mode === 'pourcentage'
        ? Math.round(assignation.valeur * config.valeur / 100)
        : config.valeur;
      let restantAPrelever = Math.min(souhaite, assignation.valeur);

      for (const av of avances.filter(a => a.reste > 0).sort((a, b) => a.date.localeCompare(b.date))) {
        if (restantAPrelever <= 0) break;
        const appliquer = Math.min(restantAPrelever, av.reste);
        await updateDoc(doc(db, 'employe_avances', av.id), {
          verse: av.verse + appliquer, reste: av.reste - appliquer,
        });
        await addDoc(collection(db, 'employe_prelevements'), {
          avanceId: av.id, employeId, siteId, userId,
          montant: appliquer,
          date: prochainDebut,
          type: 'remuneration',
          avanceMotif: av.motif ?? '',
          avanceDate: av.date,
          sourceNom: assignation.nomConfig,
          sourceDebut: prochainDebut,
          sourceFin: dateFin,
          createdAt: serverTimestamp(),
        });
        av.verse += appliquer;
        av.reste -= appliquer;
        restantAPrelever -= appliquer;
        preleve += appliquer;
      }
    }

    const ref = await addDoc(collection(db, 'employe_remunerations'), {
      employeId, siteId, userId,
      assignationId: assignation.id,
      nomConfig: assignation.nomConfig,
      montant: assignation.valeur,
      verse: preleve,
      reste: assignation.valeur - preleve,
      dateDebut: prochainDebut,
      dateFin,
      intervalleJours: assignation.intervalleJours,
      type: 'configure',
      createdAt: serverTimestamp(),
    });
    nouvelles.push({
      id: ref.id, employeId, assignationId: assignation.id,
      nomConfig: assignation.nomConfig, montant: assignation.valeur,
      verse: preleve, reste: assignation.valeur - preleve,
      dateDebut: prochainDebut, dateFin, intervalleJours: assignation.intervalleJours, type: 'configure',
    });
    prochainDebut = dateFin;
  }
  return nouvelles;
}

export default function FicheEmployePage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  const employeId = params.employeId as string;

  /* On revient d'où l'on vient : la fiche s'ouvre depuis l'onglet d'un site
     ou depuis la vue d'ensemble, et renvoyer dans le site ferait changer
     d'écran sans l'avoir demandé. */
  const retourEmployes = searchParams.get('de') === 'ensemble'
    ? '/ensemble?onglet=employes'
    : `/site/${siteId}?onglet=employes`;

  const [employe, setEmploye] = useState<Employe | null>(null);
  const [stats, setStats] = useState<Stats>({ totalRemuneration: 0, verseRemuneration: 0, resteRemuneration: 0, totalAvance: 0, verseAvance: 0, resteAvance: 0 });
  const [lignesRem, setLignesRem] = useState<LigneRemuneration[]>([]);
  const [versements, setVersements] = useState<Versement[]>([]);
  const [avances, setAvances] = useState<Avance[]>([]);
  const [assignations, setAssignations] = useState<AssignationRemuneration[]>([]);
  const [configsDisponibles, setConfigsDisponibles] = useState<ConfigRemuneration[]>([]);
  const [loading, setLoading] = useState(true);

  /* édition */
  const [editing, setEditing] = useState(false);
  const [nomEdit, setNomEdit] = useState('');
  const [fonctionEdit, setFonctionEdit] = useState('');
  const [contactEdit, setContactEdit] = useState('');
  const [etatEdit, setEtatEdit] = useState<EtatEmploye>('actif');
  const [dateEmbauchEdit, setDateEmbauchEdit] = useState('');
  const [saving, setSaving] = useState(false);

  /* suppression */
  const [confirmSupp, setConfirmSupp] = useState(false);
  const [supprimant, setSupprimant] = useState(false);

  /* modal assignation */
  const [modalAssign, setModalAssign] = useState(false);
  const [savingAssign, setSavingAssign] = useState(false);

  /* modal ajout manuel */
  const [modalManuel, setModalManuel] = useState(false);
  const [manuelNom, setManuelNom] = useState('');
  const [manuelMontant, setManuelMontant] = useState('');
  const [manuelDateDebut, setManuelDateDebut] = useState(todayStr());
  const [savingManuel, setSavingManuel] = useState(false);

  useEffect(() => { if (user) charger(); }, [employeId, user]);

  async function charger() {
    setLoading(true);
    const [empSnap, remSnap, avSnap, assignSnap, configSnap, versSnap, avCfgSnap] = await Promise.all([
      getDoc(doc(db, 'employes', employeId)),
      getDocs(query(collection(db, 'employe_remunerations'), where('employeId', '==', employeId))),
      getDocs(query(collection(db, 'employe_avances'), where('employeId', '==', employeId))),
      getDocs(query(collection(db, 'employe_rem_assignations'), where('employeId', '==', employeId))),
      getDocs(query(collection(db, 'employe_rem_configs'), where('siteId', '==', siteId))),
      getDocs(query(collection(db, 'employe_versements'), where('employeId', '==', employeId))),
      getDocs(query(collection(db, 'employe_avance_configs'), where('employeId', '==', employeId))),
    ]);

    if (!empSnap.exists()) { setLoading(false); return; }
    const emp = { id: empSnap.id, ...empSnap.data() } as Employe;
    setEmploye(emp);

    let lignes = remSnap.docs.map(d => ({ id: d.id, ...d.data() } as LigneRemuneration));
    const assigns = assignSnap.docs.map(d => ({ id: d.id, ...d.data() } as AssignationRemuneration));
    const configs = configSnap.docs.map(d => ({ id: d.id, ...d.data() } as ConfigRemuneration));

    setAssignations(assigns);
    setConfigsDisponibles(configs);

    /* avances : mutées par la génération quand un prélèvement s'applique */
    const listeAvances = avSnap.docs
      .map(d => ({ id: d.id, ...d.data() } as Avance))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const avanceConfigs = avCfgSnap.docs.map(d => ({ id: d.id, ...d.data() } as AvanceConfig));

    /* auto-génération si actif */
    if (emp.etat === 'actif') {
      for (const assign of assigns.filter(a => a.actif)) {
        const cfgAvance = avanceConfigs.find(c => c.actif && c.assignationId === assign.id);
        const nouvelles = await genererLignesManquantes(
          assign, lignes, employeId, siteId, user!.uid,
          cfgAvance ? { config: cfgAvance, avances: listeAvances } : undefined,
        );
        lignes = [...lignes, ...nouvelles];
      }
    }

    setLignesRem(lignes);
    setVersements(
      versSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as Versement))
        .sort((a, b) => b.date.localeCompare(a.date))
    );

    setAvances(listeAvances);

    const totalRem = lignes.reduce((s, d) => s + (d.montant ?? 0), 0);
    const verseRem = lignes.reduce((s, d) => s + (d.verse ?? 0), 0);
    const totalAv  = listeAvances.reduce((s, a) => s + (a.montant ?? 0), 0);
    const verseAv  = listeAvances.reduce((s, a) => s + (a.verse ?? 0), 0);
    setStats({
      totalRemuneration: totalRem, verseRemuneration: verseRem, resteRemuneration: Math.max(totalRem - verseRem, 0),
      totalAvance: totalAv, verseAvance: verseAv, resteAvance: Math.max(totalAv - verseAv, 0),
    });
    setLoading(false);
  }

  /* valeur mensuelle totale des configs actives (ramène chaque config à 30j) */
  const valeurMensuelle = useMemo(() => {
    return assignations
      .filter(a => a.actif)
      .reduce((sum, a) => sum + (a.valeur / a.intervalleJours) * 30, 0);
  }, [assignations]);

  const nbActifs   = assignations.filter(a => a.actif).length;
  const nbInactifs = assignations.filter(a => !a.actif).length;
  const nbConfigs  = assignations.length;

  /* modal configs */
  const [modalConfigs, setModalConfigs] = useState(false);

  /* édition modèle */
  const [editConfig, setEditConfig] = useState<ConfigRemuneration | null>(null);
  const [editConfigNom, setEditConfigNom] = useState('');
  const [editConfigValeur, setEditConfigValeur] = useState('');
  const [savingEditConfig, setSavingEditConfig] = useState(false);
  const [editConfigErreur, setEditConfigErreur] = useState('');

  /* suppression modèle */
  const [suppConfig, setSuppConfig] = useState<ConfigRemuneration | null>(null);
  const [supprimantConfig, setSupprimantConfig] = useState(false);


  /* confirmation toggle assignation */
  const [confirmToggle, setConfirmToggle] = useState<AssignationRemuneration | null>(null);
  const [togglingAssign, setTogglingAssign] = useState(false);

  /* édition assignation */
  const [editAssign, setEditAssign] = useState<AssignationRemuneration | null>(null);
  const [editAssignValeur, setEditAssignValeur] = useState('');
  const [savingEditAssign, setSavingEditAssign] = useState(false);

  /* suppression assignation */
  const [suppAssign, setSuppAssign] = useState<AssignationRemuneration | null>(null);
  const [supprimantAssign, setSupprimantAssign] = useState(false);

  async function sauvegarderEditConfig() {
    if (!editConfig || !editConfigNom.trim() || !editConfigValeur) return;
    const nomTrimmed = editConfigNom.trim();
    if (configsDisponibles.some(c => c.id !== editConfig.id && c.nom.toLowerCase() === nomTrimmed.toLowerCase())) {
      setEditConfigErreur('Un modèle avec ce nom existe déjà.');
      return;
    }
    setEditConfigErreur('');
    setSavingEditConfig(true);
    const valeur = parseFloat(editConfigValeur);
    await updateDoc(doc(db, 'employe_rem_configs', editConfig.id), { nom: nomTrimmed, valeur });
    setConfigsDisponibles(prev => prev.map(c => c.id === editConfig.id ? { ...c, nom: nomTrimmed, valeur } : c));
    setSavingEditConfig(false);
    setEditConfig(null);
  }

  async function supprimerConfig() {
    if (!suppConfig) return;
    setSupprimantConfig(true);
    await deleteDoc(doc(db, 'employe_rem_configs', suppConfig.id));
    setConfigsDisponibles(prev => prev.filter(c => c.id !== suppConfig.id));
    setSupprimantConfig(false);
    setSuppConfig(null);
  }

  function versementCibles(): LigneRemuneration[] {
    return [...lignesRem]
      .filter(l => versementSelection.has(l.id) && l.reste > 0)
      .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
  }

  function totalDetteSelection(): number {
    return versementCibles().reduce((s, l) => s + l.reste, 0);
  }

  async function effectuerVersement() {
    const montant = parseInt(montantVersement || '0', 10);
    if (!montant || montant <= 0) return;
    setSavingVersement(true);

    const cibles = versementCibles();
    let restant = montant;
    const mises: LigneRemuneration[] = [];
    const nouveauxVersements: Versement[] = [];

    for (const ligne of cibles) {
      if (restant <= 0) break;
      const appliquer = Math.min(restant, ligne.reste);
      const nouvelleVerse = ligne.verse + appliquer;
      const nouveauReste = ligne.reste - appliquer;
      await updateDoc(doc(db, 'employe_remunerations', ligne.id), { verse: nouvelleVerse, reste: nouveauReste });
      const ref = await addDoc(collection(db, 'employe_versements'), {
        ligneId: ligne.id, assignationId: ligne.assignationId ?? null,
        employeId, siteId, userId: user!.uid,
        nomConfig: ligne.nomConfig, montant: appliquer,
        date: todayStr(),
        ligneType: ligne.type,
        ligneNom: ligne.nomConfig,
        ligneDate: ligne.dateDebut,
        ligneDateFin: ligne.type === 'configure' ? ligne.dateFin : null,
        createdAt: serverTimestamp(),
      });
      nouveauxVersements.push({
        id: ref.id, ligneId: ligne.id, montant: appliquer, date: todayStr(),
        nomConfig: ligne.nomConfig, ligneType: ligne.type, ligneNom: ligne.nomConfig,
        ligneDate: ligne.dateDebut,
        ligneDateFin: ligne.type === 'configure' ? ligne.dateFin : null,
      });
      mises.push({ ...ligne, verse: nouvelleVerse, reste: nouveauReste });
      restant -= appliquer;
    }

    setLignesRem(prev => prev.map(l => { const m = mises.find(x => x.id === l.id); return m ?? l; }));
    setVersements(prev => [...nouveauxVersements, ...prev].sort((a, b) => b.date.localeCompare(a.date)));
    setStats(prev => ({
      ...prev,
      verseRemuneration: prev.verseRemuneration + montant,
      resteRemuneration: Math.max(prev.resteRemuneration - montant, 0),
    }));
    setSavingVersement(false);
    setModalVersement(false);
    setMontantVersement('');
    setVersementSelection(new Set());
  }

  async function confirmerToggle() {
    if (!confirmToggle) return;
    setTogglingAssign(true);
    const nouvelEtat = !confirmToggle.actif;
    await updateDoc(doc(db, 'employe_rem_assignations', confirmToggle.id), { actif: nouvelEtat });
    setAssignations(prev => prev.map(a => a.id === confirmToggle.id ? { ...a, actif: nouvelEtat } : a));
    setTogglingAssign(false);
    setConfirmToggle(null);
  }

  async function sauvegarderEditAssign() {
    if (!editAssign || !editAssignValeur) return;
    setSavingEditAssign(true);
    const valeur = parseFloat(editAssignValeur);
    await updateDoc(doc(db, 'employe_rem_assignations', editAssign.id), { valeur });
    setAssignations(prev => prev.map(a => a.id === editAssign.id ? { ...a, valeur } : a));
    setSavingEditAssign(false);
    setEditAssign(null);
  }

  async function supprimerAssignation() {
    if (!suppAssign) return;
    setSupprimantAssign(true);
    await deleteDoc(doc(db, 'employe_rem_assignations', suppAssign.id));
    setAssignations(prev => prev.filter(a => a.id !== suppAssign.id));
    setSupprimantAssign(false);
    setSuppAssign(null);
  }

  async function ajouterManuel() {
    if (!manuelNom.trim() || !manuelMontant) return;
    setSavingManuel(true);
    const montant = parseFloat(manuelMontant);
    const ref = await addDoc(collection(db, 'employe_remunerations'), {
      employeId, siteId, userId: user!.uid,
      nomConfig: manuelNom.trim(), montant, verse: 0, reste: montant,
      dateDebut: todayStr(), dateFin: todayStr(),
      type: 'manuel', createdAt: serverTimestamp(),
    });
    const nouvelle: LigneRemuneration = {
      id: ref.id, employeId, nomConfig: manuelNom.trim(), montant, verse: 0, reste: montant,
      dateDebut: todayStr(), dateFin: todayStr(), type: 'manuel',
    };
    setLignesRem(prev => [...prev, nouvelle]);
    setStats(prev => ({
      ...prev,
      totalRemuneration: prev.totalRemuneration + montant,
      resteRemuneration: prev.resteRemuneration + montant,
    }));
    setSavingManuel(false); setModalManuel(false);
    setManuelNom(''); setManuelMontant(''); setManuelDateDebut(todayStr());
  }

  function ouvrirEdition() {
    if (!employe) return;
    setNomEdit(employe.nom); setFonctionEdit(employe.fonction ?? '');
    setContactEdit(employe.contact ?? ''); setEtatEdit(employe.etat);
    setDateEmbauchEdit(employe.dateEmbauche ?? '');
    setEditing(true);
  }

  async function sauvegarder() {
    if (!employe || !nomEdit.trim()) return;
    setSaving(true);
    const data: any = { nom: nomEdit.trim(), fonction: fonctionEdit.trim(), contact: contactEdit.trim(), etat: etatEdit, dateEmbauche: dateEmbauchEdit || null };
    await updateDoc(doc(db, 'employes', employeId), data);
    setEmploye(prev => prev ? { ...prev, ...data } : prev);
    setSaving(false); setEditing(false);
  }

  async function supprimer() {
    setSupprimant(true);
    await deleteDoc(doc(db, 'employes', employeId));
    router.push(retourEmployes);
  }

  const [recherche, setRecherche] = useState('');
  const [filtreStatut, setFiltreStatut] = useState<'tous' | 'non_solde' | 'partiel' | 'solde'>('tous');
  const [tri, setTri] = useState<{ col: 'du' | 'reste' | 'avant' | null; dir: 'asc' | 'desc' }>({ col: null, dir: 'desc' });

  /* historique versements */

  /* versement */
  const [modalVersement, setModalVersement] = useState(false);
  const [versementSelection, setVersementSelection] = useState<Set<string>>(new Set());
  const [montantVersement, setMontantVersement] = useState('');
  const [savingVersement, setSavingVersement] = useState(false);
  const [listeVersementDepliee, setListeVersementDepliee] = useState(false);

  function ouvrirVersement(toutCocher: boolean) {
    const nonSoldes = lignesRem.filter(l => l.reste > 0).map(l => l.id);
    setVersementSelection(toutCocher ? new Set(nonSoldes) : new Set());
    setMontantVersement('');
    setListeVersementDepliee(false);
    setModalVersement(true);
  }

  function toggleTri(col: 'du' | 'reste' | 'avant') {
    setTri(prev => prev.col === col ? { col, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: 'desc' });
  }

  const diversesRow = useMemo(() => {
    const manuelles = lignesRem.filter(l => l.type === 'manuel');
    if (manuelles.length === 0) return null;
    const totalDu = manuelles.reduce((s, l) => s + l.montant, 0);
    const totalVerse = manuelles.reduce((s, l) => s + l.verse, 0);
    const totalReste = manuelles.reduce((s, l) => s + l.reste, 0);
    const dateDebut = manuelles.map(l => l.dateDebut).sort()[0];
    const dateFin = manuelles.map(l => l.dateFin).sort().reverse()[0];
    return { totalDu, totalVerse, totalReste, dateDebut, dateFin };
  }, [lignesRem]);

  function matchStatut(reste: number, verse: number, s: 'non_solde' | 'partiel' | 'solde') {
    if (s === 'solde') return reste <= 0;
    if (s === 'partiel') return reste > 0 && verse > 0;
    return reste > 0 && verse <= 0;
  }

  /** La ligne agrégée « Diverses » passe-t-elle la recherche + le filtre statut ? */
  const diversesVisible = useMemo(() => {
    if (!diversesRow) return false;
    if (recherche.trim() && !'diverses'.includes(recherche.toLowerCase())) return false;
    if (filtreStatut === 'tous') return true;
    return matchStatut(diversesRow.totalReste, diversesRow.totalVerse, filtreStatut);
  }, [diversesRow, recherche, filtreStatut]);

  function countStatutJournal(s: 'non_solde' | 'partiel' | 'solde') {
    const configurees = lignesRem.filter(l => {
      if (l.type === 'manuel') return false;
      if (!l.nomConfig.toLowerCase().includes(recherche.toLowerCase())) return false;
      return matchStatut(l.reste, l.verse, s);
    }).length;
    const diverses = diversesRow
      && (!recherche.trim() || 'diverses'.includes(recherche.toLowerCase()))
      && matchStatut(diversesRow.totalReste, diversesRow.totalVerse, s) ? 1 : 0;
    return configurees + diverses;
  }

  const lignesTriees = useMemo(() => {
    let base = lignesRem.filter(l => l.type !== 'manuel');
    if (recherche.trim()) base = base.filter(l => l.nomConfig.toLowerCase().includes(recherche.toLowerCase()));
    if (filtreStatut === 'solde')     base = base.filter(l => l.reste <= 0);
    if (filtreStatut === 'partiel')   base = base.filter(l => l.reste > 0 && l.verse > 0);
    if (filtreStatut === 'non_solde') base = base.filter(l => l.reste > 0 && l.verse <= 0);
    if (tri.col === 'du')     base.sort((a, b) => tri.dir === 'desc' ? b.montant - a.montant : a.montant - b.montant);
    else if (tri.col === 'reste') base.sort((a, b) => tri.dir === 'desc' ? b.reste - a.reste : a.reste - b.reste);
    else if (tri.col === 'avant') base.sort((a, b) => {
      const actifA = assignations.find(x => x.id === a.assignationId)?.actif ?? false;
      const actifB = assignations.find(x => x.id === b.assignationId)?.actif ?? false;
      if (actifA !== actifB) return actifA ? -1 : 1;
      const jA = joursRestants(a.dateFin);
      const jB = joursRestants(b.dateFin);
      return tri.dir === 'desc' ? jB - jA : jA - jB;
    });
    else base.sort((a, b) => b.dateDebut.localeCompare(a.dateDebut));
    return base;
  }, [lignesRem, recherche, filtreStatut, tri, assignations]);


  /* La déconnexion vide l'utilisateur avant que la navigation aboutisse :
     tout ce qui lit son identifiant tomberait sur du vide. */
  if (!user) return null;

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );
  if (!employe) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-400">Employé introuvable.</div>
  );

  const etatInfo = ETATS.find(e => e.key === employe.etat) ?? ETATS[0];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="w-full mx-auto p-4 sm:p-6 lg:p-8">

        {/* Retour */}
        <button onClick={() => router.push(retourEmployes)} className="flex items-center gap-2 mb-6 group">
          <ArrowLeft size={15} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
          <span className="text-sm font-medium text-gray-600 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">Employés</span>
        </button>

        {/* En-tête */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-12 h-12 rounded-2xl bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center shrink-0">
                <span className="text-xl font-bold text-indigo-600 dark:text-indigo-400">{employe.nom.charAt(0).toUpperCase()}</span>
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">{employe.nom}</h1>
                <p className="text-sm text-gray-400 truncate">{employe.fonction || 'Fonction non définie'}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${etatInfo.color}`}>{etatInfo.label}</span>
              <button onClick={ouvrirEdition} className="p-2 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-indigo-600 hover:border-indigo-300 transition-colors"><Pencil size={14} /></button>
              <button onClick={() => setConfirmSupp(true)} className="p-2 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors"><Trash2 size={14} /></button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
            <div className="flex items-center gap-2">
              <Phone size={13} className="text-gray-400 shrink-0" />
              <div>
                <p className="text-xs text-gray-400">Contact</p>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{employe.contact || '—'}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Calendar size={13} className="text-gray-400 shrink-0" />
              <div>
                <p className="text-xs text-gray-400">Date d'embauche</p>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {employe.dateEmbauche ? new Date(employe.dateEmbauche).toLocaleDateString('fr-FR') : '—'}
                </p>
              </div>
            </div>
            {employe.dateEmbauche && (
              <div className="flex items-center gap-2">
                <Clock size={13} className="text-indigo-400 shrink-0" />
                <div>
                  <p className="text-xs text-gray-400">Ancienneté</p>
                  <p className="text-sm font-bold text-indigo-600 dark:text-indigo-400">{anciennete(employe.dateEmbauche)}</p>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Settings size={13} className="text-gray-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400">Rémunération configurée</p>
                {nbConfigs === 0
                  ? <p className="text-sm italic text-gray-400">Aucune</p>
                  : <p className="text-sm font-bold text-gray-700 dark:text-gray-300">
                      {formatMontant(Math.round(valeurMensuelle))}
                      <span className="text-xs font-normal text-gray-400 ml-1">
                        / mois ({nbActifs} actif{nbActifs > 1 ? 's' : ''})
                      </span>
                    </p>
                }
              </div>
              <button onClick={() => setModalConfigs(true)} className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-indigo-600 hover:border-indigo-300 transition-colors shrink-0">
                <Pencil size={12} />
              </button>
            </div>
          </div>
        </div>

        {/* Cartes financières */}
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Modèle de fond. Pas d'indigo : il signifie « carte active », et
              ces deux-là ouvrent une page au lieu de filtrer un tableau. */}
          {([
            {
              cle: 'remuneration',
              emoji: '💰',
              label: 'Rémunération',
              montant: stats.resteRemuneration,
              pastille: 'Reste à verser',
              vers: `/site/${siteId}/employes/${employeId}/remunerations`,
              detail: [
                { libelle: 'Total', valeur: formatMontant(stats.totalRemuneration), vert: false },
                { libelle: 'Versé', valeur: formatMontant(stats.verseRemuneration), vert: true },
              ],
            },
            {
              cle: 'avance',
              emoji: '💳',
              label: 'Avance',
              montant: stats.resteAvance,
              pastille: `${avances.length} avance${avances.length > 1 ? 's' : ''}`,
              vers: `/site/${siteId}/employes/${employeId}/avances`,
              detail: [
                { libelle: 'Total', valeur: formatMontant(stats.totalAvance), vert: false },
                { libelle: 'Prélevé', valeur: formatMontant(stats.verseAvance), vert: true },
              ],
            },
          ]).map(c => (
            <button key={c.cle} type="button" onClick={() => router.push(c.vers)}
              className="block rounded-2xl border border-black/[0.06] bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
                  {c.emoji}
                </span>
                <span className="shrink-0 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-bold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {c.pastille}
                </span>
              </div>
              <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                {c.label}
              </p>
              <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight text-neutral-900 dark:text-white`}>
                {formatMontant(c.montant)}
              </p>
              <div className="mt-2.5 flex justify-between gap-2 border-t border-black/[0.06] pt-2 text-xs dark:border-white/10">
                {c.detail.map(d => (
                  <span key={d.libelle} className="flex items-baseline gap-1.5">
                    <span className="text-neutral-400">{d.libelle}</span>
                    <span className={`font-bold ${
                      d.vert ? 'text-green-600' : 'text-neutral-900 dark:text-white'}`}>
                      {d.valeur}
                    </span>
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>

        {/* Journal des rémunérations */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Journal des rémunérations</p>
            <div className="flex items-center gap-2">
              {stats.resteRemuneration > 0 && (
                <button onClick={() => ouvrirVersement(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-indigo-300 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-xs font-bold rounded-xl transition-colors shrink-0">
                  <Check size={12} /> Versement
                </button>
              )}
              <button onClick={() => { setModalManuel(true); setManuelNom(''); setManuelMontant(''); setManuelDateDebut(todayStr()); }}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-indigo-300 hover:text-indigo-600 text-xs font-bold rounded-xl transition-colors shrink-0">
                <Plus size={12} /> Ajouter rémunération
              </button>
            </div>
          </div>

          {/* Recherche + filtres statut */}
          <div className="flex flex-wrap gap-2 mb-4">
            <ChampRecherche placeholder="Rechercher une rémunération…" valeur={recherche} onChange={setRecherche} className="flex-1 min-w-[180px]" />
            {(['tous', 'non_solde', 'partiel', 'solde'] as const).map(s => {
              const labels = { tous: 'Tous', non_solde: 'Non soldé', partiel: 'Partiel', solde: 'Soldé' };
              const count = s === 'tous'
                ? lignesRem.filter(l => l.type !== 'manuel' && l.nomConfig.toLowerCase().includes(recherche.toLowerCase())).length
                  + (diversesRow && (!recherche.trim() || 'diverses'.includes(recherche.toLowerCase())) ? 1 : 0)
                : countStatutJournal(s);
              return (
                <button key={s} onClick={() => setFiltreStatut(s)}
                  className={`px-3 py-2 rounded-xl border text-xs font-bold transition-all whitespace-nowrap ${filtreStatut === s ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-indigo-300'}`}>
                  {labels[s]} ({count})
                </button>
              );
            })}
          </div>

          {lignesTriees.length === 0 && !diversesVisible
            ? <p className="text-xs text-gray-400 text-center py-6">{lignesRem.length === 0 ? 'Aucune rémunération enregistrée' : 'Aucun résultat'}</p>
            : (() => {
              const total = lignesTriees.length + (diversesVisible ? 1 : 0);
              return (
              <>
                <p className="text-xs text-gray-400 mb-2">{total} rémunération{total > 1 ? 's' : ''}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-3 py-2.5 font-medium">Rémunération</th>
                        <th className="text-center px-3 py-2.5 font-medium">Type</th>
                        <th className="text-center px-3 py-2.5 font-medium">Période</th>
                        <th className="text-center px-3 py-2.5 font-medium">Rémunération</th>
                        <th className="px-3 py-2.5 font-medium cursor-pointer select-none text-center" onClick={() => toggleTri('avant')}>
                          <span className="flex items-center gap-1">Avant prochaine {tri.col === 'avant' ? (tri.dir === 'desc' ? '↓' : '↑') : '↕'}</span>
                        </th>
                        <th className="px-3 py-2.5 font-medium cursor-pointer select-none text-center" onClick={() => toggleTri('du')}>
                          <span className="flex items-center gap-1">Dû {tri.col === 'du' ? (tri.dir === 'desc' ? '↓' : '↑') : '↕'}</span>
                        </th>
                        <th className="text-center px-3 py-2.5 font-medium">Versé</th>
                        <th className="px-3 py-2.5 font-medium cursor-pointer select-none text-center" onClick={() => toggleTri('reste')}>
                          <span className="flex items-center gap-1">Reste {tri.col === 'reste' ? (tri.dir === 'desc' ? '↓' : '↑') : '↕'}</span>
                        </th>
                        <th className="text-center px-3 py-2.5 font-medium">Statut</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {diversesVisible && diversesRow && (
                        <tr
                          onClick={() => router.push(`/site/${siteId}/employes/${employeId}/remunerations/manuelles`)}
                          className="transition-colors cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                        >
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">Diverses</td>
                          <td className="px-3 py-2.5 text-center">
                            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400">Manuel</span>
                          </td>
                          <td className="px-3 py-2.5 text-gray-300 text-center">—</td>
                          <td className="px-3 py-2.5 text-gray-300 text-center">—</td>
                          <td className="px-3 py-2.5 text-gray-300 text-center">—</td>
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(diversesRow.totalDu)}</td>
                          <td className="px-3 py-2.5 text-green-600 font-medium text-center">{diversesRow.totalVerse > 0 ? formatMontant(diversesRow.totalVerse) : '—'}</td>
                          <td className="px-3 py-2.5 text-red-500 font-medium text-center">{formatMontant(diversesRow.totalReste)}</td>
                          <td className="px-3 py-2.5 text-center">
                            {(() => {
                              const r = diversesRow.totalReste; const v = diversesRow.totalVerse;
                              if (r <= 0) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Soldé</span>;
                              if (v > 0)  return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Partiel</span>;
                              return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">Non soldé</span>;
                            })()}
                          </td>
                        </tr>
                      )}
                      {lignesTriees.map(l => {
                        const s = statutLigne(l);
                        const jr = joursRestants(l.dateFin);
                        const assign = assignations.find(a => a.id === l.assignationId);
                        const assignActive = assign?.actif ?? false;
                        return (
                          <tr
                            key={l.id}
                            onClick={() => {
                              if (l.assignationId)
                                router.push(`/site/${siteId}/employes/${employeId}/remunerations/${l.assignationId}`);
                            }}
                            className={`transition-colors ${l.assignationId ? 'cursor-pointer' : ''} hover:bg-gray-50 dark:hover:bg-gray-800/50`}
                          >
                            <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{l.nomConfig}</td>
                            <td className="px-3 py-2.5 text-center">
                              <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">Configuré</span>
                            </td>
                            <td className="px-3 py-2.5 text-gray-500 text-center">{l.intervalleJours ? `${l.intervalleJours}j` : '—'}</td>
                            <td className="px-3 py-2.5 text-gray-700 dark:text-gray-300 text-center">{assign ? formatMontant(assign.valeur) : '—'}</td>
                            <td className="px-3 py-2.5 text-center">
                              {!assignActive
                                ? <span className="text-gray-400">—</span>
                                : jr > 0
                                  ? <span className="text-indigo-500 font-medium">{jr} jour{jr > 1 ? 's' : ''}</span>
                                  : <span className="text-orange-500 font-medium">Échue</span>
                              }
                            </td>
                            <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(l.montant)}</td>
                            <td className="px-3 py-2.5 text-green-600 font-medium text-center">{l.verse > 0 ? formatMontant(l.verse) : '—'}</td>
                            <td className="px-3 py-2.5 text-red-500 font-medium text-center">{formatMontant(l.reste)}</td>
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
              );
            })()
          }
        </div>

        {/* ===== MODALS ===== */}

        {/* Modal versement */}
        {modalVersement && (() => {
          const nonSoldes = lignesRem.filter(l => l.reste > 0).sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
          const detteTotal = totalDetteSelection();
          const toutCoche = nonSoldes.length > 0 && nonSoldes.every(l => versementSelection.has(l.id));

          /* Les manuelles sont présentées comme une seule entrée « Diverses ». */
          const manuellesNonSoldees = nonSoldes.filter(l => l.type === 'manuel');
          const items: { key: string; nom: string; sousTitre: string; reste: number; ids: string[] }[] = [
            ...nonSoldes.filter(l => l.type !== 'manuel').map(l => ({
              key: l.id,
              nom: l.nomConfig,
              sousTitre: new Date(l.dateDebut).toLocaleDateString('fr-FR'),
              reste: l.reste,
              ids: [l.id],
            })),
            ...(manuellesNonSoldees.length > 0 ? [{
              key: 'diverses',
              nom: 'Diverses',
              sousTitre: `${manuellesNonSoldees.length} rémunération${manuellesNonSoldees.length > 1 ? 's' : ''} manuelle${manuellesNonSoldees.length > 1 ? 's' : ''}`,
              reste: manuellesNonSoldees.reduce((s, l) => s + l.reste, 0),
              ids: manuellesNonSoldees.map(l => l.id),
            }] : []),
          ];
          const nbCoches = items.filter(it => it.ids.every(id => versementSelection.has(id))).length;
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
              <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5 flex flex-col max-h-[85vh] min-h-0">
                <div className="flex items-center justify-between mb-4 shrink-0">
                  <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Versement</h2>
                  <button onClick={() => { setModalVersement(false); setMontantVersement(''); setVersementSelection(new Set()); }} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
                </div>

                {/* Liste des rémunérations sélectionnables */}
                <div className={`mb-3 rounded-xl border border-gray-100 dark:border-gray-800 ${listeVersementDepliee ? 'flex flex-col min-h-0 flex-1' : 'shrink-0'}`}>
                  <button onClick={() => setListeVersementDepliee(v => !v)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-xl transition-colors shrink-0">
                    <ChevronDown size={14} className={`text-gray-400 shrink-0 transition-transform ${listeVersementDepliee ? '' : '-rotate-90'}`} />
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-300 flex-1">
                      Rémunérations à verser
                      <span className="text-gray-400 font-normal ml-1.5">{nbCoches}/{items.length}</span>
                    </span>
                    <span className="text-xs font-bold text-red-500 shrink-0">{formatMontant(detteTotal)}</span>
                  </button>
                  {listeVersementDepliee && (
                    <>
                      <div className="flex justify-end px-3 pb-2 shrink-0">
                        <button onClick={() => setVersementSelection(toutCoche ? new Set() : new Set(nonSoldes.map(l => l.id)))}
                          className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">
                          {toutCoche ? 'Tout décocher' : 'Tout cocher'}
                        </button>
                      </div>
                      <div className="overflow-y-auto flex-1 min-h-0 border-t border-gray-100 dark:border-gray-800 divide-y divide-gray-50 dark:divide-gray-800">
                        {items.map(it => {
                          const coche = it.ids.every(id => versementSelection.has(id));
                          return (
                            <label key={it.key} className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${coche ? 'bg-indigo-50 dark:bg-indigo-900/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                              <input type="checkbox" checked={coche}
                                onChange={() => setVersementSelection(prev => {
                                  const s = new Set(prev);
                                  if (coche) it.ids.forEach(id => s.delete(id));
                                  else it.ids.forEach(id => s.add(id));
                                  return s;
                                })}
                                className="rounded shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{it.nom}</p>
                                <p className="text-xs text-gray-400">{it.sousTitre}</p>
                              </div>
                              <span className="text-xs font-bold text-red-500 shrink-0">{formatMontant(it.reste)}</span>
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
                    inputMode="numeric"
                    placeholder={`Max. ${formatMontant(detteTotal)}`}
                    value={montantVersement ? Number(montantVersement).toLocaleString('fr-FR') : ''}
                    onChange={e => {
                      const raw = e.target.value.replace(/\s/g, '').replace(/[^0-9]/g, '');
                      const val = parseInt(raw || '0', 10);
                      const max = detteTotal;
                      setMontantVersement(val > max ? String(max) : raw ? String(val) : '');
                    }}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />

                  <div className="flex gap-3">
                    <button onClick={() => { setModalVersement(false); setMontantVersement(''); setVersementSelection(new Set()); }}
                      className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                    <button onClick={effectuerVersement} disabled={savingVersement || !montantVersement || versementSelection.size === 0}
                      className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                      {savingVersement ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirmer
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Modal configurations */}
        {modalConfigs && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-fit min-w-80 shadow-xl p-5">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Rémunérations configurées</h2>
                <div className="flex items-center gap-2">
                  <button onClick={() => setModalAssign(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
                    <Plus size={12} /> Assigner
                  </button>
                  <button onClick={() => setModalConfigs(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
                </div>
              </div>
              {assignations.length === 0
                ? <p className="text-xs text-gray-400 text-center py-6">Aucune configuration assignée</p>
                : (
                  <div className="overflow-x-auto">
                    <p className="text-xs text-gray-400 mb-2">{assignations.length} configuration{assignations.length > 1 ? 's' : ''}</p>
                    <table className="w-full text-sm whitespace-nowrap">
                      <thead>
                        <tr className="bg-indigo-600 text-white">
                          <th className="text-center px-3 py-2.5 font-medium">Nom</th>
                          <th className="text-center px-3 py-2.5 font-medium">Valeur</th>
                          <th className="text-center px-3 py-2.5 font-medium">Intervalle</th>
                          <th className="text-center px-3 py-2.5 font-medium">Instances</th>
                          <th className="text-center px-3 py-2.5 font-medium">État</th>
                          <th className="px-3 py-2.5 text-center"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                        {assignations.map(a => {
                          const nbInstances = lignesRem.filter(l => l.assignationId === a.id).length;
                          return (
                          <tr key={a.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                            <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{a.nomConfig}</td>
                            <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{formatMontant(a.valeur)}</td>
                            <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{a.intervalleJours}j</td>
                            <td className="px-3 py-2.5 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${nbInstances > 0 ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400' : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>
                                {nbInstances}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <button onClick={() => setConfirmToggle(a)}
                                className={`px-2.5 py-1 rounded-full text-xs font-bold transition-colors ${a.actif
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-red-50 hover:text-red-500'
                                  : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 hover:bg-green-50 hover:text-green-600'}`}>
                                {a.actif ? 'Actif' : 'Inactif'}
                              </button>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <div className="flex items-center gap-1.5">
                                <button onClick={() => { setEditAssign(a); setEditAssignValeur(String(a.valeur)); }}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors">
                                  <Pencil size={12} />
                                </button>
                                <button onClick={() => setSuppAssign(a)}
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
            </div>
          </div>
        )}

        {/* Modal confirmation toggle */}
        {confirmToggle && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${confirmToggle.actif ? 'bg-red-100 dark:bg-red-900/30' : 'bg-green-100 dark:bg-green-900/30'}`}>
                <Settings size={18} className={confirmToggle.actif ? 'text-red-500' : 'text-green-600'} />
              </div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2">
                {confirmToggle.actif ? 'Désactiver' : 'Activer'} "{confirmToggle.nomConfig}" ?
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                {confirmToggle.actif
                  ? 'En désactivant cette configuration, la rémunération ne se renouvellera plus automatiquement. Les instances déjà créées ne sont pas affectées.'
                  : employe.etat === 'actif'
                    ? 'En activant cette configuration, une nouvelle instance sera créée automatiquement dès aujourd\'hui si aucune n\'est en cours.'
                    : 'Cette configuration sera activée mais ne créera pas d\'instance tant que l\'employé est inactif.'
                }
              </p>
              <div className="flex gap-3">
                <button onClick={() => setConfirmToggle(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={confirmerToggle} disabled={togglingAssign}
                  className={`flex-1 py-2.5 rounded-xl text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-40 ${confirmToggle.actif ? 'bg-red-500 hover:bg-red-600' : 'bg-green-600 hover:bg-green-700'}`}>
                  {togglingAssign ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {confirmToggle.actif ? 'Désactiver' : 'Activer'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal édition assignation */}
        {editAssign && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-fit min-w-80 shadow-xl p-5">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Modifier "{editAssign.nomConfig}"</h2>
                <button onClick={() => setEditAssign(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-3 py-2 mb-4 text-xs">
                Modifier ces valeurs ne recalcule pas les instances déjà créées. Seules les nouvelles instances utiliseront les nouvelles valeurs.
              </p>
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Valeur</p>
              <input type="number" value={editAssignValeur} onChange={e => setEditAssignValeur(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Intervalle (jours)</p>
              <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400 mb-5">
                {editAssign.intervalleJours} jour{editAssign.intervalleJours > 1 ? 's' : ''} <span className="text-xs text-gray-400 dark:text-gray-500">(non modifiable)</span>
              </p>
              <div className="flex gap-3">
                <button onClick={() => setEditAssign(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={sauvegarderEditAssign} disabled={savingEditAssign || !editAssignValeur}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {savingEditAssign ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal suppression assignation */}
        {suppAssign && (() => {
          const nbInstances = lignesRem.filter(l => l.assignationId === suppAssign.id).length;
          const impossible = nbInstances > 0;
          return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${impossible ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
                <Trash2 size={18} className={impossible ? 'text-amber-500' : 'text-red-500'} />
              </div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2">
                {impossible ? 'Suppression impossible' : `Supprimer "${suppAssign.nomConfig}" ?`}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                {impossible
                  ? `Cette configuration a généré ${nbInstances} instance${nbInstances > 1 ? 's' : ''}. Elle ne peut pas être supprimée. Vous pouvez la désactiver pour qu'elle ne génère plus de nouvelles instances.`
                  : 'Cette configuration sera supprimée. La rémunération ne se renouvellera plus automatiquement.'
                }
              </p>
              <div className="flex gap-3">
                <button onClick={() => setSuppAssign(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                  {impossible ? 'Fermer' : 'Annuler'}
                </button>
                {!impossible && (
                  <button onClick={supprimerAssignation} disabled={supprimantAssign}
                    className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                    {supprimantAssign ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Supprimer
                  </button>
                )}
              </div>
            </div>
          </div>
          );
        })()}

        {/* Modal assignation */}
        {modalAssign && (
          <ModalAssignation
            siteId={siteId}
            userId={user!.uid}
            configs={configsDisponibles}
            dejaAssignesIds={assignations.map(a => a.configId)}
            saving={savingAssign}
            onClose={() => setModalAssign(false)}
            onAssigner={async ({ configId, nomConfig, valeur, intervalleJours, actif }) => {
              setSavingAssign(true);
              const dateDebut = todayStr();
              const ref = await addDoc(collection(db, 'employe_rem_assignations'), {
                employeId, siteId, userId: user!.uid, configId,
                nomConfig, valeur, intervalleJours,
                dateDebut, actif, createdAt: serverTimestamp(),
              });
              setAssignations(prev => [...prev, { id: ref.id, configId, nomConfig, valeur, intervalleJours, employeId, dateDebut, actif }]);
              setSavingAssign(false);
              setModalAssign(false);
            }}
            onConfigCree={c => setConfigsDisponibles(prev => [...prev, { ...c, siteId }])}
            onConfigSupprime={id => setConfigsDisponibles(prev => prev.filter(c => c.id !== id))}
          />
        )}

        {/* Modal édition modèle */}
        {editConfig && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-fit min-w-80 shadow-xl p-5">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Modifier le modèle</h2>
                <button onClick={() => { setEditConfig(null); setEditConfigErreur(''); }} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-3 py-2 mb-4 text-xs">
                Ce modèle est partagé. Les modifications s'appliquent à toutes les assignations futures qui l'utilisent. Les instances déjà créées ne sont pas affectées.
              </p>
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom</p>
              <input type="text" value={editConfigNom} onChange={e => { setEditConfigNom(e.target.value); setEditConfigErreur(''); }}
                className={`w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${editConfigErreur ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
              {editConfigErreur && <p className="text-xs text-red-500 mb-3">{editConfigErreur}</p>}
              {!editConfigErreur && <div className="mb-3" />}
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Valeur par défaut</p>
              <input type="number" value={editConfigValeur} onChange={e => setEditConfigValeur(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Intervalle (jours)</p>
              <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400 mb-5">
                {editConfig.intervalleJours} jour{editConfig.intervalleJours > 1 ? 's' : ''} <span className="text-xs text-gray-400 dark:text-gray-500">(non modifiable)</span>
              </p>
              <div className="flex gap-3">
                <button onClick={() => { setEditConfig(null); setEditConfigErreur(''); }} className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={sauvegarderEditConfig} disabled={savingEditConfig || !editConfigNom.trim() || !editConfigValeur}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {savingEditConfig ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal suppression modèle */}
        {suppConfig && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center mb-4">
                <Trash2 size={18} className="text-red-500" />
              </div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2">Supprimer le modèle "{suppConfig.nom}" ?</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                Ce modèle sera supprimé pour tous les employés du site. Les assignations et instances déjà créées ne sont pas affectées, mais la rémunération ne se renouvellera plus automatiquement.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setSuppConfig(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={supprimerConfig} disabled={supprimantConfig}
                  className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {supprimantConfig ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Supprimer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal ajout manuel */}
        {modalManuel && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-fit min-w-80 shadow-xl p-5">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Rémunération manuelle</h2>
                <button onClick={() => setModalManuel(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom <span className="normal-case text-gray-300">(ex. Prime de fin d'année)</span></p>
              <input type="text" placeholder="Ex. Prime, Bonus…" value={manuelNom} onChange={e => setManuelNom(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Montant</p>
              <input type="number" placeholder="Ex. 50 000" value={manuelMontant} onChange={e => setManuelMontant(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <div className="flex gap-3">
                <button onClick={() => setModalManuel(false)} className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={ajouterManuel} disabled={savingManuel || !manuelNom.trim() || !manuelMontant}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {savingManuel ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ajouter
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal édition */}
        {editing && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-fit min-w-80 shadow-xl p-5 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Modifier l'employé</h2>
                <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom <span className="text-red-400">*</span></p>
              <input type="text" value={nomEdit} onChange={e => setNomEdit(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Fonction</p>
              <input type="text" value={fonctionEdit} onChange={e => setFonctionEdit(e.target.value)} placeholder="Ex. Caissier…"
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Numéro / Contact</p>
              <input type="tel" value={contactEdit} onChange={e => setContactEdit(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Date d'embauche</p>
              <input type="date" value={dateEmbauchEdit} onChange={e => setDateEmbauchEdit(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs font-bold text-gray-400 uppercase mb-2">État</p>
              <div className="grid grid-cols-2 gap-2 mb-5">
                {ETATS.filter(et => et.key === 'actif' || et.key === 'inactif').map(et => (
                  <button key={et.key} onClick={() => setEtatEdit(et.key)}
                    className={`py-2 rounded-xl border text-xs font-medium transition-all
                      ${etatEdit === et.key ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-indigo-700 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>
                    {et.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-3">
                <button onClick={() => setEditing(false)} className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={sauvegarder} disabled={saving || !nomEdit.trim()}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal suppression */}
        {confirmSupp && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center mb-4">
                <Trash2 size={18} className="text-red-500" />
              </div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1">Supprimer {employe.nom} ?</h2>
              <p className="text-sm text-gray-400 mb-5">Cette action est irréversible.</p>
              <div className="flex gap-3">
                <button onClick={() => setConfirmSupp(false)} className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={supprimer} disabled={supprimant}
                  className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {supprimant ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Supprimer
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
