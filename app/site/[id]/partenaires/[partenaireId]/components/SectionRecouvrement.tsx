'use client';
import { useEffect, useState } from 'react';
import {
  collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
  arrayUnion,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { auteurCourant } from '@/lib/auteur';
import { couvertureTiers, verserAuTiers } from '@/lib/versements';
import { useAuth } from '@/lib/auth-context';
import {
  roleSurSite, peutReglerFournisseur, type RoleSite,
} from '@/lib/roles';
import { formatMontant, abregeMontant, dansNJours, ecartJours } from '@/lib/format';
import { hankenGrotesk } from '../../../components/finance/font';
import { Settings, BookOpen, Loader2, Check, X, Plus, Calendar } from 'lucide-react';
import { ChampNombre } from '@/components/Champs';
import { valeurRecue, valeurVente } from '@/lib/flux-marchandise';
import FiltreDeroulant from '@/components/FiltreDeroulant';

type RoleRecouvrement = 'fournisseur' | 'client';

interface Config {
  id: string;
  actif: boolean;
  valeur: number;
  intervalleJours: number;
  role: RoleRecouvrement;
}

interface LigneJournal {
  id: string;
  date: string;
  valeur: number;
  verse: number;
  reste: number;
  role: RoleRecouvrement;
  source: 'auto' | 'manuel';
}

type Onglet = 'configuration' | 'journal-fournisseur' | 'journal-client';

interface Props {
  partenaireId: string;
  siteId: string;
  userId: string;
  rolesFournisseur: boolean;
  rolesClient: boolean;
  dette: number;
  creance: number;
  /** prévient le parent qu'un versement a réduit la dette ou la créance */
  onSolde?: (role: RoleRecouvrement, montant: number) => void;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function etatLigne(date: string): { label: string; color: string; joursRestants?: number } {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return { label: 'Passé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
  if (diff === 0) return { label: 'Arrivé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  return { label: 'À venir', color: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400', joursRestants: diff };
}

export default function SectionRecouvrement({
  partenaireId, siteId, userId, rolesFournisseur, rolesClient, dette, creance, onSolde,
}: Props) {
  /* L'admin de l'activité n'a pas de rôle de site : son identifiant sert
     à le reconnaître quand la caisse cherche qui agit. */
  const { activite } = useAuth();
  /* Régler un fournisseur n'est pas recouvrer : celui qui va chercher
     l'argent chez le client n'arbitre pas ce qui sort. Le rôle se lit ici
     plutôt que de traverser la page, qui n'en a pas l'usage. */
  const [roleSite, setRoleSite] = useState<RoleSite | null>(null);
  useEffect(() => {
    if (!userId || !siteId) return;
    roleSurSite(userId, siteId, activite?.adminUid)
      .then(setRoleSite).catch(() => setRoleSite(null));
  }, [userId, siteId, activite?.adminUid]);
  const peutRegler = peutReglerFournisseur(roleSite);
  /* Le client d'abord : c'est l'argent qu'on attend, donc le travail à
     faire. Ce qu'on doit au fournisseur vient ensuite. */
  const [onglet, setOnglet] = useState<Onglet>(
    rolesClient ? 'journal-client' : rolesFournisseur ? 'journal-fournisseur' : 'configuration',
  );
  const [configs, setConfigs] = useState<Config[]>([]);
  const [journal, setJournal] = useState<LigneJournal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingJournal, setLoadingJournal] = useState(false);

  /* édition config */
  const [editingRole, setEditingRole] = useState<RoleRecouvrement | null>(null);
  const [valeurEdit, setValeurEdit] = useState('');
  const [intervalleEdit, setIntervalleEdit] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [reinitialisant, setReinitialisant] = useState(false);

  /* versement */
  const [versementLigne, setVersementLigne] = useState<LigneJournal | null>(null);
  const [versementVal, setVersementVal] = useState('');
  const [savingVersement, setSavingVersement] = useState(false);

  /* ajout manuel */
  const [ajoutManuelRole, setAjoutManuelRole] = useState<RoleRecouvrement | null>(null);

  /* Deux filtres indépendants : l'état situe l'échéance dans le temps, le
     statut dit où en est son encaissement. Croiser les deux répond à la
     seule question qui compte — qu'est-ce qui est dû et pas encore payé. */
  const [filtreEtat, setFiltreEtat] = useState<'tous' | 'Passé' | 'Arrivé' | 'À venir'>('tous');
  const [filtreStatut, setFiltreStatut] = useState<'tous' | 'Soldé' | 'Partiel' | 'Non soldé'>('tous');

  /* Les documents du partenaire : un versement se fait sur le total d'un
     document qui n'a pas été payé, pas sur une ardoise abstraite. */
  const [documents, setDocuments] = useState<{
    id: string; reference: string; role: RoleRecouvrement;
    total: number; verse: number; date: string;
  }[]>([]);

  /* Versement global : un montant, réparti par l'app sur les échéances. */
  const [versementRole, setVersementRole] = useState<RoleRecouvrement | null>(null);
  const [versementGlobal, setVersementGlobal] = useState('');
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [ajoutDate, setAjoutDate] = useState('');
  const [ajoutDelai, setAjoutDelai] = useState(0);
  const [ajoutValeur, setAjoutValeur] = useState('');
  const [savingAjout, setSavingAjout] = useState(false);

  useEffect(() => { chargerConfigs(); }, [partenaireId]);

  /* Les achats et ventes du partenaire, avec ce qui reste à payer dessus.
     Un versement s'impute là : c'est le document qui porte la créance, la
     dette du partenaire n'en est que la somme. */
  useEffect(() => {
    Promise.all([
      getDocs(query(collection(db, 'achats'),
        where('fournisseurId', '==', partenaireId), where('siteId', '==', siteId))),
      getDocs(query(collection(db, 'ventes'),
        where('clientId', '==', partenaireId), where('siteId', '==', siteId))),
    ]).then(([aSnap, vSnap]) => {
      const docs: typeof documents = [];
      aSnap.docs.forEach(d => {
        const a = d.data() as any;
        docs.push({
          id: d.id, reference: a.reference ?? '—', role: 'fournisseur',
          total: valeurRecue(a.lignes ?? []),
          verse: a.avanceVersee ?? 0,
          date: a.dateConfirmation ?? a.dateReception ?? a.dateCommande ?? '',
        });
      });
      vSnap.docs.forEach(d => {
        const v = d.data() as any;
        docs.push({
          id: d.id, reference: v.reference ?? '—', role: 'client',
          total: valeurVente(v.lignes ?? []),
          verse: v.avanceVersee ?? 0,
          date: v.dateLivraison ?? v.dateCommande ?? '',
        });
      });
      setDocuments(docs);
    });
  }, [partenaireId, siteId]);

  /** Les documents encore dus, du plus ancien au plus récent. */
  function documentsOuverts(role: RoleRecouvrement) {
    return documents
      .filter(d => d.role === role && d.total - d.verse > 0)
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  }

  useEffect(() => {
    if (onglet === 'journal-fournisseur') chargerJournal('fournisseur');
    if (onglet === 'journal-client') chargerJournal('client');
  }, [onglet]);

  async function chargerConfigs() {
    setLoading(true);
    const snap = await getDocs(query(
      collection(db, 'recouvrement_config'),
      where('partenaireId', '==', partenaireId),
      where('siteId', '==', siteId),
    ));
    setConfigs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Config)));
    setLoading(false);
  }

  async function chargerJournal(role: RoleRecouvrement) {
    setLoadingJournal(true);
    const snap = await getDocs(query(
      collection(db, 'recouvrement_journal'),
      where('partenaireId', '==', partenaireId),
      where('siteId', '==', siteId),
      where('role', '==', role),
    ));
    const lignes = snap.docs
      .map(d => ({ id: d.id, source: 'auto', ...d.data() } as LigneJournal))
      .sort((a, b) => a.date.localeCompare(b.date));

    /* auto-création : regarde uniquement la dernière ligne 'auto' */
    const solde = role === 'fournisseur' ? dette : creance;
    const config = configs.find(c => c.role === role && c.actif);
    if (config && solde > 0) {
      const lignesAuto = lignes.filter(l => l.source === 'auto');
      if (lignesAuto.length > 0) {
        const derniere = lignesAuto[lignesAuto.length - 1];
        const dateDerniere = new Date(derniere.date); dateDerniere.setHours(0, 0, 0, 0);
        const now = new Date(); now.setHours(0, 0, 0, 0);
        if (dateDerniere <= now) {
          const prochaineDate = new Date(dateDerniere);
          prochaineDate.setDate(prochaineDate.getDate() + config.intervalleJours);
          const prochaineDateStr = prochaineDate.toISOString().split('T')[0];
          const dejaCree = lignes.some(l => l.source === 'auto' && l.date === prochaineDateStr);
          if (!dejaCree) {
            const ref = await addDoc(collection(db, 'recouvrement_journal'), {
              partenaireId, siteId, userId, role,
              date: prochaineDateStr,
              valeur: config.valeur,
              verse: 0,
              reste: config.valeur,
              source: 'auto',
              createdAt: serverTimestamp(),
            });
            lignes.push({ id: ref.id, date: prochaineDateStr, valeur: config.valeur, verse: 0, reste: config.valeur, role, source: 'auto' });
            lignes.sort((a, b) => a.date.localeCompare(b.date));
          }
        }
      }
    }

    setJournal(lignes);
    setLoadingJournal(false);
  }

  function configPour(role: RoleRecouvrement) {
    return configs.find(c => c.role === role) ?? null;
  }

  function ouvrirEditionConfig(role: RoleRecouvrement) {
    const c = configPour(role);
    setValeurEdit(c ? String(c.valeur) : '');
    setIntervalleEdit(c ? String(c.intervalleJours) : '');
    setEditingRole(role);
  }

  async function sauvegarderConfig() {
    if (!editingRole) return;
    const valeur = parseFloat(valeurEdit);
    if (!valeur) return;
    setSavingConfig(true);
    const existing = configPour(editingRole);
    if (existing) {
      await updateDoc(doc(db, 'recouvrement_config', existing.id), { valeur });
      setConfigs(prev => prev.map(c => c.id === existing.id ? { ...c, valeur } : c));
    } else {
      const intervalleJours = parseInt(intervalleEdit);
      if (!intervalleJours) { setSavingConfig(false); return; }
      const ref = await addDoc(collection(db, 'recouvrement_config'), {
        partenaireId, siteId, userId,
        role: editingRole,
        actif: false,
        valeur,
        intervalleJours,
        createdAt: serverTimestamp(),
      });
      setConfigs(prev => [...prev, { id: ref.id, role: editingRole!, actif: false, valeur, intervalleJours }]);
    }
    setSavingConfig(false);
    setEditingRole(null);
  }

  async function toggleActif(role: RoleRecouvrement) {
    const c = configPour(role);
    if (!c) return;
    const actif = !c.actif;
    await updateDoc(doc(db, 'recouvrement_config', c.id), { actif });
    if (actif) {
      const solde = role === 'fournisseur' ? dette : creance;
      if (solde > 0) {
        const snapJ = await getDocs(query(
          collection(db, 'recouvrement_journal'),
          where('partenaireId', '==', partenaireId),
          where('siteId', '==', siteId),
          where('role', '==', role),
          where('source', '==', 'auto'),
        ));
        if (snapJ.empty) {
          const now = new Date();
          now.setDate(now.getDate() + c.intervalleJours);
          const dateStr = now.toISOString().split('T')[0];
          await addDoc(collection(db, 'recouvrement_journal'), {
            partenaireId, siteId, userId, role,
            date: dateStr,
            valeur: c.valeur,
            verse: 0,
            reste: c.valeur,
            source: 'auto',
            createdAt: serverTimestamp(),
          });
        }
      }
    }
    setConfigs(prev => prev.map(c2 => c2.id === c.id ? { ...c2, actif } : c2));
  }

  async function reinitialiserRecouvrement() {
    if (!editingRole) return;
    setReinitialisant(true);
    const c = configPour(editingRole);
    if (c) {
      await deleteDoc(doc(db, 'recouvrement_config', c.id));
      setConfigs(prev => prev.filter(c2 => c2.id !== c.id));
    }
    setReinitialisant(false);
    setEditingRole(null);
  }

  async function enregistrerVersement() {
    if (!versementLigne) return;
    /* Le champ écrête déjà, mais le reste a pu changer depuis l'ouverture
       du modal : on revérifie avant d'écrire. */
    const val = Math.min(parseFloat(versementVal), versementLigne.reste);
    if (!val || val <= 0) return;
    setSavingVersement(true);
    const newVerse = versementLigne.verse + val;
    const newReste = Math.max(versementLigne.valeur - newVerse, 0);
    await updateDoc(doc(db, 'recouvrement_journal', versementLigne.id), { verse: newVerse, reste: newReste });
    setJournal(prev => prev.map(l => l.id === versementLigne.id ? { ...l, verse: newVerse, reste: newReste } : l));
    setSavingVersement(false);
    setVersementLigne(null);
    setVersementVal('');
  }

  function ouvrirAjoutManuel(role: RoleRecouvrement) {
    setAjoutDate(todayStr());
    setAjoutDelai(0);
    setAjoutValeur('');
    setAjoutManuelRole(role);
  }

  async function enregistrerAjoutManuel() {
    if (!ajoutManuelRole || !ajoutDate || !ajoutValeur) return;
    /* Le champ écrête déjà, mais le solde a pu bouger depuis l'ouverture du
       modal : on revérifie avant d'écrire, sinon la règle ne tient que tant
       que personne ne touche à rien pendant la saisie. */
    const valeur = Math.min(parseFloat(ajoutValeur), restePlanifiable(ajoutManuelRole));
    if (!valeur || valeur <= 0) return;
    setSavingAjout(true);
    const ref = await addDoc(collection(db, 'recouvrement_journal'), {
      partenaireId, siteId, userId,
      role: ajoutManuelRole,
      date: ajoutDate,
      valeur,
      verse: 0,
      reste: valeur,
      source: 'manuel',
      createdAt: serverTimestamp(),
    });
    const nouvelle: LigneJournal = { id: ref.id, date: ajoutDate, valeur, verse: 0, reste: valeur, role: ajoutManuelRole, source: 'manuel' };
    setJournal(prev => [...prev, nouvelle].sort((a, b) => a.date.localeCompare(b.date)));
    setSavingAjout(false);
    setAjoutManuelRole(null);
  }

  const ongletsDispo: { key: Onglet; label: string }[] = [
    ...(rolesClient ? [{ key: 'journal-client' as Onglet, label: 'Journal Client' }] : []),
    ...(rolesFournisseur ? [{ key: 'journal-fournisseur' as Onglet, label: 'Journal Fournisseur' }] : []),
    { key: 'configuration', label: 'Configuration' },
  ];

  const journalRole: RoleRecouvrement = onglet === 'journal-fournisseur' ? 'fournisseur' : 'client';
  const soldeJournal = journalRole === 'fournisseur' ? dette : creance;

  /**
   * Ce qu'il reste à planifier, pour le rôle du modal ouvert.
   *
   * Un recouvrement est une promesse d'encaisser une part du solde. Si les
   * échéances déjà posées couvrent tout ce qui est dû, il n'y a plus rien à
   * promettre : en ajouter une reviendrait à réclamer deux fois le même
   * argent. On retranche donc du solde ce que les échéances existantes
   * doivent encore encaisser — leur reste, pas leur valeur : une échéance
   * déjà versée a fait son travail et libère sa place.
   */
  /**
   * Où en est une échéance de son encaissement.
   *
   * L'état dit où elle en est dans le temps — arrivée, à venir — et ne dit
   * rien de l'argent. Les mêmes trois libellés que partout ailleurs dans
   * l'app : une échéance se lit comme une dette de partenaire.
   */
  function statutLigne(l: LigneJournal) {
    if (l.reste <= 0) return { label: 'Soldé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
    if (l.verse > 0)  return { label: 'Partiel', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
    return { label: 'Non soldé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
  }

  function couverture(role: RoleRecouvrement) {
    const du = role === 'fournisseur' ? dette : creance;
    /* Ce que les échéances doivent encore encaisser — leur reste, pas leur
       valeur : une échéance déjà versée a fait son travail et libère sa
       place. */
    const planifie = journal
      .filter(l => l.role === role)
      .reduce((somme, l) => somme + (l.reste ?? 0), 0);
    return { du, planifie, reste: Math.max(0, du - planifie) };
  }

  /* Les lignes du rôle affiché, avant filtres : la base des compteurs. */
  const lignesRole = journal.filter(l => l.role === journalRole);

  /**
   * Les lignes à montrer, une fois les deux filtres appliqués.
   *
   * `sauf` retire un filtre du calcul : c'est ce qui permet aux compteurs
   * d'être croisés. Le nombre affiché sur « Soldé » doit dire combien de
   * lignes on verrait en cliquant dessus — donc en tenant compte du filtre
   * d'état déjà actif, mais pas du filtre de statut qu'on est en train de
   * remplacer.
   */
  function lignesFiltrees(sauf?: 'etat' | 'statut') {
    return lignesRole.filter(l => {
      if (sauf !== 'etat' && filtreEtat !== 'tous' && etatLigne(l.date).label !== filtreEtat) return false;
      if (sauf !== 'statut' && filtreStatut !== 'tous' && statutLigne(l).label !== filtreStatut) return false;
      return true;
    });
  }

  const lignesVisibles = lignesFiltrees();

  function compteEtat(v: typeof filtreEtat) {
    const base = lignesFiltrees('etat');
    return v === 'tous' ? base.length : base.filter(l => etatLigne(l.date).label === v).length;
  }

  function compteStatut(v: typeof filtreStatut) {
    const base = lignesFiltrees('statut');
    return v === 'tous' ? base.length : base.filter(l => statutLigne(l).label === v).length;
  }

  /**
   * Les échéances qu'un versement peut honorer, dans l'ordre où il les
   * honore : la plus ancienne d'abord.
   *
   * Une échéance passée en est exclue. Elle n'attend plus l'argent : elle
   * témoigne qu'à sa date, il n'est pas venu. La remplir après coup
   * effacerait la seule trace d'un calendrier non tenu.
   */
  function echeancesOuvertes(role: RoleRecouvrement) {
    return journal
      .filter(l => l.role === role && l.reste > 0 && etatLigne(l.date).label !== 'Passé')
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Dû, planifié et reste, pour le modal de versement global. */
  function couvertureVersement(role: RoleRecouvrement) {
    const du = role === 'fournisseur' ? dette : creance;
    const planifie = echeancesOuvertes(role).reduce((s, l) => s + l.reste, 0);
    return { du, planifie, reste: Math.max(0, du - planifie) };
  }

  /**
   * Répartit un versement unique sur les échéances ouvertes.
   *
   * L'argent comble chaque échéance jusqu'à son reste avant de passer à la
   * suivante ; ce qui dépasse toutes les échéances réduit quand même la
   * dette, car le versement porte sur ce qui est dû, pas sur le calendrier.
   */
  /**
   * Verser depuis la fiche du partenaire.
   *
   * La répartition et l'écriture vivent dans `lib/versements` : la liste des
   * partenaires verse par le même chemin. Deux implémentations du même geste
   * finiraient par ne plus se comporter pareil — l'une écrivant en caisse,
   * l'autre non, sans que rien ne le signale.
   */
  async function enregistrerVersementGlobal() {
    if (!versementRole) return;
    const role = versementRole;
    /* La garde tient aussi ici : cacher un bouton ne ferme pas l'écriture
       qu'il déclenche. */
    if (role === 'fournisseur' && !peutRegler) return;
    const du = couvertureVersement(role).du;
    const total = Math.min(Number(versementGlobal) || 0, du);
    if (total <= 0) return;

    setSavingGlobal(true);
    try {
      const couv = await couvertureTiers(siteId, partenaireId, role, du);
      await verserAuTiers({
        siteId, userId: userId ?? '',
        partenaireId,
        role, montant: total, couverture: couv,
        adminUid: activite?.adminUid ?? null,
        ...(await auteurCourant(siteId, userId ?? '')),
      });
      await chargerJournal(role);
      onSolde?.(role, total);
    } finally {
      setSavingGlobal(false);
      setVersementRole(null);
      setVersementGlobal('');
    }
  }

  function restePlanifiable(role: RoleRecouvrement): number {
    return couverture(role).reste;
  }

  if (loading) return (
    <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-indigo-500" /></div>
  );

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
      {/* Titre + onglets */}
      <div className="px-5 pt-5 pb-0 border-b border-gray-100 dark:border-gray-800">
        <p className="text-xs font-bold uppercase text-gray-400 mb-3">Recouvrement</p>
        <div className="flex gap-1">
          {ongletsDispo.map(o => (
            <button key={o.key} onClick={() => setOnglet(o.key)}
              className={`px-3 py-2 text-xs font-medium rounded-t-lg transition-all border-b-2
                ${onglet === o.key
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>
              {o.key === 'configuration' ? <Settings size={12} className="inline mr-1" /> : <BookOpen size={12} className="inline mr-1" />}
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">

        {/* ===== CONFIGURATION ===== */}
        {onglet === 'configuration' && (
          <div className="space-y-4">
            {([
              ...(rolesFournisseur ? ['fournisseur' as RoleRecouvrement] : []),
              ...(rolesClient ? ['client' as RoleRecouvrement] : []),
            ]).map(role => {
              const c = configPour(role);
              const label = role === 'fournisseur' ? 'Fournisseur' : 'Client';
              const accent = role === 'fournisseur' ? 'text-amber-600' : 'text-indigo-600';
              return (
                <div key={role} className="border border-gray-100 dark:border-gray-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className={`text-sm font-bold ${accent}`}>{label}</p>
                    <div className="flex items-center gap-3">
                      {c && (
                        <button onClick={() => toggleActif(role)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                            ${c.actif ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-700'}`}>
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                            ${c.actif ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                        </button>
                      )}
                      <button onClick={() => ouvrirEditionConfig(role)}
                        className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">
                        {c ? 'Modifier' : 'Configurer'}
                      </button>
                    </div>
                  </div>
                  {c ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                        <p className="text-xs text-gray-400 mb-0.5">Valeur / recouvrement</p>
                        <p className="text-base font-bold text-gray-900 dark:text-gray-100">{formatMontant(c.valeur)}</p>
                      </div>
                      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                        <p className="text-xs text-gray-400 mb-0.5">Intervalle</p>
                        <p className="text-base font-bold text-gray-900 dark:text-gray-100">{c.intervalleJours} jours</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400">Aucune configuration — cliquez sur "Configurer"</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ===== JOURNAL ===== */}
        {(onglet === 'journal-fournisseur' || onglet === 'journal-client') && (
          loadingJournal
            ? <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-indigo-500" /></div>
            : (
              <>
                {/* Bouton ajout manuel */}
                <div className="flex justify-end gap-2 mb-3">
                  {/* Un seul versement, réparti par l'app : ligne par ligne,
                      c'était à l'utilisateur de refaire la ventilation. */}
                  {/* Régler un fournisseur n'appartient pas à qui recouvre :
                      le bouton disparaît du journal fournisseur pour lui. */}
                  {(journalRole !== 'fournisseur' || peutRegler) && (
                  <button
                    onClick={() => { setVersementRole(journalRole); setVersementGlobal(''); }}
                    disabled={soldeJournal <= 0}
                    title={soldeJournal <= 0 ? 'Rien à verser' : undefined}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold rounded-xl transition-colors">
                    <Plus size={12} /> Verser
                  </button>
                  )}
                  <button
                    onClick={() => soldeJournal > 0 ? ouvrirAjoutManuel(journalRole) : undefined}
                    disabled={soldeJournal <= 0}
                    title={soldeJournal <= 0 ? 'Aucune dette/créance en cours' : undefined}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl transition-colors">
                    <Plus size={12} /> Ajouter manuellement
                  </button>
                </div>

                {lignesRole.length === 0 ? (
                  <div className="text-center py-10 text-gray-400">
                    <Calendar size={32} className="mx-auto mb-2 opacity-30" />
                    <p className="text-sm">Aucun recouvrement planifié</p>
                    <p className="text-xs mt-1">Activez la configuration ou ajoutez manuellement</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    {/* Deux menus plutôt que huit pastilles alignées : le
                        nom du filtre reste visible, et on ne confond plus
                        les deux « Tous ». Les compteurs sont croisés —
                        chacun annonce ce qu'on verrait en le choisissant. */}
                    <div className="flex flex-wrap gap-2 mb-3">
                      <FiltreDeroulant
                        nom="État"
                        valeur={filtreEtat}
                        onChange={setFiltreEtat}
                        options={(['tous', 'Passé', 'Arrivé', 'À venir'] as const).map(v => ({
                          valeur: v, label: v === 'tous' ? 'Tous' : v, nombre: compteEtat(v),
                        }))}
                      />
                      <FiltreDeroulant
                        nom="Statut"
                        valeur={filtreStatut}
                        onChange={setFiltreStatut}
                        options={(['tous', 'Non soldé', 'Partiel', 'Soldé'] as const).map(v => ({
                          valeur: v, label: v === 'tous' ? 'Tous' : v, nombre: compteStatut(v),
                        }))}
                      />
                    </div>
                    <p className="text-sm font-medium text-gray-500 mb-2">
                      {lignesVisibles.length} recouvrement{lignesVisibles.length > 1 ? 's' : ''}
                    </p>
                    {lignesVisibles.length === 0 && (
                      <p className="text-center text-xs text-gray-400 py-8">
                        Aucun recouvrement pour ces filtres.
                      </p>
                    )}
                    {lignesVisibles.length > 0 && (
                    <table className="w-full text-sm whitespace-nowrap">
                      <thead>
                        <tr className="bg-indigo-600 text-white">
                          <th className="text-center px-4 py-3 font-medium">Date</th>
                          <th className="text-center px-4 py-3 font-medium">État</th>
                          <th className="text-center px-4 py-3 font-medium">Source</th>
                          <th className="text-center px-4 py-3 font-medium">Valeur</th>
                          <th className="text-center px-4 py-3 font-medium">Versé</th>
                          <th className="text-center px-4 py-3 font-medium">Reste</th>
                          <th className="text-center px-4 py-3 font-medium">Statut</th>
                          <th className="text-center px-4 py-3 font-medium">Suivi de contact</th>
                          <th className="px-4 py-3 text-center" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                        {lignesVisibles.map(l => {
                          const e = etatLigne(l.date);
                          return (
                            <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                              <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">
                                {new Date(l.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </td>
                              <td className="px-4 py-3 text-center">
                                <div>
                                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${e.color}`}>{e.label}</span>
                                  {e.joursRestants !== undefined && (
                                    <p className="text-xs text-gray-400 mt-0.5">{e.joursRestants} jour{e.joursRestants > 1 ? 's' : ''} restant{e.joursRestants > 1 ? 's' : ''}</p>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${l.source === 'manuel' ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                                  {l.source === 'manuel' ? 'Manuel' : 'Auto'}
                                </span>
                              </td>
                              <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(l.valeur)}</td>
                              <td className="px-4 py-3 text-green-600 font-medium text-center">{l.verse > 0 ? formatMontant(l.verse) : '—'}</td>
                              <td className="px-4 py-3 text-center">
                                <span className={l.reste <= 0 ? 'text-green-600 font-medium' : 'text-red-500 font-medium'}>
                                  {formatMontant(l.reste)}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-center">
                                {(() => { const st = statutLigne(l); return (
                                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${st.color}`}>{st.label}</span>
                                ); })()}
                              </td>
                              <td className="px-4 py-3 text-gray-400 text-center">{e.label === 'Passé' ? '—' : ''}</td>
                              <td className="px-4 py-3 text-center">
                                {l.reste > 0 && (
                                  <button onClick={() => { setVersementLigne(l); setVersementVal(''); }}
                                    className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 text-xs font-medium rounded-lg hover:bg-indigo-100 transition-colors">
                                    <Plus size={11} /> Verser
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    )}
                  </div>
                )}
              </>
            )
        )}
      </div>

      {/* Modal édition config */}
      {editingRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                Config recouvrement — {editingRole === 'fournisseur' ? 'Fournisseur' : 'Client'}
              </h2>
              <button onClick={() => setEditingRole(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Valeur par recouvrement</p>
            <input type="number" placeholder="Ex. 25000" value={valeurEdit}
              onChange={e => setValeurEdit(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Intervalle (jours)</p>
            {configPour(editingRole!) ? (
              <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400 mb-5">
                {configPour(editingRole!)!.intervalleJours} jour{configPour(editingRole!)!.intervalleJours > 1 ? 's' : ''} <span className="text-xs text-gray-400 dark:text-gray-500">(non modifiable)</span>
              </p>
            ) : (
              <input type="number" placeholder="Ex. 14" value={intervalleEdit}
                onChange={e => setIntervalleEdit(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            )}
            <div className="flex gap-3">
              <button onClick={() => setEditingRole(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={sauvegarderConfig} disabled={savingConfig || !valeurEdit || (!configPour(editingRole!) && !intervalleEdit)}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {savingConfig ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
              </button>
            </div>
            {configPour(editingRole!) && (
              <div className="mt-3 flex justify-center">
                <button onClick={reinitialiserRecouvrement} disabled={reinitialisant}
                  className="text-xs text-red-400 hover:text-red-600 disabled:opacity-50 flex items-center gap-1 transition-colors">
                  {reinitialisant ? <Loader2 size={11} className="animate-spin" /> : null}
                  Réinitialiser la configuration
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal ajout manuel */}
      {ajoutManuelRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                Ajouter un recouvrement — {ajoutManuelRole === 'fournisseur' ? 'Fournisseur' : 'Client'}
              </h2>
              <button onClick={() => setAjoutManuelRole(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Date</p>
            {/* On promet plus souvent un delai qu'une date : les deux champs
                disent la meme chose et se suivent. */}
            <div className="mb-4 flex gap-2">
              <ChampNombre valeur={ajoutDelai}
                onChange={n => { setAjoutDelai(n); setAjoutDate(dansNJours(n)); }}
                className="w-20 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-center text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
              <span className="shrink-0 self-center text-xs text-gray-400">jours</span>
              <input type="date" value={ajoutDate} min={todayStr()}
                onChange={e => { setAjoutDate(e.target.value); setAjoutDelai(ecartJours(e.target.value)); }}
                className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
            </div>
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Valeur</p>
            {/* Trois chiffres, pas un seul plafond : ce que le tiers doit,
                ce que les échéances existantes promettent déjà d'encaisser,
                et la différence — la seule part encore à planifier. Un
                « reste » nu ne dit pas s'il vient d'une grosse dette bien
                couverte ou d'une petite dette laissée de côté. */}
            {(() => { const c = couverture(ajoutManuelRole); return (
              <div className={`${hankenGrotesk.className} grid grid-cols-3 gap-2 mb-3`}>
                {([
                  { label: 'Dû', valeur: c.du, fort: false },
                  { label: 'Planifié', valeur: c.planifie, fort: false },
                  { label: 'Reste', valeur: c.reste, fort: true },
                ]).map(i => (
                  <div key={i.label}
                    className="rounded-xl bg-gray-50 dark:bg-gray-800/60 px-2.5 py-2 text-center"
                    title={formatMontant(i.valeur)}>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                      {i.label}
                    </p>
                    {/* Montant abrégé : « 20 000 000 FCFA » en toutes lettres
                        cassait sur deux lignes dans une colonne de tiers. */}
                    <p className={`mt-0.5 text-sm font-bold leading-5 tracking-tight ${
                      i.fort
                        ? i.valeur > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400'
                        : 'text-gray-900 dark:text-gray-100'}`}>
                      {abregeMontant(i.valeur)}
                    </p>
                  </div>
                ))}
              </div>
            ); })()}
            {/* La valeur se ramène au plafond au lieu d'afficher une erreur,
                et s'écrit avec ses séparateurs de milliers. */}
            <ChampNombre
              valeur={Number(ajoutValeur) || 0}
              onChange={n => setAjoutValeur(String(Math.min(n, restePlanifiable(ajoutManuelRole))))}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-400 mb-5">
              {restePlanifiable(ajoutManuelRole) <= 0
                ? 'Les échéances déjà posées couvrent tout ce qui est dû.'
                : 'Au-delà du reste, on réclamerait deux fois le même argent.'}
            </p>
            <div className="flex gap-3">
              <button onClick={() => setAjoutManuelRole(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={enregistrerAjoutManuel}
                disabled={savingAjout || !ajoutDate || !(Number(ajoutValeur) > 0)}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {savingAjout ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ajouter
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal versement global : un montant, réparti par l'app */}
      {versementRole && (() => { const c = couvertureVersement(versementRole); return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          {/* Hauteur bornée et pied fixe : l'aperçu de répartition grandit
              avec le nombre d'échéances et emportait Confirmer avec lui. */}
          <div className="flex flex-col max-h-[85vh] bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="flex shrink-0 items-center justify-between mb-4">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                Verser — {versementRole === 'fournisseur' ? 'Fournisseur' : 'Client'}
              </h2>
              <button onClick={() => setVersementRole(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Montant</p>
            {/* Le planifié ne compte que les échéances encore ouvertes :
                une échéance passée ne reçoit plus rien, elle témoigne. */}
            <div className={`${hankenGrotesk.className} grid grid-cols-3 gap-2 mb-3`}>
              {([
                { label: 'Dû', valeur: c.du, fort: false },
                { label: 'Planifié', valeur: c.planifie, fort: false },
                { label: 'Reste', valeur: c.reste, fort: true },
              ]).map(i => (
                <div key={i.label}
                  className="rounded-xl bg-gray-50 dark:bg-gray-800/60 px-2.5 py-2 text-center"
                  title={formatMontant(i.valeur)}>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{i.label}</p>
                  <p className={`mt-0.5 text-sm font-bold leading-5 tracking-tight ${
                    i.fort
                      ? i.valeur > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400'
                      : 'text-gray-900 dark:text-gray-100'}`}>
                    {abregeMontant(i.valeur)}
                  </p>
                </div>
              ))}
            </div>

            <ChampNombre
              valeur={Number(versementGlobal) || 0}
              onChange={n => setVersementGlobal(String(Math.min(n, c.du)))}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-400 mb-4">
              Réparti sur les échéances à honorer, de la plus ancienne à la plus récente.
              Les échéances passées n'en reçoivent pas.
            </p>

            {/* Ce que le versement va faire, avant de le faire : sans cet
                aperçu, la répartition serait une boîte noire. */}
            {(Number(versementGlobal) || 0) > 0 && (() => {
              let reste = Math.min(Number(versementGlobal) || 0, c.du);
              const parts = echeancesOuvertes(versementRole)
                .map(l => { const part = Math.min(reste, l.reste); reste -= part; return { l, part }; })
                .filter(x => x.part > 0);
              const soldees = parts.filter(x => x.part >= x.l.reste).length;
              return (
                <div className="mb-4 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
                  {/* Le compte tient sur une ligne ; le détail peut faire
                      vingt échéances et pousserait Confirmer hors de l'écran. */}
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800/60 text-xs">
                    <span className="font-bold text-gray-700 dark:text-gray-200">
                      {parts.length} échéance{parts.length > 1 ? 's' : ''}
                    </span>
                    {soldees > 0 && (
                      <span className="text-green-600 font-medium">
                        dont {soldees} soldée{soldees > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div className="max-h-28 overflow-y-auto divide-y divide-gray-50 dark:divide-gray-800">
                    {parts.map(({ l, part }) => (
                      <div key={l.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                        <span className="text-gray-500">
                          {new Date(l.date).toLocaleDateString('fr-FR')}
                          {part >= l.reste && <span className="ml-1.5 text-green-600 font-medium">sera soldée</span>}
                        </span>
                        <span className="font-bold text-gray-700 dark:text-gray-200">{formatMontant(part)}</span>
                      </div>
                    ))}
                  </div>
                  {reste > 0 && (
                    <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 dark:border-gray-800 text-xs">
                      <span className="text-gray-500">Hors échéance</span>
                      <span className="font-bold text-gray-700 dark:text-gray-200">{formatMontant(reste)}</span>
                    </div>
                  )}
                </div>
              );
            })()}

            </div>

            <div className="shrink-0 flex gap-3 pt-4">
              <button onClick={() => setVersementRole(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={enregistrerVersementGlobal}
                disabled={savingGlobal || !(Number(versementGlobal) > 0)}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {savingGlobal ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirmer
              </button>
            </div>
          </div>
        </div>
      ); })()}

      {/* Modal versement */}
      {versementLigne && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Enregistrer un versement</h2>
              <button onClick={() => setVersementLigne(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>
            <p className="text-xs text-gray-400 mb-1">
              Recouvrement du {new Date(versementLigne.date).toLocaleDateString('fr-FR')} · Reste {formatMontant(versementLigne.reste)}
            </p>
            <p className="text-xs font-bold text-gray-400 uppercase mb-1 mt-3">Montant versé</p>
            {/* La valeur se ramène au reste au lieu de laisser saisir
                n'importe quoi : verser plus que ce qui est dû sur une
                échéance rendrait son reste négatif. */}
            <ChampNombre
              valeur={Number(versementVal) || 0}
              onChange={n => setVersementVal(String(Math.min(n, versementLigne.reste)))}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-400 mb-5">
              Maximum {formatMontant(versementLigne.reste)}.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setVersementLigne(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={enregistrerVersement}
                disabled={savingVersement || !(Number(versementVal) > 0)}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {savingVersement ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
