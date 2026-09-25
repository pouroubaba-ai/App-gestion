'use client';
import { useEffect, useRef, useState } from 'react';
import {
  collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatMontant, abregeMontant, dansNJours, ecartJours } from '@/lib/format';
import { soldesDuSite, type SoldeTiers } from '@/lib/soldes';
import { hankenGrotesk } from './finance/font';
import PeriodFilter from './finance/PeriodFilter';
import {
  Wallet, ChevronRight,
  Loader2, Calendar, Check, X, Plus, Eye, AlertCircle,
} from 'lucide-react';
import { ChampRecherche, ChampNombre, SelectCherchable } from '@/components/Champs';
import {
  useSites, FiltreSite, CelluleSite, ToggleVue, CartesParSite,
  type PropsPortee,
} from './ContexteSites';
import { lireParSite } from '@/lib/portee';
import {
  peutPlanifierRecouvrement, peutReglerFournisseur, type RoleSite,
} from '@/lib/roles';
import {
  ordonnerMission, chargerMissions, enPochePourEcheance,
  confirmerReception, type Mission,
} from '@/lib/missions';
import ListeMissions from './ListeMissions';
import FeuilleARecuperer from './FeuilleARecuperer';

type SousOnglet = 'configuration' | 'fournisseurs' | 'clients';
type Role = 'fournisseur' | 'client';
type StatutContact =
  | 'non_contacte'
  | 'injoignable'
  | 'refuse'
  | 'convenu_partiel'
  | 'convenu_total'
  | 'reporte';
type SensDepot = 'il_vient_donner' | 'nous_allons_donner' | 'nous_venons_recuperer' | 'il_vient_recuperer';
type ModalOnglet = 'versement' | 'suivi';

interface Recouvrement {
  id: string;
  /* De quel site vient l'échéance : sur l'ensemble, elles se mêlent. */
  siteId?: string;
  date: string;
  valeur: number;
  verse: number;
  reste: number;
  role: Role;
  source: 'auto' | 'manuel';
  partenaireId: string;
  nomPartenaire?: string;
  numeroPartenaire?: string;
  dernierVersementDate?: string;
  dernierVersementMontant?: number;
  reliquat?: string | null;
  /* Par où l'argent passe, selon le dernier suivi. Deux chemins qui n'ont
     ni les mêmes étapes ni les mêmes risques : le fournisseur qui vient au
     tiroir prend et s'en va, l'argent qu'on porte traverse une poche. */
  sensConvenu?: SensDepot | null;
  /* Ce qu'on s'est engagé à verser, tiré du dernier suivi de contact.
     « Convenu totalement » vaut la valeur entière, « partiellement » le
     montant dit. Absent tant que personne n'a rien convenu : une échéance
     due n'est pas une échéance promise. */
  convenu?: number | null;
}

interface SuiviContact {
  id: string;
  journalId: string;
  statut: StatutContact;
  heure?: string;
  sensDepot?: SensDepot;
  montant?: number;
  reliquatType?: 'non_determine' | 'determine';
  reliquatDate?: string;
  dateReportage?: string;
  createdAt?: any;
}

interface VersementDetail {
  id: string;
  heure: string;
  montant: number;
  resteApres: number;
}

interface ConfigDefaut {
  id: string;
  role: Role;
  valeur: number;
  intervalleJours: number;
}

interface Props extends PropsPortee {
  userId: string;
  onCount?: (n: number) => void;
  /* Planifier un recouvrement engage le site sur des modalités de crédit :
     celui qui applique le calendrier ne le fixe pas. */
  roleSite?: RoleSite | null;
}

function todayStr() { return new Date().toISOString().split('T')[0]; }

type PeriodeRecouv = 'jour' | 'semaine' | 'mois' | 'tout';
/* le sens sépare ce qui est dû de ce qui va l'être : deux travaux différents */
type SensRecouv = 'echu' | 'avenir';

const PERIODES_RECOUV: { key: PeriodeRecouv; labelEchu: string; labelAvenir: string }[] = [
  { key: 'jour',    labelEchu: "Aujourd'hui", labelAvenir: 'Demain' },
  { key: 'semaine', labelEchu: '7 jours',     labelAvenir: '7 jours' },
  { key: 'mois',    labelEchu: '30 jours',    labelAvenir: '30 jours' },
  { key: 'tout',    labelEchu: 'Tout',        labelAvenir: 'Tout' },
];

/** Décale la date du jour de `n` jours et la rend au format ISO. */
function decalerJours(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

/** Amplitude de la période en jours ; null = sans borne. */
function amplitudeRecouv(p: PeriodeRecouv): number | null {
  if (p === 'tout') return null;
  if (p === 'semaine') return 7;
  if (p === 'mois') return 30;
  return 0;
}
function heureNow() { return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function joursDepuis(dateStr?: string) {
  if (!dateStr) return null;
  const diff = Math.round((new Date().getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

const STATUTS: { key: StatutContact; label: string }[] = [
  { key: 'non_contacte',   label: 'Non contacté' },
  { key: 'injoignable',    label: 'Injoignable' },
  { key: 'refuse',         label: 'Refuse de payer aujourd\'hui' },
  { key: 'convenu_partiel',label: 'Convenu partiellement' },
  { key: 'convenu_total',  label: 'Convenu totalement' },
  { key: 'reporte',        label: 'Reporté' },
];

/*
 * Un recouvrement va toujours dans le même sens : l'argent vient du tiers.
 *
 * Client ou fournisseur, c'est lui qui doit. L'argent ne peut donc que venir
 * à nous — il l'apporte, ou nous allons le chercher. « Nous allons donner »
 * et « Il vient récupérer » décrivent de l'argent qui sort de chez nous :
 * c'est un versement, pas un recouvrement. Les laisser au choix permettait
 * d'enregistrer un suivi qui dit l'inverse de ce qui se passe.
 *
 * Les deux autres sens restent définis : d'anciens suivis les portent, et
 * leur historique doit rester lisible.
 */
/**
 * Où en est une échéance dans le temps.
 *
 * La même règle que dans la fiche d'un partenaire : la date dit seulement si
 * le moment est passé, arrivé ou à venir — elle ne dit rien de l'argent.
 */
function etatEcheance(date: string): { label: string; color: string } {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - now.getTime()) / 86400000);
  if (diff < 0) return { label: 'Passé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
  if (diff === 0) return { label: 'Arrivé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  return { label: 'À venir', color: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' };
}

const SENS_DEPOT: { key: SensDepot; label: string; recouvrable: boolean }[] = [
  /* `recouvrable` dit que l'argent entre : c'est le cas du client, qui
     doit. Chez le fournisseur il sort, et ce sont les deux autres. */
  { key: 'il_vient_donner',       label: 'Il vient donner',       recouvrable: true },
  { key: 'nous_venons_recuperer', label: 'Nous venons récupérer', recouvrable: true },
  { key: 'nous_allons_donner',    label: 'Nous allons donner',    recouvrable: false },
  { key: 'il_vient_recuperer',    label: 'Il vient récupérer',    recouvrable: false },
];

/**
 * Les sens qu'un recouvrement peut prendre, selon qui doit.
 *
 * Un client doit : l'argent vient vers nous, soit qu'il l'apporte, soit
 * qu'on aille le chercher. Un fournisseur attend : l'argent part, soit
 * qu'on le lui porte, soit qu'il vienne le prendre.
 *
 * Proposer les quatre reviendrait à demander si un fournisseur « vient
 * donner » — la question n'a pas de sens, et la réponse fausserait le
 * suivi de celui qui la choisirait par inadvertance.
 */
function sensDuRole(role: Role) {
  return SENS_DEPOT.filter(s => s.recouvrable === (role === 'client'));
}

function statutContactColor(s?: StatutContact) {
  if (!s) return 'bg-gray-100 text-gray-400 dark:bg-gray-800';
  const map: Record<StatutContact, string> = {
    non_contacte:   'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
    injoignable:    'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
    refuse:         'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
    convenu_partiel:'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    convenu_total:  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    reporte:        'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
  };
  return map[s];
}

export default function OngletRecouvrements({ siteId, userId, onCount, sites, titre, roleSite = null }: Props) {
  /* Relancer et encaisser, oui ; décider du calendrier, non. */
  const peutPlanifier = peutPlanifierRecouvrement(roleSite);
  const ctx = useSites(siteId, sites);
  const [sousOnglet, setSousOnglet] = useState<SousOnglet>('clients');
  /* la page s'ouvre sur le jour : c'est le travail à faire maintenant */
  const [periode, setPeriode] = useState<PeriodeRecouv>('jour');
  /* on ouvre sur l'échu : c'est l'argent qu'on peut réclamer dès maintenant */
  const [sensRecouv, setSensRecouv] = useState<SensRecouv>('echu');
  const [rechPartenaire, setRechPartenaire] = useState('');
  const [recouvrements, setRecouvrements] = useState<Recouvrement[]>([]);
  const [configsDefaut, setConfigsDefaut] = useState<ConfigDefaut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingConfig, setLoadingConfig] = useState(true);

  /* modal ligne */
  /* La feuille de ce qu'il doit recuperer a la caisse. */
  const [feuilleCaisse, setFeuilleCaisse] = useState(false);
  const [ligneActive, setLigneActive] = useState<Recouvrement | null>(null);
  const [modalOnglet, setModalOnglet] = useState<ModalOnglet>('versement');

  /* versements du modal */
  const [versements, setVersements] = useState<VersementDetail[]>([]);
  const [loadingVersements, setLoadingVersements] = useState(false);
  const [valeurVersement, setValeurVersement] = useState('');
  const [savingVersement, setSavingVersement] = useState(false);

  /* suivi contact du modal */
  const [suivis, setSuivis] = useState<SuiviContact[]>([]);
  const [loadingSuivis, setLoadingSuivis] = useState(false);
  const [nouveauStatut, setNouveauStatut] = useState<StatutContact>('non_contacte');
  const [suiviHeure, setSuiviHeure] = useState('');
  const [suiviSens, setSuiviSens] = useState<SensDepot>('il_vient_donner');
  /* La séance de suivis : le modal enchaîne les échéances au lieu de se
     refermer. Un clic sur une ligne reste ce qu'il était — on ouvre un
     dossier précis, on n'entame pas une tournée. */
  const [enSerie, setEnSerie] = useState(false);
  /* Ce entre quoi on avance. Une tournée se fait par personne : on appelle
     Ibrahim une fois, quelles que soient ses trois échéances. Mais parfois
     c'est un dossier précis qu'on suit — d'où l'interrupteur. */
  const [parQui, setParQui] = useState<'partenaire' | 'echeance'>('partenaire');
  /* Le détail des échéances du partenaire, déplié à la demande : on
     s'engage sur un total, on veut pouvoir voir de quoi il est fait. */
  const [voirDetail, setVoirDetail] = useState(false);
  /* Ce qui est sorti du tiroir pour aller payer, et n'est pas arrivé : le
     porteur ne peut remettre que ce qu'il détient. */
  const [missions, setMissions] = useState<Mission[]>([]);
  /* Ce qui a reçu son suivi pendant la séance. Le statut vit dans sa
     propre collection : sans cette trace, les points de progression
     demanderaient une lecture par ligne. */
  const [suivisFaits, setSuivisFaits] = useState<Set<string>>(new Set());
  const [suiviMontant, setSuiviMontant] = useState('');
  const [suiviReliquatType, setSuiviReliquatType] = useState<'non_determine' | 'determine'>('non_determine');
  const [suiviReliquatDate, setSuiviReliquatDate] = useState('');
  const [suiviDateReportage, setSuiviDateReportage] = useState('');
  const [savingSuivi, setSavingSuivi] = useState(false);

  /* config par défaut */
  /* Ajouter un recouvrement depuis l'onglet : le meme geste que dans la
     fiche d'un partenaire, avec le partenaire a choisir en plus. */
  const [ajoutRole, setAjoutRole] = useState<Role | null>(null);
  const [ajoutPartenaire, setAjoutPartenaire] = useState('');
  const [ajoutDate, setAjoutDate] = useState('');
  const [ajoutDelai, setAjoutDelai] = useState(0);
  const [ajoutValeur, setAjoutValeur] = useState(0);
  const [savingAjout, setSavingAjout] = useState(false);
  /* Les soldes disent ce que chaque tiers doit : sans eux, on ne saurait pas
     quelle part reste a planifier. */
  const [soldes, setSoldes] = useState<{ fournisseur: Map<string, SoldeTiers>; client: Map<string, SoldeTiers> } | null>(null);
  const [partenaires, setPartenaires] = useState<{ id: string; nom: string; roles: Role[] }[]>([]);

  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [valeurEdit, setValeurEdit] = useState('');
  const [intervalleEdit, setIntervalleEdit] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [reinitialisant, setReinitialisant] = useState(false);

  useEffect(() => { chargerRecouvrements(); }, [ctx.portee]);
  useEffect(() => { chargerConfigsDefaut(); }, [ctx.portee]);

  useEffect(() => {
    if (!ligneActive) return;
    if (modalOnglet === 'versement') chargerVersements(ligneActive.id);
    if (modalOnglet === 'suivi') chargerSuivis(ligneActive.id);
  }, [ligneActive, modalOnglet]);

  async function chargerRecouvrements() {
    setLoading(true);
    const today = todayStr();
    /* Le `userId` se filtre en mémoire : croisé avec un `in` sur les sites,
       il ferait une requête composée, donc un index à créer à la main. */
    const [journalSnap, partenairesSnap, versementsSnap] = await Promise.all([
      lireParSite('recouvrement_journal', ctx.portee),
      /* Un partenaire appartient au site, pas à celui qui l'a saisi : les
         fiches portent l'identifiant du propriétaire, jamais celui du
         membre qui les consulte. */
      lireParSite('partenaires', ctx.portee),
      lireParSite('recouvrement_versements', ctx.portee),
    ]);
    const noms: Record<string, string> = {};
    const numeros: Record<string, string> = {};
    partenairesSnap.forEach(d => { noms[d.id] = d.data().nom; numeros[d.id] = d.data().numero ?? ''; });

    /* Le choix du partenaire se fait dans le modal : on garde la liste avec
       ses roles, un tiers pouvant etre client et fournisseur. */
    setPartenaires(partenairesSnap.map(d => {
      const x = d.data();
      const roles: Role[] = [];
      if (x.rolesFournisseur) roles.push('fournisseur');
      if (x.rolesClient) roles.push('client');
      return { id: d.id, nom: x.nom as string, roles };
    }));
    soldesDuSite(ctx.portee).then(setSoldes).catch(() => setSoldes(null));
    chargerMissions(ctx.portee).then(setMissions).catch(() => setMissions([]));

    /* dernier versement par journalId */
    const dernierVersement: Record<string, { date: string; montant: number }> = {};
    versementsSnap.forEach(d => {
      const data = d.data();
      const prev = dernierVersement[data.journalId];
      if (!prev || data.heure > prev.date) {
        dernierVersement[data.journalId] = { date: data.date ?? today, montant: data.montant };
      }
    });

    /* dernier suivi par journalId → reliquat */
    const reliquats: Record<string, string | null> = {};
    /* Ce qui a été convenu, et à quelle heure — le dernier suivi
       l'emporte, un engagement se renouvelle. Sans l'heure, deux suivis du
       même jour se disputeraient la ligne dans l'ordre de lecture. */
    const convenus: Record<string, {
      montant: number | null; heure: string; sens?: SensDepot | null;
    }> = {};
    const suivisSnap = await lireParSite('recouvrement_suivis', ctx.portee);
    suivisSnap.forEach(d => {
      const data = d.data();
      if (data.statut === 'reporte' && data.dateReportage) reliquats[data.journalId] = data.dateReportage;
      else if (data.statut === 'convenu_partiel' && data.reliquatType === 'determine' && data.reliquatDate) reliquats[data.journalId] = data.reliquatDate;

      const heure = (data.heure as string) ?? '';
      const vu = convenus[data.journalId];
      if (vu && vu.heure > heure) return;
      if (data.statut === 'convenu_total') {
        /* La valeur entière : elle se lit sur la ligne, pas ici. */
        convenus[data.journalId] = { montant: null, heure, sens: data.sensDepot ?? null };
      } else if (data.statut === 'convenu_partiel') {
        convenus[data.journalId] = {
          montant: (data.montant as number) ?? 0, heure, sens: data.sensDepot ?? null,
        };
      } else {
        /* Injoignable, refus, report : rien n'est promis, et le dernier
           mot efface le précédent. */
        convenus[data.journalId] = { montant: 0, heure };
      }
    });

    const lignes = journalSnap
      .map(d => ({ id: d.id, source: 'auto', ...d.data() } as Recouvrement))
      /* on garde tout l'historique : le filtre de période se fait à l'affichage */
      .filter(l => l.reste > 0)
      .map(l => ({
        ...l,
        nomPartenaire: noms[l.partenaireId] ?? '—',
        numeroPartenaire: numeros[l.partenaireId] ?? '',
        dernierVersementDate: dernierVersement[l.id]?.date,
        dernierVersementMontant: dernierVersement[l.id]?.montant,
        reliquat: reliquats[l.id] ?? null,
        /* `null` dans la table veut dire « tout » : on résout ici, où la
           valeur de l'échéance est sous la main. Aucune entrée veut dire
           que rien n'a été convenu — ce n'est pas zéro, c'est vide. */
        convenu: l.id in convenus
          ? (convenus[l.id].montant ?? l.valeur)
          : null,
        sensConvenu: convenus[l.id]?.sens ?? null,
      }))
      .sort((a, b) => (a.nomPartenaire ?? '').localeCompare(b.nomPartenaire ?? ''));

    setRecouvrements(lignes);
    /* Le porteur ne compte pas les echeances du site : la page tient deja
       son chiffre depuis ses missions, et l'ecraser ici le ferait osciller
       entre les deux a chaque chargement. */
    if (roleSite !== 'recouvrement') {
      onCount?.(lignes.filter(l => l.date === today).length);
    }
    setLoading(false);
  }

  /* Ce que le tiers doit, moins ce que les echeances promettent deja
     d'encaisser : au-dela, on reclamerait deux fois le meme argent. */
  function couvertureAjout(role: Role, partenaireId: string) {
    const solde = soldes?.[role]?.get(partenaireId);
    const du = solde?.reste ?? 0;
    const planifie = recouvrements
      .filter(r => r.role === role && r.partenaireId === partenaireId)
      .reduce((somme, r) => somme + (r.reste ?? 0), 0);
    return { du, planifie, reste: Math.max(0, du - planifie) };
  }

  function ouvrirAjout(role: Role) {
    /* La garde tient aussi ici : cacher un bouton ne ferme pas la
       fonction qu'il appelle. */
    if (!peutPlanifier) return;
    setAjoutRole(role);
    setAjoutPartenaire('');
    setAjoutDate(todayStr());
    setAjoutDelai(0);
    setAjoutValeur(0);
  }

  async function enregistrerAjout() {
    if (!ajoutRole || !ajoutPartenaire || !ajoutDate) return;
    /* Le solde a pu bouger depuis l'ouverture du modal : on revalide avant
       d'ecrire, sinon la regle ne tient que tant que personne ne touche a
       rien pendant la saisie. */
    const valeur = Math.min(ajoutValeur, couvertureAjout(ajoutRole, ajoutPartenaire).reste);
    if (!valeur || valeur <= 0) return;
    /* Une échéance appartient au site qui la réclamera. */
    const site = ctx.siteEcriture;
    if (!site) return;
    setSavingAjout(true);
    try {
      await addDoc(collection(db, 'recouvrement_journal'), {
        partenaireId: ajoutPartenaire, siteId: site, userId,
        role: ajoutRole,
        date: ajoutDate,
        valeur,
        verse: 0,
        reste: valeur,
        source: 'manuel',
        createdAt: serverTimestamp(),
      });
      await chargerRecouvrements();

      /* L'écran se place où la ligne vient d'aller. Une échéance posée à
         demain tombe dans « à venir », alors que la vue s'ouvre sur
         « échu · aujourd'hui » : on enregistrait, le modal se fermait, et
         rien n'apparaissait — la saisie passait pour perdue.
         Le côté suit aussi : un fournisseur saisi depuis l'onglet clients
         se rangeait dans l'autre. */
      if (ajoutDate > todayStr()) {
        setSensRecouv('avenir');
        /* « Demain » ne montre que demain, « 7 jours » pas au-delà : la
           période s'élargit jusqu'à contenir la date, sinon on déplace le
           regard sans rien lui montrer. */
        const jours = ecartJours(ajoutDate);
        if (jours > 30) setPeriode('tout');
        else if (jours > 7) setPeriode('mois');
        else if (jours > 1) setPeriode('semaine');
      } else {
        setSensRecouv('echu');
      }
      setSousOnglet(ajoutRole === 'fournisseur' ? 'fournisseurs' : 'clients');

      setAjoutRole(null);
    } finally { setSavingAjout(false); }
  }

  async function chargerVersements(journalId: string) {
    setLoadingVersements(true);
    const snap = await getDocs(query(
      collection(db, 'recouvrement_versements'),
      where('journalId', '==', journalId),
    ));
    const liste = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as VersementDetail))
      .sort((a, b) => a.heure.localeCompare(b.heure));
    setVersements(liste);
    setLoadingVersements(false);
  }

  async function chargerSuivis(journalId: string) {
    setLoadingSuivis(true);
    const snap = await getDocs(query(
      collection(db, 'recouvrement_suivis'),
      where('journalId', '==', journalId),
    ));
    const liste = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as SuiviContact))
      .sort((a, b) => (a.heure ?? '').localeCompare(b.heure ?? ''));
    setSuivis(liste);
    if (liste.length > 0) setNouveauStatut(liste[liste.length - 1].statut);
    setLoadingSuivis(false);
  }

  async function enregistrerVersement() {
    if (!ligneActive) return;
    /* Le plafond tient ici autant qu'au champ : borner l'un sans l'autre
       laisse passer ce qu'on tape vite. */
    const val = Math.min(parseFloat(valeurVersement) || 0, bornesVersement.plafond);
    if (!val || val <= 0) return;
    setSavingVersement(true);
    const newVerse = ligneActive.verse + val;
    const newReste = Math.max(ligneActive.valeur - newVerse, 0);
    const heure = heureNow();
    await Promise.all([
      addDoc(collection(db, 'recouvrement_versements'), {
        journalId: ligneActive.id, siteId: ligneActive.siteId ?? siteId, userId,
        heure, montant: val, resteApres: newReste,
        date: todayStr(), createdAt: serverTimestamp(),
      }),
      updateDoc(doc(db, 'recouvrement_journal', ligneActive.id), { verse: newVerse, reste: newReste }),
    ]);
    const nouveau: VersementDetail = { id: Date.now().toString(), heure, montant: val, resteApres: newReste };
    setVersements(prev => [...prev, nouveau]);
    setLigneActive(prev => prev ? { ...prev, verse: newVerse, reste: newReste } : prev);
    setRecouvrements(prev => prev.map(r => r.id === ligneActive.id ? { ...r, verse: newVerse, reste: newReste } : r));
    setValeurVersement('');
    setSavingVersement(false);
  }

  async function enregistrerSuivi() {
    if (!ligneActive) return;
    setSavingSuivi(true);
    const heure = heureNow();

    /* Les deux chemins arrivent au tiroir : le caissier doit voir venir ce
       qu'il aura à délivrer, que ce soit un porteur ou le fournisseur
       lui-même. Seul le geste change au moment de délivrer. */
    const porte = suiviSens === 'nous_allons_donner';
    const comptoir = suiviSens === 'il_vient_recuperer';

    /* Par personne, l'engagement porte sur toutes ses échéances : on a
       convenu avec Ibrahim, pas avec la facture du 23. Chacune reçoit
       pourtant son propre suivi — une seule écriture pour trois dossiers
       ne dirait plus lequel a été honoré.

       Un montant partiel se répartit de la plus ancienne à la plus
       récente : c'est l'ordre dans lequel une dette s'éteint, et celui
       que suit déjà le versement à un tiers. */
    const cibles = (parPersonne && lotActif.length > 1)
      ? [...lotActif].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
      : [ligneActive];

    let aRepartir = parseFloat(suiviMontant) || 0;

    for (const cible of cibles) {
    const data: any = {
      journalId: cible.id, siteId: cible.siteId ?? siteId, userId,
      statut: nouveauStatut, heure,
      createdAt: serverTimestamp(),
    };
    if (nouveauStatut === 'injoignable' || nouveauStatut === 'refuse') { data.heure = suiviHeure || heure; }
    if (nouveauStatut === 'convenu_partiel') {
      data.sensDepot = suiviSens;
      /* Ce qui reste à placer, borné à ce que l'échéance réclame : le
         surplus descend sur la suivante. */
      const part = Math.min(aRepartir, cible.reste);
      aRepartir -= part;
      data.montant = part;
      data.reliquatType = suiviReliquatType;
      if (suiviReliquatType === 'determine') data.reliquatDate = suiviReliquatDate;
    }
    if (nouveauStatut === 'convenu_total') { data.sensDepot = suiviSens; }
    if (nouveauStatut === 'reporte') { data.dateReportage = suiviDateReportage; }

    const ref = await addDoc(collection(db, 'recouvrement_suivis'), data);
    if (cible.id === ligneActive.id) {
      setSuivis(prev => [...prev, { id: ref.id, journalId: cible.id, ...data }]);
    }

    /* Convenir de payer ordonne la sortie. Une mission par échéance, et
       non une pour le lot : chaque échéance vit pour elle-même, se solde
       pour elle-même, et la vue par partenaire ne fait que éviter de
       saisir trois fois la même chose. Les fondre ferait d'une commodité
       de saisie une fusion des dettes.

       Le montant est celui qui vient d'être inscrit sur ce suivi : au
       total il vaut le reste, au partiel la part qu'on lui a attribuée. */
    if (ligneActive.role === 'fournisseur' && (porte || comptoir)) {
      const aPorter = nouveauStatut === 'convenu_total'
        ? cible.reste
        : (data.montant as number) ?? 0;
      if (aPorter > 0) {
        await ordonnerMission({
          /* Une mission appartient au site dont la caisse la paiera : en
             vue d'ensemble, `siteId` porte la portée entière. */
          siteId: cible.siteId ?? ctx.siteEcriture ?? '',
          mode: porte ? 'porte' : 'comptoir',
          partenaireId: cible.partenaireId,
          partenaireNom: cible.nomPartenaire ?? null,
          journalIds: [cible.id],
          montant: aPorter,
          parUid: userId,
        }).catch(() => undefined);
      }
    }
    }

    /* Convenir de porter l'argent ordonne sa sortie : sans cela, le
       gestionnaire décidait dans le vide — rien ne prévenait le caissier,
       et le porteur n'avait ni trace ni montant. La mission naît ici,
       l'argent ne sortira qu'au tiroir. */
    const engage = nouveauStatut === 'convenu_total'
      || nouveauStatut === 'convenu_partiel';
    if (engage && (porte || comptoir)) {
      chargerMissions(ctx.portee).then(setMissions).catch(() => undefined);
    }

    /* Le tableau porte le convenu : sans cette recopie, la colonne
       garderait son tiret jusqu'à la prochaine relecture complète. */
    const vus = new Set(cibles.map(c => c.id));
    setRecouvrements(prev => prev.map(r => {
      if (!vus.has(r.id)) return r;
      if (nouveauStatut === 'convenu_total') return { ...r, convenu: r.valeur };
      if (nouveauStatut === 'convenu_partiel') return r;
      return { ...r, convenu: 0 };
    }));

    setSavingSuivi(false);
  }

  /** Enregistre, puis passe à l'échéance suivante sans refermer. */
  async function suiviPuisSuivante() {
    /* Par personne, tout le lot est traité d'un coup : marquer la seule
       ligne ouverte laisserait ses sœurs grises, comme s'il restait à y
       revenir. */
    const faits = (parPersonne && lotActif.length > 1 ? lotActif : [ligneActive])
      .filter(Boolean).map(r => r!.id);
    await enregistrerSuivi();
    if (faits.length) {
      setSuivisFaits(prev => { const n = new Set(prev); faits.forEach(id => n.add(id)); return n; });
    }
    if (suivante) { ouvrirModal(suivante); setEnSerie(true); }
    else { setLigneActive(null); setEnSerie(false); }
  }

  /** Ouvre la première échéance de la liste et entame la séance. */
  function demarrerSerie() {
    const premiere = lignesDuJour[0];
    if (!premiere) return;
    setSuivisFaits(new Set());
    setEnSerie(true);
    ouvrirModal(premiere);
    /* La séance s'ouvre sur le volet de celui qui la lance : forcer le
       suivi menait le porteur à un écran fermé pour lui. */
    setModalOnglet(voletsDe(premiere.role).suivi ? 'suivi' : 'versement');
  }

  async function chargerConfigsDefaut() {
    setLoadingConfig(true);
    const snap = await lireParSite('recouvrement_config_defaut', ctx.siteEcriture ?? ctx.portee);
    setConfigsDefaut(snap.map(d => ({ id: d.id, ...d.data() } as ConfigDefaut)));
    setLoadingConfig(false);
  }

  function configDefautPour(role: Role) { return configsDefaut.find(c => c.role === role) ?? null; }

  function ouvrirEdition(role: Role) {
    if (!peutPlanifier) return;
    const c = configDefautPour(role);
    setValeurEdit(c ? String(c.valeur) : '');
    setIntervalleEdit(c ? String(c.intervalleJours) : '');
    setEditingRole(role);
  }

  async function sauvegarderConfig() {
    if (!editingRole) return;
    const valeur = parseFloat(valeurEdit);
    if (!valeur) return;
    setSavingConfig(true);
    const existing = configDefautPour(editingRole);
    if (existing) {
      await updateDoc(doc(db, 'recouvrement_config_defaut', existing.id), { valeur });
      setConfigsDefaut(prev => prev.map(c => c.id === existing.id ? { ...c, valeur } : c));
    } else {
      const intervalleJours = parseInt(intervalleEdit);
      if (!intervalleJours) { setSavingConfig(false); return; }
      const site = ctx.siteEcriture;
      if (!site) { setSavingConfig(false); return; }
      const ref = await addDoc(collection(db, 'recouvrement_config_defaut'), {
        siteId: site, userId, role: editingRole, valeur, intervalleJours, createdAt: serverTimestamp(),
      });
      setConfigsDefaut(prev => [...prev, { id: ref.id, role: editingRole!, valeur, intervalleJours }]);
    }
    setSavingConfig(false);
    setEditingRole(null);
  }

  async function reinitialiserConfig() {
    if (!editingRole) return;
    setReinitialisant(true);
    const c = configDefautPour(editingRole);
    if (c) {
      await deleteDoc(doc(db, 'recouvrement_config_defaut', c.id));
      setConfigsDefaut(prev => prev.filter(x => x.id !== c.id));
    }
    setReinitialisant(false);
    setEditingRole(null);
  }

  /* Ouvrir une ligne depuis le tableau n'entame pas de séance : c'est un
     dossier qu'on consulte, pas une tournée qu'on commence. Le mode série
     se réarme dans `suiviPuisSuivante`, qui seul enchaîne. */
  function ouvrirLigne(r: Recouvrement) {
    setEnSerie(false);
    ouvrirModal(r);
  }

  function ouvrirModal(r: Recouvrement) {
    setLigneActive(r);
    /* Le modal s'ouvre sur ce qu'on peut faire : celui qui n'encaisse pas
       tombait sur un volet vide, sans rien pour en sortir. */
    setModalOnglet(voletsDe(r.role).versement ? 'versement' : 'suivi');
    setValeurVersement('');
    setSuiviHeure(heureNow());
    /* Le sens suit l'échéance ouverte, non le partenaire : Ibrahim peut
       être client et fournisseur, mais cette ligne-ci est l'un ou l'autre.
       Posé en dur, un sens client restait choisi sur une échéance
       fournisseur — aucun bouton ne s'allumait, et enregistrer sans
       toucher à rien écrivait « il vient donner » sur un paiement. */
    setSuiviSens(sensDuRole(r.role)[0].key);
    setSuiviMontant('');
    setSuiviReliquatType('non_determine');
    setSuiviReliquatDate('');
    setSuiviDateReportage('');
  }

  function statutDuJour(r: Recouvrement): StatutContact | undefined {
    // cherché dans les suivis chargés, ici on n'a pas les suivis dans la liste principale
    return undefined;
  }

  function statutGlobal(r: Recouvrement): { label: string; color: string } {
    if (r.reste <= 0) return { label: 'Soldé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
    if (r.verse > 0) return { label: 'Partiel', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
    return { label: 'Non soldé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
  }

  /* Le client d'abord : c'est de lui que vient l'essentiel du recouvrement,
     et les cartes le montrent dans le même ordre. */
  /* Sans icône : la barre est une pilule, où trois libellés tiennent
     déjà la largeur d'un téléphone. */
  const sousOnglets: { key: SousOnglet; label: string }[] = [
    { key: 'clients',       label: 'Clients' },
    { key: 'fournisseurs',  label: 'Fournisseurs' },
    /* Le modèle par défaut vaut pour tous les partenaires du site : il
       engage plus qu'une échéance isolée, et relève donc du même droit. */
    ...(peutPlanifier
      ? [{ key: 'configuration' as const, label: 'Config par défaut' }]
      : []),
  ];

  const roleActif: Role = sousOnglet === 'fournisseurs' ? 'fournisseur' : 'client';

  /**
   * Qui tient quel volet, selon le côté de l'échéance.
   *
   * Deux gestes vivent dans ce modal : dire ce qui est convenu, et acter
   * ce qui a changé de main. Ils n'appartiennent pas aux mêmes personnes,
   * et pas dans le même sens.
   *
   * Côté client, la dette est celle du tiers : le chargé de recouvrement
   * l'appelle, convient d'une heure, puis encaisse. Les deux volets sont
   * le même métier, il les garde.
   *
   * Côté fournisseur, la dette est la nôtre : convenir d'un paiement
   * engage la maison, et cela revient à qui en répond. Le chargé de
   * recouvrement n'y décide rien — il porte l'argent et rend compte.
   *
   * D'où le partage : sur un fournisseur, le gérant convient mais ne
   * verse pas, le porteur verse mais ne convient pas. Aucun des deux n'a
   * les deux volets, et c'est ce qui rend l'écriture opposable.
   */
  function voletsDe(role: Role) {
    /* Verser, c'est avoir eu l'argent en main. Le gérant et le
       propriétaire décident — de ce qu'on réclame, de ce qu'on paie — et
       cette main-là ne leur revient pas. Leur laisser saisir un versement
       créerait une remise que personne n'a portée, attestée par celui-là
       même qui l'a décidée. */
    return {
      versement: roleSite === 'recouvrement',
      /* Côté client, chacun peut constater ce qu'on lui a répondu.
         Côté fournisseur, convenir engage la maison : le porteur n'y
         décide rien. */
      suivi: role === 'client' || peutReglerFournisseur(roleSite),
    };
  }

  const volets = ligneActive
    ? voletsDe(ligneActive.role)
    : { versement: true, suivi: true };
  const saisitVersement = volets.versement;
  const jourIso = todayStr();
  const amplitude = amplitudeRecouv(periode);

  /* Échu : du passé jusqu'à aujourd'hui inclus, ce qu'on peut réclamer.
     À venir : à partir de demain, ce qui n'est pas encore exigible.
     Le jour d'aujourd'hui appartient à l'échu, jamais aux deux. */
  const dansPeriode = (r: Recouvrement) => {
    const d = r.date ?? '';
    if (sensRecouv === 'echu') {
      if (d > jourIso) return false;
      if (periode === 'jour') return d === jourIso;
      return amplitude === null || d >= decalerJours(-amplitude);
    }
    if (d <= jourIso) return false;
    if (periode === 'jour') return d === decalerJours(1);
    return amplitude === null || d <= decalerJours(amplitude);
  };

  const parPeriode = recouvrements.filter(dansPeriode);

  /* Ouvrir sur le volet qui a quelque chose.
     La pastille de la barre annonce les échéances des deux côtés ; s'ouvrir
     d'office sur les clients quand tout est chez les fournisseurs envoie
     chercher « Aucun recouvrement aujourd'hui » là où la pastille en
     promettait deux. On ne bascule qu'une fois, au premier chargement :
     ensuite le choix appartient à celui qui navigue. */
  const basculeFaite = useRef(false);
  useEffect(() => {
    if (basculeFaite.current || loading || parPeriode.length === 0) return;
    basculeFaite.current = true;
    if (!parPeriode.some(r => r.role === 'client')
      && parPeriode.some(r => r.role === 'fournisseur')) {
      setSousOnglet('fournisseurs');
    }
  }, [loading, parPeriode]);
  const lignesDuJour = parPeriode.filter(r => {
    if (r.role !== roleActif) return false;
    const q = rechPartenaire.trim().toLowerCase();
    if (!q) return true;
    return (r.nomPartenaire ?? '').toLowerCase().includes(q)
      || (r.numeroPartenaire ?? '').toLowerCase().includes(q);
  });
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  /**
   * Où l'on en est dans la liste, et ce qui reste à voir.
   *
   * Un recouvreur revient de tournée avec dix résultats différents. Ouvrir
   * une ligne, saisir, refermer, rouvrir la suivante lui fait dix
   * allers-retours pour une seule séance de travail — et rien ne lui dit
   * où il s'est arrêté s'il est interrompu.
   *
   * La liste est celle qu'il a sous les yeux : mêmes filtres, même ordre.
   * Naviguer dans une autre le perdrait.
   */
  /* Les partenaires de la liste, dans l'ordre où elle les présente. Un
     nom ne revient qu'une fois, avec toutes ses échéances derrière lui. */
  const partenairesDuJour = (() => {
    const vus = new Map<string, Recouvrement[]>();
    for (const r of lignesDuJour) {
      const l = vus.get(r.partenaireId) ?? [];
      l.push(r);
      vus.set(r.partenaireId, l);
    }
    return [...vus.entries()].map(([id, lignes]) => ({ id, lignes }));
  })();

  /* Les échéances du partenaire ouvert : c'est sur elles qu'on s'engage
     quand on avance par personne. */
  const lotActif = ligneActive
    ? lignesDuJour.filter(r => r.partenaireId === ligneActive.partenaireId)
    : [];

  /**
   * Ce qu'on peut remettre sur l'échéance ouverte.
   *
   * Deux bornes, et la plus basse gagne. Ce qui est convenu : on ne donne
   * pas plus qu'on ne s'est engagé à donner. Ce qui est en poche : on ne
   * donne pas ce qu'on n'a pas pris.
   *
   * Côté client la seconde ne joue pas — l'argent vient du tiers, il n'est
   * pas sorti d'un tiroir.
   */
  const bornesVersement = (() => {
    if (!ligneActive) return { promis: 0, poche: null as number | null, plafond: 0 };
    const promis = ligneActive.convenu ?? ligneActive.valeur;
    const restePromis = Math.max(0, promis - ligneActive.verse);
    if (ligneActive.role === 'client') {
      return { promis, poche: null, plafond: restePromis };
    }
    const poche = enPochePourEcheance(missions, ligneActive.id, userId);
    /* Déjà remis sur cette échéance : ce qui reste en main s'en déduit. */
    const resteEnMain = Math.max(0, poche - ligneActive.verse);
    return { promis, poche: resteEnMain, plafond: Math.min(restePromis, resteEnMain) };
  })();

  /* Le pas de navigation : une personne, ou un dossier. */
  const parPersonne = parQui === 'partenaire';
  const file: Recouvrement[] = parPersonne
    ? partenairesDuJour.map(p => p.lignes[0])
    : lignesDuJour;
  const rangActif = ligneActive
    ? file.findIndex(r => parPersonne
        ? r.partenaireId === ligneActive.partenaireId
        : r.id === ligneActive.id)
    : -1;
  const suivante = rangActif >= 0 && rangActif < file.length - 1
    ? file[rangActif + 1] : null;
  const precedente = rangActif > 0 ? file[rangActif - 1] : null;
  /* Ce qui a déjà reçu un suivi pendant cette séance : le point vert dit
     ce qui est fait sans qu'il faille y retourner pour le vérifier. */
  const dejaSuivi = (r: Recouvrement) => suivisFaits.has(r.id);


  /* Ce qu'un site a à recouvrer sur la période, des deux côtés. Le
     retard compte séparément : une échéance passée n'attend plus, elle
     réclame. */
  function chiffresDuSite(id: string) {
    const siens = parPeriode.filter(r => r.siteId === id);
    const c = siens.filter(r => r.role === 'client');
    const f = siens.filter(r => r.role === 'fournisseur');
    return {
      total: siens.length,
      resteC: c.reduce((n, r) => n + r.reste, 0),
      resteF: f.reduce((n, r) => n + r.reste, 0),
      nbC: c.length,
      nbF: f.length,
      enRetard: siens.filter(r => (r.date ?? '') < jourIso).length,
    };
  }

  const lignesF = parPeriode.filter(r => r.role === 'fournisseur');
  const lignesC = parPeriode.filter(r => r.role === 'client');
  const totalF = lignesF.reduce((s, r) => s + r.valeur, 0);
  const verseF = lignesF.reduce((s, r) => s + r.verse, 0);
  const resteF = lignesF.reduce((s, r) => s + r.reste, 0);
  const totalC = lignesC.reduce((s, r) => s + r.valeur, 0);
  const verseC = lignesC.reduce((s, r) => s + r.verse, 0);
  const resteC = lignesC.reduce((s, r) => s + r.reste, 0);

  /**
   * Le trajet de l'argent qu'on doit aux fournisseurs, sur la période.
   *
   * Cinq chiffres, deux échelles. Dû et convenu parlent de décision : ce
   * qu'on nous réclame, ce qu'on a promis. Versé, à récupérer et en poche
   * parlent d'emplacement : chez le fournisseur, au tiroir, dans une
   * poche. Mêlés sur une même barre, ils ne se liraient plus.
   *
   * Un franc promis se trouve toujours à un seul de ces trois endroits,
   * jamais deux : c'est ce qui permet de les mettre bout à bout.
   */
  const convenuF = lignesF.reduce(
    (n, r) => n + (r.convenu ?? 0), 0);
  /* Les missions de la période, rattachées à ces échéances. */
  const missionsF = missions.filter(m =>
    m.journalIds.some(id => lignesF.some(r => r.id === id)));
  /* Ce qui est sorti du tiroir pour être porté, tous états confondus : une
     mission soldée a bien vu l'argent sortir, et il faut le compter pour
     savoir ce qui reste à prendre. */
  const missionsPorteesF = missionsF.filter(m => m.mode === 'porte');
  const retireF = missionsPorteesF
    .filter(m => m.etat === 'retiree' || m.etat === 'soldee')
    .reduce((n, m) => n + (m.montantRetire ?? 0), 0);

  /* Ce qu'on a promis de porter : le convenu du mode porté, non la somme
     des missions. Partir des missions ferait dépendre le chiffre de leur
     bonne création ; partir du convenu le fait dépendre de l'engagement,
     qui est la vérité. Une mission oubliée se verrait alors comme un
     manque, au lieu de disparaître du compte. */
  const convenuPorteF = lignesF
    .filter(r => r.sensConvenu === 'nous_allons_donner')
    .reduce((n, r) => n + (r.convenu ?? 0), 0);

  /* Ce qui attend encore au tiroir. */
  const aRecupererF = Math.max(0, convenuPorteF - retireF);

  /* Ce qui est dehors : sorti du tiroir, pas encore arrivé. Compter le
     seul retrait laissait une mission à moitié remise pour entièrement
     en poche. */
  const remisF = missionsPorteesF.reduce((n, m) => n + (m.montantRemis ?? 0), 0);
  const enPocheF = Math.max(0, retireF - remisF);

  /* Ce que le fournisseur vient prendre lui-même : convenu, mais hors du
     circuit du porteur. Le mêler à ce qu'on doit porter ferait croire à
     celui-ci qu'il a plus à faire qu'en réalité. */
  const parLeFournisseurF = lignesF
    .filter(r => r.sensConvenu === 'il_vient_recuperer')
    .reduce((n, r) => n + Math.max(0, (r.convenu ?? 0) - r.verse), 0);

  /**
   * Ce que la carte montre : les missions, decoupees par mode.
   *
   * Les echeances disent ce qu'on doit ; les missions disent ce qu'on a
   * decide d'en faire. La carte porte sur l'engagement pris, non sur la
   * dette — et un engagement se prend toujours d'une des deux facons :
   * quelqu'un porte l'argent, ou le fournisseur vient le prendre.
   *
   * Une mission annulee ne pese rien : elle n'a jamais engage personne.
   */
  /**
   * Les missions du porteur : ce qu'on lui a confie a emporter.
   *
   * Deux champs les designent. `mode` dit par ou l'argent sort — porte
   * par quelqu'un, ou pris au comptoir par le fournisseur lui-meme ; seul
   * le mode porte le concerne. `porteurUid` dit qui l'emporte : la sienne,
   * ou celle que personne n'a encore prise.
   *
   * Une mission sans porteur designe lui revient : le site n'en compte
   * qu'un, rien ne sert de nommer ce qui ne peut echoir qu'a lui. Le jour
   * ou ils seront deux, cette condition devra tomber — sans quoi chacun
   * verrait la mission libre de l'autre et croirait devoir la faire.
   */
  const missionsVivesF = missionsF.filter(m => m.etat !== 'annulee');
  const missionsAMoiF = missionsVivesF.filter(m => m.mode === 'porte'
    && (!m.porteurUid || m.porteurUid === userId));

  /**
   * Les journaux dont il a la mission.
   *
   * Le grand chiffre part de la, non de la somme des missions : le journal
   * porte la valeur reelle de l'echeance, la mission porte ce qu'on a
   * convenu d'en verser le jour J. Les confondre effacait justement
   * l'ecart entre les deux — le non decide.
   */
  const journauxAMoiF = new Set(
    missionsAMoiF.flatMap(m => m.journalIds ?? []));
  const reelAMoiF = lignesF
    .filter(r => journauxAMoiF.has(r.id))
    .reduce((n, r) => n + r.valeur, 0);
  /* Ce que ses missions portent : le convenu, total ou partiel. */
  const convenuAMoiF = missionsAMoiF.reduce((n, m) => n + m.montant, 0);
  /* L'ecart : ce que le suivi de contact n'a pas engage. */
  const nonDecideAMoiF = Math.max(0, reelAMoiF - convenuAMoiF);
  /* Les versements reels, non ce qui etait prevu. */
  const verseAMoiF = missionsAMoiF.reduce(
    (n, m) => n + (m.montantRemis ?? 0), 0);
  const resteAMoiF = Math.max(0, convenuAMoiF - verseAMoiF);

  /* Ce qui dort encore au tiroir a son nom : ordonne ou confirme, tant
     qu'il n'a pas l'argent en main, il doit aller le chercher. */
  const missionsAPrendreF = missionsAMoiF.filter(
    m => m.etat === 'ordonnee' || m.etat === 'confirmee');
  const aRecupererAMoiF = missionsAPrendreF.reduce((n, m) => n + m.montant, 0);


  /* Ce que les porteurs ont en main, nommé : un total dit combien est
     dehors, jamais chez qui. */
  const porteursF = (() => {
    const parUid = new Map<string, { nom: string; montant: number }>();
    for (const m of missionsPorteesF.filter(x => x.etat === 'retiree')) {
      const uid = m.porteurUid ?? '—';
      const lot = parUid.get(uid) ?? { nom: m.porteurNom ?? '—', montant: 0 };
      /* Ce qu'il lui reste en main : remis déduit. */
      lot.montant += Math.max(0, (m.montantRetire ?? 0) - (m.montantRemis ?? 0));
      parUid.set(uid, lot);
    }
    return [...parUid.values()].sort((a, b) => b.montant - a.montant);
  })();

  /* Le chargé de recouvrement porte l'argent, il ne décide pas de ce
     qu'on paie : la dette, ce qui n'est pas décidé, ce que le fournisseur
     vient prendre — rien de cela n'est son travail. */
  const vueDuPorteur = roleSite === 'recouvrement';
  /**
   * Ce que la carte couvre, selon qui la regarde.
   *
   * Le porteur y lit son propre travail : ce qu'il doit aller chercher.
   * Le gerant et le proprio y lisent celui de la maison — tout ce qui
   * dort encore au tiroir, porte comme comptoir, car ils surveillent
   * aussi les fournisseurs qui devaient passer prendre leur argent.
   */
  const missionsDeLaCarteF = vueDuPorteur ? missionsAMoiF : missionsVivesF;
  const missionsAPrendreCarteF = missionsDeLaCarteF.filter(
    m => m.etat === 'ordonnee' || m.etat === 'confirmee');
  const aRecupererCarteF = missionsAPrendreCarteF.reduce(
    (n, m) => n + m.montant, 0);
  /**
   * Ce que le porteur voit, et il ne voit que cela.
   *
   * Sa carte se construit sur ses missions, par état — non sur les
   * échéances du site. Ce qu'on doit recouvrir, ce qui est convenu, ce qui
   * n'est pas décidé : rien de cela n'est son travail, et le lui montrer
   * lui donnait à lire la gestion de la maison.
   *
   * Trois états, trois chiffres : ce qui l'attend au tiroir, ce qu'il
   * porte, ce qu'il a déjà remis.
   */
  /* Ses missions se prennent sur toutes, non sur celles de la periode.
     Les echeances se filtrent par date parce qu'on gere un calendrier ;
     lui ne gere pas de calendrier, il porte de l'argent. Une mission
     rattachee a une echeance du mois dernier est toujours dans sa poche
     aujourd'hui, et sa carte tombait a zero des que le filtre ne laissait
     plus passer l'echeance d'origine. */
  const mesMissions = missions.filter(m => m.mode === 'porte'
    && (!m.porteurUid || m.porteurUid === userId));
  const aMoiARetirer = mesMissions
    .filter(m => m.etat === 'ordonnee' || m.etat === 'confirmee')
    .reduce((n, m) => n + m.montant, 0);
  const aMoiEnMain = mesMissions
    .filter(m => m.etat === 'retiree' && m.porteurUid === userId)
    .reduce((n, m) => n + Math.max(0,
      (m.montantRetire ?? 0) - (m.montantRemis ?? 0)), 0);
  const aMoiRemis = mesMissions
    .filter(m => m.porteurUid === userId)
    .reduce((n, m) => n + (m.montantRemis ?? 0), 0);
  const nbAMoi = mesMissions.filter(
    m => m.etat !== 'soldee' && m.etat !== 'annulee').length;

  /* Ce que les tiers doivent en tout. C'est un solde : il ne connaît pas la
     période, là où les échéances ci-dessous la suivent. Les mêler dans une
     même carte ferait comparer deux chiffres qui ne parlent pas du même
     temps — d'où cette ligne à part, qui rappelle le contexte sans
     prétendre s'y rapporter. */
  const duClients = [...(soldes?.client?.values() ?? [])]
    .reduce((n, t) => n + t.reste, 0);
  const duFournisseurs = [...(soldes?.fournisseur?.values() ?? [])]
    .reduce((n, t) => n + t.reste, 0);

  return (
    <div>
      {/* Le filtre porte sur tout l'écran, cartes comprises : le poser sous
          elles laisserait croire qu'il ne touche que le tableau. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'hidden'}>{titre}</p>
        <div className="flex flex-wrap items-center gap-2">
        {ctx.ensemble && (
          <div className="flex items-center gap-2">
            {/* Un total dit combien il reste à recouvrer, jamais quelle
                boutique a laissé filer ses échéances. */}
            <ToggleVue actif={ctx.vue} onChange={ctx.setVue} />
            <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
          </div>
        )}
        </div>
      </div>

      {ctx.parSite ? (
        /* Une carte par site : ce qu'il attend, des deux côtés. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          return {
            titre: 'À recouvrer',
            valeur: formatMontant(c.resteC + c.resteF),
            dort: c.total === 0,
            /* Le retard passe devant : c'est lui qui réclame un geste. */
            badge: c.enRetard > 0
              ? {
                  texte: `${c.enRetard} en retard`,
                  ton: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
                }
              : c.total > 0
                ? {
                    texte: `${c.total} échéance${c.total > 1 ? 's' : ''}`,
                    ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                  }
                : null,
            lignes: [
              { label: `Clients · ${c.nbC}`, valeur: formatMontant(c.resteC),
                vide: c.resteC === 0, ton: 'text-orange-500' },
              { label: `Fournisseurs · ${c.nbF}`, valeur: formatMontant(c.resteF),
                vide: c.resteF === 0, ton: 'text-red-500' },
            ],
          };
        }} />
      ) : (
      <>
      {/* Trois choses de natures différentes se disputaient une seule ligne
          enroulante : l'état des comptes, la période lue, et les commandes
          qui la changent. Sur un téléphone elles tombaient où elles
          pouvaient — la date d'un côté, son filtre à la ligne suivante.
          Elles se rangent par rôle : ce qui se lit, puis ce qui commande. */}
      {!loading && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4">

          {/* L'état des comptes, hors filtre : ce que les échéances viennent
              recouvrer. Discret, parce qu'il ne se lit qu'en arrière-plan
              des chiffres qui suivent. */}
          {(duClients > 0 || duFournisseurs > 0) ? (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-gray-400">
              <span>
                Créances{' '}
                <span className="font-bold text-gray-600 dark:text-gray-300">
                  {formatMontant(duClients)}
                </span>
              </span>
              <span>
                Dettes{' '}
                <span className="font-bold text-gray-600 dark:text-gray-300">
                  {formatMontant(duFournisseurs)}
                </span>
              </span>
              {/* La précision prenait sa propre ligne sur un téléphone, pour
                  n'ajouter rien que les deux mots ne disent déjà. */}
              <span className="hidden text-gray-300 sm:inline dark:text-gray-600">
                tous comptes, hors période
              </span>
            </p>
          ) : <span className="hidden sm:block" />}

          {/* Échu / à venir et la période filtrent aussi les cartes : les
              poser sous elles laissait croire qu'ils ne touchaient que le
              tableau. */}
          {(sousOnglet === 'fournisseurs' || sousOnglet === 'clients') && (
            <div className="flex items-center gap-2">
              {/* Les deux commandes d'abord, la date qu'elles produisent
                  ensuite : séparées par un retour à la ligne, on ne voyait
                  plus laquelle produisait l'autre. */}
              <div className="flex shrink-0 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
                {([
                  { key: 'echu' as const,   label: 'Échu' },
                  { key: 'avenir' as const, label: 'À venir' },
                ]).map(o => (
                  <button key={o.key} onClick={() => setSensRecouv(o.key)}
                    className={`px-3 py-1.5 text-xs font-bold transition-colors sm:py-2 ${sensRecouv === o.key ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-indigo-600'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="shrink-0">
                <PeriodFilter<PeriodeRecouv>
                  periode={periode} onChange={setPeriode}
                  options={PERIODES_RECOUV.map(p => ({
                    key: p.key,
                    label: sensRecouv === 'echu' ? p.labelEchu : p.labelAvenir,
                  }))} />
              </div>
              <p className="min-w-0 truncate text-xs capitalize text-gray-400">
                {sensRecouv === 'echu' && periode === 'jour'
                  ? today
                  : `${sensRecouv === 'echu' ? 'Échu' : 'À venir'} · ${(PERIODES_RECOUV.find(p => p.key === periode) ?? PERIODES_RECOUV[0])[sensRecouv === 'echu' ? 'labelEchu' : 'labelAvenir']}`}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Les sous-onglets sous la ligne de contexte, au-dessus des cartes :
          ils commandent tout ce qui suit, cartes comprises. Posés dessous,
          ils se lisaient comme un filtre du seul tableau, alors que les
          chiffres du haut changent avec eux. */}
      {!loading && (
        <div className="mb-4 flex">
          <div className="flex gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
            {sousOnglets.map(o => {
              const actif = sousOnglet === o.key;
              /* Le porteur compte ses missions, non les echeances du
                 site : la pastille annoncait deux fournisseurs la ou une
                 seule mission lui revenait, et le chiffre promettait un
                 travail qui n'etait pas le sien. */
              const count = o.key === 'configuration' ? null
                : o.key === 'fournisseurs' && vueDuPorteur
                ? missionsAMoiF.length
                : parPeriode.filter(r => r.role === (o.key === 'fournisseurs' ? 'fournisseur' : 'client')).length;
              return (
                <button key={o.key} onClick={() => setSousOnglet(o.key)}
                  className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    actif
                      ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                      : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
                  {count !== null ? `${o.label} (${count})` : o.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Ce qu'il doit aller chercher au tiroir, en pleine largeur au-dessus
          du reste : c'est le geste du jour, et un geste se signale avant ce
          qui se contemple.

          Elle ne parait que s'il y a quelque chose a prendre — un zero
          n'appelle aucun geste, et une carte qui ne sert qu'a dire « rien »
          occupe la place de celles qui disent quelque chose. */}
      {!loading && sousOnglet === 'fournisseurs'
        && (vueDuPorteur || peutReglerFournisseur(roleSite))
        && aRecupererCarteF > 0 && (
        <button type="button" onClick={() => setFeuilleCaisse(true)}
          className="mb-3 flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left shadow-sm transition-colors active:bg-amber-100 dark:border-amber-800/30 dark:bg-amber-900/10 dark:active:bg-amber-900/20 sm:p-5">
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-900/30">
              <Wallet size={17} className="text-amber-600" />
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] font-bold uppercase tracking-wide text-amber-700/70 dark:text-amber-400/70">
                À récupérer à la caisse
              </span>
              <span className={`${hankenGrotesk.className} block truncate text-[19px] font-bold leading-7 tracking-tight text-amber-700 dark:text-amber-400 sm:text-[22px]`}>
                {formatMontant(aRecupererCarteF)}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="rounded-lg bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 sm:px-2.5 sm:text-xs">
              {missionsAPrendreCarteF.length}
            </span>
            <ChevronRight size={16} className="text-amber-500" />
          </span>
        </button>
      )}

      {/* Ou est l'argent deja sorti, et chez qui.

          Ce qui reste au tiroir n'est plus ici : la carte au-dessus le
          porte, en plus gros, a deux centimetres de la. Un meme total lu
          deux fois de suite fait douter d'avoir bien lu le premier.

          Ne reste que ce qu'elle seule sait dire : le nom de celui qui
          porte l'argent, et ce que le fournisseur doit venir prendre
          lui-meme. Un total dit combien est dehors, jamais dans quelle
          poche.

          La ligne disparait quand il n'y a rien : une absence est une
          information, la ou un zero n'en est pas une. */}
      {!loading && sousOnglet === 'fournisseurs' && !vueDuPorteur && (
        (porteursF.length > 0 || parLeFournisseurF > 0) && (
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800/30 dark:bg-amber-900/10">
            <AlertCircle size={14} className="shrink-0 text-amber-500" />
            {/* Nommé, sinon le chiffre ne dit pas à qui demander. */}
            {porteursF.map(pr => (
              <span key={pr.nom} className="text-xs text-amber-800 dark:text-amber-300">
                <span className="font-bold">{formatMontant(pr.montant)}</span>
                {' chez '}{pr.nom}
              </span>
            ))}
            {/* L'autre chemin : le fournisseur vient prendre lui-même, et
                cela ne passe par aucun porteur. */}
            {parLeFournisseurF > 0 && (
              <span className="text-xs text-amber-800/80 dark:text-amber-300/80">
                <span className="font-bold">{formatMontant(parLeFournisseurF)}</span>
                {' '}attendus au tiroir par le fournisseur
              </span>
            )}
          </div>
        )
      )}

      {/* La carte du côté ouvert, et elle seule. Les deux ensemble
          répondaient à une question qu'on ne pose plus : la bascule a
          déjà choisi de quel côté on travaille, et montrer l'autre chiffre
          oblige à vérifier à chaque fois lequel des deux on lit.
          Seule, elle reprend la largeur entière — c'est le chiffre du
          moment, il n'a plus à se partager l'écran. */}
      {loading ? null : (
        <div className="mb-5">
            {sousOnglet === 'clients' && (
            <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
                  👥
                </span>
                {/* Il disait ce que porte le grand chiffre — un reste, non
                    un total — et il disparaîssait justement sur l'écran où
                    la place manque pour le deviner. */}
                <span className="shrink-0 rounded-lg bg-neutral-100 px-2 py-1 text-[10px] font-bold text-neutral-500 sm:px-2.5 sm:text-xs dark:bg-neutral-800 dark:text-neutral-400">
                  À recouvrir
                </span>
              </div>
              <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                Clients
              </p>
              <p className={`${hankenGrotesk.className} mt-0.5 text-[19px] font-bold leading-7 tracking-tight text-neutral-900 sm:text-[26px] sm:leading-8 dark:text-white`}>
                {formatMontant(resteC)}
              </p>
              <div className="mt-2.5 flex flex-col gap-1 border-t border-black/[0.06] pt-2 text-xs sm:flex-row sm:justify-between sm:gap-2 dark:border-white/10">
                  {/* « Total » laissait croire à un total général : c'est la
                      somme des échéances tombant dans la période filtrée,
                      ce qui était prévu de rentrer. Le grand chiffre en est
                      le reste, une fois retiré ce qui a été versé. */}
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-neutral-400">Attendu</span>
                    <span className="font-bold text-neutral-900 dark:text-white">{formatMontant(totalC)}</span>
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-neutral-400">Versé</span>
                    <span className="font-bold text-green-600">{formatMontant(verseC)}</span>
                  </span>
              </div>
            </div>
            )}

            {sousOnglet === 'fournisseurs' && (
            /* Deux barres, deux questions. La première : où en est ce qu'on
               doit recouvrir — combien on a décidé de payer. La seconde :
               où est l'argent décidé. Une seule barre à cinq segments
               mêlerait la décision et l'emplacement, et ne dirait plus ni
               l'une ni l'autre.

               Ce qui bouge n'est plus ici : il appelle un geste, et un
               geste se signale au-dessus de ce qui se contemple. */
            <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-900 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
                  🤝
                </span>
              </div>

              <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
                À recouvrir
              </p>
              <p className={`${hankenGrotesk.className} mt-0.5 text-[19px] font-bold leading-7 tracking-tight text-neutral-900 sm:text-[26px] sm:leading-8 dark:text-white`}>
                {formatMontant(vueDuPorteur ? reelAMoiF : totalF)}
              </p>

              <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div className="h-full bg-indigo-600"
                  style={{ width: `${vueDuPorteur
                    ? (reelAMoiF > 0 ? Math.min(100, (convenuAMoiF / reelAMoiF) * 100) : 0)
                    : (totalF > 0 ? Math.min(100, (convenuF / totalF) * 100) : 0)}%` }} />
              </div>
              <p className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-neutral-400">Convenu</span>
                  <span className="font-bold text-indigo-600 dark:text-indigo-400">{formatMontant(vueDuPorteur ? convenuAMoiF : convenuF)}</span>
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="text-neutral-400">Non décidé</span>
                  <span className="font-bold text-neutral-500">{formatMontant(vueDuPorteur ? nonDecideAMoiF : Math.max(0, totalF - convenuF))}</span>
                </span>
              </p>

              {/* Sur le convenu, non sur ce qu'on doit recouvrir : on a tenu
                  quand on a donné ce qu'on avait promis. */}
              <p className="mt-2.5 flex items-baseline justify-between gap-3 border-t border-black/[0.06] pt-2 text-xs dark:border-white/10">
                <span className="text-neutral-400">Versé</span>
                <span className="font-bold text-green-600">{formatMontant(vueDuPorteur ? verseAMoiF : verseF)}</span>
              </p>
              <p className="mt-1 flex items-baseline justify-between gap-3 text-xs">
                <span className="text-neutral-400">Reste à fournir</span>
                <span className="font-bold text-red-500">{formatMontant(vueDuPorteur ? resteAMoiF : Math.max(0, convenuF - verseF))}</span>
              </p>
            </div>
            )}
        </div>
      )}

      {/* ===== FOURNISSEURS / CLIENTS ===== */}
      {(sousOnglet === 'fournisseurs' || sousOnglet === 'clients') && (
        loading
          ? <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-indigo-500" /></div>
          : (
            <>

              <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">

              {/* La recherche porte sur ce tableau : la laisser dehors la
                  faisait passer pour un filtre de la page entière.
                  Le porteur n'a pas ce tableau — il lit ses missions — et
                  cette barre lui offrait de chercher dans une liste qu'il
                  ne voit pas, puis de faire des versements ligne par ligne
                  sur des échéances dont il ne décide rien. */}
              {!(vueDuPorteur && sousOnglet === 'fournisseurs') && (
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <ChampRecherche placeholder="Rechercher un partenaire…" valeur={rechPartenaire} onChange={setRechPartenaire} className="flex-1 min-w-[180px]" />
                {lignesDuJour.length > 0 && (
                  <span className={`shrink-0 rounded-xl px-2.5 py-1 text-xs font-bold ${sensRecouv === 'echu'
                    ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'
                    : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'}`}>
                    {lignesDuJour.length} {sensRecouv === 'echu' ? 'à traiter' : 'à venir'}
                  </span>
                )}
                {/* Un recouvrement se pose aussi d'ici : le partenaire se
                    choisit dans le modal, le reste du parcours est celui de
                    sa fiche. */}
                {/* Une tournée se rend compte d'un trait : dix échéances,
                    c'était dix fois ouvrir, saisir, refermer. Le bouton
                    enchaîne les lignes de la liste telle qu'elle est
                    filtrée — cliquer sur une ligne reste autre chose : on
                    ouvre un dossier, on n'entame pas une tournée.
                    Il reste là dès qu'il y a une échéance : un bouton qui
                    paraît au-delà d'un seuil ne se trouve jamais. */}
                {lignesDuJour.length > 0 && (
                  <button onClick={demarrerSerie}
                    className="flex shrink-0 items-center gap-1.5 rounded-xl border border-indigo-200 px-3 py-2 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-400 dark:hover:bg-indigo-900/20">
                    {/* Le mot suit le geste : celui qui porte l'argent
                        fait des versements, celui qui décide fait des
                        suivis. Le même libellé pour les deux ferait
                        chercher un volet que l'un des deux n'a pas. */}
                    <Check size={13} />
                    {voletsDe(roleActif).suivi ? 'Faire les suivis' : 'Faire les versements'}
                  </button>
                )}
                {/* Une échéance appartient au site qui la réclamera :
                    sans site désigné, la saisie n'aboutissait pas. */}
                {ctx.siteEcriture && peutPlanifier && (
                  <button
                    onClick={() => ouvrirAjout(sousOnglet === 'fournisseurs' ? 'fournisseur' : 'client')}
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
                    <Plus size={13} /> Ajouter
                  </button>
                )}
              </div>
              )}

              {/* Le porteur lit ses missions, non les échéances du site : le
                  tableau lui montrait ce qu'on doit recouvrir, ce qui est
                  convenu, ce qui n'est pas décidé — la gestion de la
                  maison, dont il ne fait rien. */}
              {vueDuPorteur && sousOnglet === 'fournisseurs' ? (
                <ListeMissions missions={mesMissions} />
              ) : lignesDuJour.length === 0 ? (
                <div className="text-center py-16 text-gray-400">
                  <Calendar size={36} className="mx-auto mb-3 opacity-20" />
                  <p className="text-sm font-medium">{rechPartenaire.trim()
                    ? 'Aucun résultat'
                    : sensRecouv === 'avenir'
                      ? 'Aucune échéance à venir sur cette période'
                      : periode === 'jour' ? "Aucun recouvrement aujourd'hui" : 'Aucun recouvrement sur cette période'}</p>
                  <p className="text-xs mt-1">Les recouvrements planifiés pour aujourd'hui apparaîtront ici</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <p className="text-sm font-medium text-gray-500 mb-2">
                    {lignesDuJour.length} recouvrement{lignesDuJour.length > 1 ? 's' : ''}
                  </p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">{sousOnglet === 'fournisseurs' ? 'Fournisseur' : 'Client'}</th>
                        {ctx.ensemble && <th className="text-center px-4 py-3 font-medium">Site</th>}
                        <th className="text-center px-4 py-3 font-medium">Numéro</th>
                        {/* Quand l'échéance tombe, et où elle en est : sans ces
                            deux colonnes, rien ne distinguait une échéance
                            dépassée d'une échéance à venir. */}
                        <th className="text-center px-4 py-3 font-medium">Date</th>
                        <th className="text-center px-4 py-3 font-medium">Dernier versement</th>
                        <th className="text-center px-4 py-3 font-medium">Recouvrement</th>
                        {/* Ce qu'on s'est engagé à verser, qui n'est pas ce
                            qui est dû : une échéance de 2 000 dont on a
                            convenu 1 500 ne réclame plus que 1 500. Sans
                            cette colonne, l'engagement ne vivait que dans
                            le suivi, qu'il fallait ouvrir pour le lire. */}
                        <th className="text-center px-4 py-3 font-medium">Convenu</th>
                        <th className="text-center px-4 py-3 font-medium">Suivi de contact</th>
                        <th className="text-center px-4 py-3 font-medium">Reliquat</th>
                        <th className="text-center px-4 py-3 font-medium">Versé</th>
                        <th className="text-center px-4 py-3 font-medium">Reste</th>
                        <th className="text-center px-4 py-3 font-medium">Statut</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {lignesDuJour.map(r => {
                        const jours = joursDepuis(r.dernierVersementDate);
                        const s = statutGlobal(r);
                        return (
                          <tr key={r.id} onClick={() => ouvrirLigne(r)}
                            className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{r.nomPartenaire}</td>
                            {ctx.ensemble && <CelluleSite nom={ctx.nomDe(r.siteId)} />}
                            <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-center">{r.numeroPartenaire || '—'}</td>
                            <td className="px-4 py-3 text-center text-gray-500 dark:text-gray-400">
                              {new Date(r.date).toLocaleDateString('fr-FR')}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {jours !== null ? (
                                <div>
                                  <p className="text-xs text-gray-400">Il y a {jours} jour{jours > 1 ? 's' : ''}</p>
                                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{formatMontant(r.dernierVersementMontant ?? 0)}</p>
                                </div>
                              ) : <span className="text-gray-400">—</span>}
                            </td>
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(r.valeur)}</td>
                            {/* Rien de convenu n'est pas zéro convenu : le
                                tiret dit qu'on n'a pas encore décidé, là où
                                zéro dirait qu'on a décidé de ne rien verser. */}
                            <td className="px-4 py-3 text-center">
                              {r.convenu == null ? (
                                <span className="text-gray-300 dark:text-gray-600">—</span>
                              ) : (
                                <span className={`font-bold ${
                                  r.convenu === 0 ? 'text-gray-400'
                                    : r.convenu < r.valeur ? 'text-amber-600 dark:text-amber-500'
                                    : 'text-indigo-600 dark:text-indigo-400'}`}>
                                  {formatMontant(r.convenu)}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-gray-400 text-center">—</td>
                            <td className="px-4 py-3 text-center">
                              {r.reliquat
                                ? <span className="text-purple-600 dark:text-purple-400 font-medium">{new Date(r.reliquat).toLocaleDateString('fr-FR')}</span>
                                : <span className="text-gray-400">—</span>}
                            </td>
                            <td className="px-4 py-3 text-green-600 font-medium text-center">{r.verse > 0 ? formatMontant(r.verse) : '—'}</td>
                            <td className="px-4 py-3 font-medium text-red-500 text-center">{formatMontant(r.reste)}</td>
                            <td className="px-4 py-3 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.color}`}>{s.label}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              </div>
            </>
          )
      )}

      {/* ===== CONFIGURATION PAR DÉFAUT ===== */}
      {sousOnglet === 'configuration' && (
        loadingConfig
          ? <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-indigo-500" /></div>
          : (
            <div className="space-y-4">
              <p className="text-xs text-gray-400 mb-2">
                Cette configuration sera proposée automatiquement lors d'un achat avec dette ou d'une vente avec créance.
              </p>
              {/* Chaque site a son modèle : hors d'un site, les afficher
                  ensemble laisserait croire qu'il n'y en a qu'un, et le
                  modifier n'écrirait nulle part. */}
              {!ctx.siteEcriture && (
                <p className="rounded-xl bg-gray-50 p-3 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  Choisissez un site pour voir et modifier son modèle.
                </p>
              )}
              {(['fournisseur', 'client'] as Role[]).map(role => {
                const c = configDefautPour(role);
                const accent = role === 'fournisseur' ? 'text-amber-600' : 'text-indigo-600';
                return (
                  <div key={role} className="border border-gray-100 dark:border-gray-800 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className={`text-sm font-bold ${accent}`}>{role === 'fournisseur' ? 'Fournisseur' : 'Client'}</p>
                      {ctx.siteEcriture && (
                        <button onClick={() => ouvrirEdition(role)} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">
                          {c ? 'Modifier' : 'Configurer'}
                        </button>
                      )}
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
                      <p className="text-xs text-gray-400">
                        {/* Hors d'un site, le bouton « Configurer » n'existe
                            pas : y renvoyer enverrait chercher l'introuvable. */}
                        {ctx.siteEcriture
                          ? 'Aucune configuration par défaut — cliquez sur "Configurer"'
                          : 'Aucune configuration par défaut'}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )
      )}
      </>
      )}

      {/* ===== MODAL LIGNE ===== */}
      {ligneActive && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          {/* L'en-tête tient, le corps défile : tout le modal en
              `overflow-y-auto` laissait le titre partir vers le haut, et
              sur un téléphone la fenêtre se bloquait dès que le contenu
              dépassait la hauteur donnée. */}
          <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900">
            {/* Header modal */}
            <div className="flex shrink-0 items-center justify-between border-b border-gray-100 p-5 dark:border-gray-800">
              <div className="min-w-0">
                {/* En tête de tout : il nomme l'écran, et ce qui nomme
                    précède ce qui est nommé. Plus bas, il passait pour le
                    titre d'une section parmi d'autres. */}
                {volets.versement !== volets.suivi && (
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-indigo-500 dark:text-indigo-400">
                    {volets.versement ? 'Versement' : 'Suivi de contact'}
                  </p>
                )}
                <p className="flex items-center gap-2 text-sm font-bold text-gray-900 dark:text-gray-100">
                  {ligneActive.nomPartenaire}
                  {/* L'œil déplie ce sur quoi on s'engage : par personne, le
                      total ne dit pas de quelles échéances il est fait. */}
                  {parPersonne && lotActif.length > 1 && (
                    <button onClick={() => setVoirDetail(v => !v)}
                      title={voirDetail ? 'Masquer le détail' : 'Voir les échéances'}
                      className={`shrink-0 transition-colors ${
                        voirDetail ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-300 hover:text-gray-500'}`}>
                      <Eye size={14} />
                    </button>
                  )}
                </p>
                {/* Par personne, c'est le lot qui compte — un seul chiffre
                    pour tout ce qu'on lui doit sur la période. */}
                {parPersonne && lotActif.length > 1 ? (
                  <p className="mt-0.5 text-xs text-gray-400">
                    {lotActif.length} échéances · {formatMontant(lotActif.reduce((n, r) => n + r.valeur, 0))}
                    {' · '}Reste {formatMontant(lotActif.reduce((n, r) => n + r.reste, 0))}
                  </p>
                ) : (
                  <p className="text-xs text-gray-400 mt-0.5">Recouvrement · {formatMontant(ligneActive.valeur)} · Reste {formatMontant(ligneActive.reste)}</p>
                )}

                {/* Le détail du lot, quand on l'a demandé. */}
                {parPersonne && voirDetail && lotActif.length > 1 && (
                  <div className="mt-2 space-y-1 rounded-xl bg-gray-50 p-2 dark:bg-gray-800/60">
                    {lotActif.map(r => (
                      <p key={r.id} className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-gray-400">
                          {new Date(r.date).toLocaleDateString('fr-FR')}
                        </span>
                        <span className="font-medium text-gray-700 dark:text-gray-300">
                          {formatMontant(r.reste)}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* Où l'on en est : sans ce rang, on ne sait pas s'il
                    reste une échéance ou huit. */}
                {file.length > 1 && (
                  <span className="whitespace-nowrap text-xs tabular-nums text-gray-400">
                    {rangActif + 1} / {file.length}
                  </span>
                )}
                <button onClick={() => setLigneActive(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
            </div>

            {/* Entre quoi on avance. Une tournée se fait par personne — on
                appelle une fois, quelles que soient les échéances — mais
                un dossier précis se suit pour lui-même. L'interrupteur ne
                paraît que s'il y a de quoi grouper. */}
            {enSerie && partenairesDuJour.length < lignesDuJour.length && (
              <div className="mx-5 mt-4 flex">
                <div className="flex gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
                  {([
                    { cle: 'partenaire' as const, label: 'Par partenaire' },
                    { cle: 'echeance' as const,   label: 'Par échéance' },
                  ]).map(o => (
                    <button key={o.cle} onClick={() => { setParQui(o.cle); setVoirDetail(false); }}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                        parQui === o.cle
                          ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                          : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {volets.versement && volets.suivi && (
            <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 mx-5 mt-4 mb-4">
              {(['versement', 'suivi'] as ModalOnglet[]).map(o => (
                <button key={o} onClick={() => setModalOnglet(o)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all
                    ${modalOnglet === o ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-gray-400 dark:text-gray-500'}`}>
                  {o === 'versement' ? 'Versement' : 'Suivi de contact'}
                </button>
              ))}
            </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">

              {/* ----- VERSEMENT ----- */}
              {/* La garde tient aussi ici : cacher une bascule ne ferme pas
                  le volet qu'elle désignait. */}
              {modalOnglet === 'versement' && saisitVersement && (
                <div>
                  {/* Ce qui borne le versement, dit avant de saisir. Le
                      porteur exécute une décision qu'il n'a pas prise : sans
                      ces chiffres, il ne sait ni combien on a promis, ni
                      combien il lui reste à remettre. */}
                  {(() => {
                    const convenu = ligneActive.convenu;
                    /* Rien de convenu : l'échéance entière fait foi. */
                    const promis = convenu ?? ligneActive.valeur;
                    /* Ce qui a été versé compte sur le promis, non sur le
                       dû : on a tenu quand on a donné ce qu'on avait dit. */
                    const restePromis = Math.max(0, promis - ligneActive.verse);
                    return (
                      <div className="mb-4 rounded-xl border border-gray-100 p-3 dark:border-gray-800">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-xs text-gray-400">
                            {convenu == null ? 'Rien de convenu' : 'Convenu'}
                          </span>
                          <span className={`text-sm font-bold ${
                            convenu == null ? 'text-gray-400'
                              : 'text-indigo-600 dark:text-indigo-400'}`}>
                            {formatMontant(promis)}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-gray-100 pt-1.5 dark:border-gray-800">
                          <span className="text-xs text-gray-400">Déjà remis</span>
                          <span className="text-sm font-bold text-green-600">
                            {formatMontant(ligneActive.verse)}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-baseline justify-between gap-3">
                          <span className="text-xs text-gray-400">Reste à remettre</span>
                          <span className={`text-sm font-bold ${
                            restePromis > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                            {formatMontant(restePromis)}
                          </span>
                        </div>
                        {/* Ce qu'il détient réellement : on ne remet pas ce
                            qu'on n'a pas pris au tiroir. Zéro veut dire
                            qu'il faut d'abord passer à la caisse. */}
                        {bornesVersement.poche !== null && (
                          <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-gray-100 pt-1.5 dark:border-gray-800">
                            <span className="text-xs text-gray-400">En poche</span>
                            <span className={`text-sm font-bold ${
                              bornesVersement.poche > 0
                                ? 'text-amber-600 dark:text-amber-500' : 'text-gray-400'}`}>
                              {formatMontant(bornesVersement.poche)}
                            </span>
                          </div>
                        )}
                        {/* Le dû complet reste visible quand il dépasse le
                            promis : c'est ce que le tiers attend encore, et
                            ce n'est pas ce qu'on s'est engagé à donner. */}
                        {promis < ligneActive.valeur && (
                          <p className="mt-2 border-t border-gray-100 pt-2 text-[11px] text-gray-400 dark:border-gray-800">
                            Dû sur l&apos;échéance {formatMontant(ligneActive.valeur)}
                            {' · '}non convenu {formatMontant(ligneActive.valeur - promis)}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  {/* Une échéance passée ne se verse plus : elle n'a pas été
                      tenue. On la reporte en en posant une autre, sinon le
                      journal dirait qu'elle a été honorée à temps. */}
                  {ligneActive.reste > 0 && etatEcheance(ligneActive.date).label === 'Passé' && (
                    <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
                      Échéance passée : posez-en une nouvelle pour encaisser.
                    </p>
                  )}
                  {/* Formulaire versement */}
                  {ligneActive.reste > 0 && etatEcheance(ligneActive.date).label !== 'Passé' && (
                    <div className="flex gap-2 mb-4">
                      <input type="number"
                        max={bornesVersement.plafond}
                        placeholder={`Montant (max ${formatMontant(bornesVersement.plafond)})`}
                        value={valeurVersement} onChange={e => setValeurVersement(e.target.value)}
                        className="flex-1 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <button onClick={enregistrerVersement} disabled={savingVersement || !valeurVersement}
                        className="flex items-center gap-1.5 px-3 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
                        {savingVersement ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Verser
                      </button>
                    </div>
                  )}
                  {loadingVersements
                    ? <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin text-indigo-500" /></div>
                    : versements.length === 0
                      ? <p className="text-center text-xs text-gray-400 py-6">Aucun versement enregistré</p>
                      : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-indigo-600 text-white">
                              <th className="text-center px-3 py-2 font-medium">Heure</th>
                              <th className="text-center px-3 py-2 font-medium">Montant</th>
                              <th className="text-center px-3 py-2 font-medium">Reste après</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                            {versements.map(v => (
                              <tr key={v.id}>
                                <td className="px-3 py-2.5 text-gray-500 text-center">{v.heure}</td>
                                <td className="px-3 py-2.5 font-medium text-green-600 text-center">{formatMontant(v.montant)}</td>
                                <td className="px-3 py-2.5 text-red-500 font-medium text-center">{formatMontant(v.resteApres)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )
                  }
                </div>
              )}

              {/* ----- SUIVI DE CONTACT ----- */}
              {modalOnglet === 'suivi' && volets.suivi && (
                <div>
                  {/* Sélection statut */}
                  <p className="text-xs font-bold text-gray-400 uppercase mb-2">Statut</p>
                  <div className="grid grid-cols-2 gap-2 mb-4">
                    {STATUTS.map(s => (
                      <button key={s.key} onClick={() => setNouveauStatut(s.key)}
                        className={`px-3 py-2 rounded-xl border text-xs font-medium text-left transition-all
                          ${nouveauStatut === s.key ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-indigo-700 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>
                        {s.label}
                      </button>
                    ))}
                  </div>

                  {/* Champs selon statut */}
                  {(nouveauStatut === 'injoignable' || nouveauStatut === 'refuse') && (
                    <div className="mb-4">
                      <p className="text-xs font-bold text-gray-400 uppercase mb-1">Heure de contact</p>
                      <input type="time" value={suiviHeure} onChange={e => setSuiviHeure(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  )}

                  {(nouveauStatut === 'convenu_partiel' || nouveauStatut === 'convenu_total') && (
                    <>
                      <div className="mb-3">
                        <p className="text-xs font-bold text-gray-400 uppercase mb-1">Heure convenu</p>
                        <input type="time" value={suiviHeure} onChange={e => setSuiviHeure(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      </div>
                      <div className="mb-3">
                        <p className="text-xs font-bold text-gray-400 uppercase mb-1">Sens de dépôt</p>
                        <div className="grid grid-cols-2 gap-2">
                          {sensDuRole(ligneActive.role).map(s => (
                            <button key={s.key} onClick={() => setSuiviSens(s.key)}
                              className={`px-3 py-2 rounded-xl border text-xs font-medium text-left transition-all
                                ${suiviSens === s.key ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-indigo-700 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {nouveauStatut === 'convenu_partiel' && (
                    <>
                      <div className="mb-3">
                        <p className="text-xs font-bold text-gray-400 uppercase mb-1">Montant convenu</p>
                        <input type="number" placeholder="Ex. 25000" value={suiviMontant} onChange={e => setSuiviMontant(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      </div>
                      <div className="mb-3">
                        <p className="text-xs font-bold text-gray-400 uppercase mb-1">Reliquat</p>
                        <div className="flex gap-2 mb-2">
                          {(['non_determine', 'determine'] as const).map(r => (
                            <button key={r} onClick={() => setSuiviReliquatType(r)}
                              className={`flex-1 py-2 rounded-xl border text-xs font-medium transition-all
                                ${suiviReliquatType === r ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-indigo-700' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>
                              {r === 'non_determine' ? 'Non déterminé' : 'Déterminé'}
                            </button>
                          ))}
                        </div>
                        {suiviReliquatType === 'determine' && (
                          <input type="date" value={suiviReliquatDate} min={todayStr()} onChange={e => setSuiviReliquatDate(e.target.value)}
                            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          />
                        )}
                      </div>
                    </>
                  )}

                  {nouveauStatut === 'reporte' && (
                    <div className="mb-4">
                      <p className="text-xs font-bold text-gray-400 uppercase mb-1">Date de report</p>
                      <input type="date" value={suiviDateReportage} min={todayStr()} onChange={e => setSuiviDateReportage(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  )}

                  {/* Hors séance, le bouton enregistre et c'est tout. En
                      séance, il enregistre et ouvre la suivante : refermer
                      pour rouvrir faisait perdre le fil à chaque ligne. */}
                  {enSerie ? (
                    <div className="mb-4">
                      <div className="flex items-center gap-2">
                        <button onClick={() => precedente && ouvrirModal(precedente)}
                          disabled={!precedente || savingSuivi}
                          className="shrink-0 rounded-xl border border-gray-200 px-3 py-2.5 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-30 dark:border-gray-700 dark:hover:bg-gray-800">
                          ←
                        </button>
                        <button onClick={suiviPuisSuivante} disabled={savingSuivi}
                          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
                          {savingSuivi ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                          {suivante ? 'Enregistrer et suivant' : 'Enregistrer et terminer'}
                        </button>
                      </div>

                      {/* Les points disent ce qui est fait et ce qui
                          reste : un rang seul ne montre pas les trous. */}
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <div className="flex flex-wrap gap-1">
                          {file.map((r, i) => (
                            <button key={r.id} onClick={() => ouvrirModal(r)}
                              title={r.nomPartenaire}
                              className={`h-2 w-2 rounded-full transition-colors ${
                                i === rangActif ? 'bg-indigo-600'
                                  : dejaSuivi(r) ? 'bg-green-500'
                                  : 'bg-gray-200 dark:bg-gray-700'}`} />
                          ))}
                        </div>
                        <button onClick={() => { setLigneActive(null); setEnSerie(false); }}
                          className="shrink-0 text-xs font-bold text-gray-400 transition-colors hover:text-gray-600">
                          Arrêter
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={enregistrerSuivi} disabled={savingSuivi}
                      className="w-full py-2.5 mb-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                      {savingSuivi ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer le suivi
                    </button>
                  )}

                  {/* Historique suivis */}
                  {loadingSuivis
                    ? <div className="flex justify-center py-4"><Loader2 size={18} className="animate-spin text-indigo-500" /></div>
                    : suivis.length === 0
                      ? <p className="text-center text-xs text-gray-400 py-4">Aucun suivi enregistré</p>
                      : (
                        <div className="space-y-2">
                          <p className="text-xs font-bold text-gray-400 uppercase mb-2">Historique</p>
                          {suivis.map(s => {
                            const statutLabel = STATUTS.find(x => x.key === s.statut)?.label ?? s.statut;
                            return (
                              <div key={s.id} className="flex items-start gap-3 bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                                <span className={`mt-0.5 px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${statutContactColor(s.statut)}`}>
                                  {statutLabel}
                                </span>
                                <div className="text-xs text-gray-500 space-y-0.5">
                                  {s.heure && <p>{s.heure}</p>}
                                  {s.sensDepot && <p>{SENS_DEPOT.find(x => x.key === s.sensDepot)?.label}</p>}
                                  {s.montant !== undefined && s.montant > 0 && <p>{formatMontant(s.montant)}</p>}
                                  {s.reliquatDate && <p>Reliquat : {new Date(s.reliquatDate).toLocaleDateString('fr-FR')}</p>}
                                  {s.dateReportage && <p>Reporté au : {new Date(s.dateReportage).toLocaleDateString('fr-FR')}</p>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )
                  }
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal config par défaut */}
      {editingRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                Config par défaut — {editingRole === 'fournisseur' ? 'Fournisseur' : 'Client'}
              </h2>
              <button onClick={() => setEditingRole(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Valeur par recouvrement</p>
            <input type="number" placeholder="Ex. 25000" value={valeurEdit} onChange={e => setValeurEdit(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Intervalle (jours)</p>
            {configDefautPour(editingRole!) ? (
              <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400 mb-5">
                {configDefautPour(editingRole!)!.intervalleJours} jour{configDefautPour(editingRole!)!.intervalleJours > 1 ? 's' : ''} <span className="text-xs text-gray-400 dark:text-gray-500">(non modifiable)</span>
              </p>
            ) : (
              <input type="number" placeholder="Ex. 14" value={intervalleEdit} onChange={e => setIntervalleEdit(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            )}
            <div className="flex gap-3">
              <button onClick={() => setEditingRole(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={sauvegarderConfig} disabled={savingConfig || !valeurEdit || (!configDefautPour(editingRole!) && !intervalleEdit)}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {savingConfig ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
              </button>
            </div>
            {configDefautPour(editingRole) && (
              <div className="mt-3 flex justify-center">
                <button onClick={reinitialiserConfig} disabled={reinitialisant}
                  className="text-xs text-red-400 hover:text-red-600 disabled:opacity-50 flex items-center gap-1 transition-colors">
                  {reinitialisant ? <Loader2 size={11} className="animate-spin" /> : null}
                  Réinitialiser la configuration
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Ajouter un recouvrement : meme parcours que dans la fiche d'un
          partenaire, le choix du tiers en plus. */}
      {ajoutRole && (() => {
        const c = couvertureAjout(ajoutRole, ajoutPartenaire);
        /* Le solde s'affiche a cote du nom : choisir un tiers sans savoir ce
           qu'il doit obligerait a fermer le modal pour aller le lire. */
        const options = partenaires
          .filter(x => x.roles.includes(ajoutRole))
          .map(x => ({
            valeur: x.id, label: x.nom,
            detail: abregeMontant(soldes?.[ajoutRole]?.get(x.id)?.reste ?? 0),
          }))
          .sort((a, b) => a.label.localeCompare(b.label));

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                  Ajouter un recouvrement — {ajoutRole === 'fournisseur' ? 'Fournisseur' : 'Client'}
                </h2>
                <button onClick={() => setAjoutRole(null)} className="p-1 text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>

              <p className="mb-1 text-xs font-bold uppercase text-gray-400">
                {ajoutRole === 'fournisseur' ? 'Fournisseur' : 'Client'}
              </p>
              <div className="mb-4">
                <SelectCherchable valeur={ajoutPartenaire}
                  onChange={v => { setAjoutPartenaire(v); setAjoutValeur(0); }}
                  options={options} placeholder="Choisir…"
                  vide={`Aucun ${ajoutRole}`} />
              </div>

              <p className="mb-1 text-xs font-bold uppercase text-gray-400">Date</p>
              {/* On promet plus souvent un delai qu'une date : les deux champs
                  disent la meme chose et se suivent. Une date passee ne se
                  recouvre pas, elle se constate. */}
              <div className="mb-4 flex gap-2">
                <ChampNombre valeur={ajoutDelai}
                  onChange={n => { setAjoutDelai(n); setAjoutDate(dansNJours(n)); }}
                  className="w-20 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-center text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                <span className="shrink-0 self-center text-xs text-gray-400">jours</span>
                <input type="date" value={ajoutDate} min={todayStr()}
                  onChange={e => { setAjoutDate(e.target.value); setAjoutDelai(ecartJours(e.target.value)); }}
                  className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
              </div>

              <p className="mb-1 text-xs font-bold uppercase text-gray-400">Valeur</p>
              {/* Trois chiffres, pas un seul plafond : ce que le tiers doit,
                  ce qui est deja promis, et la part encore a planifier. */}
              <div className={`${hankenGrotesk.className} mb-3 grid grid-cols-3 gap-2`}>
                {([
                  { label: 'Dû', valeur: c.du, fort: false },
                  { label: 'Planifié', valeur: c.planifie, fort: false },
                  { label: 'Reste', valeur: c.reste, fort: true },
                ]).map(i => (
                  <div key={i.label} title={formatMontant(i.valeur)}
                    className="rounded-xl bg-gray-50 px-2.5 py-2 text-center dark:bg-gray-800/60">
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

              <ChampNombre valeur={ajoutValeur}
                onChange={setAjoutValeur} max={c.reste}
                className="mb-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
              <p className="mb-5 text-xs text-gray-400">
                {!ajoutPartenaire
                  ? `Choisissez un ${ajoutRole} pour voir ce qu'il doit.`
                  : c.reste <= 0
                    ? 'Les échéances déjà posées couvrent tout ce qui est dû.'
                    : 'Au-delà du reste, on réclamerait deux fois le même argent.'}
              </p>

              <div className="flex gap-3">
                <button onClick={() => setAjoutRole(null)}
                  className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-500 dark:border-gray-700">
                  Annuler
                </button>
                <button onClick={enregistrerAjout}
                  disabled={savingAjout || !ajoutPartenaire || !ajoutDate || ajoutValeur <= 0}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
                  {savingAjout ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ajouter
                </button>
              </div>
            </div>
          </div>
        );
      })()}

    {/* La feuille de ce qu'il doit recuperer : l'etat complet, et le
        geste qui l'attend. */}
    {feuilleCaisse && (
      <FeuilleARecuperer
        missions={missionsDeLaCarteF}
        /* Confirmer est le geste du porteur : il atteste recevoir devant
           le caissier. Qui decide ne fait que regarder — lui tendre le
           bouton reviendrait a lui faire attester une reception qu'il n'a
           pas faite. */
        peutConfirmer={vueDuPorteur}
        /* Le porteur n'a qu'un chemin : ce qu'on lui confie. Qui decide
           en a deux, et veut savoir aussi si les fournisseurs attendus
           sont venus prendre leur argent. */
        avecComptoir={!vueDuPorteur}
        onFermer={() => setFeuilleCaisse(false)}
        onConfirmer={async liste => {
          for (const m of liste) {
            await confirmerReception({
              /* Le nom se garde de la mission si elle en porte un :
                 cet ecran ne connait que l'identifiant. */
              mission: m, porteurUid: userId,
            });
          }
          const f = await chargerMissions(ctx.portee);
          setMissions(f);
        }} />
    )}
    </div>
  );
}
