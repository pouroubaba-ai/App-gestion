'use client';
import { produitsDuSite } from '@/lib/produits-site';
import { useEffect, useMemo, useState } from 'react';
import {
  collection, query, where, getDocs, addDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { auteurEtape } from '@/lib/auteur';
import {
  LigneFlux, referenceFlux, livrerVente, type Vente,
} from '@/lib/flux-marchandise';
import { ligneDepuisVente, synchroniserLignes } from '@/lib/lignes-vente';
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
import {
  Loader2, Plus, Minus, Trash2, Check, ArrowLeft, ShoppingCart, Package, X, Info,
  BarChart3, WifiOff,
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
        getDocs(query(collection(db, 'partenaires'),
          where('siteId', '==', siteId), where('userId', '==', user.uid))),
        produitsDuSite(siteId),
      ]);
      setClients(partSnap.docs
        .filter(d => d.data().rolesClient)
        .map(d => ({ id: d.id, nom: d.data().nom as string })));
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
        const max = Math.max(1, Math.floor(a.stock / Math.max(1, l.contenance)));
        return { ...l, stockUnites: a.stock,
          quantiteDemandee: Math.min(l.quantiteDemandee, max) };
      /* Un produit épuisé depuis, ou retiré du catalogue, ne se vend plus. */
      }).filter(l => l.stockUnites > 0);
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

  const total = panier.reduce((s, l) => s + l.quantiteDemandee * (l.prixVente ?? 0), 0);

  /* Ce que le reçu fait perdre.
     Une ligne vendue sous son coût creuse l'activité ; une autre vendue avec
     marge ne la comble pas — ce sont deux faits distincts, et compenser l'un
     par l'autre masquerait celui qui coûte. Seules les lignes en perte
     comptent donc ici. */
  const perte = panier.reduce((s, l) => {
    const coutLigne = l.valeurUnitaire;
    const manque = coutLigne - (l.prixVente ?? 0);
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
    && (!clientRequis || !!clientId)
    && !enCours;

  /** Ce qu'on peut encore prendre d'un article, dans l'emballage choisi. */
  function plafond(stockUnites: number, contenance: number) {
    return Math.floor(stockUnites / Math.max(1, contenance));
  }

  function ajouter(a: Article) {
    setFait(null);
    setPanier(prev => {
      const i = prev.findIndex(l => l.cle === a.cle);
      if (i >= 0) {
        const copie = [...prev];
        /* On ne vend pas ce qu'on n'a pas : au comptoir la marchandise part
           tout de suite, il n'y a pas de délai pour la réapprovisionner. */
        const max = plafond(copie[i].stockUnites, copie[i].contenance);
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
        designation: a.produit.designation,
        varianteCle: a.varianteCle,
        varianteLibelle: a.varianteLibelle,
        unite: a.produit.unite ?? 'unité',
        emballage: null,
        contenance: 1,
        quantiteDemandee: 1,
        valeurUnitaire: a.coutMoyen,
        prixVente: a.prixVente,
        prixUnitaire: a.prixVente,
        coutUnitaire: a.coutMoyen,
        stockUnites: a.stock,
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
      const max = plafond(l.stockUnites, contenance);
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

  function changerQuantite(cle: string, q: number) {
    setDetail(null);
    setPanier(prev => prev
      .map(l => l.cle === cle
        ? {
            ...l,
            quantiteDemandee: Math.max(0,
              Math.min(q, plafond(l.stockUnites, l.contenance))),
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
         quantité reçue ne diffère jamais de la quantité voulue. */
      const lignes: LigneFlux[] = panier.map(
        ({ cle, stockUnites, contenance, prixUnitaire, coutUnitaire, ...l }) => ({
          ...l, quantiteRecue: l.quantiteDemandee,
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

      /* On attend un instant : en ligne, c'est immédiat et la vente est
         conclue avant que l'écran ne bouge. Hors ligne, le délai tombe et
         on rend la main — la vente est prise, elle partira. */
      const { termine } = await sansAttendreLeReseau(ecriture);
      if (!termine) setDiffere(true);

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

      {/* Le client et la validation ne descendent pas dans la colonne : ce
          sont les deux seuls gestes qui ferment une vente, et les chercher
          entre deux clients coûte plus que tout le reste de l'écran. */}
      <div className="sticky top-[57px] z-20 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-3">
          {/* Le client occupe la largeur disponible ; la validation se pose à
              l'autre bout, toujours au même endroit quelle que soit la page. */}
          <div className="w-full max-w-sm">
            <SelectCherchable valeur={clientId} onChange={setClientId}
              options={clients.map(c => ({ valeur: c.id, label: c.nom }))}
              placeholder={aCredit ? 'Choisir le client…' : 'Client de passage'}
              vide="Aucun client" />
          </div>
          {/* À crédit, la vente engage quelqu'un : le dire ici évite de
              chercher pourquoi le bouton refuse. */}
          {aCredit && !clientId && panier.length > 0 ? (
            <span className="text-xs font-bold text-red-500 shrink-0 hidden sm:block">
              Client obligatoire
            </span>
          ) : null}
          <button onClick={valider} disabled={!pret}
            className="ml-auto flex items-center justify-center gap-1.5 px-7 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-colors shrink-0">
            {enCours ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            Valider
          </button>
        </div>
      </div>

      <div className="w-full p-4 sm:p-6 lg:p-8 grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* ─────────── Catalogue ─────────── */}
        <div className="lg:col-span-3 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4">
          <ChampRecherche valeur={recherche} onChange={setRecherche}
            placeholder="Chercher un produit…" />

          {/* Les rayons du magasin. « Tout » d'abord : c'est l'état par
              défaut, et y revenir doit être le geste le plus court. */}
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {[{ cle: '', label: 'Tout' },
                ...categories.map(c => ({ cle: c, label: c }))].map(c => {
                const n = c.cle
                  ? articles.filter(a => (a.produit.categorie ?? '') === c.cle).length
                  : articles.length;
                return (
                  <button key={c.cle || 'tout'} onClick={() => setCategorie(c.cle)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${categorie === c.cle
                      ? 'bg-indigo-600 text-white'
                      : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
                    {c.label}
                    <span className={`ml-1.5 font-medium ${categorie === c.cle
                      ? 'text-indigo-200' : 'text-gray-400'}`}>{n}</span>
                  </button>
                );
              })}
            </div>
          )}

          <p className="text-xs text-gray-400 mt-3 mb-2 text-center">
            {filtres.length} produit{filtres.length > 1 ? 's' : ''}
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto">
            {filtres.map(a => {
              const epuise = a.stock <= 0;
              return (
                <button key={a.cle} onClick={() => ajouter(a)} disabled={epuise}
                  className={`text-left p-3 rounded-xl border transition-colors ${epuise
                    ? 'border-gray-100 dark:border-gray-800 opacity-40 cursor-not-allowed'
                    : 'border-gray-200 dark:border-gray-700 hover:border-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/10'}`}>
                  <p className="text-xs font-bold leading-tight line-clamp-2">{a.designation}</p>
                  <p className="text-xs text-indigo-600 dark:text-indigo-400 font-bold mt-1">
                    {formatMontant(a.prixVente)}
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
                      ? 'épuisé'
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
              <p className="text-xs font-bold text-gray-500 dark:text-gray-400">
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
                {panier.map(l => {
                  const max = plafond(l.stockUnites, l.contenance);
                  const auPlafond = l.quantiteDemandee >= max;
                  const embs = produits.find(x => x.id === l.produitId)?.emballages ?? [];
                  const uniteNom = (l.unite?.trim() || 'unité').toLowerCase();
                  /* Le coût de ce qu'on vend : un carton a coûté vingt-huit
                     fois ce qu'a coûté la pièce. */
                  const coutLigne = l.valeurUnitaire;
                  const aPerte = (l.prixVente ?? 0) < coutLigne;
                  return (
                    <div key={l.cle} className="p-2.5 rounded-xl border border-gray-100 dark:border-gray-800">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-bold leading-tight flex items-start gap-1">
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

                      {detail === l.cle && (
                        <div data-detail-cout
                          className="mt-1.5 px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800 flex items-center justify-between">
                          <span className="text-xs text-gray-400">
                            Prix d'achat{l.emballage ? ` / ${l.emballage.toLowerCase()}` : ` / ${uniteNom}`}
                          </span>
                          <span className="text-xs font-bold text-gray-900 dark:text-gray-100">
                            {formatMontant(coutLigne)}
                          </span>
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
                              disabled={l.stockUnites < e.quantite}
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

                      <div className="flex items-center justify-between mt-1.5">
                        <span className={`text-xs ${auPlafond ? 'text-orange-500' : 'text-gray-400'}`}>
                          {auPlafond
                            ? 'tout le stock'
                            : `${max} ${l.emballage ? l.emballage.toLowerCase() : uniteNom} dispo.`}
                        </span>
                        <span className="text-xs font-bold">
                          {formatMontant(l.quantiteDemandee * (l.prixVente ?? 0))}
                        </span>
                      </div>
                    </div>
                  );
                })}
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
              {/* Ce que le reçu coûte à l'activité. Il ne s'affiche qu'en
                  existant : montré à zéro, il passerait inaperçu le jour où
                  il compte. */}
              {perte > 0 && (
                <div className="flex justify-between items-baseline mt-1">
                  <span className="text-xs font-bold text-red-500">Perte sur ce reçu</span>
                  <span className="text-xs font-bold text-red-500">{formatMontant(perte)}</span>
                </div>
              )}
            </div>

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

            {erreur ? <p className="text-xs text-red-500">{erreur}</p> : null}
          </div>
        </div>
      </div>
      {marge && (
        <ModalMargeRecu onFermer={() => setMarge(false)}
          lignes={panier.map(l => ({
            cle: l.cle,
            designation: l.designation,
            varianteLibelle: l.varianteLibelle,
            emballage: l.emballage,
            quantiteDemandee: l.quantiteDemandee,
            /* Le coût et le prix de ce qu'on vend : un carton, pas une pièce. */
            cout: l.valeurUnitaire,
            prix: l.prixVente ?? 0,
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
