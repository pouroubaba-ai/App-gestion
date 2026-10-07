'use client';
import { produitsDuSite } from '@/lib/produits-site';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection, query, where, getDocs, addDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { auteurCourant, auteurEtape } from '@/lib/auteur';
import {
  LigneFlux, referenceFlux, livrerVente, type Vente,
} from '@/lib/flux-marchandise';
import { ligneDepuisVente, synchroniserLignes } from '@/lib/lignes-vente';
import { emballagesDe } from '@/lib/mouvements';
import { enregistrerVersement } from '@/lib/versements-collection';
import { estEnsemble, racineRetour } from '@/lib/retour';
import {
  sansAttendreLeReseau, useReseau, reprendreVentesComptoir,
} from '@/lib/reseau';
import ModalPlanification from '../components/ModalPlanification';
import {
  appliquerPlanification, lireChoix, type Planification,
} from '@/lib/planification';
import { ChampRecherche, ChampNombre, SelectCherchable } from '@/components/Champs';
import type { ProduitChoisissable } from '../components/SelecteurProduits';
import ModalMargeRecu from '../components/ModalMargeRecu';
import PanneauMontants from '../components/PanneauMontants';
import {
  prixApresMontants, piedDocument,
  type MontantVente,
} from '@/lib/reductions';
import {
  Loader2, Plus, Minus, Trash2, Check, ArrowLeft, ShoppingCart, Package, X, Info,
  BarChart3, WifiOff, Percent, ChevronLeft, ChevronRight, Maximize2,
} from 'lucide-react';

interface ClientBref { id: string; nom: string }

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

function libelleVariante(sel: Record<string, string>): string {
  return Object.values(sel).join(' / ');
}

/**
 * Le stock, dit dans chacun des emballages du produit.
 *
 * Le stock se tient en unités de base — seule mesure qui s'additionne entre
 * emballages. Mais personne au comptoir ne compte en unités : on voit des
 * cartons, des paquets. « 840 » ne dit rien ; « 30 carton×28 » se vérifie
 * d'un regard sur l'étagère.
 *
 * Chaque emballage dit le même stock à sa façon : 840 unités, ce sont 30
 * cartons de 28, ou 70 paquets de 12, ou 840 pièces. On ne décompose pas —
 * on traduit, autant de fois qu'il y a de contenants.
 *
 * L'écriture reste brève : une carte de catalogue a la largeur d'une vignette,
 * et un stock qui prend trois lignes relègue le nom du produit au second plan.
 * D'où le singulier et le × collé — on lit un repère, pas une phrase.
 */
function stockLisible(
  unites: number,
  emballages: { nom: string; quantite: number }[] | undefined,
  unite: string | undefined,
): string[] {
  const stock = Math.max(0, Math.floor(unites));
  const base = (unite?.trim() || 'unité').toLowerCase();

  /* Du plus grand au plus petit : le carton avant le paquet, l'unité en
     dernier — c'est l'ordre dans lequel on parle d'un stock. */
  const tries = [...(emballages ?? [])]
    .filter(e => e.quantite > 1)
    .sort((a, b) => b.quantite - a.quantite);

  const lignes = tries
    /* Un emballage qu'on ne remplit même pas une fois n'apprend rien : le
       dire à zéro ferait croire à une rupture qui n'existe pas. */
    .filter(e => Math.floor(stock / e.quantite) > 0)
    .map(e => `${Math.floor(stock / e.quantite)} ${e.nom.toLowerCase()}×${e.quantite}`);

  /* L'unité de base ferme la liste : c'est elle qui porte le stock exact,
     les emballages n'en donnant que la part entière. */
  lignes.push(`${stock} ${base}`);
  return lignes;
}

/** Une entrée du catalogue : un produit, ou l'une de ses variantes. */
interface Article {
  cle: string;
  produit: ProduitChoisissable;
  varianteCle: string | null;
  varianteLibelle: string | null;
  designation: string;
  stock: number;
  coutMoyen: number;
  prixVente: number;
  /* Ce qui se pratique autour : un fait, pas une décision. */
  prixMarche?: number | null;
}

/** Une ligne du panier, avec de quoi la retrouver dans le catalogue. */
interface LignePanier extends LigneFlux {
  cle: string;
  /** le stock de l'article, en unités de base — la seule mesure stable */
  stockUnites: number;
  /** ce que contient l'emballage choisi ; 1 pour l'unité de base */
  contenance: number;
  /** le prix à l'unité, d'où se déduit celui de chaque emballage */
  prixUnitaire: number;
  /** le coût à l'unité : même rôle, du côté de ce que la marchandise a coûté */
  coutUnitaire: number;
  /**
   * Les deux prix d'origine, à l'unité.
   *
   * Le prix pratiqué est le plus élevé des deux ; les garder permet de
   * dire d'où il vient quand on déplie la ligne, et de le discuter.
   */
  prixRecommande?: number;
  prixMarche?: number | null;
  /**
   * Cette quantité vient de dehors.
   *
   * Posé des le clic, quand le rayon est vide — avant qu'on sache chez
   * qui. `fournisseurId` ne le dirait pas : il reste nul tant que le nom
   * n'est pas saisi, et le plafond du stock doit tomber des maintenant,
   * sinon la ligne naitrait a zero et disparaitrait aussitot.
   */
  prisDehors?: boolean;
}

/**
 * Le comptoir.
 *
 * Une vente au comptoir n'attend pas : le client est là, il prend, il paie,
 * il part. Le cycle de vente — devis, commande, préparation, prêt, livré —
 * décrit une marchandise qu'on prépare pendant que le client attend ailleurs ;
 * lui faire traverser cinq états pour un geste de vingt secondes n'aurait
 * aucun sens.
 *
 * La vente naît donc livrée : le stock sort dans le même geste, et l'argent
 * entre en caisse. Elle rejoint ensuite le cycle de vente et la fiche du
 * client comme n'importe quelle autre — c'est le chemin qui diffère, pas
 * la nature.
 *
 * L'écran ne se quitte pas entre deux ventes : on valide, le panier se vide,
 * le curseur revient dans la recherche. C'est ce qui en fait un poste plutôt
 * qu'un formulaire.
 */
export default function ComptoirPage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  /* Le comptoir vend toujours dans un site, mais on peut y entrer depuis la
     vue d'ensemble : c'est la porte d'entree qui decide du retour, pas le
     site ou la vente s'ecrit. */
  const retourCycle = `${racineRetour(estEnsemble(searchParams), siteId)}?onglet=cycle-vente`;

  const [clients, setClients] = useState<ClientBref[]>([]);
  /* Ceux chez qui on prend ce qu'on n'a pas. Reguliers et occasionnels
     ensemble : au comptoir on ne se demande pas dans quelle categorie
     range le voisin, on tape son nom. */
  const [fournisseurs, setFournisseurs] = useState<
    { id: string; nom: string; occasionnel: boolean }[]>([]);
  const [produits, setProduits] = useState<ProduitChoisissable[]>([]);
  const [loading, setLoading] = useState(true);
  /* `null` tant qu'on ne sait pas, puis le rôle — lui aussi `null` pour qui
     n'a aucune restriction. D'où le drapeau séparé. */
  const [role, setRole] = useState<RoleSite | null>(null);
  const [roleLu, setRoleLu] = useState(false);

  const [recherche, setRecherche] = useState('');
  /* '' = toutes. Une catégorie retranche, elle ne se cumule pas : au comptoir
     on cherche un rayon, pas une combinaison de rayons. */
  const [categorie, setCategorie] = useState('');
  /* Le panier en grand. La colonne est étroite et bornée en hauteur :
     dès cinq articles on ne voit plus l'ensemble, et c'est justement
     quand le total surprend qu'on veut tout relire d'un coup. */
  const [panierOuvert, setPanierOuvert] = useState(false);

  /* La page ne défile plus derrière le modal : la molette y glissait,
     et en refermant on ne savait plus où l'on était dans le catalogue. */
  useEffect(() => {
    if (!panierOuvert) return;
    const avant = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = avant; };
  }, [panierOuvert]);
  /* La bande des rayons. Sur un écran tactile le doigt la fait glisser
     tout seul ; à la souris, rien ne le dit — d'où les deux flèches, et
     la molette qui pousse de côté au lieu de descendre la page. */
  const bandeRayons = useRef<HTMLDivElement>(null);
  function glisser(sens: -1 | 1) {
    bandeRayons.current?.scrollBy({ left: sens * 240, behavior: 'smooth' });
  }
  const [panier, setPanier] = useState<LignePanier[]>([]);
  /* Un panier à moitié rempli ne doit pas disparaître parce qu'on est allé
     vérifier un prix ailleurs, ni parce que la page s'est rechargée. Il vit
     donc dans le navigateur, le temps de la vente.

     Par site : deux comptoirs ouverts sur deux sites ne partagent ni leur
     stock ni leurs clients. Le reste — le client choisi, le mode de paiement
     — ne se garde pas : les retrouver à l'ouverture ferait encaisser à
     crédit au nom de quelqu'un qu'on n'a pas revu. */
  const cle = `comptoir:${siteId}`;
  const [repris, setRepris] = useState(false);

  useEffect(() => {
    try {
      const brut = localStorage.getItem(cle);
      if (brut) setPanier(JSON.parse(brut));
    } catch { /* stockage refusé ou illisible : on repart d'un panier vide */ }
    setRepris(true);
  }, [cle]);

  useEffect(() => {
    /* Avant la reprise, le panier vaut [] : écrire effacerait ce qu'on
       s'apprête à relire. */
    if (!repris) return;
    try {
      if (panier.length > 0) localStorage.setItem(cle, JSON.stringify(panier));
      else localStorage.removeItem(cle);
    } catch { /* un stockage indisponible ne doit pas empêcher de vendre */ }
  }, [panier, cle, repris]);
  const [clientId, setClientId] = useState('');
  /* Comptant par défaut : au comptoir, l'exception est le crédit. */
  const [aCredit, setACredit] = useState(false);
  const [encaisse, setEncaisse] = useState(0);
  /* Une vente au comptoir ne passe par aucune fiche : le declencheur pose
     a l'arrivee du dossier ne l'atteint jamais. La question se pose donc
     ici, au moment ou la creance nait. */
  const [aPlanifier, setAPlanifier] = useState<
    { montant: number; clientId: string; clientNom: string } | null>(null);
  /* Une vente prise mais pas encore partie : le dire, sinon on la refait. */
  const [differe, setDiffere] = useState(false);
  const enLigne = useReseau();

  /* Une vente au comptoir naît en préparation et se livre aussitôt. Si la
     machine s'éteint entre les deux, elle reste à mi-parcours : le client
     est parti avec la marchandise, mais le stock l'ignore. On les termine
     en ouvrant le comptoir, quand le réseau est là pour le faire. */
  useEffect(() => {
    if (!user || !enLigne) return;
    let vivant = true;
    reprendreVentesComptoir({ siteId, userId: user.uid })
      /* Le stock a bougé : on relit, sinon le rayon montre ce qui est
         déjà parti. */
      .then(async n => {
        if (!vivant || n === 0) return;
        const frais = await produitsDuSite(siteId);
        if (vivant) setProduits(frais as ProduitChoisissable[]);
      })
      .catch(() => {});
  return () => { vivant = false; };
  }, [user, enLigne, siteId]);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  /* Ce qu'on vient de vendre, le temps d'un regard. */
  const [fait, setFait] = useState<{ ref: string; total: number; rendu: number } | null>(null);
  /* La ligne dont on regarde le coût. Une seule à la fois : c'est une
     vérification ponctuelle, pas une colonne du panier. Elle se referme au
     geste suivant sur la ligne — changer d'emballage, la quantité ou le prix
     dit qu'on a fini de regarder. */
  const [detail, setDetail] = useState<string | null>(null);
  /* Ce que le reçu rapporte et ce qu'il coûte, quand on veut le savoir. */
  const [marge, setMarge] = useState(false);
  /* Les remises et frais du reçu. Rien n'est posé par défaut : au
     comptoir la remise est l'exception, pas la règle. */
  const [montants, setMontants] = useState<MontantVente[]>([]);
  const [montantsOuverts, setMontantsOuverts] = useState(false);

  /* Le bouton caché n'empêche pas d'ouvrir l'adresse : la page se garde
     elle-même. */
  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(r => { setRole(r); setRoleLu(true); })
      .catch(() => setRoleLu(true));
  }, [user, siteId, activite?.adminUid]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [partSnap, prodSnap] = await Promise.all([
        /* Le site, pas le compte : un client du carnet doit pouvoir
           acheter à crédit quel que soit celui qui l'a inscrit. Sans
           cela, le comptoir affichait « Aucun client » et la vente à
           crédit devenait impossible. */
        getDocs(query(collection(db, 'partenaires'),
          where('siteId', '==', siteId))),
        produitsDuSite(siteId),
      ]);
      setClients(partSnap.docs
        .filter(d => d.data().rolesClient)
        .map(d => ({ id: d.id, nom: d.data().nom as string })));
      /* Ceux chez qui on va chercher ce qui manque. Le meme snapshot :
         demander deux fois les partenaires pour les trier autrement
         couterait une lecture pour rien.
         Les occasionnels y sont, et les reguliers aussi — on prend chez
         l'un comme chez l'autre, et c'est au moment de nommer qu'on
         choisit. */
      setFournisseurs(partSnap.docs
        .filter(d => d.data().rolesFournisseur)
        .map(d => ({ id: d.id, nom: d.data().nom as string,
          occasionnel: !!d.data().occasionnel }))
        .sort((a, b) => a.nom.localeCompare(b.nom)));
      /* `produitsDuSite` a deja joint le produit et la detention : les
         objets arrivent complets. */
      setProduits(prodSnap as ProduitChoisissable[]);
      setLoading(false);
    })();
  }, [siteId, user]);

  /* Un détail ouvert se referme dès qu'on regarde ailleurs : c'est une
     vérification, pas un panneau qu'on garde. Le clic sur le ⓘ ou sur le
     bloc lui-même ne compte pas — l'un le bascule, l'autre est son contenu. */
  useEffect(() => {
    if (!detail) return;
    function fermer(e: MouseEvent) {
      const cible = e.target as HTMLElement;
      if (cible.closest('[data-detail-cout]')) return;
      setDetail(null);
    }
    document.addEventListener('mousedown', fermer);
    return () => document.removeEventListener('mousedown', fermer);
  }, [detail]);

  /* Le catalogue se déplie à la variante : c'est elle qui porte le stock,
     et c'est elle qu'on vend. Un produit sans variante en fait une seule. */
  const articles: Article[] = useMemo(() => {
    const out: Article[] = [];
    for (const p of produits) {
      if (p.variantes?.length) {
        for (const v of p.variantes) {
          out.push({
            cle: `${p.id}::${v.cle}`,
            produit: p,
            varianteCle: v.cle,
            varianteLibelle: libelleVariante(v.selection),
            designation: `${p.designation} · ${libelleVariante(v.selection)}`,
            stock: v.stock ?? 0,
            coutMoyen: v.coutMoyen ?? p.coutMoyen ?? 0,
            prixVente: v.prixVente ?? p.prixVente ?? 0,
            prixMarche: v.prixMarche ?? p.prixMarche ?? null,
          });
        }
      } else {
        out.push({
          cle: p.id,
          produit: p,
          varianteCle: null,
          varianteLibelle: null,
          designation: p.designation,
          stock: p.stock ?? 0,
          coutMoyen: p.coutMoyen ?? 0,
          prixVente: p.prixVente ?? 0,
          prixMarche: p.prixMarche ?? null,
        });
      }
    }
    return out.sort((a, b) => a.designation.localeCompare(b.designation));
  }, [produits]);

  /* Les catégories réellement portées par les produits du site : une liste
     figée ailleurs montrerait des rayons vides. */
  const categories = useMemo(() => [...new Set(
    produits.map(p => p.categorie?.trim()).filter((c): c is string => !!c),
  )].sort((a, b) => a.localeCompare(b)), [produits]);

  /* Un panier repris porte le stock du moment où il a été rempli. Entre-temps
     une vente a pu passer : le garder ferait promettre une marchandise qui
     n'est plus là. On le relit sur le catalogue frais, et on ramène les
     quantités devenues trop grandes. */
  useEffect(() => {
    if (!repris || produits.length === 0) return;
    setPanier(prev => {
      let change = false;
      const maj = prev.map(l => {
        const a = articles.find(x => x.cle === l.cle);
        if (!a || a.stock === l.stockUnites) return l;
        change = true;
        /* Ce qui vient de dehors ne depend pas du rayon : le ramener au
           stock le ferait tomber a zero et disparaitre. */
        if (l.prisDehors) return { ...l, stockUnites: a.stock };
        const max = Math.max(1, Math.floor(a.stock / Math.max(1, l.contenance)));
        return { ...l, stockUnites: a.stock,
          quantiteDemandee: Math.min(l.quantiteDemandee, max) };
      /* Un produit épuisé depuis, ou retiré du catalogue, ne se vend plus —
         sauf celui qu'on va chercher dehors, que le rayon ne borne pas. */
      }).filter(l => l.prisDehors || l.stockUnites > 0);
      if (!change && maj.length === prev.length) return prev;
      return maj;
    });
  }, [repris, produits, articles]);

  const filtres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return articles.filter(a => {
      if (categorie && (a.produit.categorie ?? '') !== categorie) return false;
      if (!q) return true;
      return a.designation.toLowerCase().includes(q)
        || (a.produit.categorie ?? '').toLowerCase().includes(q);
    });
  }, [articles, recherche, categorie]);

  /* Le sous-total : la marchandise au prix du catalogue. C'est la base
     des pourcentages, jamais un total qui porterait déjà une remise. */
  const sousTotal = panier.reduce(
    (s, l) => s + l.quantiteDemandee * (l.prixVente ?? 0), 0);

  /* Les prix après réduction et frais annexes. Un seul calcul, le même
     que le cycle de vente : deux façons de répartir le même geste
     finiraient par se contredire, et c'est la marge qui mentirait. */
  const { prix: prixReels } = prixApresMontants(panier as any, montants);
  /* Ce qu'on encaisse vraiment. Les prix rendus SONT les prix de vente :
     c'est eux qui partent au mouvement, donc eux qui font le total. */
  const total = panier.reduce(
    (s, l, i) => s + l.quantiteDemandee * (prixReels[i] ?? l.prixVente ?? 0), 0);

  /* Le pied se cale sur ce que les lignes encaissent : l'arrondi des
     prix unitaires se loge dans la réduction, jamais dans un écart muet
     entre ce qu'on annonce et ce qu'on prend. */
  const pied = piedDocument(sousTotal, total, montants);
  const reductionRecu = pied.reduction;
  const fraisRecu = pied.frais;

  /* Ce que le reçu fait perdre.
     Une ligne vendue sous son coût creuse l'activité ; une autre vendue avec
     marge ne la comble pas — ce sont deux faits distincts, et compenser l'un
     par l'autre masquerait celui qui coûte. Seules les lignes en perte
     comptent donc ici.

     La comparaison porte sur le prix réel : une remise peut faire passer
     une ligne sous son coût, et c'est précisément ce qu'il faut voir. */
  const perte = panier.reduce((s, l, i) => {
    const manque = l.valeurUnitaire - (prixReels[i] ?? l.prixVente ?? 0);
    return manque > 0 ? s + manque * l.quantiteDemandee : s;
  }, 0);
  /* Au comptant, le client paie tout ; à crédit, il paie ce qu'il veut. */
  const paye = aCredit ? Math.min(encaisse, total) : total;
  const reste = Math.max(0, total - paye);
  const rendu = aCredit ? 0 : Math.max(0, encaisse - total);
  /* Une vente à crédit engage quelqu'un : sans nom, personne ne doit rien. */
  const clientRequis = aCredit;
  const pret = panier.length > 0
    && panier.every(l => (l.prixVente ?? 0) > 0)
    /* Une ligne prise dehors doit dire chez qui et a combien.
     *
       Sans le nom, la dette n'a personne a qui s'adresser. Sans le cout,
       la marge compte le prix de vente entier en benefice — l'erreur
       qu'on voulait justement eviter en ne passant pas « hors stock ». */
    && panier.every(l => !l.prisDehors
      || (!!l.fournisseurNom?.trim() && (l.valeurUnitaire ?? 0) > 0))
    && (!clientRequis || !!clientId)
    && !enCours;

  /** Ce qu'on peut encore prendre d'un article, dans l'emballage choisi. */
  /**
   * Ce qu'on peut vendre d'une ligne.
   *
   * Le stock, d'ordinaire : au comptoir la marchandise part tout de
   * suite, promettre ce qu'on n'a pas n'a pas de sens.
   *
   * Sauf quand la ligne dit d'ou vient le surplus. On traverse la rue le
   * prendre chez le voisin, on le vend dans la minute, et on le regle
   * apres — c'est une facon de vendre, pas un pret : le plafond du rayon
   * ne la concerne pas.
   */
  function plafond(stockUnites: number, contenance: number, duTiers = false) {
    if (duTiers) return Number.MAX_SAFE_INTEGER;
    return Math.floor(stockUnites / Math.max(1, contenance));
  }

  /**
   * Mettre un article au panier.
   *
   * `duTiers` quand le rayon est vide : la ligne naît alors en attente
   * de deux faits — chez qui on la prend, et a combien. Tant qu'ils
   * manquent, la vente ne part pas : vendre sans savoir ce qu'on doit au
   * voisin ferait un benefice qui n'existe pas.
   */
  function ajouter(a: Article, duTiers = false) {
    setFait(null);
    setPanier(prev => {
      const i = prev.findIndex(l => l.cle === a.cle);
      if (i >= 0) {
        const copie = [...prev];
        /* On ne vend pas ce qu'on n'a pas : au comptoir la marchandise part
           tout de suite, il n'y a pas de délai pour la réapprovisionner. */
        const max = plafond(copie[i].stockUnites, copie[i].contenance,
          !!copie[i].prisDehors);
        copie[i] = {
          ...copie[i],
          quantiteDemandee: Math.min(copie[i].quantiteDemandee + 1, max),
        };
        return copie;
      }
      /* Le plus petit emballage par défaut : c'est l'unité qu'on vend le
         plus souvent au comptoir, et on ne force personne à prendre un
         carton pour acheter une pièce. */
      return [...prev, {
        cle: a.cle,
        produitId: a.produit.id,
        /* Le voisin reste à nommer : la ligne porte la marque, pas
           encore le nom. C'est le panier qui le demande. */
        ...(duTiers ? { fournisseurId: null, fournisseurNom: null,
          prisDehors: true } : {}),
        designation: a.produit.designation,
        varianteCle: a.varianteCle,
        varianteLibelle: a.varianteLibelle,
        unite: a.produit.unite ?? 'unité',
        emballage: null,
        contenance: 1,
        quantiteDemandee: 1,
        valeurUnitaire: a.coutMoyen,
        /* Le même prix que la carte annonçait : le plus élevé des deux.
           En poser un autre ferait mentir l'écran qu'on vient de
           toucher. */
        prixVente: Math.max(a.prixVente, a.prixMarche ?? 0),
        prixUnitaire: Math.max(a.prixVente, a.prixMarche ?? 0),
        coutUnitaire: a.coutMoyen,
        stockUnites: a.stock,
        /* Les deux prix voyagent avec la ligne : le panier les montre
           quand on le déplie, pour qu'on sache d'où vient celui-là. */
        prixRecommande: a.prixVente,
        prixMarche: a.prixMarche ?? null,
      }];
    });
  }

  /**
   * Changer l'emballage d'une ligne.
   *
   * Le prix suit : un carton de 28 vaut 28 fois l'unité. Le modèle ne donne
   * pas de prix propre à l'emballage — un emballage n'est qu'un contenant,
   * pas un article distinct — donc il se déduit de la contenance.
   *
   * La quantité se ramène au plafond du nouvel emballage : 840 pièces font
   * 30 cartons, pas 840.
   */
  function changerEmballage(cle: string, nom: string | null) {
    setDetail(null);
    setPanier(prev => prev.map(l => {
      if (l.cle !== cle) return l;
      const emb = nom
        ? produits.find(x => x.id === l.produitId)?.emballages?.find(e => e.nom === nom)
        : null;
      const contenance = emb?.quantite ?? 1;
      const max = plafond(l.stockUnites, contenance, !!l.prisDehors);
      return {
        ...l,
        emballage: nom,
        contenance,
        /* Le prix et le coût se disent dans le contenant vendu. Laisser le
           coût à l'unité ferait opposer le prix d'un carton au coût d'une
           pièce, et la marge du dossier n'aurait plus de sens. */
        prixVente: l.prixUnitaire * contenance,
        valeurUnitaire: l.coutUnitaire * contenance,
        quantiteDemandee: Math.max(1, Math.min(l.quantiteDemandee, max)),
      };
    }));
  }

  /**
   * Nommer le voisin chez qui la ligne a ete prise.
   *
   * Le nom se tape librement : la liste propose ceux qu'on connait, mais
   * elle ne borne pas. Un voisin qui depanne pour la premiere fois n'a
   * pas de fiche, et s'arreter pour lui en creer une avant de servir le
   * client serait exactement ce qu'on cherche a eviter.
   *
   * L'identifiant suit quand le nom tombe sur quelqu'un de connu ; sinon
   * il reste nul, et la fiche naitra avec la vente — jamais avant. Un
   * panier abandonne ne doit laisser personne derriere lui.
   */
  function nommerFournisseur(cle: string, nom: string) {
    const propre = nom.trim();
    const connu = fournisseurs.find(
      f => f.nom.toLowerCase() === propre.toLowerCase());
    setPanier(prev => prev.map(l => l.cle === cle
      ? { ...l, fournisseurNom: propre || null,
          fournisseurId: connu?.id ?? null }
      : l));
  }

  /** Ce qu'on devra au voisin pour cette ligne, dans l'emballage vendu. */
  function changerCoutTiers(cle: string, montant: number) {
    setPanier(prev => prev.map(l => l.cle === cle
      ? { ...l, valeurUnitaire: Math.max(0, montant),
          /* Le cout a l'unite suit : changer d'emballage le remultiplie,
             et sans cette mise a jour il repartirait de l'ancien. */
          coutUnitaire: l.contenance > 0
            ? Math.max(0, montant) / l.contenance : Math.max(0, montant) }
      : l));
  }

  function changerQuantite(cle: string, q: number) {
    setDetail(null);
    setPanier(prev => prev
      .map(l => l.cle === cle
        ? {
            ...l,
            quantiteDemandee: Math.max(0,
              Math.min(q, plafond(l.stockUnites, l.contenance,
                !!l.prisDehors))),
          }
        : l)
      /* Zéro retire la ligne — c'est ce que disent la corbeille et le bouton
         moins descendu à bout. La saisie, elle, ne descend jamais sous un. */
      .filter(l => l.quantiteDemandee > 0));
  }

  function changerPrix(cle: string, p: number) {
    setDetail(null);
    /* On saisit le prix de ce qu'on vend — le carton, si c'est un carton
       qu'on vend. L'unitaire en découle, et c'est lui qui resservira si
       l'emballage change ensuite. */
    setPanier(prev => prev.map(l => l.cle === cle
      ? { ...l, prixVente: p, prixUnitaire: p / Math.max(1, l.contenance) }
      : l));
  }

  function vider() {
    setPanier([]); setClientId(''); setACredit(false); setEncaisse(0); setErreur('');
    /* La remise appartient au client qu'on vient de servir : la laisser
       la ferait accorder au suivant sans que personne ne l'ait voulu. */
    setMontants([]); setMontantsOuverts(false);
  }

  async function valider() {
    if (!pret) return;
    setEnCours(true); setErreur('');
    try {
      const date = aujourdhui();
      const c = clients.find(x => x.id === clientId);
      const auteur = await auteurEtape(siteId, user!.uid, user!.displayName);
      const reference = referenceFlux('VC', date);

      /* Ce que le client emporte est ce qu'il a demandé : au comptoir, la
         quantité reçue ne diffère jamais de la quantité voulue.

         Le prix enregistré est celui d'après remise. Ce n'est pas un
         prix catalogue amputé de quelque chose : c'est le prix auquel
         on a vendu, et c'est lui qui part au mouvement, dans la marge,
         dans le tableau de bord. Le reçu garde l'explication ; rien en
         aval n'a besoin de la connaître. */
      /* Les voisins qu'on vient de nommer et qui n'avaient pas de fiche.
       *
         Elle nait ici, au moment ou la vente part — jamais avant. Un
         panier abandonne, une ligne effacee, un comptoir qu'on quitte :
         rien ne doit laisser derriere lui un fournisseur que personne
         n'a jamais vu.
       *
         Occasionnel : il a depanne une fois, il n'est pas encore du
         carnet. S'il revient souvent, on le promeut depuis sa page, et
         son identifiant ne bouge pas — tout l'historique suit. */
      const nes = new Map<string, string>();
      for (const l of panier) {
        if (!l.prisDehors || l.fournisseurId) continue;
        const nom = l.fournisseurNom?.trim();
        if (!nom || nes.has(nom.toLowerCase())) continue;
        const ref = await addDoc(collection(db, 'partenaires'), {
          userId: user!.uid,
          siteId,
          nom,
          contact: '',
          rolesFournisseur: true,
          rolesClient: false,
          categoriesFournisseur: [],
          categoriesClient: [],
          prochainRecouvrement: null,
          occasionnel: true,
          ...(await auteurCourant(siteId, user!.uid, user!.displayName)),
          apporteur: null,
          createdAt: serverTimestamp(),
        });
        nes.set(nom.toLowerCase(), ref.id);
      }
      if (nes.size > 0) {
        setFournisseurs(f => [...f,
          ...[...nes].map(([nom, id]) => ({ id, nom, occasionnel: true }))]
          .sort((a, b) => a.nom.localeCompare(b.nom)));
      }

      /* Ce que le client emporte, et pour les lignes prises dehors, chez
         qui — l'identifiant tout juste cree ou celui qu'on connaissait. */
      const lignes: LigneFlux[] = panier.map(
        ({ cle, stockUnites, contenance, prixUnitaire, coutUnitaire,
          prisDehors, ...l }, i) => ({
          ...l,
          ...(prisDehors ? {
            fournisseurId: l.fournisseurId
              ?? nes.get((l.fournisseurNom ?? '').trim().toLowerCase())
              ?? null,
          } : {}),
          prixVente: prixReels[i] ?? l.prixVente ?? 0,
          quantiteRecue: l.quantiteDemandee,
        }));

      /* La vente naît en préparation le temps d'être livrée : `livrerVente`
         n'accepte pas un état inventé pour l'occasion, et en inventer un
         obligerait chaque écran du cycle à le connaître. */
      const donnees = {
        reference,
        siteId,
        clientId: clientId || null,
        clientNom: c?.nom ?? 'Client de passage',
        etat: 'preparation' as const,
        lignes,
        /* Ce qu'on a accordé, et la base sur laquelle les pourcentages
           ont été résolus. Les lignes portent déjà le prix d'après
           remise : ceci n'explique que le chemin. */
        montants,
        sousTotalOrigine: sousTotal,
        avanceVersee: 0,
        versements: [],
        devisId: null,
        validiteDevis: null,
        dateDevis: null,
        dateCommande: date,
        dateLivraisonPrevue: date,
        parDevis: null,
        parCommande: user!.uid,
        auteurDevis: null,
        auteurCommande: auteur,
        /* Le comptoir se reconnaît : la vente n'a traversé aucune étape. */
        auComptoir: true,
        note: null,
        userId: user!.uid,
        createdAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, 'ventes'), donnees);

      /* Tout ce qui suit s'inscrit localement d'abord : Firestore garde ses
         écritures et les envoie au retour du réseau. Mais il ne rend la
         main qu'une fois le serveur joint — et `livrerVente` lit le stock
         avant de l'écrire. Hors ligne, cette lecture n'aboutit jamais.

         On laisse donc la chaîne se dérouler seule. Elle finira, réseau ou
         pas ; l'écran, lui, n'a pas à l'attendre. */
      const ecriture = (async () => {
        await synchroniserLignes({
          neuve: true,
          venteId: ref.id,
          lignes: lignes.map((l, i) => ligneDepuisVente({
            siteId, venteId: ref.id, ligneIndex: i, ligne: l,
            emballages: produits.find(x => x.id === l.produitId)?.emballages ?? [],
            clientId: clientId || null, clientNom: c?.nom ?? null,
          })),
        });

        /* La marchandise part maintenant : le stock sort, la créance naît. */
        await livrerVente({
          vente: { id: ref.id, ...donnees } as unknown as Vente,
          userId: user!.uid,
          par: user!.uid,
          utilisateurNom: auteur.nom,
          utilisateurFonction: auteur.fonction,
          mode: 'retrait',
        });

        /* L'argent entre après la livraison : la marchandise étant partie,
           ce n'est plus une avance mais un règlement. */
        if (paye > 0) {
          await enregistrerVersement({
            adminUid: activite?.adminUid ?? null,
          siteId, userId: user!.uid, date,
          montant: paye,
          sens: 'entree',
          /* La marchandise part dans le même geste : ce n'est pas une dette
             qu'on éteint, c'est un achat qu'on paie. */
          motif: 'vente',
          partenaireId: clientId || '',
          partenaireNom: c?.nom ?? 'Client de passage',
          role: 'client',
          achatId: null,
          venteId: ref.id,
          reference,
          par: user!.uid,
            utilisateurNom: auteur.nom,
            utilisateurFonction: auteur.fonction,
          });
        }
      })();

      /* On rend la main tout de suite : le caissier a un client devant lui.
       *
       * La chaîne fait quatre gestes qui s'attendent — les lignes, le
       * stock, le numéro de caisse, le versement. L'attendre coûtait deux
       * à trois secondes par vente, et un caissier qui en fait cinquante
       * passe deux minutes de sa journée à regarder un bouton gris.
       *
       * Ce qu'il faut garantir n'est pas que le réseau ait répondu, c'est
       * que rien ne se perde. Trois choses s'en chargent : Firestore garde
       * ses écritures et les envoie quand il peut ; le versement et le
       * total du dossier s'écrivent désormais ensemble, donc plus de trou
       * entre les deux ; et `reprendreVentesComptoir` reprend à
       * l'ouverture suivante aussi bien la vente restée en préparation que
       * celle qui est livrée sans son argent.
       *
       * On laisse un instant à la chaîne — de quoi conclure quand la
       * connexion est bonne — puis on libère l'écran. */
      /* Ce qui rend une vente « différée », c'est l'absence de réseau —
         pas le fait qu'elle n'ait pas fini dans le court délai qu'on lui
         laisse. En ligne, l'écriture dure presque toujours plus que ce
         délai : s'y fier faisait annoncer « partira au retour du réseau »
         à chaque vente, réseau présent, et le message devenait faux une
         fois sur deux. Un avertissement qui se trompe n'avertit plus. */
      await sansAttendreLeReseau(ecriture, 300);
      if (!enLigne) setDiffere(true);

      /* Un échec ne disparaît pas en silence : le vendeur croirait la
         vente conclue. On le dit, et la reprise s'en chargera. */
      ecriture.catch(() => {
        setErreur(
          `Vente ${reference} : l'enregistrement n'a pas abouti. `
          + 'Elle sera reprise à la réouverture du comptoir.');
      });

      /* Ce que le client emporte sans l'avoir paye est une creance : on
         demande comment elle sera recouvree maintenant, pendant qu'il est
         la. Un cycle deja lance sait quoi faire, on ne redemande pas. */
      const du = total - paye;
      if (du > 0 && clientId) {
        const nom = c?.nom ?? 'Client';
        const id = clientId;
        lireChoix(siteId, id, 'client')
          .then(ch => {
            if (!ch.cycleEnCours) {
              setAPlanifier({ montant: du, clientId: id, clientNom: nom });
            }
          })
          .catch(() => {});
      }

      setFait({ ref: reference, total, rendu });
      vider();
    } catch (e: any) {
      setErreur(e?.message ?? 'Vente impossible.');
    } finally {
      setEnCours(false);
    }
  }

  /* La déconnexion vide l'utilisateur avant que la navigation aboutisse. */
  if (!user) return null;

  /* Le comptoir encaisse : il appartient à qui répond du site. */
  if (roleLu && role != null && role !== 'gerant') return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Le comptoir n'est pas ouvert à ce rôle.</p>
      <button onClick={() => router.push(retourCycle)}
        className="px-4 py-2 text-xs font-bold text-indigo-600 hover:underline">
        Retour au cycle de vente
      </button>
    </div>
  );

  if (loading || !roleLu) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

    /* Créer un client sans quitter le comptoir.
   *
   * Un client qui n'a pas encore de fiche arrivait au pire moment : il
   * fallait ouvrir les partenaires, créer, revenir, retrouver le panier.
   * La fiche naît ici, avec le nom tapé dans la recherche, et la vente
   * continue.
   *
   * Elle naît cliente, et rien d'autre. Un fournisseur se déclare où on
   * le connaît — ici on ne sait qu'une chose, c'est que cette personne
   * achète. */
  async function creerClient(nom: string): Promise<string | null> {
    const propre = nom.trim();
    if (!propre || !user) return null;

    /* Deux fiches du même nom deviendraient deux historiques pour une
       seule personne, et la dette se lirait à moitié. On rend celle qui
       existe plutôt que d'en ouvrir une autre. */
    const cle = propre.toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
    const deja = clients.find(c =>
      c.nom.trim().toLowerCase().normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ') === cle);
    if (deja) {
      setErreur(`« ${deja.nom} » existe déjà.`);
      return deja.id;
    }

    try {
      const ref = await addDoc(collection(db, 'partenaires'), {
        userId: user.uid,
        siteId,
        nom: propre,
        contact: '',
        rolesFournisseur: false,
        rolesClient: true,
        categoriesFournisseur: [],
        categoriesClient: [],
        prochainRecouvrement: null,
        ...(await auteurCourant(siteId, user.uid, user.displayName)),
        apporteur: null,
        createdAt: serverTimestamp(),
      });
      setClients(l => [...l, { id: ref.id, nom: propre }]
        .sort((a, b) => a.nom.localeCompare(b.nom)));
      setErreur('');
      return ref.id;
    } catch (e: unknown) {
      setErreur(e instanceof Error ? e.message : 'Création impossible.');
      return null;
    }
  }

  /* Une ligne du panier, dessinée une fois pour les deux endroits où
     elle vit : la colonne étroite, et le modal qui l'élargit. La
     recopier aurait laissé les deux versions diverger au premier
     changement — et c'est l'écran où l'on encaisse. */
  function ligneDuPanier(l: typeof panier[number]) {
    const max = plafond(l.stockUnites, l.contenance, !!l.prisDehors);
    const auPlafond = l.quantiteDemandee >= max;
    /* Ceux de cette déclinaison : les communs, plus les
       siens. Un carton de 10W n'a pas le même contenu
       qu'un carton de 30W. */
    const embs = emballagesDe(
      produits.find(x => x.id === l.produitId)?.emballages,
      l.varianteCle);
    const uniteNom = (l.unite?.trim() || 'unité').toLowerCase();
    /* Le coût de ce qu'on vend : un carton a coûté vingt-huit
       fois ce qu'a coûté la pièce. */
    const coutLigne = l.valeurUnitaire;
    const aPerte = (l.prixVente ?? 0) < coutLigne;
    /* Chaque ligne est une marchandise, pas une rangée de tableau : un
       fond et une bordure franche la détachent de sa voisine. À six
       articles alignés, un contour trop pâle les faisait lire comme un
       bloc, et l'œil ne retrouvait plus la sienne. */
    return (
      <div key={l.cle} className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 transition-colors hover:border-indigo-200 dark:border-gray-700 dark:bg-gray-800/40 dark:hover:border-indigo-800">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-bold leading-tight text-gray-900 dark:text-gray-100 flex items-start gap-1">
            {/* Ce qu'a coûté la marchandise ne se montre pas en
                permanence : on le consulte au moment de fixer un
                prix, pas à chaque ligne du panier. */}
            <button onClick={() => setDetail(detail === l.cle ? null : l.cle)}
              data-detail-cout title="Prix d'achat"
              className={`shrink-0 mt-px transition-colors ${detail === l.cle
                ? 'text-indigo-600 dark:text-indigo-400'
                : 'text-gray-300 hover:text-indigo-500'}`}>
              <Info size={12} />
            </button>
            <span>
              {l.designation}{l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''}
            </span>
          </p>
          <button onClick={() => changerQuantite(l.cle, 0)}
            className="text-gray-300 hover:text-red-500 shrink-0">
            <Trash2 size={13} />
          </button>
        </div>

        {detail === l.cle && (() => {
          /* Le prix affiché est le plus élevé des deux : on
             dit lesquels, pour qu'on sache d'où il vient et
             qu'on puisse le discuter. Les deux suivent
             l'emballage, comme le coût. */
          const par = l.emballage
            ? ` / ${l.emballage.toLowerCase()}` : ` / ${uniteNom}`;
          /* Les lignes posées avant que les deux prix
             voyagent n'ont que celui qu'elles portent : on
             s'y replie plutôt que de cacher la ligne. */
          const reco = (l.prixRecommande ?? l.prixUnitaire ?? 0) * l.contenance;
          const marche = (l.prixMarche ?? 0) * l.contenance;
          const retenu = Math.max(reco, marche);
          return (
            <div data-detail-cout
              className="mt-1.5 flex flex-col gap-1 rounded-lg bg-gray-50 px-2 py-1.5 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Prix d&apos;achat{par}</span>
                <span className="text-xs font-bold text-gray-900 dark:text-gray-100">
                  {formatMontant(coutLigne)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Prix recommandé</span>
                <span className={`text-xs font-bold ${reco > 0 && retenu === reco
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-gray-500'}`}>
                  {reco > 0 ? formatMontant(reco) : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Prix du marché</span>
                <span className={`text-xs font-bold ${marche > 0 && retenu === marche
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-gray-500'}`}>
                  {marche > 0 ? formatMontant(marche) : '—'}
                </span>
              </div>
            </div>
          );
        })()}

        {/* D'ou vient cette marchandise, et ce qu'elle nous coute.
         *
           Deux champs, pas un ecran : le client est devant le comptoir.
           Le nom se tape — s'il n'existe pas, il naitra avec la vente —
           et le cout est ce qu'on devra au voisin, jamais ce qu'on
           revend. La difference est notre marge.
         *
           Le fond ambre dit que cette ligne n'est pas comme les autres,
           sans avoir a l'ecrire. */}
        {l.prisDehors && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/60 p-2 dark:border-amber-800/40 dark:bg-amber-900/10">
            <p className="mb-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-500">
              Pris dehors
            </p>
            <div className="flex items-center gap-1.5">
              <input list={`fourn-${l.cle}`} value={l.fournisseurNom ?? ''}
                onChange={e => nommerFournisseur(l.cle, e.target.value)}
                placeholder="Chez qui ?"
                className="min-w-0 flex-1 rounded-lg border border-amber-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-800/40 dark:bg-gray-800" />
              <datalist id={`fourn-${l.cle}`}>
                {fournisseurs.map(f => <option key={f.id} value={f.nom} />)}
              </datalist>
              {/* Ce qu'on lui devra, dans l'emballage vendu : un carton
                  coute ce que coute le carton. */}
              <ChampNombre valeur={l.valeurUnitaire ?? 0}
                onChange={n => changerCoutTiers(l.cle, n)}
                className="w-24 shrink-0 rounded-lg border border-amber-200 bg-white px-2 py-1 text-xs text-center focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-800/40 dark:bg-gray-800" />
            </div>
          </div>
        )}

        {/* L'emballage qu'on vend. Le plus petit par défaut ;
            en changer refait le prix et ramène la quantité. */}
        {embs.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            <button onClick={() => changerEmballage(l.cle, null)}
              className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors ${!l.emballage
                ? 'bg-indigo-600 text-white'
                : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
              {uniteNom}
            </button>
            {embs.map(e => (
              <button key={e.nom} onClick={() => changerEmballage(l.cle, e.nom)}
                disabled={!l.prisDehors && l.stockUnites < e.quantite}
                className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${l.emballage === e.nom
                  ? 'bg-indigo-600 text-white'
                  : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
                {e.nom.toLowerCase()}×{e.quantite}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mt-2">
          <div className="flex items-center gap-1">
            <button onClick={() => changerQuantite(l.cle, l.quantiteDemandee - 1)}
              className="p-1 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
              <Minus size={11} />
            </button>
            {/* Une ligne se retire par la corbeille, pas en
                vidant sa quantité : on efface pour retaper. */}
            <ChampNombre valeur={l.quantiteDemandee} min={1}
              onChange={n => changerQuantite(l.cle, n)}
              className="w-24 px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-center focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button onClick={() => changerQuantite(l.cle, l.quantiteDemandee + 1)}
              disabled={auPlafond}
              className="p-1 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed">
              <Plus size={11} />
            </button>
          </div>
          {/* Vendre sous le coût reste permis — on écoule un
              fond de stock, on arrange un client — mais jamais
              sans le savoir. */}
          <ChampNombre valeur={l.prixVente ?? 0}
            onChange={n => changerPrix(l.cle, n)}
            className={`w-24 px-2 py-1 rounded-lg border text-xs text-center focus:outline-none focus:ring-2 ${aPerte
              ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 focus:ring-red-500'
              : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 focus:ring-indigo-500'}`} />
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
          <span className={`text-xs ${
            l.prisDehors ? 'text-amber-600 dark:text-amber-500'
              : auPlafond ? 'text-orange-500' : 'text-gray-400'}`}>
            {/* Le rayon ne borne pas ce qu'on va chercher dehors :
                annoncer « 0 dispo. » dirait le contraire de ce que la
                ligne permet. */}
            {l.prisDehors
              ? (l.fournisseurNom ? `chez ${l.fournisseurNom}` : 'à nommer')
              : auPlafond
              ? 'tout le stock'
              : `${max} ${l.emballage ? l.emballage.toLowerCase() : uniteNom} dispo.`}
          </span>
          <span className="text-sm font-bold tabular-nums text-indigo-600 dark:text-indigo-400">
            {formatMontant(l.quantiteDemandee * (l.prixVente ?? 0))}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">

      {/* Le comptoir vit hors du cadre commun : il porte son bandeau
          lui-même. C'est l'écran où le silence coûte le plus cher — une
          vente qu'on croit perdue se ressaisit. */}
      {!enLigne && (
        <div className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-xs font-bold text-white">
          <WifiOff size={13} className="shrink-0" />
          Hors ligne — les ventes sont prises et partiront au retour du réseau.
        </div>
      )}

      <header className="sticky top-0 z-30 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={() => router.push(retourCycle)}
              className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              <ArrowLeft size={18} />
            </button>
            <ShoppingCart size={18} className="text-indigo-500" />
            <h1 className="text-lg font-bold">Comptoir</h1>
          </div>
          {/* Le client tient dans l'en-tête, à l'autre bout : on y touche
              une fois par vente, et une barre entière pour lui seul
              repoussait le catalogue — là où se passe tout le travail. */}
          <div className="ml-auto w-44 sm:w-56">
            <SelectCherchable valeur={clientId} onChange={setClientId}
              options={clients.map(c => ({ valeur: c.id, label: c.nom }))}
              placeholder={aCredit ? 'Choisir le client…' : 'Client de passage'}
              vide="Aucun client" effacable
              surCreer={creerClient} creerLibelle="Nouveau client" />
          </div>
          {/* Une vente différée est prise, pas perdue : le dire en jaune
              plutôt qu'en vert évite de la croire partie — et de la
              ressaisir. */}
          {fait && (
            <div className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 ${
              differe
                ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-900/20'
                : 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-900/20'}`}>
              {differe
                ? <WifiOff size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
                : <Check size={14} className="shrink-0 text-green-600 dark:text-green-400" />}
              <span className={`text-xs font-bold ${
                differe
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-green-700 dark:text-green-400'}`}>
                {fait.ref} · {formatMontant(fait.total)}
                {fait.rendu > 0 ? ` · rendu ${formatMontant(fait.rendu)}` : ''}
                {differe ? ' · partira au retour du réseau' : ''}
              </span>
              <button onClick={() => { setFait(null); setDiffere(false); }}
                className={`shrink-0 hover:opacity-60 ${
                  differe
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-green-600 dark:text-green-400'}`}>
                <X size={13} />
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="w-full p-4 sm:p-6 lg:p-8 grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* ─────────── Catalogue ─────────── */}
        <div className="lg:col-span-3 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4">
          <ChampRecherche valeur={recherche} onChange={setRecherche}
            placeholder="Chercher un produit…" />

          {/* Les rayons du magasin. « Tout » d'abord : c'est l'état par
              défaut, et y revenir doit être le geste le plus court.

              Sur une seule ligne qui défile, pas sur quatre. Au comptoir
              on sert debout : quinze rayons repliés poussaient le premier
              produit hors de l'écran, et il fallait descendre avant de
              pouvoir vendre. Un doigt fait glisser la bande, un autre
              choisit — là où un menu déroulant aurait demandé d'ouvrir
              puis de choisir, et aurait caché ce qui existe. */}
          {categories.length > 0 && (
            <div className="relative mt-3">
            <button type="button" onClick={() => glisser(-1)}
              aria-label="Rayons précédents"
              className="absolute left-0 top-1/2 z-10 hidden -translate-y-1/2
                rounded-full border border-gray-200 bg-white/95 p-1
                text-gray-500 shadow-sm hover:text-indigo-600 sm:block
                dark:border-gray-700 dark:bg-gray-900/95">
              <ChevronLeft size={16} />
            </button>
            <button type="button" onClick={() => glisser(1)}
              aria-label="Rayons suivants"
              className="absolute right-0 top-1/2 z-10 hidden -translate-y-1/2
                rounded-full border border-gray-200 bg-white/95 p-1
                text-gray-500 shadow-sm hover:text-indigo-600 sm:block
                dark:border-gray-700 dark:bg-gray-900/95">
              <ChevronRight size={16} />
            </button>
            <div ref={bandeRayons}
              onWheel={e => {
                /* La molette descend la page par défaut : sur une bande
                   horizontale, elle ne ferait rien de visible. */
                if (e.deltaY === 0) return;
                e.currentTarget.scrollLeft += e.deltaY;
              }}
              className="flex gap-1.5 overflow-x-auto pb-1 sm:px-7
              [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {[{ cle: '', label: 'Tout' },
                ...categories.map(c => ({ cle: c, label: c }))].map(c => {
                const n = c.cle
                  ? articles.filter(a => (a.produit.categorie ?? '') === c.cle).length
                  : articles.length;
                return (
                  <button key={c.cle || 'tout'} onClick={() => setCategorie(c.cle)}
                    className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${categorie === c.cle
                      ? 'bg-indigo-600 text-white'
                      : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
                    {c.label}
                    <span className={`ml-1.5 font-medium ${categorie === c.cle
                      ? 'text-indigo-200' : 'text-gray-400'}`}>{n}</span>
                  </button>
                );
              })}
            </div>
            </div>
          )}

          {/* Le compte vit sur l'onglet choisi, qui le porte déjà : le
              répéter dessous disait deux fois la même chose. */}
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto">
            {filtres.map(a => {
              const epuise = a.stock <= 0;
              return (
                /* Un article epuise reste vendable : on le prend chez le
                   voisin. Le clic l'ajoute en demandant chez qui et a
                   combien — le rayon est vide, la vente ne l'est pas. */
                <button key={a.cle} onClick={() => ajouter(a, epuise)}
                  className={`text-left p-3 rounded-xl border transition-colors ${epuise
                    ? 'border-dashed border-amber-300 hover:border-amber-400 hover:bg-amber-50/50 dark:border-amber-800/50 dark:hover:bg-amber-900/10'
                    : 'border-gray-200 dark:border-gray-700 hover:border-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/10'}`}>
                  <p className="text-xs font-bold leading-tight line-clamp-2">{a.designation}</p>
                  {/* Le plus élevé des deux : si le marché paie mieux que
                      ce qu'on recommande, le refuser serait laisser de
                      l'argent sur la table. Le vendeur reste libre de
                      changer le prix au panier. */}
                  <p className="text-xs text-indigo-600 dark:text-indigo-400 font-bold mt-1">
                    {formatMontant(Math.max(a.prixVente, a.prixMarche ?? 0))}
                    {/* Le stock se dit en cartons, le prix à l'unité : sans
                        cette mention, on lit l'un pour l'autre. */}
                    <span className="font-medium text-gray-400">
                      {' / '}{(a.produit.unite?.trim() || 'unité').toLowerCase()}
                    </span>
                  </p>
                  {/* Le stock se lit dans les emballages du produit : personne
                      ne compte en unités de base devant une étagère. */}
                  <p className="text-xs text-gray-400 mt-0.5 leading-tight">
                    {epuise
                      ? <span className="font-medium text-amber-600 dark:text-amber-500">
                          épuisé · à prendre dehors
                        </span>
                      : stockLisible(a.stock, a.produit.emballages, a.produit.unite).join(' · ')}
                  </p>
                </button>
              );
            })}
            {filtres.length === 0 && (
              <div className="col-span-full py-10 text-center">
                <Package size={22} className="mx-auto text-gray-300 dark:text-gray-700" />
                <p className="text-xs text-gray-400 mt-2">Aucun produit</p>
              </div>
            )}
          </div>
        </div>

        {/* ─────────── Panier ─────────── */}
        <div className="lg:col-span-2 space-y-4">

          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="flex items-center gap-1.5 text-xs font-bold text-gray-500 dark:text-gray-400">
                {/* Le panier en grand : la colonne est étroite et bornée
                    en hauteur, et c'est quand le total surprend qu'on
                    veut relire toute la facture d'un coup. */}
                {panier.length > 0 && (
                  <button onClick={() => setPanierOuvert(true)}
                    title="Voir tout le panier"
                    className="text-gray-300 transition-colors hover:text-indigo-500">
                    <Maximize2 size={13} />
                  </button>
                )}
                Panier{panier.length > 0 ? ` (${panier.length})` : ''}
              </p>
              {panier.length > 0 && (
                <button onClick={vider} className="text-xs font-bold text-gray-400 hover:text-red-500">
                  Vider
                </button>
              )}
            </div>

            {panier.length === 0 ? (
              <p className="py-8 text-center text-xs text-gray-400">
                Choisissez un produit dans le catalogue.
              </p>
            ) : (
              <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                {panier.map(l => ligneDuPanier(l))}
              </div>
            )}
          </div>

          {/* ─────────── Paiement ─────────── */}
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4">

            <div className="pb-3 mb-3 border-b border-gray-100 dark:border-gray-800">
              <div className="flex justify-between items-baseline">
                <span className="flex items-center gap-1.5 text-xs font-bold text-gray-500 dark:text-gray-400">
                  Total
                  {/* Ce que le reçu dégage ne se lit pas en vendant : on
                      l'ouvre quand on doute d'un prix, pas à chaque ligne. */}
                  {panier.length > 0 && (
                    <button onClick={() => setMarge(true)} title="Marge du reçu"
                      className="text-gray-300 hover:text-indigo-500 transition-colors">
                      <BarChart3 size={13} />
                    </button>
                  )}
                </span>
                <span className="text-xl font-bold">{formatMontant(total)}</span>
              </div>

              {/* Ce qu'on a accordé et ce qu'on a facturé en plus. Le
                  détail du catalogue n'apparaît que si une remise
                  existe : sinon le total se suffit, et trois lignes
                  pour dire la même chose encombreraient un écran où
                  l'on sert un client qui attend. */}
              {(reductionRecu > 0 || fraisRecu > 0) && (
                <div className="mt-1.5 space-y-0.5 text-xs">
                  <div className="flex items-baseline justify-between text-gray-400">
                    <span>Sous-total</span>
                    <span className="tabular-nums">{formatMontant(sousTotal)}</span>
                  </div>
                  {reductionRecu > 0 && (
                    <div className="flex items-baseline justify-between">
                      <span className="text-gray-400">Réduction</span>
                      <span className="font-bold tabular-nums text-red-500">
                        −{formatMontant(reductionRecu)}
                      </span>
                    </div>
                  )}
                  {fraisRecu > 0 && (
                    <div className="flex items-baseline justify-between">
                      <span className="text-gray-400">Frais annexes</span>
                      <span className="font-bold tabular-nums text-indigo-600">
                        +{formatMontant(fraisRecu)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Ce que le reçu coûte à l'activité. Il ne s'affiche qu'en
                  existant : montré à zéro, il passerait inaperçu le jour où
                  il compte.

                  Une remise peut le faire apparaître : c'est exactement
                  ce qu'on veut voir avant de valider. */}
              {perte > 0 && (
                <div className="flex justify-between items-baseline mt-1">
                  <span className="text-xs font-bold text-red-500">Perte sur ce reçu</span>
                  <span className="text-xs font-bold text-red-500">{formatMontant(perte)}</span>
                </div>
              )}

              {/* Une ligne, pas un panneau : la remise est l'exception au
                  comptoir. Elle s'ouvre quand on en a besoin et se
                  referme derrière soi. */}
              {panier.length > 0 && (
                <button onClick={() => setMontantsOuverts(o => !o)}
                  className={`mt-2 flex items-center gap-1 text-[11px] font-bold transition-colors ${montants.length > 0
                    ? 'text-indigo-600 hover:text-indigo-700'
                    : 'text-gray-400 hover:text-indigo-600'}`}>
                  <Percent size={11} />
                  {montants.length > 0
                    ? `${montants.length} ${montants.length > 1 ? 'montants appliqués' : 'montant appliqué'}`
                    : 'Remise ou frais'}
                </button>
              )}
            </div>

            {/* Valider juste sous le total : c'est le montant qu'on
                regarde en encaissant, et le geste suit. Plus bas, un
                panier de dix articles poussait le bouton hors de
                l'écran ; plus haut, dans l'en-tête, il voisinait la
                flèche qui sort — et au comptoir, pressé, on touche à
                côté. */}
            {aCredit && !clientId && panier.length > 0 ? (
              <p className="mb-2 text-xs font-bold text-red-500">
                Client obligatoire
              </p>
            ) : null}
            <button onClick={valider} disabled={!pret}
              className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-7 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
              {enCours ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              Valider
            </button>

            {montantsOuverts && panier.length > 0 && (
              <div className="-mt-1 mb-3">
                <PanneauMontants
                  siteId={siteId} userId={user?.uid ?? ''}
                  montants={montants} sousTotal={sousTotal}
                  onChange={setMontants} />
              </div>
            )}

            {/* Comptant ou crédit : au comptoir l'un est la règle, l'autre
                l'exception, et l'exception demande un nom. */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button onClick={() => { setACredit(false); setEncaisse(0); }}
                className={`py-2 rounded-xl text-xs font-bold transition-colors ${!aCredit
                  ? 'bg-indigo-600 text-white'
                  : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
                Encaissé
              </button>
              <button onClick={() => { setACredit(true); setEncaisse(0); }}
                className={`py-2 rounded-xl text-xs font-bold transition-colors ${aCredit
                  ? 'bg-indigo-600 text-white'
                  : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
                À crédit
              </button>
            </div>

            {aCredit ? (
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-gray-500 dark:text-gray-400">
                    Part récupérée maintenant
                  </label>
                  {total > 0 && (
                    <button onClick={() => setEncaisse(0)}
                      className="text-xs font-bold text-indigo-600 hover:underline">
                      Rien
                    </button>
                  )}
                </div>
                <ChampNombre valeur={encaisse} onChange={setEncaisse} max={total}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <div className="flex justify-between mt-2 text-xs">
                  <span className="text-gray-400">Reste dû</span>
                  <span className={`font-bold ${reste > 0 ? 'text-orange-500' : 'text-green-600'}`}>
                    {formatMontant(reste)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mb-3">
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">
                  Reçu du client
                </label>
                <ChampNombre valeur={encaisse} onChange={setEncaisse}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <div className="flex justify-between mt-2 text-xs">
                  <span className="text-gray-400">À rendre</span>
                  <span className="font-bold text-gray-900 dark:text-gray-100">
                    {formatMontant(rendu)}
                  </span>
                </div>
              </div>
            )}

            {erreur ? <p className="mt-2 text-xs text-red-500">{erreur}</p> : null}
          </div>
        </div>
      </div>
      {/* Le panier en grand.
          Deux colonnes là où la carte n'en tenait qu'une, et toute la
          hauteur de l'écran : on relit la facture entière sans faire
          défiler, et on corrige sur place. Ce sont les mêmes lignes,
          les mêmes gestes — rien n'est recopié. */}
      {panierOuvert && (
        <div className="fixed inset-0 z-50 flex items-end justify-center
          bg-black/40 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          onClick={() => setPanierOuvert(false)}>
          <div onClick={e => e.stopPropagation()}
            className="flex max-h-[92vh] w-full max-w-4xl flex-col
              rounded-t-2xl bg-white shadow-xl dark:bg-gray-900
              sm:rounded-2xl">

            <div className="flex items-center justify-between border-b
              border-gray-100 px-5 py-4 dark:border-gray-800">
              <div className="flex items-center gap-2">
                <ShoppingCart size={16} className="text-indigo-500" />
                <h2 className="text-sm font-bold">
                  Panier ({panier.length})
                </h2>
              </div>
              <div className="flex items-center gap-3">
                {panier.length > 0 && (
                  <button onClick={vider}
                    className="text-xs font-bold text-gray-400 hover:text-red-500">
                    Vider
                  </button>
                )}
                <button onClick={() => setPanierOuvert(false)}
                  className="rounded-lg p-1 text-gray-400 transition-colors
                    hover:bg-gray-100 dark:hover:bg-gray-800">
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {panier.length === 0 ? (
                <p className="py-12 text-center text-xs text-gray-400">
                  Choisissez un produit dans le catalogue.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {panier.map(l => ligneDuPanier(l))}
                </div>
              )}
            </div>

            {/* Le total ferme la liste, comme sur un reçu. */}
            <div className="border-t border-gray-100 px-5 py-4
              dark:border-gray-800">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-bold text-gray-500
                  dark:text-gray-400">Total</span>
                <span className="text-xl font-bold">{formatMontant(total)}</span>
              </div>
              {(reductionRecu > 0 || fraisRecu > 0) && (
                <div className="mt-1.5 space-y-0.5 text-xs">
                  <div className="flex items-baseline justify-between text-gray-400">
                    <span>Sous-total</span>
                    <span className="tabular-nums">{formatMontant(sousTotal)}</span>
                  </div>
                  {reductionRecu > 0 && (
                    <div className="flex items-baseline justify-between">
                      <span className="text-gray-400">Réduction</span>
                      <span className="font-bold tabular-nums text-red-500">
                        −{formatMontant(reductionRecu)}
                      </span>
                    </div>
                  )}
                  {fraisRecu > 0 && (
                    <div className="flex items-baseline justify-between">
                      <span className="text-gray-400">Frais annexes</span>
                      <span className="font-bold tabular-nums">
                        {formatMontant(fraisRecu)}
                      </span>
                    </div>
                  )}
                </div>
              )}
              <button onClick={() => setPanierOuvert(false)}
                className="mt-3 w-full rounded-xl border border-gray-200
                  py-2.5 text-sm font-bold text-gray-600 transition-colors
                  hover:border-indigo-400 hover:text-indigo-600
                  dark:border-gray-700 dark:text-gray-300">
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      {marge && (
        <ModalMargeRecu onFermer={() => setMarge(false)}
          lignes={panier.map((l, i) => ({
            cle: l.cle,
            designation: l.designation,
            varianteLibelle: l.varianteLibelle,
            emballage: l.emballage,
            quantiteDemandee: l.quantiteDemandee,
            /* Le coût et le prix de ce qu'on vend : un carton, pas une pièce.
               Le prix est celui d'après remise : lire le catalogue
               annoncerait une marge qu'on n'encaisse pas. */
            cout: l.valeurUnitaire,
            prix: prixReels[i] ?? l.prixVente ?? 0,
          }))} />
      )}

      {/* Comment cette creance sera recouvree : demande au comptoir meme,
          seul endroit ou la vente se conclut sans passer par une fiche. */}
      {aPlanifier && (
        <ModalPlanification
          siteId={siteId}
          partenaireId={aPlanifier.clientId}
          partenaireNom={aPlanifier.clientNom}
          role="client"
          montant={aPlanifier.montant}
          onFermer={() => setAPlanifier(null)}
          onValider={async (plan: Planification) => {
            const cible = aPlanifier;
            setAPlanifier(null);
            try {
              await appliquerPlanification({
                siteId, userId: user!.uid,
                partenaireId: cible.clientId,
                role: 'client', plan,
              });
            } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
          }}
        />
      )}

    </div>
  );
}
