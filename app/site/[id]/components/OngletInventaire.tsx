'use client';
import { useAuth } from '@/lib/auth-context';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useRouter } from 'next/navigation';
import { enregistrerStockInitial } from '@/lib/mouvements';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from './finance/font';
import { Loader2, Plus, X, Check, Trash2, ChevronDown, ArrowUpDown, Filter, Download } from 'lucide-react';
import { ChampRecherche } from '@/components/Champs';
import { ouvrirPartout, detentionsDe, type ProduitSite } from '@/lib/produits-site';
import { etatsDepuisMouvements, etatDe, etatDuProduit } from '@/lib/cout-moyen';
import {
  useSites, FiltreSite, CelluleSite, ToggleVue, CartesParSite,
  type PropsPortee,
} from './ContexteSites';
import { lireParSite } from '@/lib/portee';
import { auteurCourant } from '@/lib/auteur';
import { chargerCatalogue, catalogueReprise } from '@/lib/reprise-catalogue';

/** Emballage : un conditionnement exprimé en unités de base (ex. Carton = 12 pièces). */
interface Emballage {
  nom: string;
  quantite: number;
}

/** Caractéristique d'un produit (ex. Couleur → Rouge, Bleu). */
interface Caracteristique {
  nom: string;
  valeurs: string[];
}

/**
 * Déclinaison réelle du produit, avec son propre stock.
 * `selection` ne porte que les caractéristiques qui la concernent : un modèle
 * taille unique n'a qu'une couleur. prixVente absent = hérite du produit ;
 * coutMoyen n'hérite jamais, il résulte des entrées propres à la variante.
 */
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
  /* Un produit appartient à un site : le même article tient deux fiches et
     deux stocks sur deux boutiques. */
  siteId?: string;
  designation: string;
  codeBarre?: string;
  categorie?: string;
  unite: string;
  prixVente: number;
  coutMoyen: number;
  stock: number;
  seuilAlerte?: number;
  emballages?: Emballage[];
  caracteristiques?: Caracteristique[];
  variantes?: Variante[];
  actif: boolean;
}

interface Props extends PropsPortee {
  userId: string;
}


/** Colonne chiffrée sur laquelle trier ; null = ordre de chargement. */
type TriStock = 'cout' | 'prix' | 'stock' | 'benefice' | 'valeur' | null;
type TriRenta = 'entrees' | 'sorties' | 'difference' | 'enStock' | 'derniereEntree' | 'derniereSortie' | null;

type OngletForm = 'general' | 'tarifs' | 'emballages' | 'caracteristiques' | 'variantes';

function parseMontant(s: string): number {
  return parseInt(s.replace(/[\s ]/g, ''), 10) || 0;
}

/**
 * Code-barres EAN-13 à usage interne : préfixe 200 (plage réservée aux
 * numérotations privées), 9 chiffres aléatoires, puis la clé de contrôle.
 */
function genererCodeBarre(): string {
  const base = '200' + Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join('');
  const somme = base.split('').reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return base + ((10 - (somme % 10)) % 10);
}

/** Convertit une quantité exprimée dans un emballage en unités de base. */
function enUnites(quantite: string, nomEmballage: string, emballages: Emballage[]): number {
  const nb = parseMontant(quantite);
  if (!nb) return 0;
  const emb = emballages.find(e => e.nom === nomEmballage);
  return nb * (emb ? emb.quantite : 1);
}

/** Saisie d'un stock : une quantité, et l'emballage dans lequel elle est exprimée. */
function SaisieStock({ quantite, emballage, emballages, unite, onQuantite, onEmballage }: {
  quantite: string;
  emballage: string;
  emballages: Emballage[];
  unite: string;
  onQuantite: (v: string) => void;
  onEmballage: (v: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <input type="number" min={0} placeholder="Ex. 12" value={quantite}
        onChange={e => onQuantite(e.target.value)}
        className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      {emballages.length > 0 && (
        <select value={emballage} onChange={e => onEmballage(e.target.value)}
          className="w-24 shrink-0 px-2 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">{unite.trim() ? unite.toLowerCase() : 'unité'}</option>
          {emballages.map(e => <option key={e.nom} value={e.nom}>{e.nom}</option>)}
        </select>
      )}
    </div>
  );
}

/** Libellé d'une sélection, dans l'ordre des caractéristiques : « Rouge / M ». */
function cleVariante(selection: Record<string, string>, caracs: Caracteristique[]): string {
  return caracs
    .map(c => selection[c.nom])
    .filter(Boolean)
    .join(' / ');
}

/** Deux variantes sont identiques si elles portent exactement les mêmes couples. */
function memeSelection(a: Record<string, string>, b: Record<string, string>): boolean {
  const cles = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...cles].every(k => a[k] === b[k]);
}

type FiltreStock = 'tous' | 'en_stock' | 'alerte' | 'rupture';

/** Stock total d'un produit : somme des variantes, ou stock direct s'il n'en a pas. */
function stockTotal(p: Produit): number {
  return p.variantes?.length ? p.variantes.reduce((s, v) => s + v.stock, 0) : p.stock;
}

/** Valeur au coût d'achat, variante par variante quand elles existent. */
function valeurCout(p: Produit): number {
  return p.variantes?.length
    ? p.variantes.reduce((s, v) => s + v.coutMoyen * v.stock, 0)
    : p.coutMoyen * p.stock;
}

/** Valeur au prix de vente ; une variante sans prix hérite de celui du produit. */
function valeurVenteProduit(p: Produit): number {
  return p.variantes?.length
    ? p.variantes.reduce((s, v) => s + (v.prixVente ?? p.prixVente) * v.stock, 0)
    : p.prixVente * p.stock;
}

function statutStock(p: Produit): { label: string; color: string } {
  const stock = stockTotal(p);
  if (stock <= 0) return { label: 'Rupture', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
  if (p.seuilAlerte != null && stock <= p.seuilAlerte)
    return { label: 'Alerte', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' };
  return { label: 'En stock', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
}

/**
 * Un produit n'est « récupéré » que si ses ventes couvrent ses achats.
 * Tant que ce n'est pas le cas, l'investissement dort encore en stock.
 */
function statutRentabilite(entrees: number, sorties: number): { label: string; color: string } {
  if (entrees === 0 && sorties === 0)
    return { label: 'Sans mouvement', color: 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500' };
  if (sorties > entrees)
    return { label: 'Bénéficiaire', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  if (sorties === entrees)
    return { label: 'Récupéré', color: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400' };
  return { label: 'En cours', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' };
}

function joursDepuis(date?: string): number {
  if (!date) return 0;
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.max(Math.round((now.getTime() - d.getTime()) / 86400000), 0);
}

/**
 * L'ancienneté en clair. En rentabilité c'est la durée qui informe, pas le
 * jour exact : « 47 jours » se juge d'un coup d'œil, pas « 25/07/2026 ».
 * Une date absente n'est pas zéro jour : le mouvement n'a jamais eu lieu.
 */
function libelleJours(date?: string): string {
  if (!date) return 'jamais';
  const n = joursDepuis(date);
  if (n === 0) return "aujourd'hui";
  return `${n} jour${n > 1 ? 's' : ''}`;
}

/** Pour trier : un mouvement inexistant passe après le plus ancien. */
function anciennete(date?: string): number {
  return date ? joursDepuis(date) : Number.MAX_SAFE_INTEGER;
}

function formatDateCourt(s?: string): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function filtreProduit(p: Produit, f: FiltreStock): boolean {
  if (f === 'tous') return true;
  const label = statutStock(p).label;
  return f === 'en_stock' ? label === 'En stock'
    : f === 'alerte' ? label === 'Alerte'
    : label === 'Rupture';
}

export default function OngletInventaire({ siteId, userId, sites, titre }: Props) {
  const ctx = useSites(siteId, sites);
  /* Un produit naît pour l'activité : il lui faut son identifiant. */
  const { activite } = useAuth();
  /* Échafaudage d'essai : garnir une activité neuve pour l'éprouver à
     plusieurs. Les deux boutons partent avec le test — ils ne sont pas
     une fonctionnalité de l'app. */
  const [reprise, setReprise] = useState(false);
  const [repriseFaite, setRepriseFaite] = useState<string | null>(null);

  async function reprendreCatalogue() {
    if (!activite?.id || reprise) return;
    setReprise(true);
    try {
      const sites = ctx.sites.length > 0
        ? ctx.sites.map(x => x.id)
        : (ctx.siteEcriture ? [ctx.siteEcriture] : []);
      const r = await chargerCatalogue({
        activiteId: activite.id,
        siteIds: sites,
        userId,
        produits: catalogueReprise(),
      });
      setRepriseFaite(`${r.crees} produit${r.crees > 1 ? 's' : ''} chargé${r.crees > 1 ? 's' : ''}.`);
      await charger();
    } catch (e: any) {
      setRepriseFaite(e?.message ?? 'Chargement impossible.');
    }
    setReprise(false);
  }
  const router = useRouter();
  const [produits, setProduits] = useState<Produit[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [unites, setUnites] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  /* tableau */
  const [recherche, setRecherche] = useState('');
  const [triStock, setTriStock] = useState<TriStock>(null);
  const [triRenta, setTriRenta] = useState<TriRenta>(null);
  const [sensTri, setSensTri] = useState<'asc' | 'desc'>('desc');
  const [filtreStock, setFiltreStock] = useState<FiltreStock>('tous');
  const [vue, setVue] = useState<'stock' | 'rentabilite'>('stock');
  /* par produit : ce qui est entré, ce qui est sorti, et quand pour la dernière fois */
  const [bilans, setBilans] = useState<Record<string, { entrees: number; sorties: number; derniereEntree?: string; derniereSortie?: string }>>({});

  /* modal nouveau produit */
  const [modalOuvert, setModalOuvert] = useState(false);
  const [designation, setDesignation] = useState('');
  const [categorie, setCategorie] = useState('');
  const [modeCategorie, setModeCategorie] = useState<'existant' | 'nouveau'>('existant');
  const [unite, setUnite] = useState('');
  const [modeUnite, setModeUnite] = useState<'existant' | 'nouveau'>('existant');
  const [prixVente, setPrixVente] = useState('');
  const [coutAchat, setCoutAchat] = useState('');
  /* stock saisi, et l'emballage dans lequel il est exprimé ('' = unité de base) */
  const [stockInitial, setStockInitial] = useState('');
  const [stockEmballage, setStockEmballage] = useState('');
  const [seuilAlerte, setSeuilAlerte] = useState('');
  const [seuilEmballage, setSeuilEmballage] = useState('');
  const [emballages, setEmballages] = useState<Emballage[]>([]);
  const [caracs, setCaracs] = useState<Caracteristique[]>([]);
  const [saisieValeur, setSaisieValeur] = useState<Record<number, string>>({});
  /* variantes en cours de saisie : sélection + valeurs sous forme de texte */
  const [variantesSaisie, setVariantesSaisie] = useState<
    { selection: Record<string, string>; stock: string; stockEmb: string; cout: string; prix: string }[]
  >([]);
  const [modalVariante, setModalVariante] = useState(false);
  const [selectionEnCours, setSelectionEnCours] = useState<Record<string, string>>({});
  const [erreurVariante, setErreurVariante] = useState('');
  const [modalTarifVariante, setModalTarifVariante] = useState(false);
  const [ongletForm, setOngletForm] = useState<OngletForm>('general');
  const [saving, setSaving] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => { charger(); }, [ctx.portee]);

  /* Avec une seule caractéristique, chaque choix est une variante : on les tient
     à jour automatiquement, en conservant les valeurs déjà saisies. */
  const caracUnique = caracs.filter(c => c.nom.trim() && c.valeurs.length > 0);
  const signatureAuto = caracUnique.length === 1
    ? `${caracUnique[0].nom}|${caracUnique[0].valeurs.join('|')}`
    : '';
  useEffect(() => {
    if (!signatureAuto) return;
    const [nom, ...valeurs] = signatureAuto.split('|');
    setVariantesSaisie(prev => valeurs.map(v => {
      const existante = prev.find(x => x.selection[nom] === v);
      return existante ?? { selection: { [nom]: v }, stock: '', stockEmb: '', cout: '', prix: '' };
    }));
  }, [signatureAuto]);

  /* passage à deux caractéristiques : les variantes déduites n'ont plus de sens */
  const nbCaracsValides = caracUnique.length;
  useEffect(() => {
    if (nbCaracsValides > 1) {
      setVariantesSaisie(prev => prev.filter(v => Object.keys(v.selection).length > 1));
    }
  }, [nbCaracsValides]);

  async function charger() {
    setLoading(true);
    /* Le produit appartient à l'activité : il se lit en entier, et c'est
       la détention qui le rattache à la portée regardée. */
    const [snapProd, mvSnap, dets] = await Promise.all([
      getDocs(query(collection(db, 'produits'))),
      lireParSite('mouvements', ctx.portee),
      detentionsDe(ctx.portee),
    ]);

    /* un transfert ne réalise rien : il ne compte ni en entrée ni en sortie de rentabilité */
    const agg: Record<string, { entrees: number; sorties: number; derniereEntree?: string; derniereSortie?: string }> = {};
    mvSnap.forEach(d => {
      const m = d.data();
      if (m.motif === 'transfert') return;
      const b = agg[m.produitId] ?? { entrees: 0, sorties: 0 };
      if (m.sens === 'entree') {
        b.entrees += m.valeurTotale ?? 0;
        if (!b.derniereEntree || m.date > b.derniereEntree) b.derniereEntree = m.date;
      }
      else {
        b.sorties += m.valeurTotale ?? 0;
        if (m.motif === 'vente' && (!b.derniereSortie || m.date > b.derniereSortie)) b.derniereSortie = m.date;
      }
      agg[m.produitId] = b;
    });
    setBilans(agg);

    /* Le coût moyen se déduit des entrées, il ne se lit pas : stocké, il
       part du stock courant, et une sortie pas encore écrite le fausse
       durablement. Rejoué, il est juste quel que soit l'ordre d'arrivée
       des écritures. */
    const etats = etatsDepuisMouvements(mvSnap.map(d => d.data() as any));
    /* Sur plusieurs sites, un même produit a plusieurs détentions : leurs
       stocks s'additionnent, et le coût moyen se pondère par les
       quantités — la moyenne des moyennes serait fausse dès que les
       volumes diffèrent. */
    const parProduit = new Map<string, ProduitSite[]>();
    for (const d of dets) {
      parProduit.set(d.produitId, [...(parProduit.get(d.produitId) ?? []), d]);
    }

    const liste = snapProd.docs
      /* Un produit sans détention dans la portée n'y est pas détenu : le
         montrer laisserait croire qu'il occupe un rayon qu'il n'occupe
         pas. */
      .filter(d => parProduit.has(d.id))
      .map(d => {
        const data = d.data();
        const mes = parProduit.get(d.id) ?? [];
        /* Le stock vient toujours de la détention — c'est un fait écrit —
           mais sa valeur se pèse au coût déduit. */
        const stock = mes.reduce((n, x) => n + (x.stock ?? 0), 0);
        const vsProduit = data.variantes ?? [];
        const calc = vsProduit.length > 0
          ? etatDuProduit(etats, d.id, vsProduit)
          : etatDe(etats, d.id, null);
        const valeur = stock * calc.coutMoyen;
        /* Un seul site : son prix et son seuil. Plusieurs : le premier
           renseigné, faute de prix unique à afficher. */
        const avecPrix = mes.find(x => (x.prixVente ?? 0) > 0);
        const avecSeuil = mes.find(x => x.seuilAlerte != null);

        /* Les variantes du produit disent ce qui existe ; leurs stocks
           viennent des détentions. */
        const variantes = (data.variantes ?? []).map((v: any) => {
          const parts = mes.flatMap(x => (x.variantes ?? []).filter(y => y.cle === v.cle));
          const st = parts.reduce((n, y) => n + (y.stock ?? 0), 0);
          return {
            ...v,
            stock: st,
            coutMoyen: etatDe(etats, d.id, v.cle).coutMoyen,
            prixVente: parts.find(y => (y.prixVente ?? 0) > 0)?.prixVente ?? v.prixVente ?? 0,
          };
        });

        return {
          id: d.id,
          siteId: mes.length === 1 ? mes[0].siteId : undefined,
          designation: data.designation ?? '',
          codeBarre: data.codeBarre,
          categorie: data.categorie,
          unite: data.unite ?? '',
          prixVente: avecPrix?.prixVente ?? 0,
          coutMoyen: calc.coutMoyen,
          stock,
          seuilAlerte: avecSeuil?.seuilAlerte ?? undefined,
          emballages: data.emballages ?? [],
          caracteristiques: data.caracteristiques ?? [],
          variantes,
          actif: data.actif ?? true,
        } as Produit;
      }).sort((a, b) => a.designation.localeCompare(b.designation));
    setProduits(liste);
    setCategories([...new Set(liste.map(p => p.categorie).filter((c): c is string => !!c))].sort());
    setUnites([...new Set(liste.map(p => p.unite).filter((u): u is string => !!u))].sort());
    setLoading(false);
  }

  function ouvrirModal() {
    setDesignation(''); setCategorie(''); setUnite('');
    /* rien à choisir dans une liste vide : on ouvre directement en saisie */
    setModeCategorie(categories.length > 0 ? 'existant' : 'nouveau');
    setModeUnite(unites.length > 0 ? 'existant' : 'nouveau');
    setPrixVente(''); setCoutAchat(''); setStockInitial(''); setStockEmballage(''); setSeuilAlerte(''); setSeuilEmballage('');
    setEmballages([]); setCaracs([]); setSaisieValeur({}); setVariantesSaisie([]);
    setModalVariante(false); setSelectionEnCours({}); setErreurVariante('');
    setOngletForm('general');
    setErreur('');
    setModalOuvert(true);
  }

  const emballagesUtiles = emballages.filter(e => e.nom.trim() && e.quantite > 1);
  const caracsValides = caracs.filter(c => c.nom.trim() && c.valeurs.length > 0);
  /* une variante n'apparaît dans Tarifs que si elle a reçu au moins une valeur */
  const tarifsVariantes = variantesSaisie
    .map((v, index) => ({ v, index }))
    .filter(({ v }) => v.stock || v.cout || v.prix);
  const aVariantes = variantesSaisie.length > 0;

  /* Avec une seule caractéristique, chaque choix EST une variante : l'app les
     déduit. Dès la deuxième, les combinaisons réelles ne sont pas devinables. */
  const saisieVariantesRequise = caracsValides.length > 1;

  const ongletsForm: { key: OngletForm; label: string }[] = [
    { key: 'general',          label: 'Général' },
    { key: 'tarifs',           label: 'Tarifs' },
    { key: 'emballages',       label: 'Emballages' },
    { key: 'caracteristiques', label: 'Caractéristiques' },
    /* dès qu'un groupe existe, le produit se décline : l'onglet s'ouvre */
    ...(caracsValides.length > 0 ? [{ key: 'variantes' as OngletForm, label: 'Variantes' }] : []),
  ];
  const ongletCourant: OngletForm = ongletsForm.some(o => o.key === ongletForm)
    ? ongletForm
    : 'caracteristiques';


  async function ajouterProduit() {
    const nom = designation.trim();
    if (!nom) { setOngletForm('general'); return; }
    if (produits.some(p => p.designation.toLowerCase() === nom.toLowerCase())) {
      setOngletForm('general');
      setErreur('Un produit avec ce nom existe déjà.');
      return;
    }
    if (!unite.trim()) {
      setOngletForm('general');
      setErreur('Renseigne l’unité de base.');
      return;
    }
    /* un emballage de 1 unité serait l'unité elle-même */
    const emballagesValides = emballages.filter(c => c.nom.trim() && c.quantite > 1);
    if (emballages.length !== emballagesValides.length) {
      setOngletForm('emballages');
      setErreur(emballages.some(c => c.quantite === 1)
        ? `Un emballage doit contenir au moins 2 ${unite.trim() ? `${unite.toLowerCase()}s` : 'unités'}.`
        : 'Chaque emballage doit avoir un nom et une quantité.');
      return;
    }
    /* une caractéristique entièrement vide vient d'un clic par erreur : on l'ignore.
       À moitié remplie, c'est une saisie inachevée : on bloque. */
    const caracsNonVides = caracs.filter(c => c.nom.trim() || c.valeurs.length > 0);
    if (caracsNonVides.length !== caracsValides.length) {
      setOngletForm('caracteristiques');
      const sansNom = caracsNonVides.some(c => !c.nom.trim());
      setErreur(sansNom
        ? 'Une caractéristique a des choix mais pas de nom.'
        : 'Une caractéristique n’a aucun choix.');
      return;
    }
    if (caracsValides.length > 0 && variantesSaisie.length === 0) {
      setOngletForm('variantes');
      setErreur('Ajoute au moins une variante, ou retire les caractéristiques.');
      return;
    }
    /* Le produit naît dans l'activité, pas dans un site.
     *
     * La création exigeait pourtant un site, et la vue d'ensemble n'en
     * désigne aucun : le bouton y disparaissait, alors que c'est là que
     * l'on tient le catalogue de la maison. Le site ne sert en réalité
     * qu'au stock de départ et au prix d'origine — deux choses qu'une vue
     * d'ensemble n'a pas à poser. Sans site, le produit s'ouvre partout à
     * zéro, et chaque boutique y mettra le sien. */
    const site = ctx.siteEcriture ?? null;
    if (!activite?.id) {
      setErreur('Aucune activité : impossible de créer un produit.');
      return;
    }
    setErreur('');
    setSaving(true);

    const codeBarreProduit = genererCodeBarre();
    const coutProduit = parseMontant(coutAchat);
    const prixProduit = parseMontant(prixVente);

    const variantes: Variante[] = variantesSaisie.map(v => ({
      cle: cleVariante(v.selection, caracsValides),
      codeBarre: genererCodeBarre(),
      selection: v.selection,
      stock: enUnites(v.stock, v.stockEmb, emballagesValides),
      /* le coût saisi initialise la moyenne pondérée, à défaut celui du produit */
      coutMoyen: v.cout ? parseMontant(v.cout) : coutProduit,
      ...(v.prix ? { prixVente: parseMontant(v.prix) } : {}),
    }));

    /* Le produit appartient à l'activité, pas au site : une « Mangue »
       est la même marchandise partout, et c'est ce qui permet de savoir
       combien il en est entré et sorti sur l'ensemble de la maison. Ce que
       le site détient — stock, coût, prix, seuil — vit dans
       `produits_site`. */
    const data = {
      userId,
      activiteId: activite?.id ?? null,
      designation: nom,
      codeBarre: codeBarreProduit,
      categorie: categorie.trim() || null,
      unite: unite.trim(),
      emballages: emballagesValides,
      caracteristiques: caracsValides,
      /* Les variantes disent ce qui existe comme déclinaisons ; leur stock
         se compte site par site. */
      variantes: variantes.map((v: any) => ({
        cle: v.cle, selection: v.selection, libelle: v.libelle,
      })),
      actif: true,
      createdAt: serverTimestamp(),
    };
    const ref = await addDoc(collection(db, 'produits'), data);

    /* Il apparaît aussitôt dans l'inventaire de chaque site, à zéro : sans
       cette ligne, un site ne pourrait pas recevoir un transfert d'une
       marchandise qu'il n'a jamais achetée lui-même. */
    const tousLesSites = ctx.sites.length > 0
      ? ctx.sites.map(x => x.id)
      : (site ? [site] : []);
    await ouvrirPartout({
      produitId: ref.id, siteIds: tousLesSites, userId,
      ...(site ? { siteOrigine: site } : {}),
      prixOrigine: prixProduit,
      seuilOrigine: seuilAlerte
        ? enUnites(seuilAlerte, seuilEmballage, emballagesValides) : null,
      variantesOrigine: variantes.map((v: any) => ({
        cle: v.cle, stock: 0, coutMoyen: 0, prixVente: v.prixVente ?? null,
      })),
    });

    /* le stock de départ est une entrée : sans elle, l'historique n'expliquerait pas d'où il vient */
    /* Sans site, il n'y a pas de rayon où poser ce stock : le produit
       existe, chaque boutique y entrera le sien. */
    if (site) {
    const auteur = await auteurCourant(site, userId);
    await enregistrerStockInitial({
      siteId: site, userId, produitId: ref.id, date: new Date().toISOString().split('T')[0],
      utilisateurNom: auteur.utilisateurNom,
      utilisateurFonction: auteur.utilisateurFonction,
      lignes: aVariantes
        ? variantesSaisie.map(v => ({
            varianteCle: cleVariante(v.selection, caracsValides),
            quantite: parseMontant(v.stock),
            quantiteUnites: enUnites(v.stock, v.stockEmb, emballagesValides),
            emballage: v.stockEmb || null,
            cout: v.cout ? parseMontant(v.cout) : coutProduit,
          }))
        : [{
            quantite: parseMontant(stockInitial),
            quantiteUnites: enUnites(stockInitial, stockEmballage, emballagesValides),
            emballage: stockEmballage || null,
            cout: coutProduit,
          }],
    });
    }

    /* Le produit et sa détention s'écrivent en deux collections : les
       recoller à la main ici les ferait diverger au premier oubli. On
       relit, c'est la seule version juste. */
    await charger();
    if (categorie.trim() && !categories.includes(categorie.trim())) {
      setCategories(prev => [...prev, categorie.trim()].sort());
    }
    if (unite.trim() && !unites.includes(unite.trim())) {
      setUnites(prev => [...prev, unite.trim()].sort());
    }
    setSaving(false);
    setModalOuvert(false);
  }

  if (loading) return (
    <div className="min-h-64 flex items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const enStock = produits.filter(p => stockTotal(p) > 0);
  const valeurStock = enStock.reduce((s, p) => s + valeurCout(p), 0);
  const valeurVente = enStock.reduce((s, p) => s + valeurVenteProduit(p), 0);
  const beneficeEstime = valeurVente - valeurStock;
  const marge = valeurStock > 0 ? (beneficeEstime / valeurStock) * 100 : 0;

  const ruptures = produits.filter(p => stockTotal(p) <= 0).length;

  /* agrégats de rentabilité, tous produits confondus */
  /* Ce que pèse le stock d'un site : sa valeur au coût, ce qu'il
     rapporterait, et l'état de ses rayons. Un total dit combien vaut la
     maison, jamais quelle boutique est en rupture. */
  function chiffresDuSite(id: string) {
    const siens = produits.filter(x => x.siteId === id);
    const dispo = siens.filter(x => stockTotal(x) > 0);
    const cout = dispo.reduce((n, x) => n + valeurCout(x), 0);
    const vente = dispo.reduce((n, x) => n + valeurVenteProduit(x), 0);
    return {
      produits: siens.length,
      cout,
      benefice: vente - cout,
      marge: cout > 0 ? Math.round(((vente - cout) / cout) * 100) : 0,
      enStock: dispo.length,
      ruptures: siens.filter(x => stockTotal(x) <= 0).length,
      alertes: siens.filter(x => statutStock(x).label === 'Alerte').length,
    };
  }

  const totalEntrees = Object.values(bilans).reduce((s, b) => s + b.entrees, 0);
  const totalSorties = Object.values(bilans).reduce((s, b) => s + b.sorties, 0);
  const resultatReel = totalSorties - totalEntrees;
  const statuts = produits.map(p => {
    const b = bilans[p.id] ?? { entrees: 0, sorties: 0 };
    return statutRentabilite(b.entrees, b.sorties).label;
  });
  const nbBeneficiaires = statuts.filter(l => l === 'Bénéficiaire').length;

  const apercuPrix = parseMontant(prixVente);
  const apercuCout = parseMontant(coutAchat);

  /* recliquer la même colonne inverse le sens ; en changer repart du plus
     grand, qui est ce qu'on cherche presque toujours en premier */
  function basculerTri(col: TriStock) {
    if (triStock === col) setSensTri(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setTriStock(col); setSensTri('desc'); }
  }

  function basculerRenta(col: TriRenta) {
    if (triRenta === col) setSensTri(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setTriRenta(col); setSensTri('desc'); }
  }

  const produitsAffiches = produits.filter(p => {
    /* les filtres de stock ne s'appliquent pas à la vue rentabilité */
    if (vue === 'stock' && !filtreProduit(p, filtreStock)) return false;
    const q = recherche.trim().toLowerCase();
    if (!q) return true;
    return p.designation.toLowerCase().includes(q)
      || (p.categorie ?? '').toLowerCase().includes(q)
      || (p.codeBarre ?? '').includes(q)
      || (p.variantes ?? []).some(v => v.cle.toLowerCase().includes(q) || (v.codeBarre ?? '').includes(q));
  });

  /* le tri porte sur les colonnes chiffrées : comparer des montants à l'œil
     dans une longue liste est ce qui prend le plus de temps */
  const produitsTries = triStock === null ? produitsAffiches : [...produitsAffiches].sort((a, b) => {
    const v = (x: Produit) =>
      triStock === 'cout' ? x.coutMoyen
      : triStock === 'prix' ? x.prixVente
      : triStock === 'stock' ? stockTotal(x)
      : triStock === 'benefice' ? valeurVenteProduit(x) - valeurCout(x)
      : valeurCout(x);
    return (sensTri === 'asc' ? 1 : -1) * (v(a) - v(b));
  });

  const produitsRenta = triRenta === null ? produitsAffiches : [...produitsAffiches].sort((a, b) => {
    const v = (x: Produit) => {
      const bl = bilans[x.id] ?? { entrees: 0, sorties: 0 };
      return triRenta === 'entrees' ? bl.entrees
        : triRenta === 'sorties' ? bl.sorties
        : triRenta === 'difference' ? bl.sorties - bl.entrees
        : triRenta === 'enStock' ? valeurCout(x)
        : triRenta === 'derniereEntree' ? anciennete(bl.derniereEntree)
        : anciennete(bl.derniereSortie);
    };
    return (sensTri === 'asc' ? 1 : -1) * (v(a) - v(b));
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'hidden'}>{titre}</p>
        <div className="flex flex-wrap items-center gap-2">
        {/* Le total dit ce que vaut la maison, jamais quelle boutique est
            en rupture. */}
        <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
        {/* Le filtre porte sur tout l'écran, cartes de valeur comprises. */}
        <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {/* Stock ou rentabilité : deux lectures de la page entière, cartes
          de tête comprises. Le choix se pose donc au-dessus d'elles, et non
          dans l'en-tête où il se mêlait à la portée. */}
      {!ctx.parSite && (
        <div className="mb-3 flex w-fit items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
          {([
            { key: 'stock' as const,       label: 'Stock' },
            { key: 'rentabilite' as const, label: 'Rentabilité' },
          ]).map(v => (
            <button key={v.key} onClick={() => setVue(v.key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${vue === v.key
                ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                : 'text-gray-400 dark:text-gray-500'}`}>
              {v.label}
            </button>
          ))}
        </div>
      )}

      {/* Cartes d'information : le modèle de fond sans l'indigo, qui ne
          signifie rien ici puisqu'il n'y a pas de carte à choisir. */}
      {ctx.parSite ? (
        /* Une carte par site : ce que vaut son stock, et l'état de ses
           rayons. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          return {
            titre: 'Valeur du stock',
            valeur: formatMontant(c.cout),
            dort: c.produits === 0,
            badge: c.produits > 0
              ? {
                  texte: `${c.produits} produit${c.produits > 1 ? 's' : ''}`,
                  ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                }
              : null,
            lignes: [
              { label: `Bénéfice estimé · ${c.marge} %`,
                valeur: formatMontant(c.benefice),
                vide: c.benefice === 0, ton: 'text-green-600' },
              { label: 'En stock', valeur: String(c.enStock), vide: c.enStock === 0 },
              { label: 'Alerte', valeur: String(c.alertes),
                vide: c.alertes === 0, ton: 'text-orange-500' },
              { label: 'Rupture', valeur: String(c.ruptures),
                vide: c.ruptures === 0, ton: 'text-red-500' },
            ],
          };
        }} />
      ) : (
      <>
      {vue === 'stock' ? (
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
          <div className="flex items-start justify-between gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
              📦
            </span>
            <span className="shrink-0 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-bold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              {produits.length} produit{produits.length > 1 ? 's' : ''}
            </span>
          </div>
          <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
            Valeur du stock
          </p>
          <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight text-neutral-900 dark:text-white`}>
            {formatMontant(valeurStock)}
          </p>
          <p className="mt-1 text-[11px] font-medium text-neutral-400">Au coût d&apos;achat</p>
          <div className="mt-2.5 flex justify-between gap-2 border-t border-black/[0.06] pt-2 text-xs dark:border-white/10">
            <span className="flex items-baseline gap-1.5">
              <span className="text-neutral-400">En stock</span>
              <span className="font-bold text-neutral-900 dark:text-white">{enStock.length}</span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="text-neutral-400">Rupture</span>
              <span className={`font-bold ${ruptures > 0 ? 'text-red-500' : 'text-neutral-900 dark:text-white'}`}>
                {ruptures}
              </span>
            </span>
          </div>
        </div>

        <div className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
          <div className="flex items-start justify-between gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
              📈
            </span>
            {valeurStock > 0 && (
              <span className="shrink-0 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-bold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                {marge.toFixed(0)} % de marge
              </span>
            )}
          </div>
          <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
            Bénéfice estimé
          </p>
          <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight ${beneficeEstime < 0
            ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
            {formatMontant(beneficeEstime)}
          </p>
          <p className="mt-1 text-[11px] font-medium text-neutral-400">Si tout le stock est vendu</p>
          {/* Le coût du stock est déjà la carte voisine : le répéter ici ne
              dit rien de plus. Reste ce que la carte apporte — ce que tout
              ce stock rapporterait une fois vendu. */}
          <div className="mt-2.5 flex justify-between gap-2 border-t border-black/[0.06] pt-2 text-xs dark:border-white/10">
            <span className="flex items-baseline gap-1.5">
              <span className="text-neutral-400">Vente</span>
              <span className="font-bold text-neutral-900 dark:text-white">{formatMontant(valeurVente)}</span>
            </span>
          </div>
        </div>
      </div>
      ) : (
      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {([
          { emoji: '📥', label: 'Entrées', montant: formatMontant(totalEntrees),
            note: 'Coût investi', classe: 'text-neutral-900 dark:text-white' },
          { emoji: '📤', label: 'Sorties', montant: formatMontant(totalSorties),
            note: 'Récupéré', classe: 'text-neutral-900 dark:text-white' },
          { emoji: '⚖️', label: 'Différence',
            montant: `${resultatReel >= 0 ? '+' : '−'}${formatMontant(Math.abs(resultatReel))}`,
            note: `${nbBeneficiaires} rentable${nbBeneficiaires > 1 ? 's' : ''}`,
            classe: resultatReel >= 0 ? 'text-green-600' : 'text-red-500' },
          { emoji: '📦', label: 'Valeur du stock', montant: formatMontant(valeurStock),
            note: `${enStock.length} en stock`, classe: 'text-neutral-900 dark:text-white' },
        ]).map(c => (
          <div key={c.label}
            className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-neutral-100 text-lg dark:bg-neutral-800">
              {c.emoji}
            </span>
            <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-neutral-400">
              {c.label}
            </p>
            <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight ${c.classe}`}>
              {c.montant}
            </p>
            <p className="mt-1 text-[11px] font-medium text-neutral-400">{c.note}</p>
          </div>
        ))}
      </div>
      )}

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        <p className="mb-4 text-sm font-bold text-gray-900 dark:text-gray-100">Produits</p>

        {produits.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            <ChampRecherche placeholder="Rechercher un produit, une catégorie, un code…" valeur={recherche} onChange={setRecherche} className="flex-1 min-w-[200px]" />
            {/* Quatre états du stock, groupés comme partout ailleurs : des
                boutons isolés se lisaient comme quatre actions, non comme
                un choix unique. */}
            {vue === 'stock' && (
              <div className="flex items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
                <Filter size={13} className="ml-1 mr-0.5 text-gray-400" />
                {([
                  { key: 'tous' as const,    label: 'Tous' },
                  { key: 'en_stock' as const, label: 'En stock' },
                  { key: 'alerte' as const,   label: 'Alerte' },
                  { key: 'rupture' as const,  label: 'Rupture' },
                ]).map(f => {
                  const n = produits.filter(p => filtreProduit(p, f.key)).length;
                  return (
                    <button key={f.key} onClick={() => setFiltreStock(f.key)}
                      className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${filtreStock === f.key
                        ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                        : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
                      {f.label} ({n})
                    </button>
                  );
                })}
              </div>
            )}
            {/* Le catalogue d'essai : visible tant que le rayon est vide,
                puisqu'il ne sert qu'à garnir une activité neuve. */}
            {produits.length === 0 && activite?.id && (
              <button onClick={reprendreCatalogue} disabled={reprise}
                className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
                {reprise ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                Charger les produits
              </button>
            )}
            {/* Le produit appartient à la maison : on le crée aussi depuis
                la vue d'ensemble, où se tient le catalogue. */}
            {(ctx.siteEcriture || ctx.ensemble) && (
              <button onClick={ouvrirModal}
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
                <Plus size={12} /> Nouveau produit
              </button>
            )}
          </div>
        )}

        {repriseFaite && (
          <p className="mb-3 rounded-xl bg-gray-50 p-2.5 text-[12px] text-gray-600 dark:bg-gray-800/50 dark:text-gray-300">
            {repriseFaite}
          </p>
        )}

        {/* Rayon vide : le bouton reste, c'est par lui qu'on le garnit.
            Enfermé dans la ligne de recherche — qui n'existe qu'une fois
            des produits saisis — il rendait le premier impossible. */}
        {produits.length === 0 && (ctx.siteEcriture || ctx.ensemble) && (
          <div className="mb-4 flex flex-wrap gap-2">
            {activite?.id && (
              <button onClick={reprendreCatalogue} disabled={reprise}
                className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
                {reprise ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                Charger les produits
              </button>
            )}
            <button onClick={ouvrirModal}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
              <Plus size={12} /> Nouveau produit
            </button>
          </div>
        )}

        {produitsAffiches.length === 0
          ? <p className="text-xs text-gray-400 text-center py-8">
              {produits.length === 0 ? 'Aucun produit enregistré sur ce site.' : 'Aucun résultat.'}
            </p>
          : (
            <>
              <p className="text-xs text-gray-400 mb-2">
                {produitsAffiches.length} produit{produitsAffiches.length > 1 ? 's' : ''}
              </p>
              {vue === 'stock' && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="text-center px-3 py-2.5 font-medium">Produit</th>
                      {ctx.ensemble && <th className="text-center px-3 py-2.5 font-medium">Site</th>}
                      <th className="text-center px-3 py-2.5 font-medium">Catégorie</th>
                      {([
                        { cle: 'cout' as const,     label: 'Coût' },
                        { cle: 'prix' as const,     label: 'Prix' },
                        { cle: 'stock' as const,    label: 'Stock' },
                        { cle: 'benefice' as const, label: 'Bénéfice' },
                        { cle: 'valeur' as const,   label: 'Valeur' },
                      ]).map(c => (
                        <th key={c.cle} className="px-3 py-2.5 font-medium">
                          <button onClick={() => basculerTri(c.cle)}
                            className="w-full flex items-center justify-center gap-1 hover:opacity-80 transition-opacity">
                            {c.label}
                            <ArrowUpDown size={12} className={triStock === c.cle ? 'opacity-100' : 'opacity-40'} />
                          </button>
                        </th>
                      ))}
                      <th className="text-center px-3 py-2.5 font-medium">Statut</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {produitsTries.map(p => {
                      const stock = stockTotal(p);
                      const s = statutStock(p);
                      const beneficeProduit = valeurVenteProduit(p) - valeurCout(p);
                      return (
                        <tr key={p.id}
                          onClick={() => router.push(
                            `/site/${p.siteId ?? ctx.siteEcriture}/inventaire/${p.id}${ctx.ensemble ? '?de=ensemble' : ''}`)}
                          className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{p.designation}</td>
                          {ctx.ensemble && <CelluleSite nom={ctx.nomDe(p.siteId)} />}
                          <td className="px-3 py-2.5 text-gray-500 text-center">{p.categorie || '—'}</td>
                          <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{p.coutMoyen > 0 ? formatMontant(p.coutMoyen) : '—'}</td>
                          <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 font-medium text-center">{p.prixVente > 0 ? formatMontant(p.prixVente) : '—'}</td>
                          <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">
                            {stock.toLocaleString('fr-FR')} <span className="text-xs text-gray-400">{p.unite.toLowerCase()}{stock > 1 ? 's' : ''}</span>
                          </td>
                          <td className={`px-3 py-2.5 font-medium ${beneficeProduit > 0 ? 'text-green-600' : beneficeProduit < 0 ? 'text-red-500' : 'text-gray-400'} text-center`}>
                            {stock > 0 ? formatMontant(beneficeProduit) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 font-medium text-center">{formatMontant(valeurCout(p))}</td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.color}`}>{s.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}

              {vue === 'rentabilite' && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="text-center px-3 py-2.5 font-medium">Produit</th>
                      {ctx.ensemble && <th className="text-center px-3 py-2.5 font-medium">Site</th>}
                      {([
                        { cle: 'entrees' as const,        label: "Coût d'entrée" },
                        { cle: 'sorties' as const,        label: 'Valeur de sortie' },
                        { cle: 'difference' as const,     label: 'Différence' },
                        { cle: 'enStock' as const,        label: 'Valeur en stock' },
                        { cle: 'derniereEntree' as const, label: 'Dernière entrée' },
                        { cle: 'derniereSortie' as const, label: 'Dernière sortie' },
                      ]).map(c => (
                        <th key={c.cle} className="px-3 py-2.5 font-medium">
                          <button onClick={() => basculerRenta(c.cle)}
                            className="w-full flex items-center justify-center gap-1 hover:opacity-80 transition-opacity">
                            {c.label}
                            <ArrowUpDown size={12} className={triRenta === c.cle ? 'opacity-100' : 'opacity-40'} />
                          </button>
                        </th>
                      ))}
                      <th className="text-center px-3 py-2.5 font-medium">Statut</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {produitsRenta.map(p => {
                      const b = bilans[p.id] ?? { entrees: 0, sorties: 0 };
                      const diff = b.sorties - b.entrees;
                      const enStock = valeurCout(p);
                      const st = statutRentabilite(b.entrees, b.sorties);

                      return (
                        <tr key={p.id}
                          onClick={() => router.push(
                            `/site/${p.siteId ?? ctx.siteEcriture}/inventaire/${p.id}${ctx.ensemble ? '?de=ensemble' : ''}`)}
                          className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{p.designation}</td>
                          {ctx.ensemble && <CelluleSite nom={ctx.nomDe(p.siteId)} />}
                          <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{b.entrees > 0 ? formatMontant(b.entrees) : '—'}</td>
                          <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">{b.sorties > 0 ? formatMontant(b.sorties) : '—'}</td>
                          <td className={`px-3 py-2.5 font-medium ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-500' : 'text-gray-400'} text-center`}>
                            {b.entrees > 0 || b.sorties > 0 ? formatMontant(diff) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 font-medium text-center">{formatMontant(enStock)}</td>
                          {/* l'ancienneté plutôt que la date : c'est la durée qui se juge */}
                          <td className={`px-3 py-2.5 text-center ${b.derniereEntree ? 'text-gray-500' : 'text-gray-300 dark:text-gray-600'}`}>
                            {libelleJours(b.derniereEntree)}
                          </td>
                          <td className={`px-3 py-2.5 text-center ${b.derniereSortie ? 'text-gray-500' : 'text-gray-300 dark:text-gray-600'}`}>
                            {libelleJours(b.derniereSortie)}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${st.color}`}>{st.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}
            </>
          )
        }
      </div>
      </>
      )}

      {/* Modal nouveau produit */}
      {modalOuvert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-2xl shadow-xl p-5 flex flex-col h-[560px] max-h-[85vh] min-h-0">
            <div className="flex items-center justify-between mb-5 shrink-0">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouveau produit</h2>
              <button onClick={() => setModalOuvert(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>

            <div className="flex border-b border-gray-100 dark:border-gray-800 mb-4 shrink-0">
              {ongletsForm.map(o => {
                const badge = o.key === 'emballages' ? emballages.length
                  : o.key === 'caracteristiques' ? caracs.filter(c => c.nom.trim()).length
                  : o.key === 'variantes' ? variantesSaisie.length
                  : 0;
                return (
                  <button key={o.key} type="button" onClick={() => setOngletForm(o.key)}
                    className={`px-3 py-2 text-xs font-semibold transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${ongletCourant === o.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                    {o.label}
                    {badge > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full text-xs font-bold bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">{badge}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="overflow-y-scroll flex-1 min-h-0 pr-1">
              {ongletCourant === 'general' && (
                <>
                  <p className="text-xs font-bold text-gray-400 uppercase mb-1">Désignation <span className="text-red-400">*</span></p>
                  <input type="text" placeholder="Ex. Savon Madar 400g" value={designation}
                    onChange={e => { setDesignation(e.target.value); setErreur(''); }}
                    className={`w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${erreur ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />

                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-bold text-gray-400 uppercase">Catégorie</p>
                    <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                      {(['existant', 'nouveau'] as const).map(m => (
                        <button key={m} type="button"
                          disabled={m === 'existant' && categories.length === 0}
                          onClick={() => { setModeCategorie(m); setCategorie(''); }}
                          className={`px-2.5 py-1 text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${modeCategorie === m ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-indigo-600'}`}>
                          {m === 'existant' ? 'Existante' : 'Nouvelle'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {modeCategorie === 'existant'
                    ? <select value={categorie} onChange={e => setCategorie(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                        <option value="">Choisir…</option>
                        {categories.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    : <input type="text" placeholder="Ex. Hygiène, Boisson…" value={categorie}
                        onChange={e => setCategorie(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500" />}

                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-bold text-gray-400 uppercase">Unité de base</p>
                    <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                      {(['existant', 'nouveau'] as const).map(m => (
                        <button key={m} type="button"
                          disabled={m === 'existant' && unites.length === 0}
                          onClick={() => { setModeUnite(m); setUnite(''); }}
                          className={`px-2.5 py-1 text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${modeUnite === m ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-indigo-600'}`}>
                          {m === 'existant' ? 'Existante' : 'Nouvelle'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {modeUnite === 'existant'
                    ? <select value={unite} onChange={e => setUnite(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                        <option value="">Choisir…</option>
                        {unites.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    : <input type="text" placeholder="Ex. Pièce, Kg, Litre…" value={unite}
                        onChange={e => setUnite(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500" />}
                  <p className="text-xs text-gray-400 mb-4">Le stock est toujours compté dans cette unité.</p>

                  <p className="text-xs font-bold text-gray-400 uppercase mb-1">Seuil d&apos;alerte</p>
                  <SaisieStock quantite={seuilAlerte} emballage={seuilEmballage} emballages={emballagesUtiles}
                    unite={unite} onQuantite={setSeuilAlerte} onEmballage={setSeuilEmballage} />
                  {emballagesUtiles.length > 0 && seuilEmballage && seuilAlerte && (
                    <p className="text-xs text-gray-400 mt-1">
                      Soit <span className="font-bold text-gray-600 dark:text-gray-300">{enUnites(seuilAlerte, seuilEmballage, emballagesUtiles)}</span> {unite.trim() ? unite.toLowerCase() : 'unité'}s.
                    </p>
                  )}

                  <p className="text-xs text-gray-400 mt-4">
                    Un code-barres est généré automatiquement pour le produit
                    {aVariantes ? ' et pour chacune de ses variantes' : ''}.
                  </p>
                </>
              )}

              {ongletCourant === 'tarifs' && (
                <>
                  <div className="flex gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-gray-400 uppercase mb-1">Coût d&apos;achat</p>
                      <input type="number" placeholder="Ex. 500" value={coutAchat} onChange={e => setCoutAchat(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-gray-400 uppercase mb-1">Prix de vente</p>
                      <input type="number" placeholder="Ex. 750" value={prixVente} onChange={e => setPrixVente(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </div>
                    {/* Un stock se pose dans un rayon : sans site désigné,
                        demander une quantité promettrait une entrée qui
                        n'aurait nulle part où s'écrire. */}
                    {!aVariantes && ctx.siteEcriture && (
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-gray-400 uppercase mb-1">Stock initial</p>
                        <SaisieStock quantite={stockInitial} emballage={stockEmballage} emballages={emballagesUtiles}
                          unite={unite} onQuantite={setStockInitial} onEmballage={setStockEmballage} />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3 mt-1">
                    {apercuCout > 0 && apercuPrix > 0 && (
                      <p className="text-xs text-gray-400">
                        Marge de <span className="font-bold text-green-600">{formatMontant(apercuPrix - apercuCout)}</span> par {unite.trim() ? unite.toLowerCase() : 'unité'}
                        {' '}({(((apercuPrix - apercuCout) / apercuCout) * 100).toFixed(0)} %).
                      </p>
                    )}
                    {!aVariantes && emballagesUtiles.length > 0 && stockEmballage && (
                      <p className="text-xs text-gray-400">
                        Soit <span className="font-bold text-gray-600 dark:text-gray-300">{enUnites(stockInitial, stockEmballage, emballagesUtiles)}</span> {unite.trim() ? unite.toLowerCase() : 'unité'}s.
                      </p>
                    )}
                  </div>

                  {aVariantes && (
                    <div className="mt-4">
                      <p className="text-xs font-bold text-gray-400 uppercase mb-1">Stock initial</p>
                      <p className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400">
                        {variantesSaisie.reduce((s, v) => s + enUnites(v.stock, v.stockEmb, emballagesUtiles), 0)} {unite.trim() ? unite.toLowerCase() : 'unité'}s — somme des variantes
                      </p>
                    </div>
                  )}

                  {aVariantes && (
                    <div className="mt-5 pt-4 border-t border-gray-100 dark:border-gray-800">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-bold text-gray-400 uppercase">
                          Tarifs par variante {tarifsVariantes.length > 0 && <span className="font-normal normal-case">({tarifsVariantes.length})</span>}
                        </p>
                        {tarifsVariantes.length < variantesSaisie.length && (
                          <button type="button" onClick={() => setModalTarifVariante(true)}
                            className="flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700">
                            <Plus size={12} /> Ajouter une variante
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mb-3">
                        Uniquement les variantes dont les valeurs diffèrent du produit.
                      </p>

                      {tarifsVariantes.length === 0
                        ? <p className="text-xs text-gray-400 text-center py-4">Toutes les variantes suivent le produit.</p>
                        : (
                          <>
                            <div className="flex gap-2 mb-1">
                              <p className="flex-1 min-w-0 text-xs font-bold text-gray-400 uppercase">Variante</p>
                              <p className="w-24 shrink-0 text-xs font-bold text-gray-400 uppercase">Coût</p>
                              <p className="w-24 shrink-0 text-xs font-bold text-gray-400 uppercase">Prix</p>
                              {emballagesUtiles.length > 0 && <p className="w-24 shrink-0 text-xs font-bold text-gray-400 uppercase">Unité</p>}
                              <p className="w-20 shrink-0 text-xs font-bold text-gray-400 uppercase">Stock</p>
                              <span className="w-8 shrink-0" />
                            </div>
                            {tarifsVariantes.map(({ v, index }) => (
                              <div key={index} className="flex gap-2 items-center mb-2">
                                <p className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {cleVariante(v.selection, caracsValides)}
                                </p>
                                <input type="number" placeholder={apercuCout > 0 ? String(apercuCout) : '—'} value={v.cout}
                                  onChange={e => setVariantesSaisie(prev => prev.map((x, j) => j === index ? { ...x, cout: e.target.value } : x))}
                                  className="w-24 shrink-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                                <input type="number" placeholder={apercuPrix > 0 ? String(apercuPrix) : '—'} value={v.prix}
                                  onChange={e => setVariantesSaisie(prev => prev.map((x, j) => j === index ? { ...x, prix: e.target.value } : x))}
                                  className="w-24 shrink-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                                {emballagesUtiles.length > 0 && (
                                  <select value={v.stockEmb}
                                    onChange={e => setVariantesSaisie(prev => prev.map((x, j) => j === index ? { ...x, stockEmb: e.target.value } : x))}
                                    className="w-24 shrink-0 px-2 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                                    <option value="">{unite.trim() ? unite.toLowerCase() : 'unité'}</option>
                                    {emballagesUtiles.map(e => <option key={e.nom} value={e.nom}>{e.nom}</option>)}
                                  </select>
                                )}
                                <input type="number" min={0} placeholder="0" value={v.stock}
                                  onChange={e => setVariantesSaisie(prev => prev.map((x, j) => j === index ? { ...x, stock: e.target.value } : x))}
                                  className="w-20 shrink-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                                <button type="button"
                                  onClick={() => setVariantesSaisie(prev => prev.map((x, j) => j === index ? { ...x, stock: '', stockEmb: '', cout: '', prix: '' } : x))}
                                  className="w-8 shrink-0 p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            ))}
                            <p className="text-xs text-gray-400 mt-2">Champs vides = valeurs du produit.</p>
                          </>
                        )
                      }
                    </div>
                  )}
                </>
              )}

              {ongletCourant === 'emballages' && (
                <>
                  <p className="text-xs text-gray-400 mb-3">
                    Emballages exprimés en {unite.trim() ? `${unite.toLowerCase()}s` : 'unités'}. Ex. Carton = 12 {unite.trim() ? `${unite.toLowerCase()}s` : 'unités'}.
                  </p>
                  {emballages.length === 0
                    ? <p className="text-xs text-gray-400 text-center py-6">Aucun emballage.</p>
                    : (
                      <div className="flex gap-2 mb-1">
                        <p className="flex-1 min-w-0 text-xs font-bold text-gray-400 uppercase">Nom</p>
                        <p className="w-32 shrink-0 text-xs font-bold text-gray-400 uppercase">Quantité</p>
                        <p className="w-40 shrink-0 text-xs font-bold text-gray-400 uppercase text-right">Prix</p>
                        <span className="w-8 shrink-0" />
                      </div>
                    )
                  }
                  {emballages.map((c, i) => (
                    <div key={i} className="mb-2">
                    <div className="flex gap-2 items-start">
                      <input type="text" placeholder="Ex. Carton" value={c.nom}
                        onChange={e => { setEmballages(prev => prev.map((x, j) => j === i ? { ...x, nom: e.target.value } : x)); setErreur(''); }}
                        className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                      <input type="number" min={2} placeholder="Ex. 12" value={c.quantite || ''}
                        onChange={e => { setEmballages(prev => prev.map((x, j) => j === i ? { ...x, quantite: parseMontant(e.target.value) } : x)); setErreur(''); }}
                        className={`w-32 shrink-0 px-3 py-2 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${c.quantite === 1 ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
                      <p className="w-40 shrink-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400 text-right whitespace-nowrap overflow-hidden text-ellipsis">
                        {apercuPrix > 0 && c.quantite > 1 ? formatMontant(apercuPrix * c.quantite) : '—'}
                      </p>
                      <button type="button" onClick={() => setEmballages(prev => prev.filter((_, j) => j !== i))}
                        className="w-8 shrink-0 p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {c.quantite === 1 && (
                      <p className="text-xs text-red-500 mt-1">
                        Un emballage de 1 {unite.trim() ? unite.toLowerCase() : 'unité'}, c&apos;est l&apos;unité elle-même.
                      </p>
                    )}
                    </div>
                  ))}
                  <button type="button" onClick={() => setEmballages(prev => [...prev, { nom: '', quantite: 0 }])}
                    className="flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700 mt-1">
                    <Plus size={12} /> Ajouter un emballage
                  </button>
                  {emballages.length > 0 && <p className="text-xs text-gray-400 mt-3">Le prix suit le prix unitaire × la quantité.</p>}
                </>
              )}

              {ongletCourant === 'caracteristiques' && (
                <>
                  <p className="text-xs text-gray-400 mb-3">
                    Ce qui fait varier le produit — couleur, taille… — et les choix de chacune.
                  </p>
                  {caracs.length === 0 && <p className="text-xs text-gray-400 text-center py-4">Aucune caractéristique.</p>}
                  {caracs.map((carac, i) => {
                    const nomRempli = !!carac.nom.trim();
                    const saisie = (saisieValeur[i] ?? '').trim();
                    const doublon = !!saisie && carac.valeurs.some(v => v.toLowerCase() === saisie.toLowerCase());
                    const ajouterValeur = () => {
                      if (!saisie || !nomRempli || doublon) return;
                      setCaracs(prev => prev.map((x, j) => j === i ? { ...x, valeurs: [...x.valeurs, saisie] } : x));
                      setSaisieValeur(prev => ({ ...prev, [i]: '' }));
                      setErreur('');
                    };
                    return (
                      <div key={i} className="rounded-xl border border-gray-100 dark:border-gray-800 p-3 mb-2">
                        <div className="flex gap-2 mb-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom</p>
                            <input type="text" placeholder="Ex. Couleur" value={carac.nom}
                              onChange={e => { setCaracs(prev => prev.map((x, j) => j === i ? { ...x, nom: e.target.value } : x)); setErreur(''); }}
                              className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                          </div>
                          <button type="button"
                            onClick={() => {
                              const nom = carac.nom.trim();
                              setCaracs(prev => prev.filter((_, j) => j !== i));
                              /* les variantes qui s'appuyaient dessus perdent ce critère */
                              if (nom) setVariantesSaisie(prev => prev.map(v => {
                                const { [nom]: _, ...reste } = v.selection;
                                return { ...v, selection: reste };
                              }).filter(v => Object.keys(v.selection).length > 0));
                            }}
                            className="p-2 mt-5 shrink-0 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                            <Trash2 size={12} />
                          </button>
                        </div>

                        <p className="text-xs font-bold text-gray-400 uppercase mb-1">
                          Choix {carac.valeurs.length > 0 && <span className="font-normal normal-case text-gray-400">({carac.valeurs.length})</span>}
                        </p>
                        <div className="flex gap-2">
                          <input type="text" disabled={!nomRempli}
                            placeholder={nomRempli ? 'Ex. Rouge' : 'Renseigne d’abord le nom'}
                            value={saisieValeur[i] ?? ''}
                            onChange={e => setSaisieValeur(prev => ({ ...prev, [i]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); ajouterValeur(); } }}
                            className={`flex-1 min-w-0 px-3 py-2 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:cursor-not-allowed ${doublon ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
                          <button type="button" onClick={ajouterValeur} disabled={!saisie || !nomRempli || doublon}
                            className="px-3 py-2 shrink-0 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold transition-colors">
                            Ajouter
                          </button>
                        </div>
                        {doublon && <p className="text-xs text-red-500 mt-1">« {saisie} » est déjà dans la liste.</p>}
                        {carac.valeurs.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {carac.valeurs.map(v => (
                              <span key={v} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                                {v}
                                <button type="button"
                                  onClick={() => {
                                    const nom = carac.nom.trim();
                                    setCaracs(prev => prev.map((x, j) => j === i ? { ...x, valeurs: x.valeurs.filter(y => y !== v) } : x));
                                    /* on retire le choix des variantes qui l'utilisaient */
                                    if (nom) setVariantesSaisie(prev => prev.map(va => {
                                      if (va.selection[nom] !== v) return va;
                                      const { [nom]: _, ...reste } = va.selection;
                                      return { ...va, selection: reste };
                                    }).filter(va => Object.keys(va.selection).length > 0));
                                  }}
                                  className="hover:text-red-500"><X size={10} /></button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <button type="button" onClick={() => setCaracs(prev => [...prev, { nom: '', valeurs: [] }])}
                    className="flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700 mt-1">
                    <Plus size={12} /> Ajouter une caractéristique
                  </button>

                </>
              )}

              {ongletCourant === 'variantes' && (
                <>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-bold text-gray-400 uppercase">
                          Variantes {variantesSaisie.length > 0 && <span className="font-normal normal-case">({variantesSaisie.length})</span>}
                        </p>
                        {saisieVariantesRequise && (
                          <button type="button"
                            onClick={() => { setSelectionEnCours({}); setErreurVariante(''); setModalVariante(true); }}
                            className="flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700">
                            <Plus size={12} /> Ajouter une variante
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mb-3">
                        {saisieVariantesRequise
                          ? `Avec ${caracsValides.length} caractéristiques, l’app ne peut pas deviner les combinaisons vendues : ajoute-les.`
                          : `Déduites de « ${caracsValides[0]?.nom} ».`}
                      </p>

                      {variantesSaisie.length === 0
                        ? <p className="text-xs text-gray-400 text-center py-4">Aucune variante — le produit ne peut pas être créé sans.</p>
                        : (
                          <div className="flex flex-wrap gap-2">
                            {variantesSaisie.map((v, i) => (
                              <span key={i} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm font-medium text-gray-900 dark:text-gray-100">
                                {cleVariante(v.selection, caracsValides)}
                                {saisieVariantesRequise && (
                                  <button type="button" onClick={() => setVariantesSaisie(prev => prev.filter((_, j) => j !== i))}
                                    className="text-gray-400 hover:text-red-500 transition-colors">
                                    <X size={12} />
                                  </button>
                                )}
                              </span>
                            ))}
                          </div>
                        )
                      }
                    </div>
                </>
              )}

              {erreur && <p className="text-xs text-red-500 mb-3">{erreur}</p>}
            </div>

            <div className="flex gap-3 shrink-0 pt-4">
              <button onClick={() => setModalOuvert(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
              <button onClick={ajouterProduit} disabled={saving || !designation.trim() || !unite.trim() || (caracsValides.length > 0 && variantesSaisie.length === 0)}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal choix d'une variante */}
      {modalVariante && (() => {
        const choisies = Object.entries(selectionEnCours).filter(([, v]) => v);
        const selectionNette = Object.fromEntries(choisies);
        const doublon = variantesSaisie.some(v => memeSelection(v.selection, selectionNette));
        const valide = choisies.length > 0 && !doublon;
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouvelle variante</h2>
                <button onClick={() => setModalVariante(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
              <p className="text-xs text-gray-400 mb-4">
                Clique les choix qui composent cette variante. Ne sélectionne rien pour une caractéristique qui ne la concerne pas.
              </p>

              {caracsValides.map(carac => (
                <div key={carac.nom} className="mb-3">
                  <p className="text-xs font-bold text-gray-400 uppercase mb-1.5">{carac.nom}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {carac.valeurs.map(v => {
                      const actif = selectionEnCours[carac.nom] === v;
                      return (
                        <button key={v} type="button"
                          onClick={() => {
                            /* recliquer désélectionne : la caractéristique ne concerne plus cette variante */
                            setSelectionEnCours(prev => ({ ...prev, [carac.nom]: actif ? '' : v }));
                            setErreurVariante('');
                          }}
                          className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${actif
                            ? 'bg-indigo-600 border-indigo-600 text-white'
                            : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-indigo-300'}`}>
                          {v}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {choisies.length > 0 && (
                <p className="text-xs text-gray-400 mb-1">
                  Variante : <span className="font-bold text-indigo-600">{cleVariante(selectionNette, caracsValides)}</span>
                </p>
              )}
              {doublon && <p className="text-xs text-red-500 mb-1">Cette variante existe déjà.</p>}
              {erreurVariante && <p className="text-xs text-red-500 mb-1">{erreurVariante}</p>}

              <div className="flex gap-3 mt-4">
                <button onClick={() => setModalVariante(false)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
                <button disabled={!valide}
                  onClick={() => {
                    if (!valide) return;
                    setVariantesSaisie(prev => [...prev, { selection: selectionNette, stock: '', stockEmb: '', cout: '', prix: '' }]);
                    setModalVariante(false);
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                  <Check size={14} /> Ajouter
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal choix d'une variante à tarifer */}
      {modalTarifVariante && (() => {
        const sansTarif = variantesSaisie
          .map((v, index) => ({ v, index }))
          .filter(({ v }) => !v.stock && !v.cout && !v.prix);
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5 flex flex-col max-h-[70vh] min-h-0">
              <div className="flex items-center justify-between mb-4 shrink-0">
                <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Quelle variante ?</h2>
                <button onClick={() => setModalTarifVariante(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
              </div>
              <p className="text-xs text-gray-400 mb-3 shrink-0">
                Choisis la variante à laquelle donner un stock, un coût ou un prix.
              </p>
              <div className="overflow-y-auto flex-1 min-h-0 flex flex-wrap gap-2 content-start">
                {sansTarif.map(({ v, index }) => (
                  <button key={index} type="button"
                    onClick={() => {
                      /* un stock à 0 suffit à la faire apparaître dans la liste des tarifs */
                      setVariantesSaisie(prev => prev.map((x, j) => j === index ? { ...x, stock: '0' } : x));
                      setModalTarifVariante(false);
                    }}
                    className="px-3 py-1.5 rounded-xl border border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-600 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 transition-colors">
                    {cleVariante(v.selection, caracsValides)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
