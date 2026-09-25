'use client';
import {
  detentionDe, ouvrirDetention, usageDansLActivite, type ProduitSite,
} from '@/lib/produits-site';
import { Fragment, useEffect, useState } from 'react';
import { doc, getDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { ArrowLeft, Loader2, Plus, X, Check, Trash2, Package, TrendingUp, Pencil, ArrowDownLeft, ArrowUpRight, ChevronDown, Lock } from 'lucide-react';
import CodeBarre from '@/components/CodeBarre';
import ModalMouvement from '../../components/ModalMouvement';
import type { Mouvement } from '@/lib/mouvements';
import { ChampRecherche } from '@/components/Champs';

interface Emballage {
  nom: string;
  quantite: number;
}

interface Caracteristique {
  nom: string;
  valeurs: string[];
}

interface Variante {
  cle: string;
  codeBarre: string;
  selection: Record<string, string>;
  stock: number;
  coutMoyen: number;
  prixVente?: number;
}

interface Produit {
  id: string;
  designation: string;
  codeBarre?: string;
  categorie?: string;
  unite: string;
  prixVente: number;
  coutMoyen: number;
  stock: number;
  seuilAlerte?: number | null;
  emballages?: Emballage[];
  caracteristiques?: Caracteristique[];
  variantes?: Variante[];
  actif: boolean;
}

function parseMontant(s: string): number {
  return parseInt(s.replace(/[\s ]/g, ''), 10) || 0;
}

function genererCodeBarre(): string {
  const base = '200' + Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join('');
  const somme = base.split('').reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return base + ((10 - (somme % 10)) % 10);
}

function enUnites(quantite: string, nomEmballage: string, emballages: Emballage[]): number {
  const nb = parseMontant(quantite);
  if (!nb) return 0;
  const emb = emballages.find(e => e.nom === nomEmballage);
  return nb * (emb ? emb.quantite : 1);
}

function cleVariante(selection: Record<string, string>, caracs: Caracteristique[]): string {
  return caracs.map(c => selection[c.nom]).filter(Boolean).join(' / ');
}

function memeSelection(a: Record<string, string>, b: Record<string, string>): boolean {
  const cles = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...cles].every(k => a[k] === b[k]);
}

const LIBELLE_MOTIF: Record<string, string> = {
  stock_initial: 'Stock initial', achat: 'Achat', vente: 'Vente', transfert: 'Transfert',
  retour_client: 'Retour client', retour_fournisseur: 'Retour fournisseur',
  perte: 'Perte / casse', reajustement: 'Réajustement',
};

function formatDate(s?: string | null) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function statutStock(stock: number, seuil?: number | null): { label: string; color: string } {
  if (stock <= 0) return { label: 'Rupture', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
  if (seuil != null && stock <= seuil)
    return { label: 'Alerte', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' };
  return { label: 'En stock', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
}

export default function FicheProduitPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  const produitId = params.produitId as string;

  const [produit, setProduit] = useState<Produit | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /* modal nouvelle variante */
  const [modalVariante, setModalVariante] = useState(false);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [vStock, setVStock] = useState('');
  const [vStockEmb, setVStockEmb] = useState('');
  const [vCout, setVCout] = useState('');
  const [vPrix, setVPrix] = useState('');

  const [vue, setVue] = useState<'infos' | 'mouvements'>('infos');
  const [mouvements, setMouvements] = useState<Mouvement[]>([]);
  const [modalMouvement, setModalMouvement] = useState(false);
  const [rechMouv, setRechMouv] = useState('');
  const [filtreSens, setFiltreSens] = useState<'tous' | 'entree' | 'sortie'>('tous');
  const [onglet, setOnglet] = useState<'variantes' | 'emballages' | 'caracteristiques'>('variantes');
  const [rechVariante, setRechVariante] = useState('');
  /* une seule variante dépliée à la fois : le tableau reste lisible */
  const [varianteOuverte, setVarianteOuverte] = useState<string | null>(null);

  /**
   * Un mouvement est un fait daté : supprimer ce qu'il désigne rendrait
   * l'historique incompréhensible. On refuse donc la suppression au lieu
   * de la proposer puis d'échouer.
   */
  const mouvementsDe = (cle: string) => mouvements.filter(m => m.varianteCle === cle);
  const mouvementsEmballage = (nom: string) => mouvements.filter(m => m.emballage === nom);
  const [suppVariante, setSuppVariante] = useState<Variante | null>(null);
  const [editVariante, setEditVariante] = useState<Variante | null>(null);
  const [edVPrix, setEdVPrix] = useState('');

  /* emballages */
  const [modalEmballage, setModalEmballage] = useState(false);
  const [embNom, setEmbNom] = useState('');
  const [embQte, setEmbQte] = useState('');
  const [suppEmballage, setSuppEmballage] = useState<Emballage | null>(null);

  /* caractéristiques */
  const [modalCarac, setModalCarac] = useState(false);
  const [caracNom, setCaracNom] = useState('');
  const [caracValeurs, setCaracValeurs] = useState<string[]>([]);
  const [saisieVal, setSaisieVal] = useState('');
  const [suppCarac, setSuppCarac] = useState<Caracteristique | null>(null);

  /* édition du produit */
  const [modalEdition, setModalEdition] = useState(false);
  const [edNom, setEdNom] = useState('');
  const [edCategorie, setEdCategorie] = useState('');
  const [edPrix, setEdPrix] = useState('');
  const [edSeuil, setEdSeuil] = useState('');
  const [edSeuilEmb, setEdSeuilEmb] = useState('');
  const [erreurEdition, setErreurEdition] = useState('');
  /* Ce que ce site détient : son stock, son coût, son prix, son seuil. */
  const [detention, setDetention] = useState<ProduitSite | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      /* Le produit dit ce qu'est la marchandise ; la détention dit ce que
         CE site en a. La fiche montre les deux ensemble. */
      const [snap, mvSnap, det] = await Promise.all([
        getDoc(doc(db, 'produits', produitId)),
        getDocs(query(collection(db, 'mouvements'), where('produitId', '==', produitId))),
        detentionDe(siteId, produitId),
      ]);
      setDetention(det);
      if (snap.exists()) {
        const d = snap.data() as any;
        setProduit({
          id: snap.id,
          ...d,
          /* Ce qui est local vient de la détention, jamais du produit. */
          stock: det?.stock ?? 0,
          coutMoyen: det?.coutMoyen ?? 0,
          prixVente: det?.prixVente ?? 0,
          seuilAlerte: det?.seuilAlerte ?? null,
          variantes: (d.variantes ?? []).map((v: any) => {
            const vs = (det?.variantes ?? []).find((x: any) => x.cle === v.cle);
            return {
              ...v,
              stock: vs?.stock ?? 0,
              coutMoyen: vs?.coutMoyen ?? 0,
              prixVente: vs?.prixVente ?? v.prixVente ?? 0,
            };
          }),
        } as Produit);
      }
      setMouvements(mvSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as Mouvement))
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')));
      setLoading(false);
    };
    load();
  }, [user, produitId]);

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );
  if (!produit) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-400">Produit introuvable.</div>
  );

  const caracs = produit.caracteristiques ?? [];
  const emballages = produit.emballages ?? [];
  const variantes = produit.variantes ?? [];
  const uniteLabel = produit.unite.toLowerCase();

  const stockTotal = variantes.length
    ? variantes.reduce((s, v) => s + v.stock, 0)
    : produit.stock;
  const valeurStock = variantes.length
    ? variantes.reduce((s, v) => s + v.coutMoyen * v.stock, 0)
    : produit.coutMoyen * produit.stock;
  const valeurVente = variantes.length
    ? variantes.reduce((s, v) => s + (v.prixVente ?? produit.prixVente) * v.stock, 0)
    : produit.prixVente * produit.stock;
  const benefice = valeurVente - valeurStock;

  const variantesFiltrees = variantes.filter(v => {
    const q = rechVariante.trim().toLowerCase();
    if (!q) return true;
    return v.cle.toLowerCase().includes(q) || (v.codeBarre ?? '').includes(q);
  });
  /* les totaux suivent la recherche pour rester cohérents avec ce qui est affiché */
  const stockFiltre = variantesFiltrees.reduce((s, v) => s + v.stock, 0);
  const valeurFiltre = variantesFiltrees.reduce((s, v) => s + v.coutMoyen * v.stock, 0);
  const beneficeFiltre = variantesFiltrees.reduce((s, v) => s + ((v.prixVente ?? produit.prixVente) - v.coutMoyen) * v.stock, 0);

  const mouvementsFiltres = mouvements.filter(m => {
    if (filtreSens !== 'tous' && m.sens !== filtreSens) return false;
    const q = rechMouv.trim().toLowerCase();
    if (!q) return true;
    return (LIBELLE_MOTIF[m.motif] ?? m.motif).toLowerCase().includes(q)
      || (m.partenaireNom ?? '').toLowerCase().includes(q)
      || (m.documentId ?? '').toLowerCase().includes(q)
      || (m.varianteCle ?? '').toLowerCase().includes(q);
  });
  /* les totaux suivent la recherche, mais pas le filtre de sens :
     sinon « Entrées » afficherait 0 dès qu'on filtre sur les sorties */
  const pourTotaux = mouvements.filter(m => {
    const q = rechMouv.trim().toLowerCase();
    if (!q) return true;
    return (LIBELLE_MOTIF[m.motif] ?? m.motif).toLowerCase().includes(q)
      || (m.partenaireNom ?? '').toLowerCase().includes(q)
      || (m.documentId ?? '').toLowerCase().includes(q)
      || (m.varianteCle ?? '').toLowerCase().includes(q);
  });
  const totalEntrees = pourTotaux.filter(m => m.sens === 'entree').reduce((s, m) => s + m.quantiteUnites, 0);
  const totalSorties = pourTotaux.filter(m => m.sens === 'sortie').reduce((s, m) => s + m.quantiteUnites, 0);
  /* bénéfices et pertes se lisent sur le même champ signé */
  const totalBenefices = pourTotaux.reduce((s, m) => s + Math.max(m.benefice ?? 0, 0), 0);
  const totalPertes = pourTotaux.reduce((s, m) => s + Math.min(m.benefice ?? 0, 0), 0);
  const valeurEntrees = pourTotaux.filter(m => m.sens === 'entree').reduce((s, m) => s + m.valeurTotale, 0);
  const valeurSorties = pourTotaux.filter(m => m.sens === 'sortie').reduce((s, m) => s + m.valeurTotale, 0);
  const difference = totalEntrees - totalSorties;

  async function ajouterVariante() {
    if (!produit) return;
    const choisies = Object.fromEntries(Object.entries(selection).filter(([, v]) => v));
    if (Object.keys(choisies).length === 0) return;
    if (variantes.some(v => memeSelection(v.selection, choisies))) return;

    setSaving(true);
    const nouvelle: Variante = {
      cle: cleVariante(choisies, caracs),
      codeBarre: genererCodeBarre(),
      selection: choisies,
      stock: enUnites(vStock, vStockEmb, emballages),
      coutMoyen: vCout ? parseMontant(vCout) : produit.coutMoyen,
      ...(vPrix ? { prixVente: parseMontant(vPrix) } : {}),
    };
    const maj = [...variantes, nouvelle];

    /* La déclinaison existe pour toute l'activité — « noir · 10 » désigne
       la même chose partout. Son stock, lui, n'appartient qu'à ce site. */
    await updateDoc(doc(db, 'produits', produitId), {
      variantes: maj.map(v => ({ cle: v.cle, codeBarre: v.codeBarre, selection: v.selection })),
    });

    const detId = detention?.id
      ?? await ouvrirDetention({ produitId, siteId, userId: user!.uid });
    const varsSite = [...(detention?.variantes ?? []).filter(v => v.cle !== nouvelle.cle), {
      cle: nouvelle.cle,
      stock: nouvelle.stock,
      coutMoyen: nouvelle.coutMoyen ?? 0,
      prixVente: nouvelle.prixVente ?? null,
    }];
    await updateDoc(doc(db, 'produits_site', detId), {
      variantes: varsSite,
      stock: varsSite.reduce((n, v) => n + (v.stock ?? 0), 0),
    });
    setDetention(d => (d ? { ...d, variantes: varsSite } : d));
    setProduit({ ...produit, variantes: maj, stock: maj.reduce((s, v) => s + v.stock, 0) });
    setSaving(false);
    setModalVariante(false);
    setSelection({}); setVStock(''); setVStockEmb(''); setVCout(''); setVPrix('');
  }

  /* seul le prix est modifiable : le coût moyen résulte des entrées de stock. */
  async function sauvegarderVariante() {
    if (!produit || !editVariante) return;
    setSaving(true);
    const prix = parseMontant(edVPrix);
    const maj = variantes.map(v => v.cle === editVariante.cle
      ? (() => {
          const { prixVente, ...reste } = v;
          return prix > 0 ? { ...reste, prixVente: prix } : reste;
        })()
      : v);
    /* Le prix d'une variante est une décision de ce site : il s'inscrit
       dans sa détention, pas sur le produit commun. */
    const detId = detention?.id
      ?? await ouvrirDetention({ produitId, siteId, userId: user!.uid });
    const varsSite = (detention?.variantes ?? []).map(v => v.cle === editVariante.cle
      ? { ...v, prixVente: prix > 0 ? prix : null }
      : v);
    await updateDoc(doc(db, 'produits_site', detId), { variantes: varsSite });
    setDetention(d => (d ? { ...d, variantes: varsSite } : d));
    setProduit({ ...produit, variantes: maj });
    setSaving(false);
    setEditVariante(null);
  }

  async function supprimerVariante() {
    if (!produit || !suppVariante) return;
    /* Une variante appartient au produit, donc à toute l'activité : un
       site ne peut pas effacer ce qu'un autre détient encore ou a déjà
       inscrit dans ses mouvements. Un fait s'enregistre, il ne s'annote
       pas. */
    const usage = await usageDansLActivite({
      produitId, varianteCle: suppVariante.cle,
    });
    if (usage.bloque) {
      setErreurEdition(usage.raison ?? 'Suppression impossible.');
      setSuppVariante(null);
      return;
    }
    const maj = variantes.filter(v => v.cle !== suppVariante.cle);
    await updateDoc(doc(db, 'produits', produitId), {
      variantes: maj.map(v => ({ cle: v.cle, selection: v.selection })),
    });
    setProduit({ ...produit, variantes: maj, stock: maj.reduce((s, v) => s + v.stock, 0) });
    setSuppVariante(null);
  }

  function ouvrirEdition() {
    if (!produit) return;
    setEdNom(produit.designation);
    setEdCategorie(produit.categorie ?? '');
    setEdPrix(produit.prixVente ? String(produit.prixVente) : '');
    setEdSeuil(produit.seuilAlerte != null ? String(produit.seuilAlerte) : '');
    setEdSeuilEmb('');
    setErreurEdition('');
    setModalEdition(true);
  }

  async function sauvegarderEdition() {
    if (!produit) return;
    const nom = edNom.trim();
    if (!nom) { setErreurEdition('La désignation est obligatoire.'); return; }
    setSaving(true);
    /* Le nom et la catégorie disent ce qu'est la marchandise : ils
       valent pour toute l'activité, et la correction profite à tous les
       sites. Le prix et le seuil sont une décision de ce site — un dépôt
       et une boutique ne vendent pas au même prix. */
    const commun = {
      designation: nom,
      categorie: edCategorie.trim() || null,
    };
    const local = {
      prixVente: parseMontant(edPrix),
      seuilAlerte: edSeuil ? enUnites(edSeuil, edSeuilEmb, emballages) : null,
    };
    await updateDoc(doc(db, 'produits', produitId), commun);

    const detId = detention?.id
      ?? await ouvrirDetention({ produitId, siteId, userId: user!.uid });
    await updateDoc(doc(db, 'produits_site', detId), local);
    setDetention(d => (d ? { ...d, ...local } : d));
    setProduit({ ...produit, ...commun, ...local, categorie: commun.categorie ?? undefined });
    setSaving(false);
    setModalEdition(false);
  }

  async function ajouterEmballage() {
    if (!produit) return;
    const nom = embNom.trim();
    const qte = parseMontant(embQte);
    if (!nom || qte < 2 || emballages.some(e => e.nom.toLowerCase() === nom.toLowerCase())) return;
    setSaving(true);
    const maj = [...emballages, { nom, quantite: qte }];
    await updateDoc(doc(db, 'produits', produitId), { emballages: maj });
    setProduit({ ...produit, emballages: maj });
    setSaving(false);
    setModalEmballage(false);
  }

  async function supprimerEmballage() {
    if (!produit || !suppEmballage) return;
    const maj = emballages.filter(e => e.nom !== suppEmballage.nom);
    await updateDoc(doc(db, 'produits', produitId), { emballages: maj });
    setProduit({ ...produit, emballages: maj });
    setSuppEmballage(null);
  }

  async function ajouterCarac() {
    if (!produit) return;
    const nom = caracNom.trim();
    if (!nom || caracValeurs.length === 0 || caracs.some(c => c.nom.toLowerCase() === nom.toLowerCase())) return;
    setSaving(true);
    const maj = [...caracs, { nom, valeurs: caracValeurs }];
    await updateDoc(doc(db, 'produits', produitId), { caracteristiques: maj });
    setProduit({ ...produit, caracteristiques: maj });
    setSaving(false);
    setModalCarac(false);
  }

  async function supprimerCarac() {
    if (!produit || !suppCarac) return;
    const maj = caracs.filter(c => c.nom !== suppCarac.nom);
    await updateDoc(doc(db, 'produits', produitId), { caracteristiques: maj });
    setProduit({ ...produit, caracteristiques: maj });
    setSuppCarac(null);
  }

  const choisiesEnCours = Object.fromEntries(Object.entries(selection).filter(([, v]) => v));
  const doublon = variantes.some(v => memeSelection(v.selection, choisiesEnCours));
  const varianteValide = Object.keys(choisiesEnCours).length > 0 && !doublon;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="w-full p-4 sm:p-6 lg:p-8">

        {/* On revient d'où l'on vient : renvoyer dans le site ferait
            changer d'écran sans l'avoir demandé. */}
        <button onClick={() => router.push(
          searchParams.get('de') === 'ensemble'
            ? '/ensemble?onglet=inventaire'
            : `/site/${siteId}?onglet=inventaire`)} className="flex items-center gap-2 mb-6 group">
          <ArrowLeft size={15} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
          <span className="text-sm font-medium text-gray-600 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">Retour</span>
        </button>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">{produit.designation}</h1>
                {produit.categorie && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                    {produit.categorie}
                  </span>
                )}
                {(() => { const s = statutStock(stockTotal, produit.seuilAlerte); return (
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.color}`}>{s.label}</span>
                ); })()}
              </div>
              <p className="text-xs text-gray-400">Unité de vente : {uniteLabel}</p>
              {produit.codeBarre && (
                <div className="mt-2 inline-block rounded-lg border border-gray-100 dark:border-gray-800 p-2 bg-white">
                  <CodeBarre valeur={produit.codeBarre} hauteur={44} largeurBarre={1.6} />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                {([
                  { key: 'infos' as const,      label: 'Informations' },
                  { key: 'mouvements' as const, label: 'Mouvements' },
                ]).map(v => (
                  <button key={v.key} onClick={() => setVue(v.key)}
                    className={`px-3 py-2 text-xs font-bold transition-colors ${vue === v.key ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-indigo-600'}`}>
                    {v.label}
                  </button>
                ))}
              </div>
              <button onClick={ouvrirEdition}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-indigo-300 hover:text-indigo-600 text-xs font-bold transition-colors">
                <Pencil size={12} /> Modifier
              </button>
            </div>
          </div>

          {vue === 'infos' ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Stock</p>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{stockTotal} {uniteLabel}{stockTotal > 1 ? 's' : ''}</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Coût unitaire</p>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{produit.coutMoyen > 0 ? formatMontant(produit.coutMoyen) : '—'}</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Prix de vente</p>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{produit.prixVente > 0 ? formatMontant(produit.prixVente) : '—'}</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Seuil d&apos;alerte</p>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                  {produit.seuilAlerte != null ? `${produit.seuilAlerte} ${uniteLabel}${produit.seuilAlerte > 1 ? 's' : ''}` : '—'}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-green-50 dark:bg-green-900/10 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Entrées</p>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{formatMontant(valeurEntrees)}</p>
                <p className="text-xs text-gray-400 mt-0.5">{totalEntrees} {uniteLabel}s</p>
              </div>
              <div className="bg-red-50 dark:bg-red-900/10 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Sorties</p>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{formatMontant(valeurSorties)}</p>
                <p className="text-xs text-gray-400 mt-0.5">{totalSorties} {uniteLabel}s</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Différence</p>
                <p className={`text-sm font-bold ${valeurSorties - valeurEntrees >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {valeurSorties - valeurEntrees >= 0 ? '+' : '−'}{formatMontant(Math.abs(valeurSorties - valeurEntrees))}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {difference > 0 ? '+' : ''}{difference} {uniteLabel}s
                </p>
              </div>
              <div className="bg-indigo-50 dark:bg-indigo-900/10 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">Valeur du stock</p>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{formatMontant(valeurStock)}</p>
                <p className="text-xs text-gray-400 mt-0.5">{stockTotal} {uniteLabel}s</p>
              </div>
            </div>
          )}
        </div>

        {vue === 'infos' && (<>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div className="bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-800/30 rounded-2xl p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <Package size={13} className="text-indigo-500" />
              <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400">Valeur du stock</p>
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatMontant(valeurStock)}</p>
            <p className="text-xs text-gray-400 mt-0.5">Au coût d&apos;achat</p>
          </div>
          <div className="bg-green-50 dark:bg-green-900/10 border border-green-100 dark:border-green-800/30 rounded-2xl p-4">
            <div className="flex items-center gap-1.5 mb-3">
              <TrendingUp size={13} className="text-green-500" />
              <p className="text-xs font-bold text-green-600 dark:text-green-400">Bénéfice estimé</p>
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatMontant(benefice)}</p>
            <p className="text-xs text-gray-400 mt-0.5">Si tout le stock est vendu</p>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm">
          <div className="flex border-b border-gray-100 dark:border-gray-800">
            {([
              { key: 'variantes' as const,        label: 'Variantes',        n: variantes.length },
              { key: 'emballages' as const,       label: 'Emballages',       n: emballages.length },
              { key: 'caracteristiques' as const, label: 'Caractéristiques', n: caracs.length },
            ]).map(o => (
              <button key={o.key} onClick={() => setOnglet(o.key)}
                className={`px-4 py-3 text-sm font-semibold transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${onglet === o.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                {o.label}
                {o.n > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-xs font-bold bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">{o.n}</span>
                )}
              </button>
            ))}
          </div>

          <div className="p-5">
            {onglet === 'variantes' && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <p className="text-xs text-gray-400">
                    {caracs.length > 0
                      ? caracs.map(c => c.nom).join(' · ')
                      : 'Stock unique — aucune caractéristique définie.'}
                  </p>
                  {caracs.length > 0 && (
                    <button onClick={() => { setSelection({}); setVStock(''); setVStockEmb(''); setVCout(''); setVPrix(''); setModalVariante(true); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
                      <Plus size={12} /> Ajouter une variante
                    </button>
                  )}
                </div>

                {variantes.length > 0 && (
                  <ChampRecherche placeholder="Rechercher une variante, un code-barres…" valeur={rechVariante} onChange={setRechVariante} className="w-full mb-4" />
                )}

                {caracs.length === 0
                  ? <p className="text-xs text-gray-400 text-center py-8">Ajoute une caractéristique pour décliner ce produit.</p>
                  : variantes.length === 0
                    ? <p className="text-xs text-gray-400 text-center py-8">Aucune variante.</p>
                    : variantesFiltrees.length === 0
                      ? <p className="text-xs text-gray-400 text-center py-8">Aucun résultat.</p>
                      : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm whitespace-nowrap">
                          <thead>
                            <tr className="bg-indigo-600 text-white">
                              <th className="text-center px-3 py-2.5 font-medium">Variante</th>
                              <th className="text-center px-3 py-2.5 font-medium">Code-barres</th>
                              <th className="text-center px-3 py-2.5 font-medium">Coût</th>
                              <th className="text-center px-3 py-2.5 font-medium">Prix</th>
                              <th className="text-center px-3 py-2.5 font-medium">Stock</th>
                              <th className="text-center px-3 py-2.5 font-medium">Bénéfice</th>
                              <th className="text-center px-3 py-2.5 font-medium">Valeur</th>
                              <th className="text-center px-3 py-2.5 font-medium">Statut</th>
                              <th className="px-3 py-2.5 text-center"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                            {variantesFiltrees.map(v => {
                              const beneficeVar = ((v.prixVente ?? produit.prixVente) - v.coutMoyen) * v.stock;
                              return (
                              <Fragment key={v.cle}>
                              <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                                <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">
                                  <button onClick={() => setVarianteOuverte(varianteOuverte === v.cle ? null : v.cle)}
                                    disabled={emballages.length === 0}
                                    title={emballages.length === 0 ? 'Aucun emballage' : 'Stock par emballage'}
                                    className="inline-flex items-center gap-1 hover:text-indigo-600 disabled:cursor-default transition-colors">
                                    {emballages.length > 0 && (
                                      <ChevronDown size={13} className={`text-gray-400 transition-transform ${varianteOuverte === v.cle ? 'rotate-180' : ''}`} />
                                    )}
                                    {v.cle}
                                  </button>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  {v.codeBarre
                                    ? <span className="inline-block rounded bg-white p-1">
                                        <CodeBarre valeur={v.codeBarre} hauteur={26} largeurBarre={1} afficherTexte={false} />
                                      </span>
                                    : <span className="text-gray-400 text-xs">—</span>}
                                </td>
                                <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{v.coutMoyen > 0 ? formatMontant(v.coutMoyen) : '—'}</td>
                                <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 text-center">
                                  {formatMontant(v.prixVente ?? produit.prixVente)}
                                  {v.prixVente == null && <span className="text-xs text-gray-400 ml-1">hérité</span>}
                                </td>
                                <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{v.stock}</td>
                                <td className={`px-3 py-2.5 font-medium ${beneficeVar > 0 ? 'text-green-600' : beneficeVar < 0 ? 'text-red-500' : 'text-gray-400'} text-center`}>
                                  {v.stock > 0 ? formatMontant(beneficeVar) : '—'}
                                </td>
                                <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 font-medium text-center">{formatMontant(v.coutMoyen * v.stock)}</td>
                                <td className="px-3 py-2.5 text-center">
                                  {(() => { const sv = statutStock(v.stock, produit.seuilAlerte); return (
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${sv.color}`}>{sv.label}</span>
                                  ); })()}
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  <div className="flex items-center gap-1.5">
                                    <button onClick={() => { setEditVariante(v); setEdVPrix(v.prixVente != null ? String(v.prixVente) : ''); }}
                                      className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors">
                                      <Pencil size={12} />
                                    </button>
                                    <button onClick={() => setSuppVariante(v)}
                                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                              {varianteOuverte === v.cle && emballages.length > 0 && (
                                <tr>
                                  <td colSpan={9} className="px-3 pb-3">
                                    <div className="flex flex-wrap gap-x-6 gap-y-1.5 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 text-xs">
                                      {emballages.map(e => {
                                        /* emballages complets seulement : un carton entamé n'en est pas un */
                                        const complets = e.quantite > 0 ? Math.floor(v.stock / e.quantite) : 0;
                                        const reste = e.quantite > 0 ? v.stock % e.quantite : 0;
                                        return (
                                          <span key={e.nom} className="text-gray-400">
                                            {e.nom} <span className={complets > 0 ? 'font-bold text-gray-700 dark:text-gray-200' : 'font-bold text-gray-300 dark:text-gray-600'}>
                                              {complets.toLocaleString('fr-FR')}
                                            </span>
                                            {reste > 0 && <span className="ml-1">+ {reste.toLocaleString('fr-FR')} {uniteLabel}{reste > 1 ? 's' : ''}</span>}
                                          </span>
                                        );
                                      })}
                                    </div>
                                  </td>
                                </tr>
                              )}
                              </Fragment>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-gray-100 dark:border-gray-800">
                              <td className="px-3 py-2.5 font-bold text-gray-900 dark:text-gray-100 text-center" colSpan={4}>Total</td>
                              <td className="px-3 py-2.5 font-bold text-gray-900 dark:text-gray-100 text-center">{stockFiltre}</td>
                              <td className={`px-3 py-2.5 font-bold ${beneficeFiltre > 0 ? 'text-green-600' : beneficeFiltre < 0 ? 'text-red-500' : 'text-gray-400'} text-center`}>
                                {formatMontant(beneficeFiltre)}
                              </td>
                              <td className="px-3 py-2.5 font-bold text-gray-900 dark:text-gray-100 text-center">{formatMontant(valeurFiltre)}</td>
                              <td className="px-3 py-2.5 text-center" colSpan={2}></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )
                }
              </>
            )}

            {onglet === 'emballages' && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <p className="text-xs text-gray-400">Exprimés en {uniteLabel}s. Le prix suit le prix unitaire.</p>
                  <button onClick={() => { setEmbNom(''); setEmbQte(''); setModalEmballage(true); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
                    <Plus size={12} /> Ajouter un emballage
                  </button>
                </div>
                {emballages.length === 0
                  ? <p className="text-xs text-gray-400 text-center py-8">Aucun emballage — le produit se vend en {uniteLabel}.</p>
                  : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm whitespace-nowrap">
                        <thead>
                          <tr className="bg-indigo-600 text-white">
                            <th className="text-center px-3 py-2.5 font-medium">Emballage</th>
                            <th className="text-center px-3 py-2.5 font-medium">Contenu</th>
                            <th className="text-center px-3 py-2.5 font-medium">Stock</th>
                            <th className="text-center px-3 py-2.5 font-medium">Prix</th>
                            <th className="px-3 py-2.5 text-center"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                          {emballages.map(e => (
                            <tr key={e.nom} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                              <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{e.nom}</td>
                              <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{e.quantite} {uniteLabel}{e.quantite > 1 ? 's' : ''}</td>
                              {/* Combien d'emballages *complets* le stock permet de former :
                                  un carton à moitié rempli n'est pas un carton, d'où la
                                  division entière plutôt qu'un arrondi. */}
                              {(() => {
                                const complets = e.quantite > 0 ? Math.floor(stockTotal / e.quantite) : 0;
                                const reste = e.quantite > 0 ? stockTotal % e.quantite : 0;
                                return (
                                  <td className="px-3 py-2.5 text-center">
                                    <span className={complets > 0 ? 'text-gray-900 dark:text-gray-100 font-medium' : 'text-gray-300 dark:text-gray-600'}>
                                      {complets.toLocaleString('fr-FR')}
                                    </span>
                                    {reste > 0 && (
                                      <span className="text-xs text-gray-400 ml-1.5">
                                        + {reste.toLocaleString('fr-FR')} {uniteLabel}{reste > 1 ? 's' : ''}
                                      </span>
                                    )}
                                  </td>
                                );
                              })()}
                              <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 text-center">
                                {produit.prixVente > 0 ? formatMontant(produit.prixVente * e.quantite) : '—'}
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <button onClick={() => setSuppEmballage(e)}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                                  <Trash2 size={12} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </>
            )}

            {onglet === 'caracteristiques' && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <p className="text-xs text-gray-400">Ce qui fait varier le produit — couleur, taille…</p>
                  <button onClick={() => { setCaracNom(''); setCaracValeurs([]); setSaisieVal(''); setModalCarac(true); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
                    <Plus size={12} /> Ajouter une caractéristique
                  </button>
                </div>
                {caracs.length === 0
                  ? <p className="text-xs text-gray-400 text-center py-8">Aucune caractéristique — le produit a un stock unique.</p>
                  : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm whitespace-nowrap">
                        <thead>
                          <tr className="bg-indigo-600 text-white">
                            <th className="text-center px-3 py-2.5 font-medium">Caractéristique</th>
                            <th className="text-center px-3 py-2.5 font-medium">Choix</th>
                            <th className="px-3 py-2.5 text-center"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                          {caracs.map(c => {
                            const nbUtil = variantes.filter(v => c.nom in v.selection).length;
                            return (
                              <tr key={c.nom} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                                <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{c.nom}</td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className="flex flex-wrap gap-1.5">
                                    {c.valeurs.map(v => (
                                      <span key={v} className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">{v}</span>
                                    ))}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  {nbUtil === 0
                                    ? <button onClick={() => setSuppCarac(c)}
                                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                                        <Trash2 size={12} />
                                      </button>
                                    : <span className="text-xs text-gray-300 dark:text-gray-600">verrouillée</span>}
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

        </>)}

        {vue === 'mouvements' && (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Historique des mouvements</p>
              <button onClick={() => setModalMouvement(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-colors">
                <Plus size={12} /> Nouveau mouvement
              </button>
            </div>

            {mouvements.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                <ChampRecherche placeholder="Rechercher un motif, un partenaire, un document…" valeur={rechMouv} onChange={setRechMouv} className="flex-1 min-w-[200px]" />
                <div className="flex rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shrink-0">
                  {([
                    { key: 'tous' as const,   label: 'Tous',    n: mouvements.length },
                    { key: 'entree' as const, label: 'Entrées', n: mouvements.filter(m => m.sens === 'entree').length },
                    { key: 'sortie' as const, label: 'Sorties', n: mouvements.filter(m => m.sens === 'sortie').length },
                  ]).map(f => (
                    <button key={f.key} onClick={() => setFiltreSens(f.key)}
                      className={`px-3 py-2 text-xs font-bold transition-colors ${filtreSens === f.key ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-indigo-600'}`}>
                      {f.label} ({f.n})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mouvements.length === 0
              ? <p className="text-xs text-gray-400 text-center py-8">Aucun mouvement enregistré.</p>
              : mouvementsFiltres.length === 0
                ? <p className="text-xs text-gray-400 text-center py-8">Aucun résultat.</p>
                : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm whitespace-nowrap">
                      <thead>
                        <tr className="bg-indigo-600 text-white">
                          <th className="text-center px-3 py-2.5 font-medium">Date</th>
                          <th className="text-center px-3 py-2.5 font-medium">Sens</th>
                          <th className="text-center px-3 py-2.5 font-medium">Motif</th>
                          <th className="text-center px-3 py-2.5 font-medium">Variante</th>
                          <th className="text-center px-3 py-2.5 font-medium">Quantité</th>
                          <th className="text-center px-3 py-2.5 font-medium">P.U.</th>
                          <th className="text-center px-3 py-2.5 font-medium">Total</th>
                          <th className="text-center px-3 py-2.5 font-medium">Bénéfice</th>
                          <th className="text-center px-3 py-2.5 font-medium">Partenaire</th>
                          <th className="text-center px-3 py-2.5 font-medium">Document</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                        {mouvementsFiltres.map(m => (
                          <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                            <td className="px-3 py-2.5 text-gray-500 text-center">{formatDate(m.date)}</td>
                            <td className="px-3 py-2.5 text-center">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${m.sens === 'entree'
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>
                                {m.sens === 'entree' ? <ArrowDownLeft size={10} /> : <ArrowUpRight size={10} />}
                                {m.sens === 'entree' ? 'Entrée' : 'Sortie'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{LIBELLE_MOTIF[m.motif] ?? m.motif}</td>
                            <td className="px-3 py-2.5 text-gray-500 text-center">{m.varianteCle || '—'}</td>
                            <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 text-center">
                              {m.quantiteUnites} <span className="text-xs text-gray-400">{uniteLabel}s</span>
                              {m.emballage && <span className="text-xs text-gray-400 ml-1">({m.quantite} {m.emballage})</span>}
                            </td>
                            <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{m.valeurUnitaire > 0 ? formatMontant(m.valeurUnitaire) : '—'}</td>
                            <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 font-medium text-center">{m.valeurTotale > 0 ? formatMontant(m.valeurTotale) : '—'}</td>
                            <td className={`px-3 py-2.5 font-medium ${m.benefice == null ? 'text-gray-300 dark:text-gray-600' : m.benefice >= 0 ? 'text-green-600' : 'text-red-500'} text-center`}>
                              {m.benefice == null ? '—' : formatMontant(m.benefice)}
                            </td>
                            <td className="px-3 py-2.5 text-gray-500 text-center">{m.partenaireNom || '—'}</td>
                            <td className="px-3 py-2.5 text-gray-400 text-xs text-center">{m.documentId || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
            }
          </div>
        )}

        {/* Modal nouvelle variante */}
        {modalVariante && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5 flex flex-col max-h-[85vh] min-h-0">
              <div className="flex items-center justify-between mb-4 shrink-0">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouvelle variante</h2>
                <button onClick={() => setModalVariante(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>

              <div className="overflow-y-auto flex-1 min-h-0 pr-1">
                <p className="text-xs text-gray-400 mb-3">
                  Clique les choix qui composent cette variante.
                </p>
                {caracs.map(c => (
                  <div key={c.nom} className="mb-3">
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1.5">{c.nom}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {c.valeurs.map(val => {
                        const actif = selection[c.nom] === val;
                        return (
                          <button key={val} type="button"
                            onClick={() => setSelection(prev => ({ ...prev, [c.nom]: actif ? '' : val }))}
                            className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${actif
                              ? 'bg-indigo-600 border-indigo-600 text-white'
                              : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-indigo-300'}`}>
                            {val}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {Object.keys(choisiesEnCours).length > 0 && (
                  <p className="text-xs text-gray-400 mb-1">
                    Variante : <span className="font-bold text-indigo-600">{cleVariante(choisiesEnCours, caracs)}</span>
                  </p>
                )}
                {doublon && <p className="text-xs text-red-500 mb-1">Cette variante existe déjà.</p>}

                <div className="flex gap-2 mt-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Coût</p>
                    <input type="number" placeholder={produit.coutMoyen > 0 ? String(produit.coutMoyen) : '—'} value={vCout}
                      onChange={e => setVCout(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Prix</p>
                    <input type="number" placeholder={produit.prixVente > 0 ? String(produit.prixVente) : '—'} value={vPrix}
                      onChange={e => setVPrix(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>

                <p className="text-xs font-bold text-gray-400 uppercase mb-1 mt-3">Stock</p>
                <div className="flex gap-2">
                  <input type="number" min={0} placeholder="0" value={vStock} onChange={e => setVStock(e.target.value)}
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  {emballages.length > 0 && (
                    <select value={vStockEmb} onChange={e => setVStockEmb(e.target.value)}
                      className="w-28 shrink-0 px-2 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      <option value="">{uniteLabel}</option>
                      {emballages.map(e => <option key={e.nom} value={e.nom}>{e.nom}</option>)}
                    </select>
                  )}
                </div>
                {emballages.length > 0 && vStockEmb && vStock && (
                  <p className="text-xs text-gray-400 mt-1">
                    Soit <span className="font-bold text-gray-600 dark:text-gray-300">{enUnites(vStock, vStockEmb, emballages)}</span> {uniteLabel}s.
                  </p>
                )}
              </div>

              <div className="flex gap-3 shrink-0 pt-4">
                <button onClick={() => setModalVariante(false)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={ajouterVariante} disabled={saving || !varianteValide}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ajouter
                </button>
              </div>
            </div>
          </div>
        )}

        {modalMouvement && (
          <ModalMouvement
            siteId={siteId}
            userId={user!.uid}
            produit={produit}
            onClose={() => setModalMouvement(false)}
            onEnregistre={async m => {
              setMouvements(prev => [m, ...prev].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')));
              const snap = await getDoc(doc(db, 'produits', produitId));
              if (snap.exists()) setProduit({ id: snap.id, ...snap.data() } as Produit);
              setModalMouvement(false);
            }}
          />
        )}

        {/* Modal édition produit */}
        {modalEdition && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5 flex flex-col max-h-[85vh] min-h-0">
              <div className="flex items-center justify-between mb-4 shrink-0">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Modifier le produit</h2>
                <button onClick={() => setModalEdition(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>

              <div className="overflow-y-auto flex-1 min-h-0 pr-1">
                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Désignation <span className="text-red-400">*</span></p>
                <input type="text" value={edNom} onChange={e => { setEdNom(e.target.value); setErreurEdition(''); }}
                  className={`w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${erreurEdition ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />

                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Catégorie</p>
                <input type="text" placeholder="Ex. Hygiène" value={edCategorie} onChange={e => setEdCategorie(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />

                <div className="flex gap-2 mb-1">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Coût moyen</p>
                    <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400">
                      {produit.coutMoyen > 0 ? formatMontant(produit.coutMoyen) : '—'}
                    </p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Prix de vente</p>
                    <input type="number" value={edPrix} onChange={e => setEdPrix(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>
                <p className="text-xs text-gray-400 mb-4">
                  Le coût est calculé sur les achats — il évolue à chaque entrée de stock.
                  {produit.coutMoyen > 0 && parseMontant(edPrix) > 0 && (
                    <> Marge de <span className="font-bold text-green-600">{formatMontant(parseMontant(edPrix) - produit.coutMoyen)}</span> par {uniteLabel}.</>
                  )}
                </p>

                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Seuil d&apos;alerte</p>
                <div className="flex gap-2">
                  <input type="number" min={0} placeholder="Ex. 10" value={edSeuil} onChange={e => setEdSeuil(e.target.value)}
                    className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  {emballages.length > 0 && (
                    <select value={edSeuilEmb} onChange={e => setEdSeuilEmb(e.target.value)}
                      className="w-28 shrink-0 px-2 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      <option value="">{uniteLabel}</option>
                      {emballages.map(e => <option key={e.nom} value={e.nom}>{e.nom}</option>)}
                    </select>
                  )}
                </div>
                {emballages.length > 0 && edSeuilEmb && edSeuil && (
                  <p className="text-xs text-gray-400 mt-1">
                    Soit <span className="font-bold text-gray-600 dark:text-gray-300">{enUnites(edSeuil, edSeuilEmb, emballages)}</span> {uniteLabel}s.
                  </p>
                )}

                {erreurEdition && <p className="text-xs text-red-500 mt-3">{erreurEdition}</p>}
                {variantes.length > 0 && (
                  <p className="text-xs text-gray-400 mt-3">
                    Le coût et le prix s&apos;appliquent aux variantes qui n&apos;ont pas les leurs.
                  </p>
                )}
              </div>

              <div className="flex gap-3 shrink-0 pt-4">
                <button onClick={() => setModalEdition(false)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={sauvegarderEdition} disabled={saving || !edNom.trim()}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal nouvel emballage */}
        {modalEmballage && (() => {
          const nom = embNom.trim();
          const qte = parseMontant(embQte);
          const doublonEmb = !!nom && emballages.some(e => e.nom.toLowerCase() === nom.toLowerCase());
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
              <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouvel emballage</h2>
                  <button onClick={() => setModalEmballage(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
                </div>
                <div className="flex gap-2 mb-1">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom</p>
                    <input type="text" placeholder="Ex. Carton" value={embNom} onChange={e => setEmbNom(e.target.value)}
                      className={`w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${doublonEmb ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
                  </div>
                  <div className="w-28 shrink-0">
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Quantité</p>
                    <input type="number" min={2} placeholder="Ex. 12" value={embQte} onChange={e => setEmbQte(e.target.value)}
                      className={`w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${qte === 1 ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
                  </div>
                </div>
                {doublonEmb && <p className="text-xs text-red-500 mb-3">Cet emballage existe déjà.</p>}
                {qte === 1 && <p className="text-xs text-red-500 mb-3">Un emballage de 1 {uniteLabel}, c&apos;est l&apos;unité elle-même.</p>}
                {!doublonEmb && qte !== 1 && (
                  <p className="text-xs text-gray-400 mb-3">
                    {qte > 1 && produit.prixVente > 0
                      ? <>Se vendra {formatMontant(produit.prixVente * qte)}.</>
                      : <>Exprimé en {uniteLabel}s.</>}
                  </p>
                )}
                <div className="flex gap-3">
                  <button onClick={() => setModalEmballage(false)}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                  <button onClick={ajouterEmballage} disabled={saving || !nom || qte < 2 || doublonEmb}
                    className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ajouter
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Modal suppression emballage */}
        {suppEmballage && (() => {
          const lies = mouvementsEmballage(suppEmballage.nom);
          const bloque = lies.length > 0;
          return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className={`bg-white dark:bg-gray-900 rounded-2xl w-full shadow-xl p-5 ${bloque ? 'max-w-lg' : 'max-w-sm'}`}>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${bloque ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
                {bloque ? <Lock size={18} className="text-amber-500" /> : <Trash2 size={18} className="text-red-500" />}
              </div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2">
                {bloque ? `« ${suppEmballage.nom} » ne peut pas être supprimé` : `Supprimer “${suppEmballage.nom}” ?`}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                {bloque
                  ? `${lies.length} mouvement${lies.length > 1 ? 's' : ''} a été saisi dans cet emballage. Le supprimer rendrait ces quantités illisibles.`
                  : `Le stock reste inchangé — il est compté en ${uniteLabel}s. Cet emballage ne sera plus proposé à la saisie.`}
              </p>

              {bloque && (
                <div className="max-h-56 overflow-y-auto mb-5 rounded-xl border border-gray-100 dark:border-gray-800">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0">
                      <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500">
                        <th className="text-center px-2 py-1.5 font-medium">Date</th>
                        <th className="text-center px-2 py-1.5 font-medium">Sens</th>
                        <th className="text-center px-2 py-1.5 font-medium">Motif</th>
                        <th className="text-center px-2 py-1.5 font-medium">Quantité</th>
                        <th className="text-center px-2 py-1.5 font-medium">Valeur</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {lies.map(m => (
                        <tr key={m.id}>
                          <td className="px-2 py-1.5 text-center text-gray-500">{formatDate(m.date)}</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}>
                              {m.sens === 'entree' ? 'Entrée' : 'Sortie'}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-500">{m.motif}</td>
                          <td className="px-2 py-1.5 text-center text-gray-600 dark:text-gray-400">
                            {m.quantite.toLocaleString('fr-FR')} {suppEmballage.nom}
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-900 dark:text-gray-100">{formatMontant(m.valeurTotale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={() => setSuppEmballage(null)}
                  className={`py-2.5 rounded-xl text-sm font-medium ${bloque
                    ? 'flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold'
                    : 'flex-1 border border-gray-200 dark:border-gray-700 text-gray-500'}`}>
                  {bloque ? 'Compris' : 'Annuler'}
                </button>
                {!bloque && (
                  <button onClick={supprimerEmballage}
                    className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                    <Trash2 size={14} /> Supprimer
                  </button>
                )}
              </div>
            </div>
          </div>
          );
        })()}

        {/* Modal nouvelle caractéristique */}
        {modalCarac && (() => {
          const nom = caracNom.trim();
          const val = saisieVal.trim();
          const doublonNom = !!nom && caracs.some(c => c.nom.toLowerCase() === nom.toLowerCase());
          const doublonVal = !!val && caracValeurs.some(v => v.toLowerCase() === val.toLowerCase());
          const ajouterVal = () => {
            if (!val || !nom || doublonVal) return;
            setCaracValeurs(prev => [...prev, val]);
            setSaisieVal('');
          };
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
              <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouvelle caractéristique</h2>
                  <button onClick={() => setModalCarac(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
                </div>

                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom</p>
                <input type="text" placeholder="Ex. Couleur" value={caracNom} onChange={e => setCaracNom(e.target.value)}
                  className={`w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${doublonNom ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
                {doublonNom ? <p className="text-xs text-red-500 mb-3">Cette caractéristique existe déjà.</p> : <div className="mb-3" />}

                <p className="text-xs font-bold text-gray-400 uppercase mb-1">
                  Choix {caracValeurs.length > 0 && <span className="font-normal normal-case text-gray-400">({caracValeurs.length})</span>}
                </p>
                <div className="flex gap-2">
                  <input type="text" disabled={!nom} placeholder={nom ? 'Ex. Rouge' : 'Renseigne d’abord le nom'}
                    value={saisieVal} onChange={e => setSaisieVal(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); ajouterVal(); } }}
                    className={`flex-1 min-w-0 px-3 py-2 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:cursor-not-allowed ${doublonVal ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
                  <button type="button" onClick={ajouterVal} disabled={!val || !nom || doublonVal}
                    className="px-3 py-2 shrink-0 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold transition-colors">
                    Ajouter
                  </button>
                </div>
                {doublonVal && <p className="text-xs text-red-500 mt-1">« {val} » est déjà dans la liste.</p>}
                {caracValeurs.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {caracValeurs.map(v => (
                      <span key={v} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                        {v}
                        <button type="button" onClick={() => setCaracValeurs(prev => prev.filter(x => x !== v))}
                          className="hover:text-red-500"><X size={10} /></button>
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex gap-3 mt-4">
                  <button onClick={() => setModalCarac(false)}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                  <button onClick={ajouterCarac} disabled={saving || !nom || caracValeurs.length === 0 || doublonNom}
                    className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ajouter
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Modal suppression caractéristique */}
        {suppCarac && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center mb-4">
                <Trash2 size={18} className="text-red-500" />
              </div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2">Supprimer &ldquo;{suppCarac.nom}&rdquo; ?</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                Aucune variante ne l&apos;utilise, sa suppression est sans effet sur le stock.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setSuppCarac(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={supprimerCarac}
                  className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  <Trash2 size={14} /> Supprimer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal édition variante */}
        {editVariante && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Modifier &ldquo;{editVariante.cle}&rdquo;</h2>
                <button onClick={() => setEditVariante(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>

              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Prix de vente</p>
              <input type="number" placeholder={produit.prixVente > 0 ? String(produit.prixVente) : '—'} value={edVPrix}
                onChange={e => setEdVPrix(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs text-gray-400 mb-4">
                Vide = prix du produit ({formatMontant(produit.prixVente)}).
              </p>

              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Coût moyen</p>
              <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400 mb-1">
                {editVariante.coutMoyen > 0 ? formatMontant(editVariante.coutMoyen) : '—'}
              </p>
              <p className="text-xs text-gray-400 mb-4">
                Calculé sur les achats — non modifiable. Il évolue à chaque entrée de stock.
              </p>

              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Stock</p>
              <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400 mb-1">
                {editVariante.stock} {uniteLabel}{editVariante.stock > 1 ? 's' : ''}
              </p>
              <p className="text-xs text-gray-400 mb-5">
                Se règle par les entrées et sorties.
              </p>

              <div className="flex gap-3">
                <button onClick={() => setEditVariante(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button onClick={sauvegarderVariante} disabled={saving}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal suppression variante */}
        {suppVariante && (() => {
          const lies = mouvementsDe(suppVariante.cle);
          const bloque = lies.length > 0;
          return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className={`bg-white dark:bg-gray-900 rounded-2xl w-full shadow-xl p-5 ${bloque ? 'max-w-lg' : 'max-w-sm'}`}>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${bloque ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
                {bloque ? <Lock size={18} className="text-amber-500" /> : <Trash2 size={18} className="text-red-500" />}
              </div>
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-2">
                {bloque ? `« ${suppVariante.cle} » ne peut pas être supprimée` : `Supprimer “${suppVariante.cle}” ?`}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                {bloque
                  ? `${lies.length} mouvement${lies.length > 1 ? 's' : ''} la concerne${lies.length > 1 ? 'nt' : ''}. Les effacer rendrait l'historique du stock incohérent.`
                  : `Son stock de ${suppVariante.stock} ${uniteLabel}${suppVariante.stock > 1 ? 's' : ''} sera retiré du produit.`}
              </p>

              {bloque && (
                <div className="max-h-56 overflow-y-auto mb-5 rounded-xl border border-gray-100 dark:border-gray-800">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0">
                      <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500">
                        <th className="text-center px-2 py-1.5 font-medium">Date</th>
                        <th className="text-center px-2 py-1.5 font-medium">Sens</th>
                        <th className="text-center px-2 py-1.5 font-medium">Motif</th>
                        <th className="text-center px-2 py-1.5 font-medium">Quantité</th>
                        <th className="text-center px-2 py-1.5 font-medium">Valeur</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {lies.map(m => (
                        <tr key={m.id}>
                          <td className="px-2 py-1.5 text-center text-gray-500">{formatDate(m.date)}</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}>
                              {m.sens === 'entree' ? 'Entrée' : 'Sortie'}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-500">{m.motif}</td>
                          <td className="px-2 py-1.5 text-center text-gray-600 dark:text-gray-400">
                            {m.quantiteUnites.toLocaleString('fr-FR')}
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-900 dark:text-gray-100">{formatMontant(m.valeurTotale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={() => setSuppVariante(null)}
                  className={`py-2.5 rounded-xl text-sm font-medium ${bloque
                    ? 'flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold'
                    : 'flex-1 border border-gray-200 dark:border-gray-700 text-gray-500'}`}>
                  {bloque ? 'Compris' : 'Annuler'}
                </button>
                {!bloque && (
                  <button onClick={supprimerVariante}
                    className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                    <Trash2 size={14} /> Supprimer
                  </button>
                )}
              </div>
            </div>
          </div>
          );
        })()}
      </div>
    </div>
  );
}
