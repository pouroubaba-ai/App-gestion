'use client';
import { marqueOrigine } from '@/lib/retour';
import { useEffect, useState, useMemo } from 'react';
import {
  collection, query, where, getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import {
  Plus, X, Search, Eye, Trash2, Pencil, Loader2,
  Tag, ChevronDown, ArrowUpDown, Filter, Undo2, Banknote } from 'lucide-react';
import { ChampRecherche, ChampNombre, SelectCherchable } from '@/components/Champs';
import PartenairesResumeCard from './PartenairesResumeCard';
import ModalVersementTiers from './ModalVersementTiers';
import ModalRetour from './ModalRetour';
import { soldesDuSite, soldeDe, type SoldesParRole } from '@/lib/soldes';
import { chargerVersementsDuSite } from '@/lib/versements-collection';
import { auteurCourant } from '@/lib/auteur';
import {
  employesDuSite, sourceDe, LIBELLES_SOURCE,
  type Apporteur, type EmployeChoix,
} from '@/lib/apporteur';
import { valeurRecue, valeurVente } from '@/lib/flux-marchandise';
import { chargerAchatsDuSite, chargerVentesDuSite } from '@/lib/flux-marchandise';
import {
  useSites, FiltreSite, CelluleSite, ToggleVue, CartesParSite,
  type PropsPortee,
} from './ContexteSites';
import {
  peutGererPartenaires, peutReglerFournisseur, type RoleSite,
} from '@/lib/roles';
import { lireParSite } from '@/lib/portee';

type Role = 'fournisseur' | 'client';
type Vue = 'fournisseurs' | 'clients';

interface Categorie {
  id: string;
  nom: string;
  role: Role;
  nbPartenaires: number;
}

interface Partenaire {
  id: string;
  nom: string;
  contact?: string;
  rolesFournisseur: boolean;
  rolesClient: boolean;
  categoriesFournisseur: string[];  // ids
  categoriesClient: string[];       // ids
  dette: number;
  creance: number;
  prochainRecouvrement?: string | null;
  /* Qui a ajouté ce partenaire, figé à la création. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /** qui l'a amené ; absent s'il est venu de lui-même */
  apporteur?: Apporteur | null;
  /* Un partenaire appartient à un site : le même fournisseur connu de deux
     boutiques y tient deux fiches, et deux dettes distinctes. */
  siteId?: string;
}

/** Le versement le plus récent d'un partenaire, pour la colonne du tableau. */
interface DernierVersement {
  date: string;
  montant: number;
}

interface Props extends PropsPortee {
  userId: string;
  defaultVue?: 'clients' | 'fournisseurs';
  /* Inscrire un partenaire engage le site sur une relation commerciale :
     tous les rôles qui lisent ce fichier ne décident pas de son contenu. */
  roleSite?: RoleSite | null;
}

/**
 * Depuis combien de temps le versement a eu lieu.
 *
 * Une date oblige à compter dans sa tête pour savoir si le partenaire paie
 * encore ; « il y a 5 j » se lit d'un coup d'œil sur toute une colonne.
 */
function anciennete(date: string): string {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const jours = Math.round((now.getTime() - d.getTime()) / 86400000);
  if (jours <= 0) return "aujourd'hui";
  if (jours === 1) return 'hier';
  return `il y a ${jours} j`;
}

/**
 * Dans combien de temps tombe l'échéance.
 *
 * Miroir d'`anciennete`, dans l'autre sens : un recouvrement court vers sa
 * date, il ne s'en éloigne pas. Un retard se dit, il ne se déduit pas d'une
 * date qu'il faudrait comparer de tête à celle du jour.
 */
function echeance(date: string): string {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const jours = Math.round((d.getTime() - now.getTime()) / 86400000);
  if (jours === 0) return "aujourd'hui";
  if (jours === 1) return 'demain';
  if (jours > 1) return `dans ${jours} j`;
  if (jours === -1) return 'hier';
  return `en retard de ${-jours} j`;
}

function statut(reste: number, verse: number) {
  if (reste <= 0) return { label: 'Soldé', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  if (verse > 0)  return { label: 'Partiel', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  return { label: 'Non soldé', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
}

export default function OngletPartenaires({ siteId, userId, sites, titre, defaultVue = 'clients', roleSite = null }: Props) {
  /* Encaisser un règlement est le geste même du recouvrement : c'est pour
     cela que ce poste existe. Décider avec qui la maison commerce, non. */
  const peutCreer = peutGererPartenaires(roleSite);
  const ctx = useSites(siteId, sites);
  const router = useRouter();
  const [vue, setVueBrut] = useState<Vue>(defaultVue);
  /* Régler un fournisseur n'est pas recouvrer : le chargé de recouvrement
     fait rentrer ce qui est dû, il n'arbitre pas ce qui sort. */
  const peutVerserIci = vue === 'fournisseurs'
    ? peutReglerFournisseur(roleSite) : true;

  /* L'URL suit la vue, comme elle suit l'onglet : actualiser en regardant
     les fournisseurs doit ramener sur les fournisseurs. */
  function setVue(v: Vue) {
    setVueBrut(v);
    const params = new URLSearchParams(window.location.search);
    params.set('onglet', 'partenaires');
    params.set('vue', v);
    window.history.replaceState(null, '', `?${params.toString()}`);
  }
  const [partenaires, setPartenaires] = useState<Partenaire[]>([]);
  const [categories, setCategories] = useState<Categorie[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filtreStatut, setFiltreStatut] = useState<'tous' | 'solde' | 'partiel' | 'non-solde'>('tous');
  const [tri, setTri] = useState<'nom' | 'montant' | 'recouvrement' | 'operation' | 'versement'>('nom');
  const [triDir, setTriDir] = useState<'asc' | 'desc'>('asc');

  /* - Modal nouveau partenaire - */
  const [showModalPartenaire, setShowModalPartenaire] = useState(false);
  const [nom, setNom] = useState('');
  const [contact, setContact] = useState('');
  const [rolesFournisseur, setRolesFournisseur] = useState(false);
  const [rolesClient, setRolesClient] = useState(false);
  const [catsFournisseurSel, setCatsFournisseurSel] = useState<string[]>([]);
  const [catsClientSel, setCatsClientSel] = useState<string[]>([]);
  const [showDropdownF, setShowDropdownF] = useState(false);
  const [showDropdownC, setShowDropdownC] = useState(false);
  const [searchCatF, setSearchCatF] = useState('');
  const [searchCatC, setSearchCatC] = useState('');
  const [saving, setSaving] = useState(false);
  const [erreur, setErreur] = useState('');

  /* - Modal catégories - */
  const [showModalCats, setShowModalCats] = useState(false);
  const [roleCats, setRoleCats] = useState<Role>('fournisseur');
  const [nouvelleCategorie, setNouvelleCategorie] = useState('');
  const [savingCat, setSavingCat] = useState(false);
  const [erreurCat, setErreurCat] = useState('');
  const [confirmSuppCat, setConfirmSuppCat] = useState<Categorie | null>(null);

  /* Encaisser depuis la liste : passer par la fiche de chacun oblige à
     savoir d'avance qui vient payer. */
  const [versementOuvert, setVersementOuvert] = useState(false);
  /* Le retour part d'un tiers précis : c'est sa marchandise qui revient. */
  const [retourPour, setRetourPour] = useState<Partenaire | null>(null);

  /* Qui a amené le partenaire. Distinct de l'auteur de la fiche : le
     comptable qui saisit dix clients ne les a pas amenés. */
  const [employes, setEmployes] = useState<EmployeChoix[]>([]);
  const [apporteurEmploye, setApporteurEmploye] = useState('');
  /* Le cas choisi. `apporteurEmploye` porte l'identifiant ou 'externe' ;
     lui seul ne dirait pas si un champ vide est un choix ou un oubli. */
  const [modeApporteur, setModeApporteur] = useState<'aucun' | 'employe' | 'externe'>('aucun');
  const [apporteurNom, setApporteurNom] = useState('');
  const [apporteurFonction, setApporteurFonction] = useState('');

  /* Ce qui a réellement circulé, par partenaire. Les champs `verseF` et
     `verseC` du document partenaire n'ont jamais été écrits nulle part :
     les lire donnait toujours zéro. Le versé vit dans les achats et les
     ventes, sur leurs versements — c'est là qu'on va le chercher. */
  const [verseParPartenaire, setVerseParPartenaire] = useState<{
    fournisseur: Map<string, number>;
    client: Map<string, number>;
  }>({ fournisseur: new Map(), client: new Map() });

  /* Le dernier versement de chacun : un total ne dit pas si le partenaire a
     payé hier ou il y a six mois, et c'est cette date qui décide s'il faut
     le relancer. */
  const [dernierVersement, setDernierVersement] = useState<{
    fournisseur: Map<string, DernierVersement>;
    client: Map<string, DernierVersement>;
  }>({ fournisseur: new Map(), client: new Map() });

  /** Le versé d'un partenaire dans un rôle, reconstitué depuis ses documents. */
  function verseDe(p: Partenaire, estFourn: boolean) {
    const m = estFourn ? verseParPartenaire.fournisseur : verseParPartenaire.client;
    return m.get(p.id) ?? 0;
  }

  /* La dernière opération avec chaque tiers. Un solde ne dit pas si le
     compte est encore vivant : un client qui doit peu mais n'achète plus
     depuis six mois n'appelle pas le même geste qu'un autre. */
  const [derniereOperation, setDerniereOperation] = useState<{
    fournisseur: Map<string, DernierVersement>;
    client: Map<string, DernierVersement>;
  }>({ fournisseur: new Map(), client: new Map() });

  function derniereOperationDe(id: string, estFourn: boolean) {
    const m = estFourn ? derniereOperation.fournisseur : derniereOperation.client;
    return m.get(id);
  }

  function dernierVersementDe(id: string, estFourn: boolean) {
    const m = estFourn ? dernierVersement.fournisseur : dernierVersement.client;
    return m.get(id);
  }

  /* La prochaine échéance de chacun, prise dans le journal de recouvrement.
     Le champ `prochainRecouvrement` du partenaire ne se remplissait qu'à la
     main sur sa fiche : la colonne restait vide alors que les échéances
     existaient déjà. Une seule source, celle que l'app alimente. */
  const [prochaineEcheance, setProchaineEcheance] = useState<{
    fournisseur: Map<string, string>;
    client: Map<string, string>;
  }>({ fournisseur: new Map(), client: new Map() });

  function prochainRecouvrementDe(p: Partenaire, estFourn: boolean) {
    const m = estFourn ? prochaineEcheance.fournisseur : prochaineEcheance.client;
    const date = m.get(p.id) ?? p.prochainRecouvrement ?? null;
    /* Le champ recopié sur le partenaire peut porter une date dépassée : elle
       n'est pas davantage prochaine que celles du journal. */
    return date && date >= new Date().toISOString().split('T')[0] ? date : null;
  }

  useEffect(() => { fetchAll(); }, [ctx.portee]);

  /**
   * Le versé, le dernier versement et la dernière opération de chaque tiers.
   *
   * Tout vient des soldes et de la collection des versements : la page lisait
   * les achats et les ventes une fois pour les soldes, une autre pour ces
   * chiffres, sur les deux plus grosses collections du site. Les deux calculs
   * donnaient d'ailleurs le même résultat.
   */
  async function chargerVerse(soldes: SoldesParRole) {
    const fournisseur = new Map<string, number>();
    const client = new Map<string, number>();
    const derniersF = new Map<string, DernierVersement>();
    const derniersC = new Map<string, DernierVersement>();
    const opF = new Map<string, DernierVersement>();
    const opC = new Map<string, DernierVersement>();

    /* Le versé et la dernière opération sont déjà calculés : on les recopie
       plutôt que de relire les dossiers. */
    for (const [role, cible, ops] of [
      ['fournisseur', fournisseur, opF],
      ['client', client, opC],
    ] as const) {
      for (const [id, sol] of (role === 'fournisseur' ? soldes.fournisseur : soldes.client)) {
        cible.set(id, sol.verse);
        if (sol.derniereOperation) {
          ops.set(id, { date: sol.derniereOperation, montant: sol.derniereValeur });
        }
      }
    }

    /* Le dernier versement, lui, ne vit que dans sa collection. */
    for (const v of await chargerVersementsDuSite(ctx.portee)) {
      const derniers = v.role === 'fournisseur' ? derniersF : derniersC;
      const actuel = derniers.get(v.partenaireId);
      /* Plusieurs versements le même jour se cumulent, comme les achats. */
      if (!actuel || v.date > actuel.date) {
        derniers.set(v.partenaireId, { date: v.date, montant: v.montant });
      } else if (v.date === actuel.date) {
        derniers.set(v.partenaireId,
          { date: v.date, montant: actuel.montant + v.montant });
      }
    }

    setVerseParPartenaire({ fournisseur, client });
    setDernierVersement({ fournisseur: derniersF, client: derniersC });
    setDerniereOperation({ fournisseur: opF, client: opC });
  }


  /** La prochaine échéance non soldée de chaque partenaire, par rôle. */
  async function chargerEcheances() {
    const docs = await lireParSite('recouvrement_journal', ctx.portee);
    const fournisseur = new Map<string, string>();
    const client = new Map<string, string>();
    const jour = new Date().toISOString().split('T')[0];
    for (const d of docs) {
      const r = d.data() as any;
      if (!r.partenaireId || !r.date) continue;
      /* Une échéance soldée n'appelle plus rien. */
      if ((r.reste ?? 0) <= 0) continue;
      /* Une échéance passée n'est pas prochaine : elle atteste qu'à sa date
         l'argent n'est pas venu. Ce qui reste dû se lit dans la créance, et
         le retard dans l'onglet Recouvrements — pas dans une colonne qui
         promet une date à venir. */
      if (r.date < jour) continue;
      const m = r.role === 'fournisseur' ? fournisseur : client;
      const actuelle = m.get(r.partenaireId);
      /* La plus proche des échéances restantes. */
      if (!actuelle || r.date < actuelle) m.set(r.partenaireId, r.date);
    }
    setProchaineEcheance({ fournisseur, client });
  }

  async function fetchAll() {
    setLoading(true);
    chargerEcheances();
    /* Un partenaire appartient au site, pas à celui qui l'a saisi.
       Filtrer sur le `userId` du compte connecté datait du temps où un
       seul compte tenait toute l'activité : depuis qu'un site a des
       membres, un gérant ou un chargé de recouvrement ne voyait plus rien
       — les fiches portent l'identifiant du propriétaire qui les a créées,
       jamais le sien. La portée du site suffit à les délimiter. */
    const [partSnap, catSnap] = await Promise.all([
      lireParSite('partenaires', ctx.portee),
      lireParSite('categories_partenaire', ctx.portee),
    ]);
    const cats = catSnap.map(d => ({ id: d.id, ...d.data() } as Categorie));

    /* Dette et créance ne sont plus lues sur la fiche : elles se déduisent
       des achats confirmés et des ventes livrées non soldés. Un chiffre
       stocké survivait à la suppression de son document et n'avait plus
       aucun rapport avec la réalité. */
    /* Les employés servent à désigner un apporteur : cela n'a de sens que
       dans un site, où l'on enregistre. */
    if (ctx.siteEcriture) {
      employesDuSite(ctx.siteEcriture, userId).then(setEmployes).catch(() => setEmployes([]));
    } else setEmployes([]);
    const soldes = await soldesDuSite(ctx.portee);
    chargerVerse(soldes);
    const parts = partSnap.map(d => {
      const brut = { id: d.id, ...d.data() } as Partenaire;
      return {
        ...brut,
        dette: soldeDe(soldes, d.id, 'fournisseur').reste,
        creance: soldeDe(soldes, d.id, 'client').reste,
      };
    });
    // Calculer nbPartenaires par catégorie
    const catsAvecNb = cats.map(c => ({
      ...c,
      nbPartenaires: parts.filter(p =>
        (c.role === 'fournisseur' ? p.categoriesFournisseur : p.categoriesClient)?.includes(c.id)
      ).length,
    }));
    setCategories(catsAvecNb);
    setPartenaires(parts);
    setLoading(false);
  }

  const filtrés = useMemo(() => {
    const q = search.toLowerCase();
    const estFourn = vue === 'fournisseurs';
    let list = partenaires.filter(p => {
      const matchVue = estFourn ? p.rolesFournisseur : p.rolesClient;
      const matchSearch = !q || p.nom.toLowerCase().includes(q);
      if (!matchVue || !matchSearch) return false;
      if (filtreStatut !== 'tous') {
        const reste = estFourn ? p.dette : p.creance;
        const verse = verseDe(p, estFourn);
        const s = statut(reste, verse).label;
        if (filtreStatut === 'solde' && s !== 'Soldé') return false;
        if (filtreStatut === 'partiel' && s !== 'Partiel') return false;
        if (filtreStatut === 'non-solde' && s !== 'Non soldé') return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      let va: number | string = 0, vb: number | string = 0;
      if (tri === 'nom') { va = a.nom.toLowerCase(); vb = b.nom.toLowerCase(); }
      else if (tri === 'montant') { va = estFourn ? a.dette : a.creance; vb = estFourn ? b.dette : b.creance; }
      else if (tri === 'versement') {
        /* Sans versement, le tiers se range en fin de liste : il n'est ni le
           plus gros payeur ni le plus petit, il n'a rien payé. */
        const va2 = dernierVersementDe(a.id, estFourn)?.montant;
        const vb2 = dernierVersementDe(b.id, estFourn)?.montant;
        va = va2 ?? (triDir === 'asc' ? Infinity : -Infinity);
        vb = vb2 ?? (triDir === 'asc' ? Infinity : -Infinity);
      }
      else if (tri === 'operation') {
        /* Sans opération, le tiers se range en fin de liste quel que soit le
           sens : un compte sans activité n'est ni le plus récent ni le plus
           ancien, il est hors du classement. */
        const da = derniereOperationDe(a.id, estFourn);
        const dbb = derniereOperationDe(b.id, estFourn);
        va = da ? new Date(da.date).getTime() : (triDir === 'asc' ? Infinity : -Infinity);
        vb = dbb ? new Date(dbb.date).getTime() : (triDir === 'asc' ? Infinity : -Infinity);
      }
      else if (tri === 'recouvrement') {
        const ea = prochainRecouvrementDe(a, estFourn);
        const eb = prochainRecouvrementDe(b, estFourn);
        va = ea ? new Date(ea).getTime() : (triDir === 'asc' ? Infinity : -Infinity);
        vb = eb ? new Date(eb).getTime() : (triDir === 'asc' ? Infinity : -Infinity);
      }
      if (va < vb) return triDir === 'asc' ? -1 : 1;
      if (va > vb) return triDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [partenaires, vue, search, filtreStatut, tri, triDir, verseParPartenaire, prochaineEcheance, derniereOperation, dernierVersement]);

  function toggleTri(col: typeof tri) {
    if (tri === col) setTriDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setTri(col); setTriDir('asc'); }
  }

  /* Ce que chaque site a laissé dehors et ce qu'il doit. Le même
     fournisseur connaît deux boutiques : chacune tient sa propre dette, et
     un total les confond. */
  function chiffresDuSite(id: string) {
    const siens = partenaires.filter(x => x.siteId === id);
    const clients = siens.filter(x => x.rolesClient);
    const fourns = siens.filter(x => x.rolesFournisseur);
    const creance = clients.reduce((n, x) => n + (x.creance || 0), 0);
    const dette = fourns.reduce((n, x) => n + (x.dette || 0), 0);
    return {
      total: siens.length,
      creance, dette,
      nbClients: clients.length,
      nbFourns: fourns.length,
      /* Ceux qui doivent encore : c'est eux qui appellent un geste. */
      ouvertsC: clients.filter(x => (x.creance || 0) > 0).length,
      ouvertsF: fourns.filter(x => (x.dette || 0) > 0).length,
    };
  }

  const totalDette = partenaires.filter(p => p.rolesFournisseur).reduce((s, p) => s + (p.dette || 0), 0);
  const totalCreance = partenaires.filter(p => p.rolesClient).reduce((s, p) => s + (p.creance || 0), 0);
  const recouvrementAujourdhui = partenaires.filter(p => {
    const e = prochainRecouvrementDe(p, vue === 'fournisseurs');
    if (!e) return false;
    return new Date(e).toDateString() === new Date().toDateString();
  }).length;

  /** L'apporteur tel qu'il sera écrit : un employé, un externe, ou rien. */
  function construireApporteur(): Apporteur | null {
    if (!apporteurEmploye) return null;
    if (apporteurEmploye === 'externe') {
      if (!apporteurNom.trim()) return null;
      return {
        employeId: null,
        nom: apporteurNom.trim(),
        /* Sans précision, on dit d'où il vient plutôt que d'inventer un rôle. */
        fonction: apporteurFonction.trim() || 'Externe',
      };
    }
    const e = employes.find(x => x.id === apporteurEmploye);
    return e ? { employeId: e.id, nom: e.nom, fonction: e.fonction } : null;
  }

  function ouvrirModalPartenaire() {
    setNom(''); setContact(''); setRolesFournisseur(false); setRolesClient(false);
    setCatsFournisseurSel([]); setCatsClientSel([]); setErreur('');
    setApporteurEmploye(''); setApporteurNom(''); setApporteurFonction('');
    setModeApporteur('aucun');
    setShowModalPartenaire(true);
  }

  async function ajouterPartenaire() {
    if (!nom.trim()) { setErreur('Nom requis.'); return; }
    if (!rolesFournisseur && !rolesClient) { setErreur('Sélectionnez au moins un rôle.'); return; }
    setSaving(true); setErreur('');
    try {
      /* Une fiche appartient à un site : la vue d'ensemble n'en désigne
         aucun tant qu'on n'a pas filtré. */
      const site = ctx.siteEcriture;
      if (!site) { setErreur('Choisissez un site avant de créer un partenaire.'); return; }
      await addDoc(collection(db, 'partenaires'), {
        userId,
        siteId: site,
        nom: nom.trim(),
        contact: contact.trim(),
        rolesFournisseur,
        rolesClient,
        categoriesFournisseur: catsFournisseurSel,
        categoriesClient: catsClientSel,
        prochainRecouvrement: null,
        /* Qui a créé la fiche, recopié au moment du geste : sur une
           plateforme partagée, savoir qui a ajouté un tiers évite d'avoir
           à le demander. */
        ...(await auteurCourant(site, userId)),
        apporteur: construireApporteur(),
        createdAt: serverTimestamp(),
      });
      setShowModalPartenaire(false);
      fetchAll();
    } catch (e: any) {
      setErreur(e?.message ?? 'Erreur.');
    } finally {
      setSaving(false);
    }
  }

  async function ajouterCategorie() {
    const nomTrim = nouvelleCategorie.trim();
    if (!nomTrim) return;
    const doublon = categories.some(c => c.role === roleCats && c.nom.toLowerCase() === nomTrim.toLowerCase());
    if (doublon) { setErreurCat('Une catégorie avec ce nom existe déjà.'); return; }
    setErreurCat('');
    setSavingCat(true);
    try {
      const ref = await addDoc(collection(db, 'categories_partenaire'), {
        userId, siteId,
        nom: nomTrim,
        role: roleCats,
        nbPartenaires: 0,
        createdAt: serverTimestamp(),
      });
      setCategories(prev => [...prev, { id: ref.id, nom: nomTrim, role: roleCats, nbPartenaires: 0 }]);
      setNouvelleCategorie('');
    } finally {
      setSavingCat(false);
    }
  }

  async function supprimerCategorie(cat: Categorie) {
    if (cat.nbPartenaires > 0) { setConfirmSuppCat(cat); return; }
    await deleteDoc(doc(db, 'categories_partenaire', cat.id));
    setCategories(prev => prev.filter(c => c.id !== cat.id));
  }

  async function confirmerSuppression() {
    if (!confirmSuppCat) return;
    await deleteDoc(doc(db, 'categories_partenaire', confirmSuppCat.id));
    setCategories(prev => prev.filter(c => c.id !== confirmSuppCat.id));
    setPartenaires(prev => prev.map(p => ({
      ...p,
      categoriesFournisseur: p.categoriesFournisseur.filter(id => id !== confirmSuppCat.id),
      categoriesClient: p.categoriesClient.filter(id => id !== confirmSuppCat.id),
    })));
    setConfirmSuppCat(null);
  }

  const catsFournisseur = categories.filter(c => c.role === 'fournisseur');
  const catsClient = categories.filter(c => c.role === 'client');

  function countFiltreStatut(s: 'tous' | 'solde' | 'partiel' | 'non-solde') {
    const estFourn = vue === 'fournisseurs';
    const base = partenaires.filter(p => {
      const matchVue = estFourn ? p.rolesFournisseur : p.rolesClient;
      const matchSearch = !search || p.nom.toLowerCase().includes(search.toLowerCase());
      return matchVue && matchSearch;
    });
    if (s === 'tous') return base.length;
    return base.filter(p => {
      const reste = estFourn ? p.dette : p.creance;
      const verse = verseDe(p, estFourn);
      const label = statut(reste, verse).label;
      if (s === 'solde')     return label === 'Soldé';
      if (s === 'partiel')   return label === 'Partiel';
      if (s === 'non-solde') return label === 'Non soldé';
      return false;
    }).length;
  }

  function toggleCat(role: 'f' | 'c', id: string) {
    if (role === 'f') {
      setCatsFournisseurSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    } else {
      setCatsClientSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    }
  }

  function nomCat(id: string) {
    return categories.find(c => c.id === id)?.nom ?? id;
  }

  if (loading) return (
    <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-indigo-500" /></div>
  );

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'hidden'}>{titre}</p>
          {recouvrementAujourdhui > 0 && (
            <span className="flex items-center gap-1 px-3 py-1.5 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl text-xs font-medium text-orange-600 dark:text-orange-400">
              Recouvrement du jour ({recouvrementAujourdhui})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Un total confond les boutiques : la bascule dit ce que chacune
              a laissé dehors. */}
          <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
          {/* Le filtre porte sur tout l'écran, carte résumé comprise : le
              poser sous elle laisserait croire qu'il ne touche que le
              tableau. */}
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {/* Clients ou fournisseurs : deux lectures de la page entière, carte
          résumé comprise. Le choix se pose donc au-dessus d'elle, et non
          dans l'en-tête où il se mêlait au titre. */}
      {!ctx.parSite && (
        <div className="mb-4 flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 w-fit">
          {(['clients', 'fournisseurs'] as Vue[]).map(v => (
            <button key={v} onClick={() => setVue(v)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all
                ${vue === v
                  ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-gray-400 dark:text-gray-500'}`}>
              {v === 'fournisseurs' ? 'Fournisseurs' : 'Clients'}
            </button>
          ))}
        </div>
      )}

      {ctx.parSite ? (
        /* Une carte par site : ses créances, ses dettes, ses tiers. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          return {
            titre: 'Créances à recouvrer',
            valeur: formatMontant(c.creance),
            dort: c.total === 0,
            /* Un même tiers peut être client et fournisseur : compter les
               fiches donnerait « 1 tiers » sous deux lignes garnies. Ce
               sont les comptes ouverts qui appellent un geste. */
            badge: c.ouvertsC + c.ouvertsF > 0
              ? {
                  texte: `${c.ouvertsC + c.ouvertsF} compte${c.ouvertsC + c.ouvertsF > 1 ? 's' : ''} ouvert${c.ouvertsC + c.ouvertsF > 1 ? 's' : ''}`,
                  ton: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
                }
              : c.total > 0
                ? {
                    texte: 'Tout soldé',
                    ton: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                  }
                : null,
            lignes: [
              { label: `Clients · ${c.ouvertsC}/${c.nbClients}`,
                valeur: formatMontant(c.creance),
                vide: c.creance === 0, ton: 'text-orange-500' },
              { label: `Fournisseurs · ${c.ouvertsF}/${c.nbFourns}`,
                valeur: formatMontant(c.dette),
                vide: c.dette === 0, ton: 'text-red-500' },
            ],
          };
        }} />
      ) : (
      <>
      {/* Résumé */}
      {(() => {
        const estFourn = vue === 'fournisseurs';
        const duRole = partenaires.filter(p => estFourn ? p.rolesFournisseur : p.rolesClient);
        const reste = estFourn ? totalDette : totalCreance;
        const verse = duRole.reduce((s, p) => s + verseDe(p, estFourn), 0);
        return (
          <PartenairesResumeCard
            role={estFourn ? 'fournisseur' : 'client'}
            reste={reste}
            verse={verse}
            nbDus={duRole.filter(p => (estFourn ? p.dette : p.creance) > 0).length}
            nbTotal={duRole.length}
            /* La page des transactions travaille dans un site : lui passer
               la portée entière collait les identifiants en un seul — un
               site inexistant, donc une page vide dont on ne revenait pas.
               Hors d'un site, la carte ne mène nulle part. */
            onOuvrir={ctx.siteEcriture ? () => router.push(
              `/site/${ctx.siteEcriture}/transactions`
              + `?role=${estFourn ? 'fournisseur' : 'client'}`
              + marqueOrigine(ctx.ensemble, false)) : undefined}
          />
        );
      })()}

      {/* Tableau */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">

      {/* La recherche porte sur ce tableau : la laisser dehors la faisait
          passer pour un filtre de la page entière. */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <ChampRecherche placeholder="Rechercher un partenaire…" valeur={search} onChange={setSearch} className="w-full" />
        </div>
        {/* Filtre statut */}
        <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 gap-0.5">
          <Filter size={13} className="text-gray-400 ml-1 mr-0.5" />
          {(['tous', 'non-solde', 'partiel', 'solde'] as const).map(s => (
            <button key={s} onClick={() => setFiltreStatut(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                ${filtreStatut === s
                  ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
              {s === 'tous' ? 'Tous' : s === 'partiel' ? 'Partiel' : s === 'non-solde' ? 'Non soldé' : 'Soldé'} ({countFiltreStatut(s)})
            </button>
          ))}
        </div>
        {/* Verser et créer agissent sur les lignes de ce tableau : sur une
            ligne à part, en haut de l'écran, ils s'éloignaient de ce qu'ils
            modifient. Un site doit être désigné : un partenaire appartient
            à un site, et un versement s'inscrit dans sa caisse. */}
        {ctx.siteEcriture && peutVerserIci && (
          <button onClick={() => setVersementOuvert(true)}
            className="flex shrink-0 items-center gap-1.5 px-3 py-2 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-sm font-bold rounded-xl transition-colors">
            <Plus size={15} /> Verser
          </button>
        )}
        {ctx.siteEcriture && peutCreer && (
          <button onClick={ouvrirModalPartenaire}
            className="flex shrink-0 items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl transition-colors">
            <Plus size={15} /> Nouveau partenaire
          </button>
        )}
      </div>

        <p className="text-sm font-medium text-gray-500 mb-2">
          {filtrés.length} {vue === 'fournisseurs' ? 'fournisseur' : 'client'}{filtrés.length > 1 ? 's' : ''}
        </p>

        {filtrés.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">Aucun résultat</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  <th className="text-center px-4 py-3 font-medium">
                    <button onClick={() => toggleTri('nom')} className="flex items-center gap-1 hover:opacity-80">
                      {vue === 'fournisseurs' ? 'Fournisseur' : 'Client'}
                      <ArrowUpDown size={12} className={tri === 'nom' ? 'opacity-100' : 'opacity-40'} />
                    </button>
                  </th>
                  {/* Le même partenaire peut tenir une fiche sur plusieurs
                      sites : sans cette colonne, deux lignes identiques. */}
                  {ctx.ensemble && <th className="text-center px-4 py-3 font-medium">Site</th>}
                  <th className="text-center px-4 py-3 font-medium">
                    <button onClick={() => toggleTri('operation')} className="flex items-center gap-1 hover:opacity-80">
                      {vue === 'fournisseurs' ? 'Dernier achat' : 'Dernière vente'}
                      <ArrowUpDown size={12} className={tri === 'operation' ? 'opacity-100' : 'opacity-40'} />
                    </button>
                  </th>
                  <th className="text-center px-4 py-3 font-medium">
                    <button onClick={() => toggleTri('versement')} className="flex items-center gap-1 hover:opacity-80">
                      Dernier versement
                      <ArrowUpDown size={12} className={tri === 'versement' ? 'opacity-100' : 'opacity-40'} />
                    </button>
                  </th>
                  <th className="text-center px-4 py-3 font-medium">
                    <button onClick={() => toggleTri('montant')} className="flex items-center gap-1 hover:opacity-80">
                      {vue === 'fournisseurs' ? 'Dette' : 'Créance'}
                      <ArrowUpDown size={12} className={tri === 'montant' ? 'opacity-100' : 'opacity-40'} />
                    </button>
                  </th>
                  <th className="text-center px-4 py-3 font-medium">
                    <button onClick={() => toggleTri('recouvrement')} className="flex items-center gap-1 hover:opacity-80">
                      Prochain recouvrement
                      <ArrowUpDown size={12} className={tri === 'recouvrement' ? 'opacity-100' : 'opacity-40'} />
                    </button>
                  </th>
                  <th className="text-center px-4 py-3 font-medium">Statut</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {filtrés.map(p => {
                  const estFourn = vue === 'fournisseurs';
                  const montant = estFourn ? p.dette : p.creance;
                  const dernier = dernierVersementDe(p.id, estFourn);
                  return (
                    <tr key={p.id} onClick={() => router.push(`/site/${p.siteId ?? ctx.siteEcriture}/partenaires/${p.id}?vue=${vue}${ctx.ensemble ? '&de=ensemble' : ''}`)} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{p.nom}</td>
                      {ctx.ensemble && <CelluleSite nom={ctx.nomDe(p.siteId)} />}
                      <td className="px-4 py-3 text-center">
                        {(() => {
                          const o = derniereOperationDe(p.id, estFourn);
                          return o ? (
                            <span>
                              <span className="font-medium text-gray-700 dark:text-gray-300">
                                {formatMontant(o.montant)}
                              </span>
                              <span className="ml-1.5 text-xs text-gray-400">{anciennete(o.date)}</span>
                            </span>
                          ) : <span className="text-gray-300 dark:text-gray-600">—</span>;
                        })()}
                      </td>
                      {/* Cette colonne affichait un tiret en dur. Le dernier
                          versement se lit sur les documents du partenaire.
                          On montre l'ancienneté, pas la date : ce qui décide
                          d'une relance, c'est le temps écoulé depuis le
                          dernier paiement, pas le jour du calendrier. */}
                      <td className="px-4 py-3 text-gray-400 text-center">
                        {dernier ? (
                          <span>
                            <span className="text-gray-700 dark:text-gray-300">{formatMontant(dernier.montant)}</span>
                            <span className="ml-1.5 text-xs">{anciennete(dernier.date)}</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(montant)}</td>
                      <td className="px-4 py-3 text-gray-400 text-center">
                        {(() => {
                          const e = prochainRecouvrementDe(p, estFourn);
                          if (!e) return '—';
                          /* Une échéance dépassée est la seule qui appelle
                             une action : c'est la seule qu'on colore. */
                          const enRetard = e < new Date().toISOString().split('T')[0];
                          return (
                            <span>
                              <span className="text-gray-700 dark:text-gray-300">
                                {new Date(e).toLocaleDateString('fr-FR')}
                              </span>
                              <span className={`ml-1.5 text-xs ${
                                enRetard ? 'font-medium text-red-500' : 'text-gray-400'}`}>
                                {echeance(e)}
                              </span>
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {(() => { const s = statut(montant, verseDe(p, estFourn)); return (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.color}`}>{s.label}</span>
                        ); })()}
                      </td>
                      {/* Le retour part d'ici : c'est la marchandise de ce
                          tiers qui revient, on n'a pas à le choisir après. */}
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={e => { e.stopPropagation(); setRetourPour(p); }}
                          title="Enregistrer un retour"
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-400 transition-colors hover:bg-orange-50 hover:text-orange-600 dark:hover:bg-orange-900/20">
                          <Undo2 size={13} /> Retour
                        </button>
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
      )}

      {/* Modal nouveau partenaire */}
      {showModalPartenaire && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md shadow-xl p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouveau partenaire</h2>
                <p className="text-xs text-gray-400 mt-0.5">Peut être fournisseur, client, ou les deux à la fois</p>
              </div>
              <button onClick={() => setShowModalPartenaire(false)} className="text-gray-400 hover:text-gray-600 p-1">
                <X size={18} />
              </button>
            </div>

            {/* Nom */}
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom</p>
            <input type="text" placeholder="Ex. Électro Import SARL" value={nom}
              onChange={e => setNom(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            {/* Rôle */}
            <p className="text-xs font-bold text-gray-400 uppercase mb-2">Rôle</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button onClick={() => setRolesFournisseur(v => !v)}
                className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-all
                  ${rolesFournisseur
                    ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-gray-900 dark:text-gray-100'
                    : 'border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100'}`}>
                {rolesFournisseur && <span className="text-indigo-600">✓</span>} Fournisseur
              </button>
              <button onClick={() => setRolesClient(v => !v)}
                className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-all
                  ${rolesClient
                    ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-gray-900 dark:text-gray-100'
                    : 'border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100'}`}>
                {rolesClient && <span className="text-indigo-600">✓</span>} Client
              </button>
            </div>

            {/* Catégories fournisseur */}
            {rolesFournisseur && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-bold text-gray-400 uppercase">Catégories fournisseur</p>
                  <button onClick={() => { setRoleCats('fournisseur'); setShowModalCats(true); }}
                    className="text-xs text-indigo-500 flex items-center gap-1 hover:text-indigo-700">
                    <Eye size={12} /> Voir
                  </button>
                </div>
                <div className="relative">
                  <div className="min-h-[40px] px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-wrap gap-1 cursor-pointer"
                    onClick={() => setShowDropdownF(v => !v)}>
                    {catsFournisseurSel.length === 0
                      ? <span className="text-sm text-gray-400">Aucune catégorie</span>
                      : catsFournisseurSel.map(id => (
                        <span key={id} className="bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 text-xs px-2 py-0.5 rounded-full">{nomCat(id)}</span>
                      ))
                    }
                  </div>
                  {showDropdownF && (
                    <div className="absolute z-20 w-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg">
                      <div className="p-2 border-b border-gray-100 dark:border-gray-800">
                        <ChampRecherche placeholder="Rechercher une catégorie…" valeur={searchCatF} onChange={setSearchCatF} className="w-full" />
                      </div>
                      <div className="max-h-40 overflow-y-auto p-1">
                        {catsFournisseur.filter(c => c.nom.toLowerCase().includes(searchCatF.toLowerCase())).map(c => (
                          <label key={c.id} className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
                            <input type="checkbox" checked={catsFournisseurSel.includes(c.id)}
                              onChange={() => toggleCat('f', c.id)} className="accent-indigo-600" />
                            <span className="text-sm text-gray-700 dark:text-gray-300">{c.nom}</span>
                          </label>
                        ))}
                        {catsFournisseur.length === 0 && <p className="text-xs text-gray-400 px-3 py-2">Aucune catégorie — créez-en via "Voir"</p>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Catégories client */}
            {rolesClient && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-bold text-gray-400 uppercase">Catégories client</p>
                  <button onClick={() => { setRoleCats('client'); setShowModalCats(true); }}
                    className="text-xs text-indigo-500 flex items-center gap-1 hover:text-indigo-700">
                    <Eye size={12} /> Voir
                  </button>
                </div>
                <div className="relative">
                  <div className="min-h-[40px] px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-wrap gap-1 cursor-pointer"
                    onClick={() => setShowDropdownC(v => !v)}>
                    {catsClientSel.length === 0
                      ? <span className="text-sm text-gray-400">Aucune catégorie</span>
                      : catsClientSel.map(id => (
                        <span key={id} className="bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 text-xs px-2 py-0.5 rounded-full">{nomCat(id)}</span>
                      ))
                    }
                  </div>
                  {showDropdownC && (
                    <div className="absolute z-20 w-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg">
                      <div className="p-2 border-b border-gray-100 dark:border-gray-800">
                        <ChampRecherche placeholder="Rechercher une catégorie…" valeur={searchCatC} onChange={setSearchCatC} className="w-full" />
                      </div>
                      <div className="max-h-40 overflow-y-auto p-1">
                        {catsClient.filter(c => c.nom.toLowerCase().includes(searchCatC.toLowerCase())).map(c => (
                          <label key={c.id} className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
                            <input type="checkbox" checked={catsClientSel.includes(c.id)}
                              onChange={() => toggleCat('c', c.id)} className="accent-indigo-600" />
                            <span className="text-sm text-gray-700 dark:text-gray-300">{c.nom}</span>
                          </label>
                        ))}
                        {catsClient.length === 0 && <p className="text-xs text-gray-400 px-3 py-2">Aucune catégorie — créez-en via "Voir"</p>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Contact */}
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Contact</p>
            <input type="tel" placeholder="Ex. +225 07 12 34 56 78" value={contact}
              onChange={e => setContact(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            {/* Apporté par : un employé, dont la fonction suit, ou quelqu'un
                du dehors. Vide, le partenaire est venu de lui-même. */}
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Apporté par</p>
            {/* Trois cas, trois boutons : personne, un employé, ou quelqu'un
                du dehors. Dans une liste déroulante, les employés et les deux
                autres choix se mélangeaient. */}
            <div className="mb-2 grid grid-cols-3 gap-2">
              {([
                { cle: 'aucun' as const,   label: 'Sans apporteur' },
                { cle: 'employe' as const, label: 'Employé' },
                { cle: 'externe' as const, label: 'Externe' },
              ]).map(o => {
                const actif = modeApporteur === o.cle;
                return (
                  <button key={o.cle} type="button"
                    onClick={() => {
                      setModeApporteur(o.cle);
                      /* Changer de cas efface ce qu'on avait saisi dans
                         l'autre : sinon un nom externe survivrait au choix
                         d'un employé. */
                      setApporteurEmploye(o.cle === 'externe' ? 'externe' : '');
                      setApporteurNom(''); setApporteurFonction('');
                    }}
                    className={`rounded-xl border py-2.5 text-sm font-medium transition-all ${
                      actif
                        ? 'border-indigo-400 bg-indigo-50 text-gray-900 dark:bg-indigo-900/30 dark:text-gray-100'
                        : 'border-gray-200 text-gray-900 dark:border-gray-700 dark:text-gray-100'}`}>
                    {o.label}
                  </button>
                );
              })}
            </div>

            {modeApporteur === 'employe' && (
              <div className="mb-4">
                {/* Une liste d'employés peut être longue : on la cherche. */}
                <SelectCherchable valeur={apporteurEmploye} onChange={setApporteurEmploye}
                  options={employes.map(e => ({ valeur: e.id, label: e.nom, detail: e.fonction }))}
                  placeholder="Choisir un employé…" vide="Aucun employé" />
              </div>
            )}

            {modeApporteur === 'externe' && (
              <div className="mb-4 grid grid-cols-2 gap-2">
                <input type="text" placeholder="Nom" value={apporteurNom}
                  onChange={e => setApporteurNom(e.target.value)}
                  className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <input type="text" placeholder="Fonction" value={apporteurFonction}
                  onChange={e => setApporteurFonction(e.target.value)}
                  className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            )}
            {modeApporteur === 'aucun' && <div className="mb-4" />}

            {erreur && <p className="text-red-500 text-xs mb-3">{erreur}</p>}

            <div className="flex gap-3">
              <button onClick={() => setShowModalPartenaire(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={ajouterPartenaire} disabled={saving}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {saving ? <Loader2 size={15} className="animate-spin" /> : null} Ajouter le partenaire
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal catégories */}
      {showModalCats && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-900/40 rounded-lg flex items-center justify-center">
                  <Tag size={15} className="text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                    Catégories {roleCats === 'fournisseur' ? 'fournisseur' : 'client'}
                  </h2>
                </div>
              </div>
              <button onClick={() => setShowModalCats(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={16} /></button>
            </div>

            {/* Nouvelle catégorie */}
            <div className="flex gap-2 mb-1">
              <input type="text" placeholder="Nouvelle catégorie…" value={nouvelleCategorie}
                onChange={e => { setNouvelleCategorie(e.target.value); setErreurCat(''); }}
                onKeyDown={e => e.key === 'Enter' && ajouterCategorie()}
                className="flex-1 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button onClick={ajouterCategorie} disabled={savingCat || !nouvelleCategorie.trim()}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl flex items-center gap-1 transition-colors">
                <Plus size={14} /> Ajouter
              </button>
            </div>
            {erreurCat && <p className="text-red-500 text-xs mb-3">{erreurCat}</p>}
            {!erreurCat && <div className="mb-3" />}

            {/* Tableau */}
            <div className="rounded-xl overflow-hidden border border-gray-100 dark:border-gray-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    <th className="text-center px-3 py-2 font-medium">Catégorie</th>
                    <th className="text-center px-3 py-2 font-medium">Partenaires</th>
                    <th className="px-3 py-2 text-center" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                  {categories.filter(c => c.role === roleCats).map(c => (
                    <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{c.nom}</td>
                      <td className="px-3 py-2.5 text-gray-500 text-center">{c.nbPartenaires}</td>
                      <td className="px-3 py-2.5 flex items-center gap-2 justify-end text-center">
                        <button className="text-gray-400 hover:text-gray-600 p-1"><Pencil size={13} /></button>
                        <button onClick={() => supprimerCategorie(c)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={13} /></button>
                      </td>
                    </tr>
                  ))}
                  {categories.filter(c => c.role === roleCats).length === 0 && (
                    <tr><td colSpan={3} className="px-3 py-4 text-center text-gray-400 text-xs">Aucune catégorie</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <button onClick={() => setShowModalCats(false)}
              className="mt-4 w-full py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* Modal confirmation suppression catégorie */}
      {confirmSuppCat && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-xl flex items-center justify-center mb-4">
              <Trash2 size={18} className="text-amber-500" />
            </div>
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1">Supprimer cette catégorie ?</h2>
            <p className="text-sm text-gray-400 mb-5">
              <span className="font-medium text-gray-700 dark:text-gray-300">«&nbsp;{confirmSuppCat.nom}&nbsp;»</span> est liée à{' '}
              <span className="font-medium text-gray-700 dark:text-gray-300">{confirmSuppCat.nbPartenaires} partenaire{confirmSuppCat.nbPartenaires > 1 ? 's' : ''}</span>.
              En la supprimant, ces partenaires perdront cette catégorie.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmSuppCat(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={confirmerSuppression}
                className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-bold transition-colors">
                Supprimer quand même
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overlay dropdowns */}
      {(showDropdownF || showDropdownC) && (
        <div className="fixed inset-0 z-10" onClick={() => { setShowDropdownF(false); setShowDropdownC(false); }} />
      )}
    {/* Seuls les tiers qui doivent quelque chose sont proposés : verser à
        un compte soldé n'a pas d'objet. */}
    {/* Le versement s'écrit dans le site du partenaire, pas dans celui
        qu'on regarde : en vue d'ensemble les deux diffèrent. */}
    {retourPour && (retourPour.siteId ?? ctx.siteEcriture) && (
      <ModalRetour
        siteId={(retourPour.siteId ?? ctx.siteEcriture)!}
        userId={userId}
        role={vue === 'fournisseurs' ? 'fournisseur' : 'client'}
        partenaireId={retourPour.id}
        partenaireNom={retourPour.nom}
        onFermer={() => setRetourPour(null)}
        onRetour={fetchAll}
      />
    )}

    {versementOuvert && ctx.siteEcriture && peutVerserIci && (
      <ModalVersementTiers
        siteId={ctx.siteEcriture}
        userId={userId}
        /* Le chargé de recouvrement va chercher l'argent chez le client : il
           ne tient pas la caisse, et ce qu'il encaisse attend d'être remis.
           Le gérant, lui, encaisse au comptoir — l'argent va au tiroir dans
           le même geste. */
        parRemise={roleSite === 'recouvrement'}
        roleSite={roleSite}
        role={vue === 'fournisseurs' ? 'fournisseur' : 'client'}
        tiers={partenaires
          .filter(p => (vue === 'fournisseurs' ? p.rolesFournisseur : p.rolesClient))
          .map(p => ({ id: p.id, nom: p.nom, du: vue === 'fournisseurs' ? p.dette : p.creance }))
          .filter(t => t.du > 0)}
        onFermer={() => setVersementOuvert(false)}
        onVerse={(id, montant) => {
          /* Les soldes se recalculent : inutile de les corriger à la main,
             et le faire risquerait de les faire diverger du calcul. */
          fetchAll();
        }}
      />
    )}
    </div>
  );
}
