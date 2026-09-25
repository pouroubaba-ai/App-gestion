'use client';
import { estEnsemble, racineRetour } from '@/lib/retour';
import { useEffect, useState, useMemo, useRef } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { ChampRecherche } from '@/components/Champs';
import { sourceDe, LIBELLES_SOURCE, parApporteur, type Apporteur } from '@/lib/apporteur';
import { soldesDuSite, soldeDe, type SoldesParRole } from '@/lib/soldes';
import { LIBELLES_MOTIF_VERSEMENT } from '@/lib/versements-collection';
import { ArrowLeft, FileText, Package, RefreshCw, Loader2, Receipt, Banknote, ArrowUpDown, Filter, UserPlus, ChevronDown } from 'lucide-react';

type Role = 'client' | 'fournisseur';
type StatutFiltre = 'tous' | 'non-solde' | 'partiel' | 'solde';
type Onglet = 'partenaire' | 'produit' | 'mouvement' | 'document' | 'versement' | 'apporteur';

interface Mouvement {
  id: string;
  partenaireId: string;
  role: Role;
  /** ce qui a produit la ligne ; porte le motif du document */
  type?: 'achat' | 'vente';
  produit: string;
  unite: string;
  /** conditionnement de saisie ; absent quand la ligne est à l'unité */
  emballage?: string | null;
  quantite: number;
  cout: number;
  prixVente: number;
  date: string;
  nomPartenaire?: string;
  /* le dossier d'origine ; absent des lignes saisies à la main */
  achatId?: string | null;
  venteId?: string | null;
  reference?: string | null;
  /** le produit par son identifiant : le nom seul ne se recoupe pas */
  produitId?: string | null;
  /** ce qui a produit la ligne ; un retour en est un à part entière */
  motif?: 'achat' | 'vente' | 'retour';
  /** la ligne que ce retour annule ; absent hors retour */
  mouvementOrigineId?: string | null;
  /* Qui a fait le geste, figé au moment où il a eu lieu. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}

/** Un versement, quelle que soit son origine. */
interface Versement {
  id: string;
  date: string;
  heure?: string;
  montant: number;
  role: Role;
  motif: string;
  reference?: string | null;
  nomPartenaire?: string;
  /* Qui a encaissé, tel que figé au moment du geste. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
}

interface Partenaire {
  id: string;
  nom: string;
  verseF: number;
  verseC: number;
  dette: number;
  creance: number;
  rolesFournisseur: boolean;
  rolesClient: boolean;
  /* Qui a ajouté ce partenaire, figé à la création de sa fiche. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /** qui l'a amené ; distinct de l'auteur de la saisie */
  apporteur?: Apporteur | null;
}

/* La quantité rendue vient des mouvements de retour, pas d'un champ porté
   par la ligne : c'est elle qu'il faut déduire pour savoir ce qui reste. */
/**
 * Depuis combien de temps l'opération a eu lieu.
 *
 * Une date oblige à compter dans sa tête pour savoir si le compte est encore
 * vivant ; « il y a 5 j » se lit d'un coup d'œil sur toute une colonne.
 */
/** Le motif d'un versement en clair ; inconnu, il s'affiche tel quel. */
/**
 * Le rôle d'une ligne, même écrite avant que le champ n'existe.
 *
 * Son sens le dit : ce qui entre en stock vient d'un fournisseur, ce qui en
 * sort part chez un client. Sans cette déduction, tout l'historique antérieur
 * disparaîtrait des vues.
 */
function roleDe(m: { role?: Role | null; sens?: string }): Role {
  return m.role ?? (m.sens === 'entree' ? 'fournisseur' : 'client');
}

function libelleMotif(motif: string): string {
  const table = LIBELLES_MOTIF_VERSEMENT as Record<string, string>;
  return table[motif] ?? motif;
}

function anciennete(date: string): string {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const jours = Math.round((now.getTime() - d.getTime()) / 86400000);
  if (jours <= 0) return "aujourd'hui";
  if (jours === 1) return 'hier';
  return `il y a ${jours} j`;
}

function benefice(m: Mouvement, retour = 0) {
  return (m.quantite - retour) * (m.prixVente - m.cout);
}
function totalMouvement(m: Mouvement, role: Role, retour = 0) {
  return (m.quantite - retour) * (role === 'client' ? m.prixVente : m.cout);
}

/** Un en-tête de colonne qui trie au clic. */
function EnTeteTri({ cle, actif, sens, onTrier, children }: {
  cle: string;
  actif: boolean;
  sens: 'asc' | 'desc';
  onTrier: (cle: string) => void;
  children: React.ReactNode;
}) {
  return (
    <th className="text-center px-4 py-3 font-medium">
      <button onClick={() => onTrier(cle)}
        className="mx-auto flex items-center gap-1 transition-opacity hover:opacity-80">
        {children}
        <ArrowUpDown size={12} className={actif ? 'opacity-100' : 'opacity-40'} />
      </button>
    </th>
  );
}

export default function TransactionsSitePage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  const roleParam = (searchParams.get('role') as Role) ?? 'client';

  const [role, setRole] = useState<Role>(roleParam);
  const [onglet, setOngletBrut] = useState<Onglet>('partenaire');

  /* Un terme saisi sur les produits n'a rien à filtrer sur les versements :
     changer d'onglet repart d'une liste entière. */
  const [recherche, setRecherche] = useState('');
  const [ongletsOuverts, setOngletsOuverts] = useState(false);
  const boiteOnglets = useRef<HTMLDivElement>(null);

  /* Un clic ailleurs referme : sinon la liste reste ouverte sur la page. */
  useEffect(() => {
    if (!ongletsOuverts) return;
    function ailleurs(e: MouseEvent) {
      if (!boiteOnglets.current?.contains(e.target as Node)) setOngletsOuverts(false);
    }
    document.addEventListener('mousedown', ailleurs);
    return () => document.removeEventListener('mousedown', ailleurs);
  }, [ongletsOuverts]);
  function setOnglet(o: Onglet) { setOngletBrut(o); setRecherche(''); setFiltreStatut('tous'); }

  /* Le tri vit par onglet : revenir aux produits après avoir trié les
     versements doit retrouver les produits comme on les avait laissés. */
  const [tris, setTris] = useState<Record<string, { cle: string; sens: 'asc' | 'desc' }>>({});
  const tri = tris[onglet];

  function trier(cle: string) {
    setTris(p => {
      const actuel = p[onglet];
      /* Un premier clic classe du plus grand au plus petit : sur des
         montants, c'est ce qu'on cherche presque toujours. */
      const sens = actuel?.cle === cle && actuel.sens === 'desc' ? 'asc' : 'desc';
      return { ...p, [onglet]: { cle, sens } };
    });
  }

  /** Applique le tri courant à une liste, sur la valeur que `valeurDe` rend. */
  function applique<T>(liste: T[], valeurDe: (x: T, cle: string) => number | string | null): T[] {
    if (!tri) return liste;
    const signe = tri.sens === 'asc' ? 1 : -1;
    return [...liste].sort((a, b) => {
      const va = valeurDe(a, tri.cle) ?? 0;
      const vb = valeurDe(b, tri.cle) ?? 0;
      if (typeof va === 'string' || typeof vb === 'string') {
        return signe * String(va).localeCompare(String(vb));
      }
      return signe * (va - vb);
    });
  }

  /* Seuls les tableaux qui portent un statut se filtrent ainsi. */
  const [filtreStatut, setFiltreStatut] = useState<StatutFiltre>('tous');

  /* Les mêmes quatre états que l'onglet Partenaires : rien versé, versé en
     partie, entièrement réglé. Deux boutons seulement confondaient le tiers
     qui n'a rien payé avec celui qui a payé presque tout. */
  function statutDe(total: number, verse: number): Exclude<StatutFiltre, 'tous'> {
    if (total - verse <= 0) return 'solde';
    return verse > 0 ? 'partiel' : 'non-solde';
  }
  function passeStatut(total: number, verse: number) {
    return filtreStatut === 'tous' || statutDe(total, verse) === filtreStatut;
  }

  /** Le terme cherché, sans casse ni espaces morts. */
  const terme = recherche.trim().toLowerCase();
  /** Vrai si l'un des champs contient le terme ; vrai aussi sans terme. */
  function correspond(...champs: (string | null | undefined)[]) {
    if (!terme) return true;
    return champs.some(c => (c ?? '').toLowerCase().includes(terme));
  }
  const [mouvements, setMouvements] = useState<Mouvement[]>([]);
  const [partenaires, setPartenaires] = useState<Partenaire[]>([]);
  const [loading, setLoading] = useState(true);
  /* Les soldes se déduisent des dossiers non soldés, jamais de la fiche. */
  const [soldes, setSoldes] = useState<SoldesParRole | null>(null);
  /* ce qui a été payé sur chaque document, achat comme vente */
  const [verseParDoc, setVerseParDoc] = useState<Record<string, number>>({});
  const [versements, setVersements] = useState<Versement[]>([]);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getDocs(query(collection(db, 'partenaires'), where('siteId', '==', siteId), where('userId', '==', user.uid))),
      getDocs(query(collection(db, 'mouvements'), where('siteId', '==', siteId), where('userId', '==', user.uid))),
      /* Les versements vivent sur le document, pas sur ses lignes. */
      getDocs(query(collection(db, 'achats'), where('siteId', '==', siteId))),
      getDocs(query(collection(db, 'ventes'), where('siteId', '==', siteId))),
      /* Tous les versements, quelle que soit leur origine : imbriqués dans
         les dossiers, ils échappaient à toute lecture d'ensemble. */
      getDocs(query(collection(db, 'versements'), where('siteId', '==', siteId))),
    ]).then(([partSnap, movSnap, achSnap, venSnap, vSnap]) => {
      const parts = partSnap.docs.map(d => ({ id: d.id, ...d.data() } as Partenaire));
      const nomMap = new Map(parts.map(p => [p.id, p.nom]));
      setPartenaires(parts);
      setMouvements(movSnap.docs.map(d => {
        const data = { id: d.id, ...d.data() } as Mouvement;
        return { ...data, nomPartenaire: nomMap.get(data.partenaireId) ?? '—' };
      }));

      setVerseParDoc(Object.fromEntries([
        ...achSnap.docs.map(d => [d.id, d.data().avanceVersee ?? 0] as const),
        ...venSnap.docs.map(d => [d.id, d.data().avanceVersee ?? 0] as const),
      ]));

      setVersements(vSnap.docs
        .map(d => {
          const v = { id: d.id, ...d.data() } as any;
          return {
            id: v.id,
            date: v.date ?? '',
            heure: v.heure ?? '',
            montant: v.montant ?? 0,
            role: v.role as Role,
            motif: v.motif ?? 'reglement',
            reference: v.reference ?? null,
            nomPartenaire: v.partenaireNom ?? nomMap.get(v.partenaireId) ?? '—',
            utilisateurNom: v.utilisateurNom ?? null,
            utilisateurFonction: v.utilisateurFonction ?? null,
          } as Versement;
        })
        /* du plus récent au plus ancien : on vient voir ce qui vient d'entrer */
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')));

      setLoading(false);
    });
    soldesDuSite(siteId).then(setSoldes);
  }, [user, siteId]);

  /* Les lignes du rôle affiché, retours exclus : un retour est un mouvement
     à part, on le montre à côté de ce qu'il annule, pas comme une vente. */
  /* Les lignes écrites avant que le motif n'existe n'en portent pas : les
     exclure ferait disparaître tout l'historique antérieur. Seul un motif
     `retour` explicite écarte une ligne d'ici. */
  const filtres = useMemo(
    () => mouvements.filter(m => roleDe(m) === role && m.motif !== 'retour'),
    [mouvements, role]);

  const retours = useMemo(
    () => mouvements.filter(m => roleDe(m) === role && m.motif === 'retour'),
    [mouvements, role]);

  /** Valeur d'un mouvement de retour, au prix du sens concerné. */
  function valeurRetour(m: Mouvement) {
    return m.quantite * (role === 'client' ? m.prixVente : m.cout);
  }

  /** Ce qui a été retourné sur une ligne, un document, un produit ou un tiers. */
  function retoursDe(critere: (m: Mouvement) => boolean) {
    const liste = retours.filter(critere);
    return {
      quantite: liste.reduce((n, m) => n + m.quantite, 0),
      valeur: liste.reduce((n, m) => n + valeurRetour(m), 0),
    };
  }

  /* Agrégation onglet partenaire */
  const statsPartenaires = useMemo(() => {
    return partenaires
      .filter(p => role === 'client' ? p.rolesClient : p.rolesFournisseur)
      .map(p => {
        const movs = filtres.filter(m => m.partenaireId === p.id);
        const totalTx = movs.reduce((s, m) => s + totalMouvement(m, role), 0);
        const totalBenef = movs.reduce((s, m) => s + benefice(m), 0);
        /* Les retours sont leurs propres mouvements : on les cherche par
           leur motif et le partenaire, jamais dans un champ de la ligne. */
        const totalRetour = retoursDe(r => r.partenaireId === p.id).valeur;
        /* La dernière opération vient des soldes, comme le reste : la
           calculer ici depuis les mouvements donnait une autre date que
           l'onglet Partenaires, pour le même tiers. */
        /* Versé et reste viennent du même calcul : deux sources pour le
           même compte finiraient par afficher deux chiffres. */
        const solde = soldes ? soldeDe(soldes, p.id, role) : null;
        const verse = solde?.verse ?? 0;
        const reste = solde?.reste ?? 0;
        return {
          id: p.id, nom: p.nom, totalTx, totalBenef, totalRetour, verse, reste,
          derniere: solde?.derniereOperation ?? '',
          derniereValeur: solde?.derniereValeur ?? 0,
          utilisateurNom: p.utilisateurNom ?? null,
          utilisateurFonction: p.utilisateurFonction ?? null,
          apporteur: p.apporteur ?? null,
        };
      });
  }, [partenaires, filtres, role, soldes, retours]);

  /* Agrégation onglet produit */
  const statsProduits = useMemo(() => {
    const map = new Map<string, {
      produit: string; produitId: string | null;
      unite: string; emballage: string | null;
      quantite: number; coutTotal: number; venteTotal: number;
    }>();
    filtres.forEach(m => {
      const e = map.get(m.produit) ?? {
        produit: m.produit, produitId: m.produitId ?? null,
        unite: m.unite, emballage: m.emballage ?? null,
        quantite: 0, coutTotal: 0, venteTotal: 0,
      };
      map.set(m.produit, {
        produit: m.produit,
        produitId: e.produitId ?? m.produitId ?? null,
        unite: e.unite || m.unite,
        /* Un produit peut arriver en carton puis à la pièce : on garde le
           premier conditionnement vu, et la colonne le signale. */
        emballage: e.emballage ?? m.emballage ?? null,
        quantite: e.quantite + m.quantite,
        coutTotal: e.coutTotal + m.quantite * m.cout,
        venteTotal: e.venteTotal + m.quantite * m.prixVente,
      });
    });
    /* Les retours d'un produit se cherchent par son identifiant, dans les
       mouvements qui portent le motif retour. */
    return Array.from(map.values()).map(e => {
      const r = retoursDe(x => e.produitId
        ? x.produitId === e.produitId
        : x.produit === e.produit);
      return { ...e, retour: r.quantite, retourValeur: r.valeur };
    });
  }, [filtres, retours, role]);

  /* Agrégation onglet document : les lignes d'un même dossier se regroupent
     sous lui. Une ligne sans dossier a été saisie à la main et reste seule. */
  const documents = useMemo(() => {
    const map = new Map<string, {
      cle: string; reference: string; achatId?: string | null; venteId?: string | null;
      nomPartenaire: string; date: string;
      utilisateurNom: string | null; utilisateurFonction: string | null;
      produits: number; total: number; retour: number; verse: number;
    }>();
    filtres.forEach(m => {
      const cle = m.achatId ?? m.venteId ?? `libre-${m.id}`;
      const prev = map.get(cle);
      map.set(cle, {
        cle,
        reference: m.reference ?? '—',
        achatId: m.achatId ?? null,
        venteId: m.venteId ?? null,
        nomPartenaire: m.nomPartenaire ?? '—',
        /* L'auteur du premier mouvement du dossier : c'est lui qui l'a conclu. */
        utilisateurNom: prev?.utilisateurNom ?? m.utilisateurNom ?? null,
        utilisateurFonction: prev?.utilisateurFonction ?? m.utilisateurFonction ?? null,
        date: prev && prev.date > m.date ? prev.date : m.date,
        produits: (prev?.produits ?? 0) + 1,
        total: (prev?.total ?? 0) + totalMouvement(m, role),
        retour: 0,
        verse: verseParDoc[m.achatId ?? m.venteId ?? ''] ?? 0,
      });
    });
    /* Les retours d'un document se cherchent par son identifiant, comme
       ceux d'un produit par le sien. */
    return [...map.values()]
      .map(d => ({
        ...d,
        retour: retoursDe(r => (r.achatId ?? r.venteId) === (d.achatId ?? d.venteId)
          && !!(d.achatId ?? d.venteId)).valeur,
      }))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  }, [filtres, retours, verseParDoc, role]);

  const versementsRole = useMemo(
    () => versements.filter(v => v.role === role), [versements, role]);

  /* Du plus proche de la question posée au plus éloigné : on arrive ici
     depuis une carte de créances ou de dettes, donc pour savoir qui doit
     quoi. Les trois premiers onglets parlent d'argent, les deux derniers
     de marchandise, et le détail ligne à ligne vient en dernier — on y
     descend pour vérifier, jamais pour commencer. */
  /* Le compteur de chaque filtre, calculé avant qu'il ne s'applique :
     « Soldé (0) » se lit, « Soldé » seul laisse cliquer dans le vide. */
  function compteStatut(s: StatutFiltre): number {
    const lignes: { total: number; verse: number }[] = onglet === 'partenaire'
      ? statsPartenaires.filter(p => correspond(p.nom))
          .map(p => ({ total: p.totalTx, verse: p.verse }))
      : onglet === 'document'
        ? documents.filter(d => correspond(d.reference, d.nomPartenaire))
            .map(d => ({ total: d.total, verse: d.verse }))
      : onglet === 'apporteur'
        ? parApporteur(statsPartenaires.map(p => ({
            apporteur: p.apporteur, total: p.totalTx, benefice: p.totalBenef,
            verse: p.verse, retour: p.totalRetour, reste: p.reste,
            derniere: p.derniere, derniereValeur: p.derniereValeur,
          }))).filter(a => correspond(a.nom, a.fonction))
            .map(a => ({ total: a.total, verse: a.verse }))
        : [];
    if (s === 'tous') return lignes.length;
    return lignes.filter(l => statutDe(l.total, l.verse) === s).length;
  }

  /* Les apporteurs se déduisent des partenaires déjà agrégés : c'est la
     même matière, regroupée autrement. */
  const apporteursVus = applique(
    parApporteur(statsPartenaires.map(p => ({
      apporteur: p.apporteur,
      total: p.totalTx,
      benefice: p.totalBenef,
      verse: p.verse,
      retour: p.totalRetour,
      reste: p.reste,
      derniere: p.derniere,
      derniereValeur: p.derniereValeur,
    }))).filter(a => correspond(a.nom, a.fonction) && passeStatut(a.total, a.verse)),
    (a, c) => ({
      nom: a.nom, tiers: a.tiers, derniere: a.derniere ?? '', total: a.total, benefice: a.benefice,
      perte: a.perte, verse: a.verse, retour: a.retour, reste: a.reste,
    } as Record<string, number | string>)[c] ?? 0);

  /* Chaque onglet se cherche sur ce qui le désigne : un nom de tiers, une
     référence, un produit. Le filtre s'applique après l'agrégation — on
     cherche dans ce qui est affiché, pas dans les lignes brutes. */
  const partenairesVus = applique(
    statsPartenaires.filter(p => correspond(p.nom) && passeStatut(p.totalTx, p.verse)),
    (p, c) => ({
      nom: p.nom, total: p.totalTx, benefice: p.totalBenef, retour: p.totalRetour,
      verse: p.verse, reste: p.reste, derniere: p.derniereValeur,
    } as Record<string, number | string>)[c] ?? 0);

  const documentsVus = applique(
    documents.filter(d =>
      correspond(d.reference, d.nomPartenaire) && passeStatut(d.total, d.verse)),
    (d, c) => ({
      reference: d.reference, partenaire: d.nomPartenaire, date: d.date,
      produits: d.produits, total: d.total, verse: d.verse,
      retour: d.retour, reste: Math.max(0, d.total - d.verse),
    } as Record<string, number | string>)[c] ?? 0);

  const versementsVus = applique(
    versementsRole.filter(v =>
      correspond(v.nomPartenaire, v.reference, v.motif, v.utilisateurNom)),
    (v, c) => ({
      date: v.date, partenaire: v.nomPartenaire ?? '', motif: v.motif,
      montant: v.montant,
    } as Record<string, number | string>)[c] ?? 0);

  const produitsVus = applique(
    statsProduits.filter(p => correspond(p.produit, p.unite, p.emballage)),
    (p, c) => ({
      produit: p.produit, quantite: p.quantite, retour: p.retour,
      retourValeur: p.retourValeur, coutTotal: p.coutTotal, venteTotal: p.venteTotal,
    } as Record<string, number | string>)[c] ?? 0);

  const mouvementsVus = applique(
    filtres.filter(m => correspond(m.produit, m.nomPartenaire, m.reference)),
    (m, c) => ({
      produit: m.produit, date: m.date, partenaire: m.nomPartenaire ?? '',
      quantite: m.quantite, cout: m.cout, prixVente: m.prixVente,
    } as Record<string, number | string>)[c] ?? 0);

  const onglets: { key: Onglet; label: string; icon: React.ElementType }[] = [
    { key: 'partenaire', label: role === 'client' ? 'Clients' : 'Fournisseurs', icon: FileText },
    { key: 'document',   label: 'Documents',  icon: Receipt },
    { key: 'versement',  label: 'Versements', icon: Banknote },
    { key: 'produit',    label: 'Produits',   icon: Package },
    { key: 'mouvement',  label: 'Mouvements', icon: RefreshCw },
    /* Le rendement d'un portefeuille : ce que les tiers d'un apporteur ont
       rapporté, quel que soit celui qui a tenu la caisse. */
    { key: 'apporteur',  label: 'Apporteurs', icon: UserPlus },
  ];

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="p-4 sm:p-6">

        {/* Retour */}
        {/* On revient d'où l'on vient : la carte des créances s'ouvre
            aussi depuis la vue d'ensemble. */}
        <button onClick={() => router.push(
          `${racineRetour(estEnsemble(searchParams), siteId)}`
          + `?onglet=partenaires&vue=${role === 'client' ? 'clients' : 'fournisseurs'}`)}
          className="flex items-center gap-2 mb-5 group">
          <ArrowLeft size={15} className="text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200 transition-colors" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
            Partenaires
          </span>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <span className="text-sm text-gray-400">{role === 'client' ? 'Clients' : 'Fournisseurs'}</span>
        </button>

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
            {(['client', 'fournisseur'] as Role[]).map(r => (
              <button key={r} onClick={() => setRole(r)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all
                  ${role === r ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-gray-400 dark:text-gray-500'}`}>
                {r === 'client' ? 'Clients' : 'Fournisseurs'}
              </button>
            ))}
          </div>
        </div>

        {/* Six onglets alignés se ressemblaient trop pour qu'on les
            distingue. Repliés, on lit d'abord où l'on est. */}
        <div className="relative mb-4" ref={boiteOnglets}>
          <button onClick={() => setOngletsOuverts(o => !o)}
            className="flex w-full items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:border-indigo-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 sm:w-auto sm:min-w-[220px]">
            <span className="flex items-center gap-2">
              {(() => {
                const o = onglets.find(x => x.key === onglet);
                const Icon = o?.icon ?? FileText;
                return <><Icon size={15} className="text-indigo-500" /> {o?.label}</>;
              })()}
            </span>
            <ChevronDown size={15} className={`text-gray-400 transition-transform ${
              ongletsOuverts ? 'rotate-180' : ''}`} />
          </button>

          {ongletsOuverts && (
            <div className="absolute left-0 top-full z-30 mt-1 w-full overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900 sm:w-[260px]">
              {onglets.map(o => {
                const Icon = o.icon;
                const actif = onglet === o.key;
                return (
                  <button key={o.key}
                    onClick={() => { setOnglet(o.key); setOngletsOuverts(false); }}
                    className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
                      actif
                        ? 'bg-indigo-50 font-medium text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400'
                        : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800'}`}>
                    <Icon size={15} className={actif ? 'text-indigo-500' : 'text-gray-400'} />
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Contenu : recherche, filtres et tableau dans la même carte —
            posés sur le fond gris, ils flottaient sans rien délimiter. */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">

        <div className="flex flex-wrap items-center gap-2 p-4 pb-3">
          <div className="relative min-w-[200px] flex-1">
            <ChampRecherche
              placeholder={{
                partenaire: role === 'client' ? 'Rechercher un client…' : 'Rechercher un fournisseur…',
                document: 'Rechercher une référence, un partenaire…',
                versement: 'Rechercher un partenaire, une référence, un motif…',
                produit: 'Rechercher un produit…',
                mouvement: 'Rechercher un produit, un partenaire…',
                apporteur: 'Rechercher un apporteur…',
              }[onglet]}
              valeur={recherche}
              onChange={setRecherche}
              className="w-full"
            />
          </div>

          {/* Seuls les tableaux qui portent un statut se filtrent ainsi : un
              versement est un fait accompli, il n'est ni soldé ni partiel. */}
          {(onglet === 'partenaire' || onglet === 'document' || onglet === 'apporteur') && (
            <div className="flex items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
              <Filter size={13} className="ml-1 mr-0.5 text-gray-400" />
              {(['tous', 'non-solde', 'partiel', 'solde'] as const).map(st => (
                <button key={st} onClick={() => setFiltreStatut(st)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    filtreStatut === st
                      ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                      : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
                  {st === 'tous' ? 'Tous' : st === 'partiel' ? 'Partiel'
                    : st === 'non-solde' ? 'Non soldé' : 'Soldé'} ({compteStatut(st)})
                </button>
              ))}
            </div>
          )}
        </div>


          {/* Onglet Partenaires */}
          {onglet === 'partenaire' && (
            partenairesVus.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun {role === 'client' ? 'client' : 'fournisseur'}</div>
              : (
                <div className="overflow-x-auto">
                  <p className="px-4 pb-1 text-sm font-medium text-gray-500">
                    {partenairesVus.length} {role === 'client' ? 'client' : 'fournisseur'}{partenairesVus.length > 1 ? 's' : ''}
                  </p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">Nom</th>
                        <th className="text-center px-4 py-3 font-medium">
                          {role === 'client' ? 'Dernière vente' : 'Dernier achat'}
                        </th>
                        <EnTeteTri cle="total" actif={tri?.cle === 'total'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Total</EnTeteTri>
                        {/* Un fournisseur ne dégage aucun bénéfice : on lui
                            achète, on ne lui vend rien. La marge naît à la
                            revente, et elle appartient au client. */}
                        {role === 'client' && <EnTeteTri cle="benefice" actif={tri?.cle === 'benefice'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Bénéfice</EnTeteTri>}
                        {role === 'client' && <th className="text-center px-4 py-3 font-medium">Perte</th>}
                        <EnTeteTri cle="verse" actif={tri?.cle === 'verse'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Versé</EnTeteTri>
                        <EnTeteTri cle="retour" actif={tri?.cle === 'retour'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Total retour</EnTeteTri>
                        <EnTeteTri cle="reste" actif={tri?.cle === 'reste'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Reste</EnTeteTri>
                        <th className="text-center px-4 py-3 font-medium">Statut</th>
                        {/* Qui l'a amené, et d'où : un employé ou quelqu'un
                            du dehors. Distinct de l'auteur de la saisie. */}
                        <th className="text-center px-4 py-3 font-medium">Apporté par</th>
                        <th className="text-center px-4 py-3 font-medium">Source</th>
                        {/* Qui a ajouté le tiers, comme dans l'onglet
                            Partenaires : la fonction puis l'auteur. */}
                        <th className="text-center px-4 py-3 font-medium">Fonction</th>
                        <th className="text-center px-4 py-3 font-medium">Auteur</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {partenairesVus.map(p => {
                        const perte = p.totalBenef < 0 ? p.totalBenef : 0;
                        return (
                          <tr key={p.id}
                            onClick={() => router.push(`/site/${siteId}/partenaires/${p.id}/transactions?role=${role}&retour=global`)}
                            className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{p.nom}</td>
                            <td className="px-4 py-3 text-center">
                              {p.derniere ? (
                                <span>
                                  <span className="font-medium text-gray-700 dark:text-gray-300">
                                    {formatMontant(p.derniereValeur)}
                                  </span>
                                  <span className="ml-1.5 text-xs text-gray-400">{anciennete(p.derniere)}</span>
                                </span>
                              ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                            </td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(p.totalTx)}</td>
                            {role === 'client' && (
                              <td className="px-4 py-3 text-center">
                                <span className={p.totalBenef >= 0 ? 'text-green-600 font-medium' : 'text-gray-400'}>
                                  {p.totalBenef >= 0 ? `+${formatMontant(p.totalBenef)}` : '—'}
                                </span>
                              </td>
                            )}
                            {role === 'client' && (
                              <td className="px-4 py-3 text-center">
                                <span className={perte < 0 ? 'text-red-500 font-medium' : 'text-gray-400'}>
                                  {perte < 0 ? formatMontant(perte) : '—'}
                                </span>
                              </td>
                            )}
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(p.verse)}</td>
                            <td className={`px-4 py-3 text-center ${
                              p.totalRetour > 0 ? 'text-orange-500 font-medium' : 'text-gray-300 dark:text-gray-600'}`}>
                              {formatMontant(p.totalRetour)}
                            </td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(p.reste)}</td>
                            <td className="px-4 py-3 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${p.reste <= 0 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                                {p.reste <= 0 ? 'Soldé' : 'Partiel'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className="text-gray-700 dark:text-gray-300">{p.apporteur?.nom ?? '—'}</span>
                              {p.apporteur?.fonction && (
                                <span className="ml-1.5 text-xs text-gray-400">{p.apporteur.fonction}</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {(() => {
                                const src = sourceDe(p.apporteur);
                                return (
                                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                                    src === 'interne'
                                      ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
                                      : src === 'externe'
                                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                        : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>
                                    {LIBELLES_SOURCE[src]}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-center">{p.utilisateurFonction ?? '—'}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{p.utilisateurNom ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {/* Onglet Produits */}
          {onglet === 'produit' && (
            produitsVus.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun produit</div>
              : (
                <div className="overflow-x-auto">
                  <p className="px-4 pb-1 text-sm font-medium text-gray-500">
                    {produitsVus.length} produit{produitsVus.length > 1 ? 's' : ''}
                  </p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">Produit</th>
                        <th className="text-center px-4 py-3 font-medium">Unité</th>
                        <th className="text-center px-4 py-3 font-medium">Emballage</th>
                        <EnTeteTri cle="quantite" actif={tri?.cle === 'quantite'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Quantité</EnTeteTri>
                        <EnTeteTri cle="retour" actif={tri?.cle === 'retour'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Retour</EnTeteTri>
                        <EnTeteTri cle="coutTotal" actif={tri?.cle === 'coutTotal'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Coût total</EnTeteTri>
                        <EnTeteTri cle="retourValeur" actif={tri?.cle === 'retourValeur'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Total retour</EnTeteTri>
                        {role === 'client' && <>
                          <th className="text-center px-4 py-3 font-medium">Vente total</th>
                          <th className="text-center px-4 py-3 font-medium">Différence</th>
                          <th className="text-center px-4 py-3 font-medium">État</th>
                        </>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {produitsVus.map(p => {
                        const diff = p.venteTotal - p.coutTotal;
                        const gain = diff >= 0;
                        return (
                          <tr key={p.produit} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{p.produit}</td>
                            <td className="px-4 py-3 text-gray-500 text-center">{p.unite || '—'}</td>
                            <td className="px-4 py-3 text-gray-500 text-center">{p.emballage || '—'}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{p.quantite}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{p.retour}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(p.coutTotal)}</td>
                            <td className={`px-4 py-3 text-center ${
                              p.retourValeur > 0 ? 'text-orange-500 font-medium' : 'text-gray-300 dark:text-gray-600'}`}>
                              {formatMontant(p.retourValeur)}
                            </td>
                            {role === 'client' && <>
                              <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(p.venteTotal)}</td>
                              <td className={`px-4 py-3 font-medium ${gain ? 'text-green-600' : 'text-red-500'} text-center`}>
                                {gain ? '+' : ''}{formatMontant(diff)}
                              </td>
                              <td className="px-4 py-3 text-center">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${gain ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>
                                  {gain ? 'Bénéfice' : 'Perte'}
                                </span>
                              </td>
                            </>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {/* Onglet Mouvements */}
          {onglet === 'mouvement' && (
            mouvementsVus.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun mouvement</div>
              : (
                <div className="overflow-x-auto">
                  <p className="px-4 pb-1 text-sm font-medium text-gray-500">
                    {mouvementsVus.length} mouvement{mouvementsVus.length > 1 ? 's' : ''}
                  </p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">Produit</th>
                        <th className="text-center px-4 py-3 font-medium">Date</th>
                        <th className="text-center px-4 py-3 font-medium">{role === 'client' ? 'Client' : 'Fournisseur'}</th>
                        <th className="text-center px-4 py-3 font-medium">Unité</th>
                        <EnTeteTri cle="quantite" actif={tri?.cle === 'quantite'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Quantité</EnTeteTri>
                        <th className="text-center px-4 py-3 font-medium">Retour</th>
                        <EnTeteTri cle="cout" actif={tri?.cle === 'cout'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Coût</EnTeteTri>
                        <th className="text-center px-4 py-3 font-medium">Total retour</th>
                        {/* Un fournisseur ne dégage ni marge ni perte : on lui
                            achète. Un prix de vente « prévu » et sa différence
                            ne se jouent qu'à la revente, donc côté client. */}
                        {role === 'client' && <th className="text-center px-4 py-3 font-medium">Prix</th>}
                        <th className="text-center px-4 py-3 font-medium">Total</th>
                        {role === 'client' && <th className="text-center px-4 py-3 font-medium">Différence</th>}
                        {role === 'client' && <th className="text-center px-4 py-3 font-medium">État</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {mouvementsVus.map(m => {
                        /* Ce qui a été rendu sur cette ligne précise : les
                           retours qui portent son identifiant. */
                        const r = retoursDe(x => x.mouvementOrigineId === m.id);
                        const diff = benefice(m, r.quantite);
                        const gain = diff >= 0;
                        const tot = totalMouvement(m, role, r.quantite);
                        return (
                          <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{m.produit}</td>
                            <td className="px-4 py-3 text-gray-500 text-center">{new Date(m.date).toLocaleDateString('fr-FR')}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{m.nomPartenaire}</td>
                            <td className="px-4 py-3 text-gray-500 text-center">{m.unite}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{m.quantite}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{r.quantite}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(m.cout)}</td>
                            {/* Le retour en argent, juste après le coût dont
                                il se déduit : deux cartons et deux pièces ne
                                pèsent pas pareil, la quantité seule ne dit
                                pas ce qui est reparti. */}
                            <td className={`px-4 py-3 text-center ${
                              r.valeur > 0 ? 'text-orange-500 font-medium' : 'text-gray-300 dark:text-gray-600'}`}>
                              {formatMontant(r.valeur)}
                            </td>
                            {role === 'client' && (
                              <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{m.prixVente > 0 ? formatMontant(m.prixVente) : '—'}</td>
                            )}
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(tot)}</td>
                            {role === 'client' && (
                            <td className={`px-4 py-3 font-medium ${gain ? 'text-green-600' : 'text-red-500'} text-center`}>
                              {gain ? '+' : ''}{formatMontant(diff)}
                            </td>
                            )}
                            {role === 'client' && (
                            <td className="px-4 py-3 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${gain ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>
                                {gain ? 'Bénéfice' : 'Perte'}
                              </span>
                            </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {/* Onglet Documents */}
          {onglet === 'document' && (
            documentsVus.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun document</div>
              : (
                <div className="overflow-x-auto">
                  <p className="px-4 pb-1 text-sm font-medium text-gray-500">
                    {documentsVus.length} document{documentsVus.length > 1 ? 's' : ''}
                  </p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">Référence</th>
                        <th className="text-center px-4 py-3 font-medium">{role === 'client' ? 'Client' : 'Fournisseur'}</th>
                        <th className="text-center px-4 py-3 font-medium">Date</th>
                        <EnTeteTri cle="produits" actif={tri?.cle === 'produits'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Produits</EnTeteTri>
                        <EnTeteTri cle="total" actif={tri?.cle === 'total'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Total</EnTeteTri>
                        <EnTeteTri cle="verse" actif={tri?.cle === 'verse'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Versé</EnTeteTri>
                        <EnTeteTri cle="retour" actif={tri?.cle === 'retour'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Total retour</EnTeteTri>
                        <EnTeteTri cle="reste" actif={tri?.cle === 'reste'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Reste</EnTeteTri>
                        <th className="text-center px-4 py-3 font-medium">Statut</th>
                        <th className="text-center px-4 py-3 font-medium">Fonction</th>
                        <th className="text-center px-4 py-3 font-medium">Auteur</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {documentsVus.map(d => {
                        const reste = Math.max(0, d.total - d.verse);
                        const lien = d.achatId
                          ? `/site/${siteId}/achats/${d.achatId}`
                          : d.venteId ? `/site/${siteId}/ventes/${d.venteId}` : null;
                        return (
                          <tr key={d.cle}
                            onClick={() => lien && router.push(lien)}
                            className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${lien ? 'cursor-pointer' : ''}`}>
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{d.reference}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{d.nomPartenaire}</td>
                            <td className="px-4 py-3 text-gray-500 text-center">
                              {d.date ? new Date(d.date).toLocaleDateString('fr-FR') : '—'}
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-center">{d.produits}</td>
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(d.total)}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(d.verse)}</td>
                            <td className={`px-4 py-3 text-center ${
                              d.retour > 0 ? 'text-orange-500 font-medium' : 'text-gray-300 dark:text-gray-600'}`}>
                              {formatMontant(d.retour)}
                            </td>
                            <td className={`px-4 py-3 font-medium text-center ${reste > 0 ? 'text-orange-500' : 'text-gray-400'}`}>
                              {formatMontant(reste)}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${reste <= 0
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                                {reste <= 0 ? 'Soldé' : 'Partiel'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-center">{d.utilisateurFonction ?? '—'}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{d.utilisateurNom ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {/* Onglet Apporteurs */}
          {onglet === 'apporteur' && (
            apporteursVus.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun apporteur</div>
              : (
                <div className="overflow-x-auto">
                  <p className="px-4 pb-1 text-sm font-medium text-gray-500">
                    {apporteursVus.length} apporteur{apporteursVus.length > 1 ? 's' : ''}
                  </p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <EnTeteTri cle="nom" actif={tri?.cle === 'nom'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Nom</EnTeteTri>
                        <th className="text-center px-4 py-3 font-medium">Source</th>
                        <EnTeteTri cle="tiers" actif={tri?.cle === 'tiers'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>
                          {role === 'client' ? 'Clients' : 'Fournisseurs'}
                        </EnTeteTri>
                        <EnTeteTri cle="derniere" actif={tri?.cle === 'derniere'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>
                          {role === 'client' ? 'Dernière vente' : 'Dernier achat'}
                        </EnTeteTri>
                        <EnTeteTri cle="total" actif={tri?.cle === 'total'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Total</EnTeteTri>
                        {/* Un fournisseur ne dégage aucune marge : on lui achète. */}
                        {role === 'client' && (
                          <EnTeteTri cle="benefice" actif={tri?.cle === 'benefice'}
                            sens={tri?.sens ?? 'desc'} onTrier={trier}>Bénéfice</EnTeteTri>
                        )}
                        {role === 'client' && (
                          <EnTeteTri cle="perte" actif={tri?.cle === 'perte'}
                            sens={tri?.sens ?? 'desc'} onTrier={trier}>Perte</EnTeteTri>
                        )}
                        <EnTeteTri cle="verse" actif={tri?.cle === 'verse'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Versé</EnTeteTri>
                        <EnTeteTri cle="retour" actif={tri?.cle === 'retour'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Total retour</EnTeteTri>
                        <EnTeteTri cle="reste" actif={tri?.cle === 'reste'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Reste</EnTeteTri>
                        <th className="text-center px-4 py-3 font-medium">Statut</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {apporteursVus.map(a => (
                        <tr key={a.cle} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-4 py-3 text-center">
                            <span className="font-medium text-gray-900 dark:text-gray-100">{a.nom}</span>
                            {a.fonction && (
                              <span className="ml-1.5 text-xs text-gray-400">{a.fonction}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {/* Le nom dit déjà « Sans apporteur » : le répéter
                                en pastille n'ajoute rien. */}
                            {a.source === 'aucun' ? (
                              <span className="text-gray-300 dark:text-gray-600">—</span>
                            ) : (
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                                a.source === 'interne'
                                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
                                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                                {LIBELLES_SOURCE[a.source]}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{a.tiers}</td>
                          <td className="px-4 py-3 text-center">
                            {a.derniere ? (
                              <span>
                                <span className="font-medium text-gray-700 dark:text-gray-300">
                                  {formatMontant(a.derniereValeur)}
                                </span>
                                <span className="ml-1.5 text-xs text-gray-400">{anciennete(a.derniere)}</span>
                              </span>
                            ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{formatMontant(a.total)}</td>
                          {role === 'client' && (
                            <td className="px-4 py-3 text-center">
                              <span className={a.benefice > 0 ? 'text-green-600 font-medium' : 'text-gray-400'}>
                                {a.benefice > 0 ? `+${formatMontant(a.benefice)}` : '—'}
                              </span>
                            </td>
                          )}
                          {role === 'client' && (
                            <td className="px-4 py-3 text-center">
                              <span className={a.perte < 0 ? 'text-red-500 font-medium' : 'text-gray-400'}>
                                {a.perte < 0 ? formatMontant(a.perte) : '—'}
                              </span>
                            </td>
                          )}
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(a.verse)}</td>
                          <td className={`px-4 py-3 text-center ${
                            a.retour > 0 ? 'text-orange-500 font-medium' : 'text-gray-300 dark:text-gray-600'}`}>
                            {formatMontant(a.retour)}
                          </td>
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{formatMontant(a.reste)}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${a.reste <= 0
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                              {a.reste <= 0 ? 'Soldé' : 'Partiel'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {/* Onglet Versements */}
          {onglet === 'versement' && (
            versementsVus.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun versement</div>
              : (
                <div className="overflow-x-auto">
                  <p className="px-4 pb-1 text-sm font-medium text-gray-500">
                    {versementsVus.length} versement{versementsVus.length > 1 ? 's' : ''}
                    <span className="ml-2 text-gray-400">
                      · Total {formatMontant(versementsVus.reduce((n, v) => n + v.montant, 0))}
                    </span>
                  </p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">Date</th>
                        <th className="text-center px-4 py-3 font-medium">Heure</th>
                        <th className="text-center px-4 py-3 font-medium">{role === 'client' ? 'Client' : 'Fournisseur'}</th>
                        <th className="text-center px-4 py-3 font-medium">Motif</th>
                        <th className="text-center px-4 py-3 font-medium">Référence</th>
                        <EnTeteTri cle="montant" actif={tri?.cle === 'montant'}
                          sens={tri?.sens ?? 'desc'} onTrier={trier}>Montant</EnTeteTri>
                        {/* Comme dans les mouvements de caisse : la fonction,
                            puis l'auteur. Un montant sans auteur n'engage
                            personne sur une plateforme partagée. */}
                        <th className="text-center px-4 py-3 font-medium">Fonction</th>
                        <th className="text-center px-4 py-3 font-medium">Auteur</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {versementsVus.map(v => (
                        <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">
                            {v.date ? new Date(v.date).toLocaleDateString('fr-FR') : '—'}
                          </td>
                          <td className="px-4 py-3 text-gray-400 text-center">{v.heure || '—'}</td>
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{v.nomPartenaire}</td>
                          {/* D'où vient l'argent : une avance et un
                              recouvrement ne se lisent pas pareil. */}
                          <td className="px-4 py-3 text-gray-500 text-center">
                            {libelleMotif(v.motif)}
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-center">{v.reference || '—'}</td>
                          <td className="px-4 py-3 font-medium text-green-600 text-center">{formatMontant(v.montant)}</td>
                          <td className="px-4 py-3 text-gray-500 text-center">{v.utilisateurFonction ?? '—'}</td>
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{v.utilisateurNom ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          )}
        </div>
      </div>
    </div>
  );
}
