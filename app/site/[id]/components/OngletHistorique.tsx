'use client';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from './finance/font';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ArrowUpDown, Filter } from 'lucide-react';
import { ChampRecherche } from '@/components/Champs';
import PeriodFilter from './finance/PeriodFilter';
import {
  useSites, FiltreSite, CelluleSite, ToggleVue, CartesParSite,
  type PropsPortee,
} from './ContexteSites';
import { lireParSite } from '@/lib/portee';

interface Props extends PropsPortee {
  userId: string;
}

type Sens = 'entree' | 'sortie';
type Vue = 'mouvement' | 'document' | 'produit' | 'motif' | 'auteur';
type Periode = 'jour' | 'semaine' | 'mois' | 'annee' | 'tout';

/** Un mouvement tel que l'historique a besoin de le lire. */
interface Ligne {
  id: string;
  produitId: string;
  produitNom: string;
  varianteLibelle?: string | null;
  sens: Sens;
  motif: string;
  date: string;
  quantite: number;
  emballage?: string | null;
  unite?: string | null;
  quantiteUnites: number;
  valeurUnitaire: number;
  valeurTotale: number;
  /* Sur une sortie, le prix obtenu et le coût diffèrent : l'un dit ce que le
     client a payé, l'autre ce que la marchandise avait coûté. */
  cout?: number;
  partenaireNom?: string | null;
  documentId?: string | null;
  /* Qui a fait le geste, et à quel titre. Figés à l'écriture : la fiche de
     l'employé changera, l'archive doit rester vraie. */
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /* D'où vient le fait : sur l'ensemble, deux sites écrivent au même
     registre et rien ne les distinguerait. */
  siteId?: string | null;
}

/* Les motifs sont écrits en base sous forme technique : l'affichage les nomme. */
const LIBELLES_MOTIF: Record<string, string> = {
  stock_initial:     'Stock initial',
  achat:             'Achat',
  transfert:         'Transfert',
  retour_client:     'Retour client',
  retour_fournisseur:'Retour fournisseur',
  reajustement:      'Réajustement',
  vente:             'Vente',
  perte:             'Perte',
};

/**
 * Le dossier dont un document est issu.
 *
 * Un document n'a pas de fiche propre : il n'est que la trace d'un dossier
 * — l'achat, la vente ou le transfert qui l'a produit. C'est celui-là qu'on
 * ouvre, puisque c'est lui qui porte les lignes, l'argent et les étapes.
 *
 * Un réajustement, une perte, un stock initial n'ont pas de dossier : ils
 * valent pour eux-mêmes, et la ligne ne mène nulle part.
 */
function cheminDossier(
  siteId: string, motif: string, documentId: string | null,
  ensemble = false, sens?: string, vueHisto?: string,
) {
  if (!documentId) return null;
  /* `de` dit d'où l'on vient : la fiche s'en sert pour savoir où fermer.
     L'historique d'un site et celui de l'ensemble sont deux écrans : les
     confondre ferait changer de vue en fermant un dossier.
     Le sens et la vue suivent : entrées et sorties sont deux écrans, et
     sans eux fermer un document d'entrée renvoyait sur les sorties. */
  const q = new URLSearchParams({ de: ensemble ? 'ensemble-historique' : 'historique' });
  if (sens) q.set('sens', sens);
  if (vueHisto) q.set('vueHisto', vueHisto);
  const suffixe = `?${q.toString()}`;
  if (motif === 'vente') return `/site/${siteId}/ventes/${documentId}${suffixe}`;
  if (motif === 'achat') return `/site/${siteId}/achats/${documentId}${suffixe}`;
  if (motif === 'transfert') return `/site/${siteId}/transferts/${documentId}${suffixe}`;
  return null;
}

function libelleMotif(m: string): string {
  return LIBELLES_MOTIF[m] ?? m;
}



function iso(d: Date): string { return d.toISOString().split('T')[0]; }

function debutPeriode(p: Periode): string {
  const d = new Date();
  if (p === 'jour') return iso(d);
  if (p === 'semaine') {
    const jour = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - jour);
    return iso(d);
  }
  if (p === 'mois') { d.setDate(1); return iso(d); }
  if (p === 'annee') { d.setMonth(0, 1); return iso(d); }
  return '';
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Quantités en unités de base : pas de décimale, un produit entier ou rien. */
function formatQte(n: number): string {
  return Math.trunc(n).toLocaleString('fr-FR');
}

export default function OngletHistorique({ siteId, userId, sites, titre }: Props) {
  const ctx = useSites(siteId, sites);
  const searchParams = useSearchParams();
  const router = useRouter();
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [loading, setLoading] = useState(true);

  /* L'état de l'écran vit dans l'adresse : sans ça, revenir d'un dossier
     rouvrait sur les sorties et les mouvements, quel que soit l'endroit
     qu'on avait quitté. */
  const [sens, setSensBrut] = useState<Sens>(
    searchParams?.get('sens') === 'entree' ? 'entree' : 'sortie');
  const [vue, setVueBrut] = useState<Vue>(
    (['mouvement', 'document', 'produit', 'motif', 'auteur'] as const)
      .includes(searchParams?.get('vueHisto') as Vue)
      ? (searchParams!.get('vueHisto') as Vue) : 'mouvement');

  /* `history.replaceState` plutôt que le routeur : on ne veut qu'une trace
     dans l'adresse, pas une navigation qui remonterait la page. */
  function poser(cle: string, valeur: string) {
    const p = new URLSearchParams(window.location.search);
    p.set(cle, valeur);
    window.history.replaceState(null, '', `?${p.toString()}`);
  }
  function setSens(s: Sens) { setSensBrut(s); poser('sens', s); }
  function setVue(v: Vue) { setVueBrut(v); poser('vueHisto', v); }
  /* Ce qui s'est passé aujourd'hui : c'est la question qu'on se pose en
     ouvrant l'écran. Les périodes plus larges se demandent, elles ne
     s'imposent pas. */
  const [periode, setPeriode] = useState<Periode>('jour');
  const [recherche, setRecherche] = useState('');
  const [filtreMotif, setFiltreMotif] = useState<string>('tous');

  const [tri, setTri] = useState<string | null>(null);
  const [ordre, setOrdre] = useState<'asc' | 'desc'>('desc');

  useEffect(() => { charger(); }, [ctx.portee]);

  async function charger() {
    setLoading(true);
    /* Le produit appartient à l'activité : le filtrer par site priverait
       de son nom un mouvement venu d'ailleurs — un transfert reçu, par
       exemple, dont la fiche est née sur le site expéditeur. */
    const [mvSnap, prodSnap] = await Promise.all([
      lireParSite('mouvements', ctx.portee),
      getDocs(collection(db, 'produits')),
    ]);

    /* le mouvement ne porte que l'id du produit : son nom et son unité
       vivent sur la fiche, il faut les rapprocher pour afficher une ligne */
    const noms: Record<string, { nom: string; unite?: string | null; variantes: any[] }> = {};
    prodSnap.docs.forEach(d => {
      const p = d.data();
      noms[d.id] = { nom: p.designation ?? p.nom ?? '—', unite: p.unite ?? null, variantes: p.variantes ?? [] };
    });

    const l: Ligne[] = mvSnap.map(d => {
      const m = d.data();
      const p = noms[m.produitId];
      /* une variante n'a pas de nom : elle est définie par sa sélection
         de caractéristiques (Couleur: Rouge, Taille: M) */
      const variante = m.varianteCle && p
        ? p.variantes.find((v: any) => v.cle === m.varianteCle)
        : null;
      const libelleVariante = variante?.selection
        ? Object.values(variante.selection as Record<string, string>).join(' · ')
        : null;
      return {
        id: d.id,
        produitId: m.produitId,
        produitNom: p?.nom ?? '—',
        varianteLibelle: libelleVariante,
        sens: m.sens,
        motif: m.motif,
        date: m.date,
        quantite: m.quantite ?? 0,
        emballage: m.emballage ?? null,
        unite: p?.unite ?? null,
        quantiteUnites: m.quantiteUnites ?? 0,
        valeurUnitaire: m.valeurUnitaire ?? 0,
        valeurTotale: m.valeurTotale ?? 0,
        cout: m.cout ?? m.coutMoyenAlors ?? m.valeurUnitaire ?? 0,
        partenaireNom: m.partenaireNom ?? null,
        documentId: m.documentId ?? null,
        siteId: m.siteId ?? null,
        utilisateurNom: m.utilisateurNom ?? null,
        utilisateurFonction: m.utilisateurFonction ?? null,
      };
    });

    setLignes(l);
    setLoading(false);
  }

  if (loading) return (
    <div className="min-h-64 flex items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const debut = debutPeriode(periode);
  const dansPeriode = (date: string) => !debut || (date ?? '') >= debut;

  /* le toggle décide du flux lu ; la période et le motif le restreignent */
  const duSens = lignes.filter(l => l.sens === sens && dansPeriode(l.date));

  /* Ce sur quoi porte la vue ouverte : un seul flux partout, les deux dans
     la vue Auteur. Les compteurs du filtre et le test de page vide s'y
     réfèrent, sinon ils annonceraient un nombre que le tableau dément. */
  const baseVue = vue === 'auteur'
    ? lignes.filter(l => dansPeriode(l.date))
    : duSens;

  /* les motifs proposés au filtre sont ceux réellement présents : une liste
     figée afficherait des motifs qui n'existent pas dans ce site */
  const motifsPresents = [...new Set(baseVue.map(l => l.motif))].sort();
  const retenues = duSens.filter(l => filtreMotif === 'tous' || l.motif === filtreMotif);

  /* La vue Auteur regarde les deux flux à la fois : ce qu'une personne a
     fait entrer et ce qu'elle a fait sortir se lisent sur la même ligne.
     Elle ne peut donc pas partir de `retenues`, qui n'a retenu qu'un sens.
     La période et le motif la restreignent comme les autres ; le toggle
     Entrées/Sorties, non. */
  const desDeuxSens = lignes.filter(l =>
    dansPeriode(l.date) && (filtreMotif === 'tous' || l.motif === filtreMotif));

  /* Ce qui a bougé chez un site sur la période : ce qui est entré, ce qui
     est sorti, et ce que les sorties ont laissé. Un total dit combien la
     maison a vendu, jamais laquelle de ses boutiques l'a fait. */
  function chiffresDuSite(id: string) {
    const siennes = lignes.filter(l => l.siteId === id && dansPeriode(l.date));
    const ent = siennes.filter(l => l.sens === 'entree');
    const sor = siennes.filter(l => l.sens === 'sortie');
    /* Ce que la sortie a laissé : le prix obtenu moins ce que la
       marchandise avait coûté, dans le même emballage. */
    const marge = sor.reduce((n, l) =>
      n + ((l.valeurUnitaire - (l.cout ?? l.valeurUnitaire)) * l.quantite), 0);
    return {
      entrees: ent.reduce((n, l) => n + l.valeurTotale, 0),
      sorties: sor.reduce((n, l) => n + l.valeurTotale, 0),
      nbEntrees: ent.length,
      nbSorties: sor.length,
      marge,
    };
  }

  function basculer(col: string) {
    if (tri === col) setOrdre(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setTri(col); setOrdre('desc'); }
  }

  function ordonner<T>(liste: T[], valeur: ((x: T) => number) | null): T[] {
    if (!valeur) return liste;
    return [...liste].sort((a, b) => (ordre === 'asc' ? 1 : -1) * (valeur(a) - valeur(b)));
  }

  const q = recherche.trim().toLowerCase();

  /* ————— Vue Mouvement : les faits élémentaires, dans l'ordre du temps ————— */
  const mouvements = ordonner(
    retenues.filter(l => !q
      || l.produitNom.toLowerCase().includes(q)
      || (l.partenaireNom ?? '').toLowerCase().includes(q)
      || libelleMotif(l.motif).toLowerCase().includes(q)),
    tri === 'quantite' ? (l => l.quantiteUnites)
      : tri === 'valeur' ? (l => l.valeurTotale)
      : tri === 'date' ? (l => new Date(l.date).getTime())
      : null);
  /* sans tri choisi, le plus récent d'abord : c'est ce qu'on vient voir */
  const mouvementsAffiches = tri ? mouvements : [...mouvements].sort((a, b) => b.date.localeCompare(a.date));

  /* ————— Vue Document : les actes, pas les faits —————
     Plusieurs mouvements d'un même contexte forment un document. Les lignes
     sans documentId sont des actes isolés : chacune vaut pour elle-même. */
  const documents = ordonner(
    [...retenues.reduce((acc, l) => {
      const cle = l.documentId ?? `seul:${l.id}`;
      const prev = acc.get(cle) ?? {
        cle, documentId: l.documentId ?? null, motif: l.motif, date: l.date,
        partenaireNom: l.partenaireNom, produits: 0, quantite: 0, valeur: 0,
        marge: 0,
        /* Toutes les lignes d'un document naissent du même geste : la
           première suffit à dire qui l'a fait. */
        utilisateurNom: l.utilisateurNom ?? null,
        utilisateurFonction: l.utilisateurFonction ?? null,
        /* Un document appartient à un site : toutes ses lignes en viennent. */
        siteId: l.siteId ?? null,
      };
      acc.set(cle, {
        ...prev,
        produits: prev.produits + 1,
        quantite: prev.quantite + l.quantiteUnites,
        valeur: prev.valeur + l.valeurTotale,
        /* Ce que le document a laissé : le prix obtenu moins ce que la
           marchandise avait coûté. Les deux se disent dans l'emballage
           vendu, donc la quantité qui les multiplie est la même. */
        marge: prev.marge
          + ((l.valeurUnitaire - (l.cout ?? l.valeurUnitaire)) * l.quantite),
        /* un document porte une date : celle de la plus ancienne de ses lignes */
        date: l.date < prev.date ? l.date : prev.date,
      });
      return acc;
    }, new Map<string, { cle: string; documentId: string | null; motif: string; date: string; partenaireNom?: string | null; produits: number; quantite: number; valeur: number; marge: number; siteId: string | null; utilisateurNom: string | null; utilisateurFonction: string | null }>())]
      .map(([, v]) => v)
      .filter(d => !q
        || libelleMotif(d.motif).toLowerCase().includes(q)
        || (d.partenaireNom ?? '').toLowerCase().includes(q)),
    tri === 'produits' ? (d => d.produits)
      : tri === 'quantite' ? (d => d.quantite)
      : tri === 'valeur' ? (d => d.valeur)
      : tri === 'date' ? (d => new Date(d.date).getTime())
      : null);
  const documentsAffiches = tri ? documents : [...documents].sort((a, b) => b.date.localeCompare(a.date));

  /* ————— Vue Produit : une colonne par motif —————
     C'est l'agrégation que la liste chronologique ne permet pas de faire à
     l'œil : les mouvements d'un même produit y sont dispersés. */
  const parProduit = [...retenues.reduce((acc, l) => {
    const prev = acc.get(l.produitId) ?? {
      produitId: l.produitId, nom: l.produitNom, unite: l.unite,
      total: 0, valeur: 0, parMotif: {} as Record<string, number>,
    };
    acc.set(l.produitId, {
      ...prev,
      total: prev.total + l.quantiteUnites,
      valeur: prev.valeur + l.valeurTotale,
      /* Chaque motif porte ce qu'il a fait circuler, en valeur. Des quantités
         ne s'additionneraient pas entre emballages — un carton et une pièce
         ne se somment pas ; leurs valeurs, si. */
      parMotif: { ...prev.parMotif, [l.motif]: (prev.parMotif[l.motif] ?? 0) + l.valeurTotale },
    });
    return acc;
  }, new Map<string, { produitId: string; nom: string; unite?: string | null; total: number; valeur: number; parMotif: Record<string, number> }>())]
    .map(([, v]) => v)
    .filter(p => !q || p.nom.toLowerCase().includes(q));

  const produitsAffiches = ordonner(
    parProduit,
    tri === 'total' ? (p => p.total)
      : tri === 'valeur' ? (p => p.valeur)
      : tri && tri.startsWith('motif:') ? (p => p.parMotif[tri.slice(6)] ?? 0)
      : null);
  const produitsOrdonnes = tri ? produitsAffiches : [...parProduit].sort((a, b) => b.valeur - a.valeur);

  /* ————— Vue Motif : le constat brut, avant de savoir sur quoi ————— */
  const parMotif = [...retenues.reduce((acc, l) => {
    const prev = acc.get(l.motif) ?? { motif: l.motif, mouvements: 0, produits: new Set<string>(), quantite: 0, valeur: 0 };
    prev.produits.add(l.produitId);
    acc.set(l.motif, {
      motif: l.motif,
      mouvements: prev.mouvements + 1,
      produits: prev.produits,
      quantite: prev.quantite + l.quantiteUnites,
      valeur: prev.valeur + l.valeurTotale,
    });
    return acc;
  }, new Map<string, { motif: string; mouvements: number; produits: Set<string>; quantite: number; valeur: number }>())]
    .map(([, v]) => ({ ...v, nbProduits: v.produits.size }))
    .filter(m => !q || libelleMotif(m.motif).toLowerCase().includes(q));

  const motifsAffiches = ordonner(
    parMotif,
    tri === 'mouvements' ? (m => m.mouvements)
      : tri === 'nbProduits' ? (m => m.nbProduits)
      : tri === 'quantite' ? (m => m.quantite)
      : tri === 'valeur' ? (m => m.valeur)
      : null);
  const motifsOrdonnes = tri ? motifsAffiches : [...parMotif].sort((a, b) => b.valeur - a.valeur);

  /* ————— Vue Auteur : qui a fait le geste —————
     Les trois autres vues disent quel dossier, quoi, et pourquoi ; aucune ne
     dit qui. La question se pose surtout sur les sorties, et surtout sur
     plusieurs sites, où les caissiers ne se comparent nulle part ailleurs.

     Un mouvement sans auteur n'est pas écarté : le taire ferait un tableau
     dont les totaux ne retombent pas sur ceux des autres vues. Il se range
     sous un nom qui dit ce qu'il est — une archive ancienne, écrite avant
     qu'on enregistre l'auteur. */
  const SANS_AUTEUR = 'Non renseigné';
  const parAuteur = [...desDeuxSens.reduce((acc, l) => {
    const nom = (l.utilisateurNom ?? '').trim() || SANS_AUTEUR;
    const prev = acc.get(nom) ?? {
      nom,
      /* La fonction est figée à l'écriture : un employé promu garde sur ses
         anciens mouvements le titre qu'il avait alors. On montre donc la
         dernière connue, pas une vérité intemporelle. */
      fonction: l.utilisateurFonction ?? null,
      entrees: 0, sorties: 0,
      nbEntrees: 0, nbSorties: 0,
      produits: new Set<string>(), sites: new Set<string>(),
      documents: new Set<string>(),
      derniere: l.date,
    };
    prev.produits.add(l.produitId);
    if (l.siteId) prev.sites.add(l.siteId);
    /* Un document compte pour un acte, quel que soit son nombre de lignes :
       sinon celui qui vend dix produits d'un coup paraîtrait dix fois plus
       actif que celui qui en vend un. Une ligne isolée vaut un acte. */
    prev.documents.add(l.documentId ?? `seul:${l.id}`);
    const entree = l.sens === 'entree';
    acc.set(nom, {
      ...prev,
      fonction: prev.fonction ?? l.utilisateurFonction ?? null,
      entrees: prev.entrees + (entree ? l.valeurTotale : 0),
      sorties: prev.sorties + (entree ? 0 : l.valeurTotale),
      nbEntrees: prev.nbEntrees + (entree ? 1 : 0),
      nbSorties: prev.nbSorties + (entree ? 0 : 1),
      derniere: l.date > prev.derniere ? l.date : prev.derniere,
    });
    return acc;
  }, new Map<string, { nom: string; fonction: string | null; entrees: number; sorties: number; nbEntrees: number; nbSorties: number; produits: Set<string>; sites: Set<string>; documents: Set<string>; derniere: string }>())]
    .map(([, v]) => ({
      ...v, nbProduits: v.produits.size, nbSites: v.sites.size,
      nbDocuments: v.documents.size,
    }))
    .filter(a => !q
      || a.nom.toLowerCase().includes(q)
      || (a.fonction ?? '').toLowerCase().includes(q));

  const auteursAffiches = ordonner(
    parAuteur,
    tri === 'documents' ? (a => a.nbDocuments)
      : tri === 'nbProduits' ? (a => a.nbProduits)
      : tri === 'entrees' ? (a => a.entrees)
      : tri === 'sorties' ? (a => a.sorties)
      : tri === 'derniere' ? (a => new Date(a.derniere).getTime())
      : null);
  /* Sans tri choisi, celui qui a le plus fait sortir d'abord : c'est le
     geste le plus fréquent, et celui qu'on vient regarder. */
  const auteursOrdonnes = tri ? auteursAffiches : [...parAuteur].sort((a, b) => b.sorties - a.sorties);

  const totalValeur = retenues.reduce((s, l) => s + l.valeurTotale, 0);
  const totalQuantite = retenues.reduce((s, l) => s + l.quantiteUnites, 0);

  /** En-tête de colonne triable, pour n'écrire le bouton qu'une fois. */
  function Th({ cle, label }: { cle: string; label: string }) {
    return (
      <th className="px-3 py-2.5 font-medium">
        <button onClick={() => basculer(cle)}
          className="w-full flex items-center justify-center gap-1 hover:opacity-80 transition-opacity">
          {label}
          <ArrowUpDown size={12} className={tri === cle ? 'opacity-100' : 'opacity-40'} />
        </button>
      </th>
    );
  }

  const vide = (
    <p className="text-xs text-gray-400 text-center py-8">
      {q ? 'Aucun résultat.' : 'Aucun mouvement sur la période.'}
    </p>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'text-sm font-bold text-gray-900 dark:text-gray-100'}>
          {titre ?? 'Historique'}
        </p>
        {/* Le même sélecteur que le tableau de bord : un choix unique se dit
            dans une liste, et la liste se lit partout pareil. */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Un total dit combien a bougé, jamais dans quelle boutique. */}
          <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {/* La période commande la page entière, cartes de tête comprises :
          dans l'en-tête, parmi les réglages de portée, elle se lisait comme
          un filtre du seul tableau. Elle se tient donc au-dessus d'elles. */}
      <div className="mb-3 flex justify-end">
        <PeriodFilter periode={periode} onChange={setPeriode} />
      </div>

      {ctx.parSite ? (
        /* Une carte par site : ce qui y est entré, ce qui en est sorti. */
        <CartesParSite sites={ctx.sitesVus} contenu={id => {
          const c = chiffresDuSite(id);
          const n = c.nbEntrees + c.nbSorties;
          return {
            titre: 'Sorties',
            valeur: formatMontant(c.sorties),
            dort: n === 0,
            badge: n > 0
              ? {
                  texte: `${n} mouvement${n > 1 ? 's' : ''}`,
                  ton: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                }
              : null,
            lignes: [
              { label: `Entrées · ${c.nbEntrees}`, valeur: formatMontant(c.entrees),
                vide: c.entrees === 0, ton: 'text-green-600' },
              { label: `Sorties · ${c.nbSorties}`, valeur: formatMontant(c.sorties),
                vide: c.sorties === 0, ton: 'text-gray-900 dark:text-gray-100' },
              { label: 'Marge', valeur: formatMontant(c.marge),
                vide: c.marge === 0,
                ton: c.marge < 0 ? 'text-red-500' : 'text-green-600' },
            ],
          };
        }} />
      ) : (
      <>
      {/* Deux flux symétriques : on lit l'un ou l'autre, jamais les deux mêlés. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {([
          { key: 'entree' as const, label: 'Entrées', emoji: '📥' },
          { key: 'sortie' as const, label: 'Sorties', emoji: '📤' },
        ]).map(o => {
          const actif = sens === o.key;
          const duFlux = lignes.filter(l => l.sens === o.key && dansPeriode(l.date));
          const valeur = duFlux.reduce((s, l) => s + l.valeurTotale, 0);
          return (
            /* Modèle de fond : l'emoji et le compte partagent la première
               ligne, et l'indigo dit laquelle des deux vues est ouverte. */
            <button key={o.key} type="button"
              onClick={() => { setSens(o.key); setFiltreMotif('tous'); setTri(null); }}
              className={`block rounded-2xl p-5 text-left shadow-sm transition-all ${
                actif
                  ? 'text-white'
                  : 'border border-black/[0.06] bg-white hover:-translate-y-0.5 dark:border-white/10 dark:bg-neutral-900'}`}
              style={actif
                ? { background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }
                : undefined}>
              <div className="flex items-start justify-between gap-3">
                <span className={`flex h-8 w-8 items-center justify-center rounded-[10px] text-lg ${
                  actif ? 'bg-white/15' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
                  {o.emoji}
                </span>
                <span className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-bold ${
                  actif
                    ? 'bg-white/15 text-indigo-100'
                    : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                  {duFlux.length} mouvement{duFlux.length > 1 ? 's' : ''}
                </span>
              </div>
              <p className={`mt-3 text-[11px] font-bold uppercase tracking-wide ${
                actif ? 'text-indigo-100' : 'text-neutral-400'}`}>
                {o.label}
              </p>
              <p className={`${hankenGrotesk.className} mt-0.5 text-[26px] font-bold leading-8 tracking-tight ${
                actif ? 'text-white' : 'text-neutral-900 dark:text-white'}`}>
                {formatMontant(valeur)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            {sens === 'entree' ? 'Entrées' : 'Sorties'}
          </p>
          <div className="flex rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shrink-0">
            {([
              { key: 'mouvement' as const, label: 'Mouvements' },
              { key: 'document' as const,  label: 'Documents' },
              { key: 'produit' as const,   label: 'Produits' },
              { key: 'motif' as const,     label: 'Motifs' },
              { key: 'auteur' as const,    label: 'Auteurs' },
            ]).map(o => (
              <button key={o.key} onClick={() => { setVue(o.key); setTri(null); }}
                className={`px-3 py-1.5 text-xs font-bold transition-colors ${vue === o.key ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-indigo-600'}`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {baseVue.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <ChampRecherche className="flex-1 min-w-[200px]"
              placeholder={vue === 'auteur'
                ? 'Rechercher un auteur, une fonction…'
                : 'Rechercher un produit, un motif, un partenaire…'}
              valeur={recherche} onChange={setRecherche} />
            {/* la vue Motif classe déjà par motif : la filtrer la viderait */}
            {vue !== 'motif' && motifsPresents.length > 1 && (
              <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1 gap-0.5 shrink-0">
                <Filter size={13} className="text-gray-400 ml-1 mr-0.5" />
                <button onClick={() => setFiltreMotif('tous')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                    ${filtreMotif === 'tous'
                      ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                      : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
                  Tous ({baseVue.length})
                </button>
                {motifsPresents.map(m => (
                  <button key={m} onClick={() => setFiltreMotif(m)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                      ${filtreMotif === m
                        ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                        : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'}`}>
                    {libelleMotif(m)} ({baseVue.filter(l => l.motif === m).length})
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ————— Mouvements ————— */}
        {vue === 'mouvement' && (
          mouvementsAffiches.length === 0 ? vide : (
            <div className="overflow-x-auto">
              <p className="text-sm font-medium text-gray-500 mb-2">
                {mouvementsAffiches.length} {mouvementsAffiches.length === 1 ? 'mouvement' : 'mouvements'}
              </p>
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    {/* Le produit d'abord : c'est lui qu'on cherche dans la
                        liste, la date ne sert qu'à le situer. */}
                    <th className="text-center px-3 py-2.5 font-medium">Produit</th>
                    {ctx.ensemble && <th className="text-center px-3 py-2.5 font-medium">Site</th>}
                    <Th cle="date" label="Date" />
                    <th className="text-center px-3 py-2.5 font-medium">Motif</th>
                    <th className="text-center px-3 py-2.5 font-medium">Partenaire</th>
                    {/* Sans les deux, un mouvement de stock ne désigne
                        personne : la fonction dit à quel titre, le nom dit
                        qui. */}
                    <th className="text-center px-3 py-2.5 font-medium">Fonction</th>
                    <th className="text-center px-3 py-2.5 font-medium">Auteur</th>
                    <th className="text-center px-3 py-2.5 font-medium">Emballage</th>
                    <Th cle="quantite" label="Qté" />
                    <th className="text-center px-3 py-2.5 font-medium">Coût unitaire</th>
                    {/* Une sortie se valorise au prix obtenu : sans lui, la
                        ligne ne dit pas ce que la vente a rapporté. */}
                    {sens === 'sortie' && (
                      <th className="text-center px-3 py-2.5 font-medium">Prix unitaire</th>
                    )}
                    <Th cle="valeur" label="Total" />
                  </tr>
                </thead>
                <tbody>
                  {mouvementsAffiches.map(l => (
                    /* Un mouvement est un fait, pas une porte : il ne mène ni
                       au produit ni au dossier. On le lit, c'est tout. */
                    <tr key={l.id}
                      className="border-b border-gray-50 dark:border-gray-800 transition-colors">
                      <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">
                        {l.produitNom}
                        {l.varianteLibelle && <span className="text-gray-400 font-normal"> · {l.varianteLibelle}</span>}
                      </td>
                      {ctx.ensemble && <CelluleSite nom={ctx.nomDe(l.siteId)} />}
                      <td className="px-3 py-2.5 text-center text-gray-500">{formatDate(l.date)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{libelleMotif(l.motif)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{l.partenaireNom ?? '—'}</td>
                      <td className="px-3 py-2.5 text-center text-gray-400">
                        {l.utilisateurFonction || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">
                        {l.utilisateurNom || '—'}
                      </td>
                      {/* l'unité est elle-même un emballage, celui de contenance 1 */}
                      <td className="px-3 py-2.5 text-center text-gray-500">{l.emballage ?? l.unite ?? 'unité'}</td>
                      {/* La quantité se lit dans l'emballage de la colonne
                          voisine : montrer les unités de base à côté du mot
                          « carton » ferait lire vingt-huit cartons pour un. */}
                      <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">{formatQte(l.quantite)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{formatMontant(l.cout ?? l.valeurUnitaire)}</td>
                      {sens === 'sortie' && (
                        <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">
                          {formatMontant(l.valeurUnitaire)}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-center font-bold text-gray-900 dark:text-gray-100">{formatMontant(l.valeurTotale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* ————— Documents ————— */}
        {vue === 'document' && (
          documentsAffiches.length === 0 ? vide : (
            <div className="overflow-x-auto">
              <p className="text-sm font-medium text-gray-500 mb-2">
                {documentsAffiches.length} {documentsAffiches.length === 1 ? 'document' : 'documents'}
              </p>
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    {/* Un document se retrouve par sa référence, puis par le
                        tiers qu'il engage ; la date ne fait que le situer. */}
                    <th className="text-center px-3 py-2.5 font-medium">Référence</th>
                    {ctx.ensemble && <th className="text-center px-3 py-2.5 font-medium">Site</th>}
                    <th className="text-center px-3 py-2.5 font-medium">Partenaire</th>
                    <th className="text-center px-3 py-2.5 font-medium">Motif</th>
                    <th className="text-center px-3 py-2.5 font-medium">Fonction</th>
                    <th className="text-center px-3 py-2.5 font-medium">Auteur</th>
                    <Th cle="date" label="Date" />
                    {/* Pas de quantité : un document mêlant des cartons et des
                        pièces, leur somme ne désigne rien. */}
                    <Th cle="produits" label="Produits" />
                    {/* Ce que le document a laissé. Il n'existe que sur une
                        sortie : une entrée fait rentrer de la marchandise, elle
                        ne dégage rien tant qu'elle n'est pas revendue. */}
                    {sens === 'sortie' && (
                      <th className="text-center px-3 py-2.5 font-medium">Marge</th>
                    )}
                    <Th cle="valeur" label="Total" />
                  </tr>
                </thead>
                <tbody>
                  {documentsAffiches.map(d => {
                    const chemin = cheminDossier(
                      d.siteId ?? ctx.siteEcriture ?? '', d.motif, d.documentId,
                      ctx.ensemble, sens, vue);
                    return (
                    <tr key={d.cle}
                      onClick={() => { if (chemin) router.push(chemin); }}
                      className={`border-b border-gray-50 dark:border-gray-800 transition-colors ${chemin
                        ? 'hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer'
                        : ''}`}>
                      {/* une ligne sans document est un acte isolé, pas un dossier */}
                      <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">
                        {d.documentId ? d.documentId.slice(0, 8).toUpperCase() : '—'}
                      </td>
                      {ctx.ensemble && <CelluleSite nom={ctx.nomDe(d.siteId)} />}
                      <td className="px-3 py-2.5 text-center text-gray-500">{d.partenaireNom ?? '—'}</td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{libelleMotif(d.motif)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-400">
                        {d.utilisateurFonction || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">
                        {d.utilisateurNom || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{formatDate(d.date)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">{d.produits}</td>
                      {sens === 'sortie' && (
                        <td className={`px-3 py-2.5 text-center font-bold ${d.marge < 0
                          ? 'text-red-500'
                          : d.marge > 0 ? 'text-green-600' : 'text-gray-300 dark:text-gray-700'}`}>
                          {formatMontant(d.marge)}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-center font-bold text-gray-900 dark:text-gray-100">{formatMontant(d.valeur)}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* ————— Produits : une colonne par motif —————
            Lue seule, une ligne dit ce que ce produit a fait sortir ou rentrer.
            Lue en colonne, elle dit par quoi — et c'est là qu'un produit qui
            sort surtout en réajustement se distingue d'un produit qui se vend. */}
        {vue === 'produit' && (
          produitsOrdonnes.length === 0 ? vide : (
            <div className="overflow-x-auto">
              <p className="text-sm font-medium text-gray-500 mb-2">
                {produitsOrdonnes.length} {produitsOrdonnes.length === 1 ? 'produit' : 'produits'}
              </p>
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    <th className="text-center px-3 py-2.5 font-medium">Produit</th>
                    {/* Un motif par colonne, en valeur : la ligne dit par quoi
                        le produit a circulé, et pour combien. */}
                    {motifsPresents.map(m => (
                      <Th key={m} cle={`motif:${m}`} label={libelleMotif(m)} />
                    ))}
                    <Th cle="valeur" label="Valeur" />
                  </tr>
                </thead>
                <tbody>
                  {produitsOrdonnes.map(p => (
                    <tr key={p.produitId}
                      onClick={() => { if (ctx.siteEcriture) router.push(
                        `/site/${ctx.siteEcriture}/inventaire/${p.produitId}`); }}
                      className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors">
                      <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">{p.nom}</td>
                      {motifsPresents.map(m => {
                        const v = p.parMotif[m] ?? 0;
                        return (
                          <td key={m} className={`px-3 py-2.5 text-center ${v === 0 ? 'text-gray-300 dark:text-gray-700' : 'text-gray-900 dark:text-gray-100'}`}>
                            {v === 0 ? '—' : formatMontant(v)}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2.5 text-center font-bold text-gray-900 dark:text-gray-100">{formatMontant(p.valeur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* ————— Motifs : le constat brut ————— */}
        {vue === 'motif' && (
          motifsOrdonnes.length === 0 ? vide : (
            <div className="overflow-x-auto">
              <p className="text-sm font-medium text-gray-500 mb-2">
                {motifsOrdonnes.length} {motifsOrdonnes.length === 1 ? 'motif' : 'motifs'}
              </p>
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    <th className="text-center px-3 py-2.5 font-medium">Motif</th>
                    <Th cle="mouvements" label="Mouvements" />
                    <Th cle="nbProduits" label="Produits" />
                    <Th cle="valeur" label="Valeur" />
                    <th className="text-center px-3 py-2.5 font-medium">Part</th>
                  </tr>
                </thead>
                <tbody>
                  {motifsOrdonnes.map(m => (
                    <tr key={m.motif}
                      onClick={() => { setFiltreMotif(m.motif); setVue('produit'); setTri(null); }}
                      className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors">
                      <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">{libelleMotif(m.motif)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">{m.mouvements}</td>
                      <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">{m.nbProduits}</td>
                      <td className="px-3 py-2.5 text-center font-bold text-gray-900 dark:text-gray-100">{formatMontant(m.valeur)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-500">
                        {totalValeur > 0 ? `${Math.round((m.valeur / totalValeur) * 100)} %` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* ————— Auteurs : qui a fait le geste —————
            Entrées et sorties sur la même ligne : c'est le volume qu'une
            personne a fait circuler dans chaque sens. La vue ignore donc le
            toggle Entrées/Sorties, qui la couperait en deux moitiés.

            Pas de marge ici, volontairement : elle appartient au produit,
            pas à celui qui le sort. Le vendeur écoule un stock entré par un
            autre, à un coût qu'il n'a pas fixé — la lui attribuer lui
            prêterait un mérite qui revient à l'achat.
            Le site ne se compte que sur l'ensemble : dans un site, il
            vaudrait un partout. */}
        {vue === 'auteur' && (
          auteursOrdonnes.length === 0 ? vide : (
            <div className="overflow-x-auto">
              <p className="text-sm font-medium text-gray-500 mb-2">
                {auteursOrdonnes.length} {auteursOrdonnes.length === 1 ? 'auteur' : 'auteurs'}
                <span className="text-gray-400"> · les deux flux</span>
              </p>
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    <th className="text-center px-3 py-2.5 font-medium">Auteur</th>
                    <th className="text-center px-3 py-2.5 font-medium">Fonction</th>
                    {ctx.ensemble && <th className="text-center px-3 py-2.5 font-medium">Sites</th>}
                    <Th cle="documents" label="Documents" />
                    <Th cle="nbProduits" label="Produits" />
                    <Th cle="entrees" label="Entrées" />
                    <Th cle="sorties" label="Sorties" />
                    <Th cle="derniere" label="Dernier" />
                  </tr>
                </thead>
                <tbody>
                  {auteursOrdonnes.map(a => (
                    <tr key={a.nom}
                      className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                      <td className={`px-3 py-2.5 text-center font-medium ${
                        a.nom === SANS_AUTEUR
                          ? 'text-gray-400 italic'
                          : 'text-gray-900 dark:text-gray-100'}`}>
                        {a.nom}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{a.fonction ?? '—'}</td>
                      {ctx.ensemble && (
                        <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">
                          {a.nbSites || '—'}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">{a.nbDocuments}</td>
                      <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">{a.nbProduits}</td>
                      {/* Le compte de mouvements accompagne son montant :
                          il dit en combien de gestes la somme s'est faite,
                          et deux colonnes de plus l'auraient noyé. */}
                      <td className="px-3 py-2.5 text-center">
                        {a.nbEntrees === 0 ? <span className="text-gray-300">—</span> : (
                          <span className="inline-flex items-baseline gap-1.5">
                            <span className="font-bold text-green-600">{formatMontant(a.entrees)}</span>
                            <span className="text-[11px] text-gray-400 tabular-nums">{a.nbEntrees}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {a.nbSorties === 0 ? <span className="text-gray-300">—</span> : (
                          <span className="inline-flex items-baseline gap-1.5">
                            <span className="font-bold text-gray-900 dark:text-gray-100">{formatMontant(a.sorties)}</span>
                            <span className="text-[11px] text-gray-400 tabular-nums">{a.nbSorties}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{formatDate(a.derniere)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
      </>
      )}
    </div>
  );
}
