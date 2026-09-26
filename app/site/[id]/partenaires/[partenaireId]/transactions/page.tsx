'use client';
import { useEffect, useState, useMemo } from 'react';
import {
  collection, query, where, getDocs, addDoc, serverTimestamp, getDoc, doc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { soldeTiers } from '@/lib/soldes';
import { ArrowLeft, Plus, X, Loader2, FileText, Package, RefreshCw, Banknote } from 'lucide-react';
import FiltreDeroulant from '@/components/FiltreDeroulant';

type Role = 'client' | 'fournisseur';
type Onglet = 'partenaire' | 'produit' | 'mouvement' | 'versement';

interface Mouvement {
  id: string;
  partenaireId: string;
  role: Role;
  type: 'vente' | 'achat';
  produit: string;
  /** unité de compte du produit : pièce, kilo… */
  unite: string;
  /** conditionnement de saisie ; absent = saisi à l'unité */
  emballage?: string | null;
  /** quantité ramenée à l'unité de base ; absente sur les saisies manuelles */
  quantiteUnites?: number;
  /** nombre d'unités dans l'emballage utilisé ; 1 si saisi à l'unité */
  emballageContenu?: number;
  /** référence du document dont la ligne provient */
  reference?: string | null;
  achatId?: string | null;
  /** côté vente, l'équivalent d'`achatId` ; il manquait ici, et les lignes
      de vente n'étaient donc reliées à aucune fiche */
  venteId?: string | null;
  quantite: number;
  cout: number;
  /** le produit par son identifiant : le nom seul ne se recoupe pas */
  produitId?: string | null;
  /** ce qui a produit la ligne ; un retour en est un à part entière */
  motif?: 'achat' | 'vente' | 'retour';
  /** la ligne que ce retour annule ; absent hors retour */
  mouvementOrigineId?: string | null;
  prixVente: number;
  date: string;
  createdAt?: any;
}

/** Un versement encaissé sur une échéance de recouvrement. */
interface Versement {
  id: string;
  date: string;
  heure?: string;
  montant: number;
  resteApres: number;
  /** le rôle vit sur l'échéance, pas sur le versement */
  role: Role;
  dateEcheance?: string;
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
}

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

function fmt(n: number) { return formatMontant(n); }

function benefice(m: Mouvement, retour = 0) {
  return (m.quantite - retour) * (m.prixVente - m.cout);
}
/* La quantité rendue vient des mouvements de retour, pas d'un champ porté
   par la ligne : c'est elle qu'il faut déduire pour savoir ce qui reste. */
function total(m: Mouvement, retour = 0) {
  return (m.quantite - retour) * (m.role === 'client' ? m.prixVente : m.cout);
}

export default function TransactionsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  const partenaireId = params.partenaireId as string;
  const roleParam = (searchParams.get('role') as Role) ?? 'client';
  const retourParam = searchParams.get('retour');
  const retourVue = retourParam && retourParam !== 'global' ? retourParam : (roleParam === 'client' ? 'clients' : 'fournisseurs');

  const [role, setRole] = useState<Role>(roleParam);
  const [onglet, setOnglet] = useState<Onglet>('partenaire');
  const [mouvements, setMouvements] = useState<Mouvement[]>([]);
  const [partenaire, setPartenaire] = useState<Partenaire | null>(null);
  const [loading, setLoading] = useState(true);
  const [solde, setSolde] = useState<{ verse: number; reste: number } | null>(null);

  /* Modal ajout mouvement */
  const [showModal, setShowModal] = useState(false);
  const [mProduit, setMProduit] = useState('');
  const [mUnite, setMUnite] = useState('');
  const [mQuantite, setMQuantite] = useState('');
  const [mRetour, setMRetour] = useState('0');
  const [mCout, setMCout] = useState('');
  const [mPrixVente, setMPrixVente] = useState('');
  const [mDate, setMDate] = useState(new Date().toISOString().split('T')[0]);
  const [saving, setSaving] = useState(false);
  const [erreur, setErreur] = useState('');
  /* ce qui a été payé sur chaque document, achat comme vente */
  const [versesParAchat, setVersesParAchat] = useState<Record<string, number>>({});
  const [versements, setVersements] = useState<Versement[]>([]);
  /* Un document soldé n'appelle plus rien : on veut pouvoir ne garder que
     ceux sur lesquels il reste à agir. */
  const [filtreDoc, setFiltreDoc] = useState<'tous' | 'Soldé' | 'Partiel'>('tous');

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getDoc(doc(db, 'partenaires', partenaireId)),
      getDocs(query(
        collection(db, 'mouvements'),
        where('partenaireId', '==', partenaireId),
        where('siteId', '==', siteId),
      )),
      /* Les versements vivent sur le document, pas sur ses lignes de
         mouvement — et cela vaut des deux côtés : côté vente, le versé
         était écrit en dur à zéro, donc le reste valait toujours le total. */
      getDocs(query(
        collection(db, 'achats'),
        where('fournisseurId', '==', partenaireId),
        where('siteId', '==', siteId),
      )),
      getDocs(query(
        collection(db, 'ventes'),
        where('clientId', '==', partenaireId),
        where('siteId', '==', siteId),
      )),
    ]).then(([partSnap, movSnap, achSnap, venSnap]) => {
      if (partSnap.exists()) setPartenaire({ id: partSnap.id, ...partSnap.data() } as Partenaire);
      setMouvements(movSnap.docs.map(d => ({ id: d.id, ...d.data() } as Mouvement)));
      setVersesParAchat(Object.fromEntries([
        ...achSnap.docs.map(d => [d.id, d.data().avanceVersee ?? 0] as const),
        ...venSnap.docs.map(d => [d.id, d.data().avanceVersee ?? 0] as const),
      ]));
      setLoading(false);
    });
  }, [user, siteId, partenaireId]);

  /* Les versements encaissés sur les échéances de recouvrement. Le rôle et
     la date d'échéance vivent sur le journal, pas sur le versement : il faut
     les deux pour savoir de quel côté ranger l'argent. */
  /* Le solde suit le rôle affiché : il se déduit des dossiers non soldés. */
  useEffect(() => {
    if (!user) return;
    soldeTiers(siteId, partenaireId, role).then(setSolde);
  }, [user, siteId, partenaireId, role]);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getDocs(query(
        collection(db, 'recouvrement_journal'),
        where('partenaireId', '==', partenaireId),
        where('siteId', '==', siteId),
      )),
      getDocs(query(
        collection(db, 'recouvrement_versements'),
        where('siteId', '==', siteId),
      )),
    ]).then(([jSnap, vSnap]) => {
      const echeances = new Map(jSnap.docs.map(d => [d.id, d.data()]));
      setVersements(vSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .filter(v => echeances.has(v.journalId))
        .map(v => {
          const e = echeances.get(v.journalId)!;
          return {
            id: v.id,
            date: v.date ?? e.date,
            heure: v.heure ?? '',
            montant: v.montant ?? 0,
            resteApres: v.resteApres ?? 0,
            role: e.role as Role,
            dateEcheance: e.date,
          } as Versement;
        })
        /* du plus récent au plus ancien : on vient voir ce qui vient d'entrer */
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')));
    });
  }, [user, siteId, partenaireId]);

  const versementsRole = useMemo(
    () => versements.filter(v => v.role === role), [versements, role]);

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

  /** Ce qui a été retourné sur une ligne, un document, un produit ou un tiers. */
  const retoursDe = useMemo(() => (critere: (m: Mouvement) => boolean) => {
    const liste = retours.filter(critere);
    return {
      quantite: liste.reduce((n, m) => n + m.quantite, 0),
      valeur: liste.reduce((n, m) =>
        n + m.quantite * (role === 'client' ? m.prixVente : m.cout), 0),
    };
  }, [retours, role]);

  /* Agrégation onglet partenaire */
  const statsPartenaire = useMemo(() => {
    const totalTx = filtres.reduce((s, m) => s + total(m), 0);
    const totalBenef = filtres.reduce((s, m) => s + benefice(m), 0);
    const verse = role === 'client' ? (partenaire?.verseC || 0) : (partenaire?.verseF || 0);
    /* Le reste se déduit des dossiers non soldés : stocké sur la fiche, il
       survivait à leur suppression. */
    const reste = solde?.reste ?? 0;
    return { totalTx, totalBenef, verse, reste };
  }, [filtres, partenaire, role]);

  /**
   * Un document regroupe les lignes qui en proviennent. Cumuler tous les
   * achats sur une seule ligne effaçait ce qui les distingue : leur
   * référence, leur date, le nombre de produits qu'ils portent.
   */
  /* « unité » n'est qu'un repli : dès qu'une vraie unité existe, elle prime. */
  const uniteReelle = (a: string | null, b: string) =>
    (a && a.toLowerCase() !== 'unité') ? a : b;

  const documents = useMemo(() => {
    const map = new Map<string, {
      cle: string; reference: string; achatId?: string | null; venteId?: string | null;
      motif: string;
      date: string; produits: number; total: number; retour: number; verse: number;
    }>();
    filtres.forEach(m => {
      /* une ligne sans document reste isolée : elle a été saisie à la main */
      const cle = m.achatId ?? m.venteId ?? `libre-${m.id}`;
      const prev = map.get(cle);
      map.set(cle, {
        cle,
        reference: m.reference ?? '—',
        achatId: m.achatId ?? null,
        venteId: m.venteId ?? null,
        motif: m.type === 'achat' ? 'Achat' : 'Vente',
        date: prev && prev.date > m.date ? prev.date : m.date,
        produits: (prev?.produits ?? 0) + 1,
        /* La valeur du document, entière. Une facture ne rétrécit pas :
           elle vaut ce qu'elle a valu, et ce qui est revenu se lit dans
           sa propre colonne. Retirer le retour d'ici affichait « Total
           6 500 » sur une vente de 13 000, et l'écran se contredisait
           d'une page à l'autre pour le même document. */
        total: (prev?.total ?? 0) + total(m),
        /* en valeur, pas en quantité : mêler des pièces et des cartons
           ne donnerait aucun total lisible au niveau du document */
        retour: retoursDe(r => (r.achatId ?? r.venteId) === cle).valeur,
        verse: versesParAchat[m.achatId ?? m.venteId ?? ''] ?? 0,
      });
    });
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
  }, [filtres, versesParAchat]);

  /** Soldé quand plus rien n'est dû dessus ; partiel sinon.
   *  Le retour éteint autant que l'argent : l'ignorer laissait « Partiel »
   *  sur un document dont la marchandise était entièrement revenue. */
  function statutDoc(d: { total: number; verse: number; retour: number }) {
    return Math.max(0, d.total - d.verse - d.retour) <= 0 ? 'Soldé' : 'Partiel';
  }

  const documentsAffiches = useMemo(
    () => filtreDoc === 'tous' ? documents : documents.filter(d => statutDoc(d) === filtreDoc),
    [documents, filtreDoc]);

  function compteDoc(v: 'tous' | 'Soldé' | 'Partiel') {
    return v === 'tous' ? documents.length : documents.filter(d => statutDoc(d) === v).length;
  }

  /* Agrégation onglet produit */
  const statsProduits = useMemo(() => {
    const map = new Map<string, { produit: string; produitId: string | null; unite: string; emballage: string | null; emballageContenu: number; quantite: number; coutTotal: number; venteTotal: number }>();
    filtres.forEach(m => {
      const existing = map.get(m.produit) ?? { produit: m.produit, produitId: m.produitId ?? null, unite: m.unite, emballage: m.emballage ?? null, emballageContenu: m.emballageContenu ?? 1, quantite: 0, coutTotal: 0, venteTotal: 0 };
      map.set(m.produit, {
        produit: m.produit,
        unite: uniteReelle(existing.unite, m.unite),
        /* les quantités étant ramenées à l'unité de base, le conditionnement
           de lecture est l'unité elle-même : tout emballage en contient plusieurs */
        emballage: uniteReelle(existing.unite, m.unite),
        emballageContenu: 1,
        quantite: existing.quantite + (m.quantiteUnites ?? m.quantite),
        produitId: existing.produitId ?? m.produitId ?? null,
        coutTotal: existing.coutTotal + m.quantite * m.cout,
        venteTotal: existing.venteTotal + m.quantite * m.prixVente,
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
  }, [filtres, retoursDe]);

  async function ajouterMouvement() {
    if (!mProduit.trim() || !mUnite.trim() || !mQuantite || !mCout) {
      setErreur('Produit, unité, quantité et coût sont requis.'); return;
    }
    setSaving(true); setErreur('');
    try {
      const data = {
        siteId, userId: user!.uid, partenaireId,
        role,
        type: role === 'client' ? 'vente' : 'achat',
        produit: mProduit.trim(),
        unite: mUnite.trim(),
        quantite: Number(mQuantite),
        retour: Number(mRetour) || 0,
        cout: Number(mCout),
        prixVente: Number(mPrixVente) || 0,
        date: mDate,
        createdAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, 'mouvements'), data);
      setMouvements(prev => [...prev, { id: ref.id, ...data } as Mouvement]);
      setShowModal(false);
      resetModal();
    } catch (e: any) {
      setErreur(e?.message ?? 'Erreur.');
    } finally {
      setSaving(false);
    }
  }

  function resetModal() {
    setMProduit(''); setMUnite(''); setMQuantite(''); setMRetour('0');
    setMCout(''); setMPrixVente(''); setMDate(new Date().toISOString().split('T')[0]); setErreur('');
  }

  const onglets: { key: Onglet; label: string; icon: React.ElementType }[] = [
    { key: 'partenaire', label: 'Document',   icon: FileText },
    { key: 'produit',    label: 'Produit',    icon: Package },
    { key: 'mouvement',  label: 'Mouvement',  icon: RefreshCw },
    /* Ce qui a été vendu et ce qui a été encaissé sont deux histoires :
       la première vit dans les mouvements, la seconde ici. */
    { key: 'versement',  label: 'Versement',  icon: Banknote },
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
        <button onClick={() => retourParam === 'global'
            ? router.push(`/site/${siteId}/transactions?role=${role}`)
            : router.push(`/site/${siteId}/partenaires/${partenaireId}?vue=${retourVue}`)
          }
          className="flex items-center gap-2 mb-5 group">
          <ArrowLeft size={15} className="text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200 transition-colors" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
            {partenaire?.nom ?? 'Partenaire'}
          </span>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <span className="text-sm text-gray-400">Transactions</span>
        </button>

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          {/* Toggle Client / Fournisseur — uniquement si partenaire des deux rôles */}
          {partenaire?.rolesFournisseur && partenaire?.rolesClient ? (
            <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
              {(['client', 'fournisseur'] as Role[]).map(r => (
                <button key={r} onClick={() => setRole(r)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all
                    ${role === r ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-gray-400 dark:text-gray-500'}`}>
                  {r === 'client' ? 'Client' : 'Fournisseur'}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm font-bold text-gray-700 dark:text-gray-200">
              {role === 'client' ? 'Client' : 'Fournisseur'}
            </p>
          )}
        </div>

        {/* Onglets */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 mb-4 border-b border-gray-100 dark:border-gray-800">
          {onglets.map(o => {
            const Icon = o.icon;
            const actif = onglet === o.key;
            return (
              <button key={o.key} onClick={() => setOnglet(o.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all shrink-0
                  ${actif ? 'bg-indigo-600 text-white' : 'border border-indigo-200 dark:border-indigo-800 text-gray-500 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300'}`}>
                <Icon size={14} /> {o.label}
              </button>
            );
          })}
        </div>

        {/* Contenu */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">

          {/* Onglet Partenaire */}
          {onglet === 'partenaire' && (
            filtres.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucune transaction</div>
              : (
                <div className="overflow-x-auto">
                <div className="mb-3">
                  <FiltreDeroulant
                    nom="Statut"
                    valeur={filtreDoc}
                    onChange={setFiltreDoc}
                    options={(['tous', 'Partiel', 'Soldé'] as const).map(v => ({
                      valeur: v, label: v === 'tous' ? 'Tous' : v, nombre: compteDoc(v),
                    }))}
                  />
                </div>
                <p className="text-sm font-medium text-gray-500 mb-2">
                  {documentsAffiches.length} document{documentsAffiches.length > 1 ? 's' : ''}
                </p>
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="text-center px-4 py-3 font-medium">Référence</th>
                      <th className="text-center px-4 py-3 font-medium">Motif</th>
                      <th className="text-center px-4 py-3 font-medium">Produits</th>
                      <th className="text-center px-4 py-3 font-medium">Date</th>
                      <th className="text-center px-4 py-3 font-medium">Total</th>
                      <th className="text-center px-4 py-3 font-medium">Retour</th>
                      <th className="text-center px-4 py-3 font-medium">Versé</th>
                      <th className="text-center px-4 py-3 font-medium">Reste</th>
                      <th className="text-center px-4 py-3 font-medium">Statut</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {documentsAffiches.map(d => {
                      /* Le retour éteint autant que l'argent : l'oublier
                         ici laissait un reste dû sur une marchandise
                         déjà revenue. Et le versé se borne à ce qui
                         couvre encore le document — versé plus retour ne
                         peut pas dépasser ce qu'il valait. */
                      const verseVu = Math.min(d.verse, Math.max(0, d.total - d.retour));
                      const reste = Math.max(0, d.total - verseVu - d.retour);
                      return (
                        <tr key={d.cle}
                          onClick={() => {
                            if (d.achatId) router.push(`/site/${siteId}/achats/${d.achatId}`);
                            else if (d.venteId) router.push(`/site/${siteId}/ventes/${d.venteId}`);
                          }}
                          className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${d.achatId || d.venteId ? 'cursor-pointer' : ''}`}>
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{d.reference}</td>
                          <td className="px-4 py-3 text-gray-500 text-center">{d.motif}</td>
                          <td className="px-4 py-3 text-gray-500 text-center">{d.produits}</td>
                          <td className="px-4 py-3 text-gray-500 text-center">{new Date(d.date).toLocaleDateString('fr-FR')}</td>
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{fmt(d.total)}</td>
                          <td className={`px-4 py-3 text-center ${d.retour > 0 ? 'text-orange-500 font-medium' : 'text-gray-300 dark:text-gray-600'}`}>
                            {fmt(d.retour)}
                          </td>
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{fmt(verseVu)}</td>
                          <td className={`px-4 py-3 font-medium text-center ${reste > 0 ? 'text-orange-500' : 'text-gray-400'}`}>{fmt(reste)}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${reste <= 0
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                              {reste <= 0 ? 'Soldé' : 'Partiel'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-100 dark:border-gray-800 font-bold">
                      <td className="px-4 py-3 text-gray-500 text-center">Total</td>
                      <td className="px-4 py-3 text-center" />
                      <td className="px-4 py-3 text-gray-500 text-center">{documentsAffiches.reduce((n, d) => n + d.produits, 0)}</td>
                      <td className="px-4 py-3 text-center" />
                      <td className="px-4 py-3 text-gray-900 dark:text-gray-100 text-center">{fmt(documentsAffiches.reduce((n, d) => n + d.total, 0))}</td>
                      <td className="px-4 py-3 text-center">{(() => {
                        const r = documentsAffiches.reduce((n, d) => n + d.retour, 0);
                        return <span className={r > 0 ? 'text-orange-500' : 'text-gray-300 dark:text-gray-600'}>{fmt(r)}</span>;
                      })()}</td>
                      {/* le pied additionne les lignes affichées : un total repris
                          d'ailleurs ne correspondrait pas à ce que la colonne montre */}
                      {(() => {
                        const v = documentsAffiches.reduce((n, d) =>
                          n + Math.min(d.verse, Math.max(0, d.total - d.retour)), 0);
                        const r = documentsAffiches.reduce((n, d) => n + Math.max(0,
                          d.total - Math.min(d.verse, Math.max(0, d.total - d.retour)) - d.retour), 0);
                        return (
                          <>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{fmt(v)}</td>
                            <td className={`px-4 py-3 text-center ${r > 0 ? 'text-orange-500' : 'text-gray-400'}`}>{fmt(r)}</td>
                          </>
                        );
                      })()}
                      <td className="px-4 py-3 text-center" />
                    </tr>
                  </tfoot>
                </table>
                </div>
              )
          )}

          {/* Onglet Produit */}
          {onglet === 'produit' && (
            statsProduits.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun produit</div>
              : (
                <div className="overflow-x-auto">
                  <p className="text-sm font-medium text-gray-500 mb-2">
                    {statsProduits.length} produit{statsProduits.length > 1 ? 's' : ''}
                  </p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">Produit</th>
                        <th className="text-center px-4 py-3 font-medium">Unité</th>
                        <th className="text-center px-4 py-3 font-medium">Emballage</th>
                        <th className="text-center px-4 py-3 font-medium">Qté</th>
                        <th className="text-center px-4 py-3 font-medium">Retour</th>
                        <th className="text-center px-4 py-3 font-medium">Valeur retour</th>
                        <th className="text-center px-4 py-3 font-medium">Coût total</th>
                        {role === 'client' && <th className="text-center px-4 py-3 font-medium">Vente total</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {statsProduits.map(p => {
                        return (
                          <tr key={p.produit} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{p.produit}</td>
                            <td className="px-4 py-3 text-gray-500 text-center">{p.unite}</td>
                            <td className={`px-4 py-3 text-center ${p.emballage ? 'text-gray-500' : 'text-gray-300 dark:text-gray-600'}`}>
                              {p.emballage ?? '—'}
                            </td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{p.quantite.toLocaleString('fr-FR')}</td>
                            <td className={`px-4 py-3 text-center ${p.retour > 0 ? 'text-gray-700 dark:text-gray-300' : 'text-gray-300 dark:text-gray-600'}`}>
                              {p.retour.toLocaleString('fr-FR')}
                            </td>
                            <td className={`px-4 py-3 text-center ${p.retourValeur > 0 ? 'text-orange-500 font-medium' : 'text-gray-300 dark:text-gray-600'}`}>
                              {fmt(p.retourValeur)}
                            </td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{fmt(p.coutTotal)}</td>
                            {role === 'client' && <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{fmt(p.venteTotal)}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {/* Onglet Mouvement */}
          {onglet === 'mouvement' && (
            filtres.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun mouvement</div>
              : (
                <div className="overflow-x-auto">
                  <p className="text-sm font-medium text-gray-500 mb-2">
                    {filtres.length} mouvement{filtres.length > 1 ? 's' : ''}
                  </p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">Référence</th>
                        <th className="text-center px-4 py-3 font-medium">Produit</th>
                        <th className="text-center px-4 py-3 font-medium">Motif</th>
                        <th className="text-center px-4 py-3 font-medium">Date</th>
                        <th className="text-center px-4 py-3 font-medium">{role === 'client' ? 'Client' : 'Fournisseur'}</th>
                        <th className="text-center px-4 py-3 font-medium">Unité</th>
                        <th className="text-center px-4 py-3 font-medium">Emballage</th>
                        <th className="text-center px-4 py-3 font-medium">Qté</th>
                        <th className="text-center px-4 py-3 font-medium">Retour</th>
                        <th className="text-center px-4 py-3 font-medium">Coût</th>
                        {role === 'client' && <th className="text-center px-4 py-3 font-medium">Prix vente</th>}
                        <th className="text-center px-4 py-3 font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {filtres.map(m => {
                        /* Ce qui a été rendu sur cette ligne précise : les
                           retours qui portent son identifiant. */
                        const r = retoursDe(x => x.mouvementOrigineId === m.id);
                        /* La ligne vaut ce qu'elle a valu : le retour a
                           sa colonne, il n'a pas à rogner le total. Ici
                           2 mangues à 6 500 affichaient 6 500 au lieu de
                           13 000, quand l'onglet Produit, lui, montrait
                           bien 13 000 pour la même ligne. */
                        const tot = total(m);
                        return (
                          <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                            <td className={`px-4 py-3 whitespace-nowrap text-center ${m.reference ? 'text-gray-600 dark:text-gray-400' : 'text-gray-300 dark:text-gray-600'}`}>
                              {m.reference ?? '—'}
                            </td>
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap text-center">{m.produit}</td>
                            <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-center">{m.type === 'achat' ? 'Achat' : 'Vente'}</td>
                            <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-center">{new Date(m.date).toLocaleDateString('fr-FR')}</td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 whitespace-nowrap text-center">{partenaire?.nom}</td>
                            <td className="px-4 py-3 text-gray-500 text-center">{m.unite}</td>
                            {/* l'unité est elle-même un emballage, celui de contenance 1 */}
                            <td className="px-4 py-3 text-center text-gray-500">
                              {m.emballage ?? m.unite}
                            </td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{m.quantite.toLocaleString('fr-FR')}</td>
                            <td className={`px-4 py-3 text-center ${r.quantite > 0 ? 'text-orange-500 font-medium' : 'text-gray-300 dark:text-gray-600'}`}>
                              {r.quantite.toLocaleString('fr-FR')}
                            </td>
                            <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{fmt(m.cout)}</td>
                            {role === 'client' && (
                              <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">{m.prixVente > 0 ? fmt(m.prixVente) : '—'}</td>
                            )}
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 text-center">{fmt(tot)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {/* Onglet Versements */}
          {onglet === 'versement' && (
            versementsRole.length === 0
              ? <div className="text-center py-16 text-gray-400 text-sm">Aucun versement</div>
              : (
                <div className="overflow-x-auto">
                  <p className="text-sm font-medium text-gray-500 mb-2">
                    {versementsRole.length} versement{versementsRole.length > 1 ? 's' : ''}
                    <span className="ml-2 text-gray-400">
                      · Total {fmt(versementsRole.reduce((s, v) => s + v.montant, 0))}
                    </span>
                  </p>
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        <th className="text-center px-4 py-3 font-medium">Date</th>
                        <th className="text-center px-4 py-3 font-medium">Heure</th>
                        <th className="text-center px-4 py-3 font-medium">Échéance</th>
                        <th className="text-center px-4 py-3 font-medium">Montant</th>
                        <th className="text-center px-4 py-3 font-medium">Reste après</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {versementsRole.map(v => (
                        <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">
                            {v.date ? new Date(v.date).toLocaleDateString('fr-FR') : '—'}
                          </td>
                          <td className="px-4 py-3 text-gray-400 text-center">{v.heure || '—'}</td>
                          {/* La date de l'échéance honorée : un versement du
                              20 sur une échéance du 16 se lit d'un coup. */}
                          <td className="px-4 py-3 text-gray-500 text-center">
                            {v.dateEcheance ? new Date(v.dateEcheance).toLocaleDateString('fr-FR') : '—'}
                          </td>
                          <td className="px-4 py-3 font-medium text-green-600 text-center">{fmt(v.montant)}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={v.resteApres <= 0 ? 'text-green-600 font-medium' : 'text-red-500 font-medium'}>
                              {fmt(v.resteApres)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          )}
        </div>
      </div>

      {/* Modal ajout mouvement */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md shadow-xl p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
                Nouveau mouvement — {role === 'client' ? 'Vente' : 'Achat'}
              </h2>
              <button onClick={() => { setShowModal(false); resetModal(); }} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Produit</p>
                <input type="text" value={mProduit} onChange={e => setMProduit(e.target.value)}
                  placeholder="Ex. Carrelage 60x60"
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Unité</p>
                <input type="text" value={mUnite} onChange={e => setMUnite(e.target.value)}
                  placeholder="Ex. m², kg, pcs"
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Quantité</p>
                <input type="number" min="0" value={mQuantite} onChange={e => setMQuantite(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Retour</p>
                <input type="number" min="0" value={mRetour} onChange={e => setMRetour(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Coût unitaire</p>
                <input type="number" min="0" value={mCout} onChange={e => setMCout(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">
                  {role === 'client' ? 'Prix de vente' : 'Prix de vente prévu'}
                </p>
                <input type="number" min="0" value={mPrixVente} onChange={e => setMPrixVente(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>

            <div className="mb-4">
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Date</p>
              <input type="date" value={mDate} onChange={e => setMDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>

            {/* Aperçu calculé */}
            {mQuantite && mCout && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 mb-4 text-xs space-y-1">
                <div className="flex justify-between text-gray-500">
                  <span>Total {role === 'client' ? 'vente' : 'achat'}</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {fmt((Number(mQuantite) - Number(mRetour)) * (role === 'client' ? Number(mPrixVente) : Number(mCout)))}
                  </span>
                </div>
                {mPrixVente && (
                  <div className="flex justify-between text-gray-500">
                    <span>Différence</span>
                    <span className={`font-medium ${(Number(mQuantite) - Number(mRetour)) * (Number(mPrixVente) - Number(mCout)) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {fmt((Number(mQuantite) - Number(mRetour)) * (Number(mPrixVente) - Number(mCout)))}
                    </span>
                  </div>
                )}
              </div>
            )}

            {erreur && <p className="text-red-500 text-xs mb-3">{erreur}</p>}

            <div className="flex gap-3">
              <button onClick={() => { setShowModal(false); resetModal(); }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={ajouterMouvement} disabled={saving}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Ajouter
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
