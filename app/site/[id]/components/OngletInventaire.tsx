'use client';
import { useAuth } from '@/lib/auth-context';
import { useCallback, useEffect, useState } from 'react';
import {
  collection, query, where, getDocs, addDoc, doc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useRouter, useSearchParams } from 'next/navigation';
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
/* Le conditionnement vient de `lib/mouvements` : le redéclarer ici
   laissait les deux diverger, et c'est ce qui est arrivé quand il a
   gagné son lien aux déclinaisons. */
import { nomDejaPris, type Emballage } from '@/lib/mouvements';

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
type TriStock = 'cout' | 'prix' | 'marche' | 'stock' | 'benefice' | 'valeur' | null;
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

/**
 * Ce que dit un stock, face à son seuil.
 *
 * Travaille sur un nombre et non sur un produit : une déclinaison a son
 * propre stock, et c'est elle qu'on veut juger. Le produit entier passe
 * par `statutStock`, qui lui somme ses variantes.
 */
function statutDuStock(
  stock: number, seuil?: number | null,
): { label: string; color: string } {
  if (stock <= 0) return { label: 'Rupture', color: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' };
  if (seuil != null && stock <= seuil)
    return { label: 'Alerte', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' };
  return { label: 'En stock', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
}

function statutStock(p: Produit): { label: string; color: string } {
  return statutDuStock(stockTotal(p), p.seuilAlerte);
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

/**
 * Ranger un produit dans une catégorie, depuis cette catégorie.
 *
 * On cherche par le nom. Si le produit appartient déjà à un autre rayon,
 * on le dit avant de bouger quoi que ce soit : le déplacer le retirera de
 * là-bas, et c'est précisément ce qu'on veut savoir avant de cliquer.
 *
 * Une catégorie à la fois — un produit rangé dans deux rayons serait
 * compté deux fois dans ce que pèse chacun.
 */
function AjoutDansCategorie({ categorie, produits, onClasser }: {
  categorie: string;
  produits: Produit[];
  onClasser: (produitId: string, categorie: string | null) => Promise<void>;
}) {
  const [recherche, setRecherche] = useState('');
  const [enCours, setEnCours] = useState<string | null>(null);

  const q = recherche.trim().toLowerCase();
  /* Ceux qui ne sont pas déjà ici : les proposer n'aurait rien à faire
     bouger. */
  const candidats = q
    ? produits
        .filter(p => ((p.categorie ?? '').trim() || '') !== categorie)
        .filter(p => p.designation.toLowerCase().includes(q))
        .slice(0, 6)
    : [];

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <div className="relative">
        <input type="text" value={recherche}
          onChange={e => setRecherche(e.target.value)}
          placeholder={`Ranger un produit dans « ${categorie} »…`}
          className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

        {q && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
            {candidats.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-gray-400">
                Aucun produit à ranger ici.
              </p>
            ) : candidats.map(p => {
              const ailleurs = (p.categorie ?? '').trim();
              return (
                <button key={p.id} type="button"
                  disabled={enCours !== null}
                  onClick={async () => {
                    setEnCours(p.id);
                    try {
                      await onClasser(p.id, categorie);
                      setRecherche('');
                    } finally { setEnCours(null); }
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-indigo-50 disabled:opacity-50 dark:hover:bg-indigo-900/30">
                  <span className="min-w-0 truncate text-gray-900 dark:text-gray-100">
                    {p.designation}
                  </span>
                  {/* Là où il est aujourd'hui. Le ranger ici l'en
                      retirera — le dire avant vaut mieux que de le
                      découvrir après. */}
                  {enCours === p.id ? (
                    <Loader2 size={12} className="shrink-0 animate-spin text-indigo-500" />
                  ) : ailleurs ? (
                    <span className="shrink-0 text-[11px] text-orange-500">
                      déjà dans « {ailleurs} »
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-gray-400">
                      sans catégorie
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function OngletInventaire({ siteId, userId, sites, titre }: Props) {
  const ctx = useSites(siteId, sites);
  /* Vers quel site ouvrir la fiche d'un produit.
   *
   * Le produit appartient à l'activité depuis la migration : il ne porte
   * plus de site. `siteEcriture` ne répond que lorsqu'il n'y en a qu'un,
   * et vaut `null` en vue d'ensemble — l'adresse devenait « /site/null ».
   * À plusieurs, on ouvre sur le site dont on regarde l'inventaire. */
  const siteOuvert = ctx.siteEcriture
    ?? (Array.isArray(siteId) ? siteId[0] : siteId);
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
  const searchParams = useSearchParams();
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
  /* Stock ou Rentabilité : deux lectures de la même marchandise, et
     celle qu'on regardait doit survivre au rafraîchissement. */
  const [vue, setVueEtat] = useState<'stock' | 'rentabilite'>(
    searchParams.get('rubrique') === 'rentabilite' ? 'rentabilite' : 'stock');
  /* Comment on regarde le rayon.
   *
   * Par produit : la liste, une ligne par référence. Par déclinaison :
   * chaque 10W et chaque 30W sur sa propre ligne — c'est là que se lit un
   * stock qui dort sur une seule taille. Par catégorie : ce que pèse
   * chaque rayon, et ce qu'on y range.
   *
   * Trois questions différentes sur la même marchandise : les mêler dans
   * un seul tableau obligerait à retrier à l'œil. */
  /* La vue choisie vit dans l'adresse, pas seulement en mémoire.
     Sans cela, ouvrir un produit depuis « Déclinaisons » et revenir
     ramenait sur « Produits » : le retour rouvre la page, et la page
     repartait de son état par défaut. */
  const groupeInitial = (searchParams.get('groupe') === 'variante'
    || searchParams.get('groupe') === 'categorie')
    ? searchParams.get('groupe') as 'variante' | 'categorie'
    : 'produit';
  const [groupe, setGroupe] = useState<'produit' | 'variante' | 'categorie'>(
    groupeInitial);
  /* La catégorie ouverte, quand on veut voir ce qu'elle contient. */
  const [categorieOuverte, setCategorieOuverte] = useState<string | null>(null);

  /* L'état mène le rendu, l'adresse le conserve.
   *
   * `replaceState` plutôt que le routeur : changer d'onglet n'est pas une
   * navigation — on ne veut ni rechargement, ni une entrée d'historique
   * par clic, qui obligerait à appuyer dix fois sur Retour pour sortir de
   * la page. Et `replaceState` ne prévient pas React : c'est l'état local
   * qui rend, l'adresse ne fait que s'en souvenir.
   *
   * Une valeur par défaut ne s'écrit pas : une adresse nue vaut déjà
   * « Stock » et « Produits ». */
  const inscrireDansUrl = useCallback((cle: string, valeur: string | null) => {
    const q = new URLSearchParams(window.location.search);
    if (valeur) q.set(cle, valeur); else q.delete(cle);
    const suite = q.toString();
    window.history.replaceState(null, '',
      suite ? `${window.location.pathname}?${suite}` : window.location.pathname);
  }, []);

  const setVue = useCallback((v: 'stock' | 'rentabilite') => {
    setVueEtat(v);
    inscrireDansUrl('rubrique', v === 'rentabilite' ? v : null);
  }, [inscrireDansUrl]);

  const choisirGroupe = useCallback((g: 'produit' | 'variante' | 'categorie') => {
    setGroupe(g);
    /* Changer de regroupement referme la catégorie ouverte : elle
       n'appartenait qu'à l'ancienne vue. */
    setCategorieOuverte(null);
    inscrireDansUrl('groupe', g === 'produit' ? null : g);
  }, [inscrireDansUrl]);
  /* par produit : ce qui est entré, ce qui est sorti, et quand pour la dernière fois */
  /* Chaque sens porte la part dont le coût était inconnu.
     À l'entrée : de la marchandise reçue sans qu'on sache ce qu'elle a
     coûté — elle gonfle la quantité sans gonfler la valeur.
     À la sortie : vendue depuis un rayon au coût inconnu — l'argent
     rentre, mais aucune entrée ne lui répond.
     Sans les nommer, les deux chiffres se lisent de travers : l'un
     paraît trop petit, l'autre trop rentable. */
  const [bilans, setBilans] = useState<Record<string, { entrees: number; qteEntreeSansCout: number; sorties: number; sortiesSansCout: number; derniereEntree?: string; derniereSortie?: string }>>({});

  /* modal nouveau produit */
  const [modalOuvert, setModalOuvert] = useState(false);
  const [designation, setDesignation] = useState('');
  const [categorie, setCategorie] = useState('');
  const [modeCategorie, setModeCategorie] = useState<'existant' | 'nouveau'>('existant');
  const [unite, setUnite] = useState('');
  const [modeUnite, setModeUnite] = useState<'existant' | 'nouveau'>('existant');
  /* Les prix pratiqués site par site : c'est le marché, un fait qui ne
     dépend pas de nous et qui diffère d'un endroit à l'autre. */
  const [prixMarche, setPrixMarche] =
    useState<Record<string, { siteId: string; prix: number }[]>>({});
  /* Les détentions, gardées telles quelles : ce sont elles qui
     nomment leur site, et les cartes par site en ont besoin. */
  const [detentions, setDetentions] = useState<ProduitSite[]>([]);
  const [prixVente, setPrixVente] = useState('');
  /* Ce qui se pratique autour, quand on le connaît. Facultatif : un
     produit neuf n'a pas encore de marché. */
  const [prixMarcheSaisi, setPrixMarcheSaisi] = useState('');
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
    const agg: Record<string, { entrees: number; qteEntreeSansCout: number; sorties: number; sortiesSansCout: number; derniereEntree?: string; derniereSortie?: string }> = {};
    mvSnap.forEach(d => {
      const m = d.data();
      if (m.motif === 'transfert') return;
      const b = agg[m.produitId]
        ?? { entrees: 0, qteEntreeSansCout: 0, sorties: 0, sortiesSansCout: 0 };
      /* Les deux drapeaux sont posés à l'écriture du mouvement, pas
         devinés ici : `coutInconnu` sur une entrée reçue sans valeur,
         `margeInconnue` sur une sortie prise à un rayon qui n'en avait
         pas. On ne fait que les additionner. */
      if (m.sens === 'entree') {
        b.entrees += m.valeurTotale ?? 0;
        /* Une entrée sans coût vaut zéro — c'est précisément ce qu'on
           lui reproche. L'additionner en valeur ne dirait rien ; c'est
           sa quantité qui témoigne de ce qui est entré sans prix. */
        if (m.coutInconnu) b.qteEntreeSansCout += m.quantiteUnites ?? m.quantite ?? 0;
        if (!b.derniereEntree || m.date > b.derniereEntree) b.derniereEntree = m.date;
      }
      else {
        b.sorties += m.valeurTotale ?? 0;
        if (m.margeInconnue) b.sortiesSansCout += m.valeurTotale ?? 0;
        if (m.motif === 'vente' && (!b.derniereSortie || m.date > b.derniereSortie)) b.derniereSortie = m.date;
      }
      agg[m.produitId] = b;
    });
    setBilans(agg);
    setDetentions(dets);

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

    /* Ce que chaque site pratique, déclinaison par déclinaison. Le prix
       du marché ne se calcule pas : il se constate là où l'on vend, et
       deux boutiques ne vendent pas au même prix. On garde donc la liste
       plutôt qu'une moyenne — un prix moyen n'est pratiqué nulle part. */
    const marche: Record<string, { siteId: string; prix: number }[]> = {};
    for (const d of dets) {
      const noter = (cle: string, prix: number) => {
        if (!(prix > 0)) return;
        (marche[cle] ??= []).push({ siteId: d.siteId, prix });
      };
      /* Le marché relevé, et lui seul. Le prix qu'on pratique est une
         décision : le lire comme un prix de marché ferait passer notre
         propre choix pour une contrainte extérieure. */
      noter(d.produitId, d.prixMarche ?? 0);
      for (const v of (d.variantes ?? [])) {
        noter(`${d.produitId}:${v.cle}`, v.prixMarche ?? d.prixMarche ?? 0);
      }
    }
    for (const k of Object.keys(marche)) marche[k].sort((a, b) => a.prix - b.prix);
    setPrixMarche(marche);

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

  /**
   * Ouvrir le formulaire, éventuellement dans un rayon donné.
   *
   * Créer depuis une catégorie la préremplit : on sait déjà où le produit
   * va, c'est même pour cela qu'on a ouvert ce rayon. La ressaisir
   * laisserait le produit tomber ailleurs sur une faute de frappe.
   */
  function ouvrirModal(dansCategorie?: string) {
    const rayon = dansCategorie ?? '';
    setDesignation(''); setCategorie(rayon); setUnite('');
    /* rien à choisir dans une liste vide : on ouvre directement en saisie */
    setModeCategorie(categories.length > 0 ? 'existant' : 'nouveau');
    setModeUnite(unites.length > 0 ? 'existant' : 'nouveau');
    setPrixVente(''); setPrixMarcheSaisi(''); setCoutAchat(''); setStockInitial(''); setStockEmballage(''); setSeuilAlerte(''); setSeuilEmballage('');
    setEmballages([]); setCaracs([]); setSaisieValeur({}); setVariantesSaisie([]);
    setModalVariante(false); setSelectionEnCours({}); setErreurVariante('');
    setOngletForm('general');
    setErreur('');
    setModalOuvert(true);
  }

  const emballagesUtiles = emballages.filter(e => e.nom.trim() && e.quantite > 1);
  const caracsValides = caracs.filter(c => c.nom.trim() && c.valeurs.length > 0);
  /* une variante n'apparaît dans Tarifs que si elle a reçu au moins une valeur */
  /* Les déclinaisons en cours de saisie, sous la forme qu'elles auront
     une fois écrites. Un conditionnement peut s'y rattacher avant même
     que le produit existe — c'est le moment où l'on sait qu'un carton de
     10W n'en contient pas le même nombre qu'un carton de 30W. */
  const clesVariantes = variantesSaisie
    .map(v => cleVariante(v.selection, caracs.filter(c => c.nom.trim())))
    .filter(Boolean);

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
    const emballagesValides = emballages
      .filter(c => c.nom.trim() && c.quantite > 1)
      /* Une liste vide veut dire « toutes les déclinaisons » : l'écrire
         quand même ferait un champ qui ne dit rien, et les produits
         existants n'en ont pas. */
      .map(c => ((c.variantes?.length ?? 0) > 0
        ? { nom: c.nom.trim(), quantite: c.quantite, variantes: c.variantes }
        : { nom: c.nom.trim(), quantite: c.quantite }));
    if (emballages.length !== emballagesValides.length) {
      setOngletForm('emballages');
      setErreur(emballages.some(c => c.quantite === 1)
        ? `Un emballage doit contenir au moins 2 ${unite.trim() ? `${unite.toLowerCase()}s` : 'unités'}.`
        : 'Chaque emballage doit avoir un nom et une quantité.');
      return;
    }

    /* Deux conditionnements de même nom ne peuvent pas se rencontrer sur
       une même déclinaison : le vendeur ne saurait pas lequel il tient.
       Ils le peuvent s'ils ne se croisent jamais — « Carton » vaut dix
       pièces pour le 10W et six pour le 30W. */
    for (let i = 0; i < emballagesValides.length; i++) {
      const avant = emballagesValides.slice(0, i);
      const e = emballagesValides[i];
      if (nomDejaPris(avant, e.nom, (e as any).variantes)) {
        setOngletForm('emballages');
        setErreur(clesVariantes.length > 0
          ? `« ${e.nom} » est déjà pris pour ces déclinaisons.`
          : `« ${e.nom} » existe déjà.`);
        return;
      }
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
    /* Un coût laissé vide n'est pas un coût nul : le produit entre en
       rayon sans qu'on sache ce qu'il a coûté, et c'est le premier achat
       qui le posera. Écrire zéro le ferait passer pour gratuit, et toute
       vente compterait en bénéfice le prix entier. */
    const coutIgnore = coutProduit <= 0;

    const variantes: Variante[] = variantesSaisie.map(v => ({
      cle: cleVariante(v.selection, caracsValides),
      codeBarre: genererCodeBarre(),
      selection: v.selection,
      stock: enUnites(v.stock, v.stockEmb, emballagesValides),
      /* le coût saisi initialise la moyenne pondérée, à défaut celui du produit */
      coutMoyen: v.cout ? parseMontant(v.cout) : coutProduit,
      /* Une déclinaison sans coût propre hérite de l'ignorance du
         produit : ni la sienne ni celle du produit ne dit ce qu'elle a
         coûté. */
      ...(v.cout ? {} : coutIgnore ? { coutInconnu: true } : {}),
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
      /* Le rayon naît dans l'ignorance si aucun coût n'a été saisi : le
         premier achat le posera. */
      coutOrigineInconnu: coutIgnore,
      prixOrigine: prixProduit,
      marcheOrigine: parseMontant(prixMarcheSaisi) || null,
      seuilOrigine: seuilAlerte
        ? enUnites(seuilAlerte, seuilEmballage, emballagesValides) : null,
      variantesOrigine: variantes.map((v: any) => ({
        cle: v.cle, stock: 0, coutMoyen: 0,
        coutInconnu: !!v.coutInconnu,
        prixVente: v.prixVente ?? null,
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
            ...(v.cout ? {} : coutIgnore ? { coutInconnu: true } : {}),
          }))
        : [{
            quantite: parseMontant(stockInitial),
            quantiteUnites: enUnites(stockInitial, stockEmballage, emballagesValides),
            emballage: stockEmballage || null,
            cout: coutProduit,
            ...(coutIgnore ? { coutInconnu: true } : {}),
          }],
    });
    }

    /* Le produit et sa détention s'écrivent en deux collections : les
       recoller à la main ici les ferait diverger au premier oubli. On
       relit, c'est la seule version juste. */
    await charger();
    /* Le test se fait dans le setter, pas avant.
     *
     * `charger()` vient de reconstruire ces listes depuis les produits
     * relus : la catégorie qu'on ajoute y est déjà. Mais `categories`,
     * capturé au moment du rendu, tient encore la liste d'avant — le
     * test passait, et la même catégorie s'inscrivait deux fois. Dans le
     * setter, `prev` est la liste à jour. */
    if (categorie.trim()) {
      setCategories(prev => (prev.includes(categorie.trim())
        ? prev : [...prev, categorie.trim()].sort()));
    }
    if (unite.trim()) {
      setUnites(prev => (prev.includes(unite.trim())
        ? prev : [...prev, unite.trim()].sort()));
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
  /* Un bénéfice se mesure contre un coût.
   *
   * À la reprise, le stock entre sans qu'on sache ce qu'il a coûté. La
   * soustraction rendrait alors le prix de vente entier, et l'écran
   * annoncerait comme gain ce qui n'est qu'un chiffre d'affaires.
   *
   * Le bénéfice ne se calcule donc que sur les produits valorisés, et
   * l'écran dit combien ils sont. Mêler les autres ferait un chiffre
   * qui n'est ni l'un ni l'autre : plus faux à mesure que le stock non
   * valorisé pèse lourd. */
  const valorises = enStock.filter(p => valeurCout(p) > 0);
  const valeurStockVal = valorises.reduce((s, p) => s + valeurCout(p), 0);
  const valeurVenteVal = valorises.reduce(
    (s, p) => s + valeurVenteProduit(p), 0);
  const beneficeEstime = valeurVenteVal - valeurStockVal;
  const marge = valeurStockVal > 0
    ? (beneficeEstime / valeurStockVal) * 100 : 0;
  const coutConnu = valorises.length > 0;
  /* Tous valorisés : le compte n'apprend rien, on ne l'écrit pas. */
  const partiel = coutConnu && valorises.length < enStock.length;

  const ruptures = produits.filter(p => stockTotal(p) <= 0).length;

  /* agrégats de rentabilité, tous produits confondus */
  /* Ce que pèse le stock d'un site : sa valeur au coût, ce qu'il
     rapporterait, et l'état de ses rayons. Un total dit combien vaut la
     maison, jamais quelle boutique est en rupture. */
  /* Ce que porte un site, lu sur ses détentions.
   *
   * On filtrait les produits sur leur `siteId` — un champ qui ne vaut que
   * pour les produits détenus sur un seul site, et qui reste vide dès
   * qu'il y en a deux. Un dépôt plein s'affichait alors « Aucune activité
   * sur la période » : ses produits existaient, aucun ne lui était
   * rattaché.
   *
   * La détention, elle, nomme toujours son site. C'est elle qui porte le
   * stock, le coût moyen et le prix de ce rayon-là : deux boutiques ne
   * détiennent pas le même stock du même produit, et leurs cartes ne
   * doivent pas afficher le même chiffre. */
  function chiffresDuSite(id: string) {
    const siennes = detentions.filter(x => x.siteId === id);
    const parProduit = new Map(produits.map(p => [p.id, p]));

    let cout = 0;
    let vente = 0;
    /* Ce qui est en rayon sans qu'on sache ce qu'il a coûté, compté au
       prix recommandé. */
    let sansCout = 0;
    let nbSansCout = 0;
    let enStock = 0;
    let ruptures = 0;
    let alertes = 0;

    for (const det of siennes) {
      const p = parProduit.get(det.produitId);
      if (!p) continue;
      /* Le stock du site, variantes comprises : la détention les porte
         séparément quand le produit en a. */
      const st = (det.variantes ?? []).length > 0
        ? (det.variantes ?? []).reduce((n, v) => n + (v.stock ?? 0), 0)
        : (det.stock ?? 0);

      if (st > 0) {
        enStock += 1;
        const prix = det.prixVente ?? p.prixVente ?? 0;
        const c = det.coutMoyen ?? 0;
        /* Un rayon qui ignore ce qu'il a payé vaut quand même quelque
           chose : il est plein. Faute de coût, on le compte au prix
           recommandé — c'est le seul chiffre dont on dispose, et le
           laisser à zéro faisait disparaître du stock bien réel de la
           valeur totale. La part ainsi comptée se dit en dessous : on ne
           la confond pas avec ce qu'on a mesuré. */
        if (c > 0) {
          cout += st * c;
          /* Seules les ventes adossées à un coût entrent dans le
             bénéfice : mêler les autres rendrait leur prix de vente
             entier comme gain. */
          vente += st * prix;
        } else {
          sansCout += st * prix;
          nbSansCout += 1;
        }
      } else {
        ruptures += 1;
      }
      const seuil = det.seuilAlerte ?? p.seuilAlerte;
      if (st > 0 && seuil != null && st <= seuil) alertes += 1;
    }

    /* La valeur du stock : ce qu'on a mesuré, plus ce qu'on estime.
       Les deux s'additionnent — le rayon est plein des deux côtés — mais
       la carte dit laquelle est estimée. */
    const valeur = cout + sansCout;
    return {
      produits: siennes.length,
      valeur,
      sansCout,
      nbSansCout,
      cout,
      benefice: vente - cout,
      marge: cout > 0 ? Math.round(((vente - cout) / cout) * 100) : 0,
      vente,
      enStock,
      ruptures,
      alertes,
    };
  }

  const totalEntrees = Object.values(bilans).reduce((s, b) => s + b.entrees, 0);
  const totalSorties = Object.values(bilans).reduce((s, b) => s + b.sorties, 0);
  /* Ce dont le coût manquait, de chaque côté. La différence n'en est pas
     corrigée — elle reste ce qu'elle est — mais sans ces chiffres, des
     entrées maigres face à des sorties massives se lisent comme une marge
     entière, là où c'est seulement le coût qui manque. */
  const qteEntreeSansCout = Object.values(bilans).reduce((s, b) => s + b.qteEntreeSansCout, 0);
  const nbProduitsSansCout = Object.values(bilans).filter(b => b.qteEntreeSansCout > 0).length;
  const sortiesSansCout = Object.values(bilans).reduce((s, b) => s + b.sortiesSansCout, 0);

  /* Ce que vaut ce qui est entré sans coût, pris au prix de vente.
   *
   * Un stock initial entre en quantité sans valeur : la somme des
   * mouvements le compte pour zéro, et la carte restait à « 0 FCFA »
   * sous 80 000 unités bien présentes. Le prix de vente est le seul
   * chiffre qu'on ait sur cette marchandise — il surestime le coût,
   * puisqu'il porte la marge, mais il dit un ordre de grandeur là où
   * zéro ne disait rien du tout.
   *
   * Il reste séparé du coût constaté, et n'entre pas dans la
   * différence : mêler un prix à des coûts ferait un total que rien ne
   * vérifie. La carte additionne les deux pour l'œil, et dit sous le
   * chiffre quelle part est estimée. */
  const parProduitPrix = new Map(produits.map(p => [p.id, p.prixVente ?? 0]));
  const entreesEstimees = Object.entries(bilans).reduce((s, [id, b]) =>
    s + b.qteEntreeSansCout * (parProduitPrix.get(id) ?? 0), 0);
  /* Ce que la carte montre : le coût réellement constaté, plus
     l'estimation de ce qui n'en avait pas. */
  const entreesAffichees = totalEntrees + entreesEstimees;

  /* La différence se prend sur ce que la carte des entrées affiche.
   *
   * Elle se calculait sur le seul coût constaté, ce qui se tenait tant
   * que les entrées montraient zéro : les deux chiffres disaient la même
   * ignorance. Maintenant que la carte valorise ce qui n'avait pas de
   * coût, garder l'ancien calcul donnait deux cartes voisines qui se
   * contredisent — des entrées à plusieurs millions, et une différence
   * qui les compte encore pour rien, donc entièrement bénéficiaire.
   *
   * Elle vaut donc ce qu'on voit : sorties moins entrées affichées. Le
   * résultat porte l'approximation de son estimé, et la carte des
   * entrées dit laquelle. */
  const resultatReel = totalSorties - entreesAffichees;
  const statuts = produits.map(p => {
    const b = bilans[p.id] ?? { entrees: 0, qteEntreeSansCout: 0, sorties: 0, sortiesSansCout: 0 };
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

  /**
   * Changer la catégorie d'un produit.
   *
   * Un produit n'appartient qu'à un rayon : le ranger ici le retire de
   * là-bas, sans geste supplémentaire. `null` le laisse sans catégorie —
   * ce n'est pas une suppression, c'est une absence de rangement.
   *
   * La catégorie vit sur le produit, donc sur l'activité : un article
   * rangé dans « Électricité » l'est pour toutes les boutiques de la
   * maison.
   */
  async function classer(produitId: string, categorie: string | null) {
    await updateDoc(doc(db, 'produits', produitId), {
      categorie: categorie?.trim() || null,
    });
    await charger();
    if (categorie?.trim()) {
      setCategories(c => (c.includes(categorie.trim()) ? c : [...c, categorie.trim()]));
    }
  }

  const produitsAffiches = produits.filter(p => {
    /* les filtres de stock ne s'appliquent pas à la vue rentabilité */
    if (vue === 'stock' && !filtreProduit(p, filtreStock)) return false;
    const q = recherche.trim().toLowerCase();
    if (!q) return true;
    /* On cherche sur le nom tel qu'il s'affiche, variante comprise :
       « rallonge usb 4t 10w » ne se trouvait pas, parce que le nom et la
       variante étaient testés séparément — et aucun des deux ne porte la
       phrase entière.

       Les mots se cherchent un à un et dans n'importe quel ordre : on
       tape ce dont on se souvient, pas le libellé exact. */
    const mots = q.split(/\s+/).filter(Boolean);
    const contient = (texte: string) =>
      mots.every(m => texte.includes(m));

    const base = `${p.designation} ${p.categorie ?? ''}`.toLowerCase();
    if (contient(base)) return true;
    if ((p.codeBarre ?? '').includes(q)) return true;
    return (p.variantes ?? []).some(v =>
      contient(`${base} ${v.cle}`.toLowerCase())
      || (v.codeBarre ?? '').includes(q));
  });

  /**
   * Une ligne par déclinaison.
   *
   * Le tableau par produit additionne les stocks : « 400 pièces » sans
   * dire que 380 sont du 10W et 20 du 30W. C'est pourtant là que se
   * décide un rachat — une taille qui dort et une autre en rupture se
   * lisent pareil quand on les additionne.
   *
   * Un produit sans déclinaison reste une ligne : il n'a rien à détailler.
   */
  const lignesVariantesBrutes = produitsAffiches.flatMap(p => {
    const vs = p.variantes ?? [];
    if (vs.length === 0) {
      return [{
        cle: p.id, produit: p, varianteCle: null as string | null,
        stock: stockTotal(p), coutMoyen: p.coutMoyen,
        prixVente: p.prixVente,
      }];
    }
    /* La recherche retient le produit dès qu'une de ses variantes
       correspond : ici on ne garde que celles qui répondent vraiment.
       Chercher « 10W » ne doit pas ramener le 30W avec. */
    const q = recherche.trim().toLowerCase();
    const mots = q.split(/\s+/).filter(Boolean);
    const gardees = mots.length === 0 ? vs : vs.filter(v => {
      const nom = `${p.designation} ${p.categorie ?? ''} ${v.cle}`.toLowerCase();
      return mots.every(m => nom.includes(m))
        || (v.codeBarre ?? '').includes(q)
        || (p.codeBarre ?? '').includes(q);
    });

    return (gardees.length > 0 ? gardees : vs).map(v => ({
      cle: `${p.id}:${v.cle}`, produit: p, varianteCle: v.cle,
      stock: v.stock ?? 0,
      coutMoyen: v.coutMoyen ?? p.coutMoyen,
      prixVente: v.prixVente ?? p.prixVente,
    }));
  });

  /* Le statut d'une déclinaison : le seuil reste au produit, une
     déclinaison n'en a pas de propre. */
  const statutLigne = (l: typeof lignesVariantesBrutes[number]) =>
    statutDuStock(l.stock, l.varianteCle ? null : l.produit.seuilAlerte);

  /* Le même filtre que sur les produits, appliqué au stock de chaque
     déclinaison : c'est elle qui est en rupture, pas le produit entier. */
  const lignesFiltrees = lignesVariantesBrutes.filter(l => {
    if (filtreStock === 'tous') return true;
    const st = statutLigne(l).label;
    return filtreStock === 'rupture' ? st === 'Rupture'
      : filtreStock === 'alerte' ? st === 'Alerte'
      : st !== 'Rupture';
  });

  /* Comparer des montants à l'œil dans cent vingt-sept lignes est ce qui
     prend le plus de temps : le tri porte sur les colonnes chiffrées,
     comme sur la liste des produits. */
  /* Les prix pratiqués sur cette déclinaison, du plus bas au plus haut.
     Sans variante, c'est la détention du produit qui les porte. */
  const marcheDe = (x: { produit: { id: string }; varianteCle: string | null }) =>
    prixMarche[x.varianteCle ? `${x.produit.id}:${x.varianteCle}` : x.produit.id] ?? [];

  const lignesVariantes = triStock === null ? lignesFiltrees
    : [...lignesFiltrees].sort((a, b) => {
      const v = (x: typeof lignesFiltrees[number]) =>
        triStock === 'cout' ? x.coutMoyen
        : triStock === 'prix' ? x.prixVente
        /* On trie sur le haut de l'éventail : c'est le meilleur prix
           qu'on puisse espérer, donc le plus parlant pour comparer. */
        : triStock === 'marche' ? (marcheDe(x)[marcheDe(x).length - 1]?.prix ?? 0)
        : triStock === 'stock' ? x.stock
        : triStock === 'benefice' ? x.stock * (x.prixVente - x.coutMoyen)
        : x.stock * x.coutMoyen;
      return (sensTri === 'asc' ? 1 : -1) * (v(a) - v(b));
    });

  /**
   * Ce que pèse chaque rayon.
   *
   * Les produits sans catégorie se rassemblent sous « Sans catégorie » :
   * les cacher les rendrait introuvables, et c'est justement ceux-là
   * qu'on veut ranger.
   */
  const parCategorie = (() => {
    const m = new Map<string, Produit[]>();
    for (const p of produitsAffiches) {
      const c = (p.categorie ?? '').trim() || 'Sans catégorie';
      const l = m.get(c) ?? [];
      l.push(p);
      m.set(c, l);
    }
    return [...m.entries()]
      .map(([nom, liste]) => ({
        nom,
        liste,
        nb: liste.length,
        stock: liste.reduce((n, p) => n + stockTotal(p), 0),
        valeur: liste.reduce((n, p) => n + valeurCout(p), 0),
        vente: liste.reduce((n, p) => n + valeurVenteProduit(p), 0),
      }))
      /* La plus lourde d'abord : c'est celle qui décide du rayon.
         « Sans catégorie » ferme la marche — c'est une absence, pas un
         rayon. */
      .sort((a, b) => {
        if (a.nom === 'Sans catégorie') return 1;
        if (b.nom === 'Sans catégorie') return -1;
        return b.valeur - a.valeur;
      });
  })();

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
      const bl = bilans[x.id] ?? { entrees: 0, qteEntreeSansCout: 0, sorties: 0, sortiesSansCout: 0 };
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
            valeur: formatMontant(c.valeur),
            /* Sous la valeur elle-même, et non dans les lignes : c'est ce
               nombre-là qu'elle corrige. */
            mention: c.sansCout > 0
              ? (<>Dont <span className="font-bold text-orange-500">
                  {formatMontant(c.sansCout)}
                </span> au coût inconnu</>)
              : null,
            dort: c.produits === 0,
            badge: c.produits > 0
              ? {
                  texte: `${c.produits} produit${c.produits > 1 ? 's' : ''}`,
                  ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                }
              : null,
            lignes: [
              /* Sans coût connu, aucun bénéfice ne se mesure : un tiret
                 le dit, là où un montant mentirait. */
              { label: c.cout > 0 ? `Bénéfice estimé · ${c.marge} %` : 'Bénéfice estimé',
                valeur: c.cout > 0 ? formatMontant(c.benefice) : '—',
                vide: c.cout === 0 || c.benefice === 0,
                ton: c.cout > 0 ? 'text-green-600' : undefined },
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
          <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight ${coutConnu && beneficeEstime < 0
            ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
            {coutConnu ? formatMontant(beneficeEstime) : '—'}
          </p>
          <p className="mt-1 text-[11px] font-medium text-neutral-400">
            {partiel
              ? `Sur ${valorises.length} produits valorisés`
              : 'Si tout le stock est vendu'}
          </p>
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
          { emoji: '📥', label: 'Entrées', montant: formatMontant(entreesAffichees),
            note: 'Coût investi', classe: 'text-neutral-900 dark:text-white',
            /* Quelle part du chiffre est estimée. Le total mêle un coût
               constaté et un prix de vente pris faute de mieux : sans le
               dire, on lirait le tout comme du coût vérifié. */
            mention: entreesEstimees > 0
              ? (<>Dont <span className="font-bold text-orange-500">
                  {formatMontant(entreesEstimees)}
                </span> estimé{nbProduitsSansCout > 1 ? 's' : ''} au prix de vente,
                  coût inconnu</>)
              : null },
          { emoji: '📤', label: 'Sorties', montant: formatMontant(totalSorties),
            note: 'Récupéré', classe: 'text-neutral-900 dark:text-white',
            /* Ce qui est parti d'un rayon dont on ignorait le coût :
               l'argent est bien rentré, mais aucune entrée ne lui
               répond. Le dire ici évite qu'une sortie massive sans
               contrepartie passe pour une marge. */
            mention: sortiesSansCout > 0
              ? (<>Dont <span className="font-bold text-orange-500">
                  {formatMontant(sortiesSansCout)}
                </span> au coût inconnu</>)
              : null },
          { emoji: '⚖️', label: 'Différence',
            montant: `${resultatReel >= 0 ? '+' : '−'}${formatMontant(Math.abs(resultatReel))}`,
            note: `${nbBeneficiaires} rentable${nbBeneficiaires > 1 ? 's' : ''}`,
            classe: resultatReel >= 0 ? 'text-green-600' : 'text-red-500',
            mention: null },
          { emoji: '📦', label: 'Valeur du stock', montant: formatMontant(valeurStock),
            note: `${enStock.length} en stock`, classe: 'text-neutral-900 dark:text-white',
            mention: null },
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
            {c.mention && (
              <p className="mt-0.5 text-[11px] font-medium leading-snug text-neutral-400">
                {c.mention}
              </p>
            )}
          </div>
        ))}
      </div>
      )}

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        {/* Trois façons de lire le même rayon, au-dessus de tout le
            reste : c'est ce choix qui décide du contenu du tableau, donc
            de ce que la recherche et les filtres viendront affiner.

            Par produit : une ligne par référence.
            Par déclinaison : la liste devient exhaustive — chaque 10W et
            chaque 30W sur sa ligne, là où le produit les additionnait.
            Par catégorie : ce que pèse chaque rayon, et ce qu'on y range. */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Produits</p>
          {vue === 'stock' && produits.length > 0 && (
            <div className="flex items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
              {([
                { key: 'produit' as const,   label: 'Produits' },
                { key: 'variante' as const,  label: 'Déclinaisons' },
                { key: 'categorie' as const, label: 'Catégories' },
              ]).map(g => (
                <button key={g.key} onClick={() => choisirGroupe(g.key)}
                  className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${groupe === g.key
                    ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                    : 'text-gray-400 hover:text-gray-600 dark:text-gray-500'}`}>
                  {g.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {produits.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            <ChampRecherche placeholder="Rechercher un produit, une catégorie, un code…" valeur={recherche} onChange={setRecherche} className="flex-1 min-w-[200px]" />
            {/* Quatre états du stock, groupés comme partout ailleurs : des
                boutons isolés se lisaient comme quatre actions, non comme
                un choix unique. */}
            {vue === 'stock' && groupe !== 'categorie' && (
              <div className="flex items-center gap-0.5 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
                <Filter size={13} className="ml-1 mr-0.5 text-gray-400" />
                {([
                  { key: 'tous' as const,    label: 'Tous' },
                  { key: 'en_stock' as const, label: 'En stock' },
                  { key: 'alerte' as const,   label: 'Alerte' },
                  { key: 'rupture' as const,  label: 'Rupture' },
                ]).map(f => {
                  /* Le compte suit ce qu'on regarde : en déclinaisons,
                     c'est chaque taille qui est en rupture, pas le
                     produit qui les additionne. */
                  const n = groupe === 'variante'
                    ? lignesVariantesBrutes.filter(l => {
                        if (f.key === 'tous') return true;
                        const st = statutLigne(l).label;
                        return f.key === 'rupture' ? st === 'Rupture'
                          : f.key === 'alerte' ? st === 'Alerte'
                          : st !== 'Rupture';
                      }).length
                    : produits.filter(p => filtreProduit(p, f.key)).length;
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
                la vue d'ensemble, où se tient le catalogue.

                En vue catégories, chaque rayon porte son propre bouton —
                créer depuis là préremplit la catégorie, et un bouton
                général laisserait choisir au hasard ce qu'on venait
                justement de désigner. */}
            {(ctx.siteEcriture || ctx.ensemble) && groupe !== 'categorie' && (
              <button onClick={() => ouvrirModal()}
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
            <button onClick={() => ouvrirModal()}
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
                {vue === 'stock' && groupe === 'variante'
                  ? `${lignesVariantes.length} déclinaison${lignesVariantes.length > 1 ? 's' : ''}`
                  : vue === 'stock' && groupe === 'categorie'
                  ? `${parCategorie.length} catégorie${parCategorie.length > 1 ? 's' : ''}`
                  : `${produitsAffiches.length} produit${produitsAffiches.length > 1 ? 's' : ''}`}
              </p>

              {/* Une ligne par déclinaison : la liste devient exhaustive.
                  Le tableau par produit additionne les stocks — « 400
                  pièces » sans dire que 380 sont du 10W. Une taille qui
                  dort et une autre en rupture s'y lisaient pareil. */}
              {vue === 'stock' && groupe === 'variante' && (
                <div className="overflow-x-auto">
                  <table className="w-full whitespace-nowrap text-sm">
                    <thead>
                      <tr className="bg-indigo-600 text-white">
                        {/* La variante se lit dans le nom : une colonne
                            à part répétait ce que la ligne dit déjà, et
                            affichait un tiret partout où le produit n'en
                            a aucune. */}
                        <th className="px-3 py-2.5 text-center font-medium">Produit</th>
                        <th className="px-3 py-2.5 text-center font-medium">Catégorie</th>
                        {([
                          { cle: 'cout' as const,     label: 'Coût' },
                          { cle: 'prix' as const,     label: 'Prix recommandé' },
                          { cle: 'marche' as const,   label: 'Prix du marché' },
                          { cle: 'stock' as const,    label: 'Stock' },
                          { cle: 'benefice' as const, label: 'Bénéfice' },
                          { cle: 'valeur' as const,   label: 'Valeur' },
                        ]).map(c => (
                          <th key={c.cle} className="px-3 py-2.5 font-medium">
                            <button onClick={() => basculerTri(c.cle)}
                              className="flex w-full items-center justify-center gap-1 transition-opacity hover:opacity-80">
                              {c.label}
                              <ArrowUpDown size={12}
                                className={triStock === c.cle ? 'opacity-100' : 'opacity-40'} />
                            </button>
                          </th>
                        ))}
                        <th className="px-3 py-2.5 text-center font-medium">Statut</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {lignesVariantes.map(l => (
                        <tr key={l.cle}
                          onClick={() => router.push(`/site/${l.produit.siteId || siteOuvert}/inventaire/${l.produit.id}` + `?groupe=${groupe}`)}
                          className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          {/* Une ligne par article réellement vendable :
                              la variante se lit à côté du nom, en
                              pastille. C'est cette ligne-là qui porte un
                              coût, un prix et un stock — le produit qui
                              la contient n'en a aucun en propre. */}
                          <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">
                            {l.produit.designation}
                            {l.varianteCle && (
                              <span className="ml-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                                {l.varianteCle}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-center text-gray-500">
                            {l.produit.categorie || '—'}
                          </td>
                          <td className="px-3 py-2.5 text-center text-gray-500">
                            {formatMontant(l.coutMoyen)}
                          </td>
                          <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">
                            {formatMontant(l.prixVente)}
                          </td>
                          {/* Le marché est un fait, et il diffère d'un
                              endroit à l'autre : on montre l'éventail,
                              pas une moyenne que personne ne pratique.
                              Un seul prix pratiqué, un seul chiffre. */}
                          <td className="px-3 py-2.5 text-center">
                            {(() => {
                              const liste = marcheDe(l);
                              if (liste.length === 0) {
                                return <span className="text-gray-300 dark:text-gray-600">—</span>;
                              }
                              const bas = liste[0].prix;
                              const haut = liste[liste.length - 1].prix;
                              if (bas === haut) {
                                return (
                                  <span className="text-gray-600 dark:text-gray-300">
                                    {formatMontant(bas)}
                                  </span>
                                );
                              }
                              return (
                                <span className="inline-flex flex-col leading-tight">
                                  <span className="font-medium text-gray-900 dark:text-gray-100">
                                    {formatMontant(bas)} – {formatMontant(haut)}
                                  </span>
                                  <span className="text-[10px] text-gray-400">
                                    {liste.length} sites
                                  </span>
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={l.stock > 0
                              ? 'font-medium text-gray-900 dark:text-gray-100'
                              : 'text-red-500'}>
                              {l.stock.toLocaleString('fr-FR')}
                            </span>
                            <span className="ml-1 text-xs text-gray-400">
                              {l.produit.unite}
                            </span>
                          </td>
                          {/* Ce que cette déclinaison rapporterait si son
                              stock partait au prix affiché. Une taille
                              peut se vendre à perte pendant qu'une autre
                              gagne — le produit entier le cachait. */}
                          <td className="px-3 py-2.5 text-center">
                            {(() => {
                              /* Sans coût connu, la marge ne se calcule pas :
                                 le prix moins zéro serait le prix entier. */
                              const b = l.coutMoyen > 0
                                ? l.stock * (l.prixVente - l.coutMoyen) : null;
                              return (
                                <span className={b == null ? 'text-gray-300 dark:text-gray-600'
                                  : b > 0 ? 'font-medium text-green-600'
                                  : b < 0 ? 'font-medium text-red-500'
                                  : 'text-gray-300 dark:text-gray-600'}>
                                  {b == null ? '—' : formatMontant(b)}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2.5 text-center text-gray-500">
                            {l.coutMoyen > 0 ? formatMontant(l.stock * l.coutMoyen) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {(() => {
                              /* Le seuil vit sur le produit : une
                                 déclinaison n'en a pas de propre, et
                                 l'appliquer à chacune alerterait sur
                                 toutes dès que l'une descend. */
                              const st = statutDuStock(l.stock,
                                l.varianteCle ? null : l.produit.seuilAlerte);
                              return (
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${st.color}`}>
                                  {st.label}
                                </span>
                              );
                            })()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Ce que pèse chaque rayon. On l'ouvre pour voir ce qu'il
                  contient, et y ranger ce qui traîne ailleurs. */}
              {vue === 'stock' && groupe === 'categorie' && (
                <div className="space-y-2">
                  {parCategorie.map(c => {
                    const ouverte = categorieOuverte === c.nom;
                    return (
                      <div key={c.nom}
                        className="rounded-xl border border-gray-100 dark:border-gray-800">
                        <button type="button"
                          onClick={() => setCategorieOuverte(ouverte ? null : c.nom)}
                          className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <span className="flex min-w-0 items-center gap-2">
                            <ChevronDown size={14}
                              className={`shrink-0 text-gray-400 transition-transform ${ouverte ? '' : '-rotate-90'}`} />
                            <span className={`truncate font-bold ${c.nom === 'Sans catégorie'
                              ? 'text-gray-400'
                              : 'text-gray-900 dark:text-gray-100'}`}>
                              {c.nom}
                            </span>
                            <span className="shrink-0 text-xs text-gray-400">
                              {c.nb} produit{c.nb > 1 ? 's' : ''}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-4 text-xs">
                            <span className="text-gray-400">
                              {c.stock.toLocaleString('fr-FR')} en stock
                            </span>
                            <span className="font-bold text-gray-900 dark:text-gray-100">
                              {formatMontant(c.valeur)}
                            </span>
                          </span>
                        </button>

                        {ouverte && (
                          <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-800">
                            {/* Ranger passe avant la liste : sur un rayon
                                de quarante produits, le chercher en bas
                                demandait de faire défiler tout ce qu'on
                                ne cherchait pas. */}
                            {c.nom !== 'Sans catégorie' && (ctx.siteEcriture || ctx.ensemble) && (
                              <div className="mb-3">
                                <AjoutDansCategorie
                                  categorie={c.nom}
                                  produits={produits}
                                  onClasser={classer} />
                                {/* Créer directement dans ce rayon : la
                                    catégorie est déjà choisie, c'est pour
                                    elle qu'on est là. */}
                                <button type="button"
                                  onClick={() => ouvrirModal(c.nom)}
                                  className="mt-2 flex items-center gap-1.5 text-xs font-bold text-indigo-600 transition-colors hover:text-indigo-700">
                                  <Plus size={12} /> Nouveau produit dans « {c.nom} »
                                </button>
                              </div>
                            )}
                            <div className="space-y-1">
                              {c.liste.map(p => (
                                <div key={p.id}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                  <button type="button"
                                    onClick={() => router.push(`/site/${p.siteId || siteOuvert}/inventaire/${p.id}` + `?groupe=${groupe}`)}
                                    className="min-w-0 flex-1 truncate text-left text-gray-900 hover:text-indigo-600 dark:text-gray-100">
                                    {p.designation}
                                  </button>
                                  <span className="shrink-0 text-xs text-gray-400">
                                    {stockTotal(p).toLocaleString('fr-FR')} {p.unite}
                                  </span>
                                  {/* Retirer ne supprime rien : le produit
                                      quitte le rayon et rejoint « Sans
                                      catégorie », d'où on le rangera
                                      ailleurs. */}
                                  {c.nom !== 'Sans catégorie' && (ctx.siteEcriture || ctx.ensemble) && (
                                    <button type="button"
                                      onClick={() => classer(p.id, null)}
                                      title="Retirer de cette catégorie"
                                      className="shrink-0 rounded-lg p-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20">
                                      <X size={12} />
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>

                            {/* Ranger un produit ici. S'il appartient déjà
                                à un autre rayon, on le dit : le déplacer
                                le retire de là-bas, et c'est ce qu'on
                                veut savoir avant de le faire. */}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {vue === 'stock' && groupe === 'produit' && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="text-center px-3 py-2.5 font-medium">Produit</th>
                      {ctx.ensemble && <th className="text-center px-3 py-2.5 font-medium">Site</th>}
                      <th className="text-center px-3 py-2.5 font-medium">Catégorie</th>
                      {/* Ni coût ni prix ici : un produit à déclinaisons
                          n'en a pas un seul. Une gamme dont une variante
                          coûte 800 et l'autre 25 000 afficherait une
                          moyenne que rien ne pratique. Ces deux chiffres
                          appartiennent à la déclinaison, et se lisent
                          dans sa vue. */}
                      {([
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
                            `/site/${p.siteId || siteOuvert}/inventaire/${p.id}` + `?groupe=${groupe}${ctx.ensemble ? '&de=ensemble' : ''}`)}
                          className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100 text-center">{p.designation}</td>
                          {ctx.ensemble && <CelluleSite nom={ctx.nomDe(p.siteId)} />}
                          <td className="px-3 py-2.5 text-gray-500 text-center">{p.categorie || '—'}</td>
                          <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-center">
                            {stock.toLocaleString('fr-FR')} <span className="text-xs text-gray-400">{p.unite.toLowerCase()}{stock > 1 ? 's' : ''}</span>
                          </td>
                          {/* Sans coût, pas de marge : la différence avec
                              zéro ferait un bénéfice égal au prix de vente,
                              soit exactement le chiffre faux qu'on cherche à
                              ne pas afficher. */}
                          <td className={`px-3 py-2.5 font-medium ${p.coutMoyen <= 0 ? 'text-gray-400' : beneficeProduit > 0 ? 'text-green-600' : beneficeProduit < 0 ? 'text-red-500' : 'text-gray-400'} text-center`}>
                            {p.coutMoyen > 0 && stock > 0 ? formatMontant(beneficeProduit) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 font-medium text-center">
                            {p.coutMoyen > 0 ? formatMontant(valeurCout(p)) : '—'}
                          </td>
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
                      const b = bilans[p.id] ?? { entrees: 0, qteEntreeSansCout: 0, sorties: 0, sortiesSansCout: 0 };
                      const diff = b.sorties - b.entrees;
                      const enStock = valeurCout(p);
                      const st = statutRentabilite(b.entrees, b.sorties);

                      return (
                        <tr key={p.id}
                          onClick={() => router.push(
                            `/site/${p.siteId || siteOuvert}/inventaire/${p.id}` + `?groupe=${groupe}${ctx.ensemble ? '&de=ensemble' : ''}`)}
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
                    {/* Deux prix, deux natures. Le recommandé est ce
                        qu'on décide de pratiquer ; le marché est ce qui
                        se pratique autour, qu'on le veuille ou non. Les
                        confondre sous « prix de vente » faisait passer un
                        fait extérieur pour une décision. */}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-gray-400 uppercase mb-1">Prix recommandé</p>
                      <input type="number" placeholder="Ex. 750" value={prixVente} onChange={e => setPrixVente(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-gray-400 uppercase mb-1">Prix du marché</p>
                      <input type="number" placeholder="Facultatif" value={prixMarcheSaisi}
                        onChange={e => setPrixMarcheSaisi(e.target.value)}
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
                    {/* À quelles déclinaisons ce conditionnement
                        s'applique. Un carton de 10W n'en contient pas le
                        même nombre qu'un carton de 30W : les proposer
                        tous les deux laisse choisir le mauvais au moment
                        de vendre.

                        Ne paraît que si des déclinaisons existent déjà —
                        sinon la question ne se pose pas. */}
                    {clesVariantes.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <button type="button"
                          onClick={() => setEmballages(prev => prev.map((x, j) =>
                            j === i ? { ...x, variantes: [] } : x))}
                          className={`rounded-lg px-2 py-0.5 text-[11px] font-bold transition-colors ${
                            (c.variantes?.length ?? 0) === 0
                              ? 'bg-indigo-600 text-white'
                              : 'border border-gray-200 text-gray-500 dark:border-gray-700'}`}>
                          Toutes
                        </button>
                        {clesVariantes.map(cle => {
                          const prise = (c.variantes ?? []).includes(cle);
                          return (
                            <button key={cle} type="button"
                              onClick={() => setEmballages(prev => prev.map((x, j) => {
                                if (j !== i) return x;
                                const liees = x.variantes ?? [];
                                return {
                                  ...x,
                                  variantes: prise
                                    ? liees.filter(y => y !== cle)
                                    : [...liees, cle],
                                };
                              }))}
                              className={`rounded-lg px-2 py-0.5 text-[11px] font-bold transition-colors ${
                                prise
                                  ? 'bg-indigo-600 text-white'
                                  : 'border border-gray-200 text-gray-500 dark:border-gray-700'}`}>
                              {cle}
                            </button>
                          );
                        })}
                      </div>
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
