'use client';
import { produitsDuSite, sitesDeLActivite } from '@/lib/produits-site';
import { creerProduitRapide, creerGammeRapide } from '@/lib/produit-rapide';
import ModalGammeProduit from '../../components/ModalGammeProduit';
import { estEnsemble, marqueOrigine, racineRetour } from '@/lib/retour';
import { useEffect, useState } from 'react';
import { useBrouillon, cleBrouillon, oublierBrouillon } from '@/lib/brouillon';
import { collection, query, where, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ligneDepuisVente, synchroniserLignes } from '@/lib/lignes-vente';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { auteurCourant, auteurEtape } from '@/lib/auteur';
import { Loader2, Check, FileText, ClipboardList } from 'lucide-react';
import SelecteurProduits, { ProduitChoisissable } from '../../components/SelecteurProduits';
import PanneauMontants from '../../components/PanneauMontants';
import {
  prixApresMontants, type MontantVente,
} from '@/lib/reductions';
import { LigneFlux, referenceFlux } from '@/lib/flux-marchandise';
import { SelectCherchable, ChampNombre } from '@/components/Champs';

interface ClientBref { id: string; nom: string }

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

/** Date obtenue en ajoutant un nombre de jours à aujourd'hui. */
function dansNJours(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

/** Nombre de jours entre aujourd'hui et une date, jamais négatif. */
function ecartJours(date: string): number {
  if (!date) return 0;
  const auj = new Date(aujourdhui()).getTime();
  return Math.max(0, Math.round((new Date(date).getTime() - auj) / 86400000));
}

/** Date par défaut de fin de validité : un mois, l'usage le plus répandu. */
function dansUnMois() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}

export default function NouvelleVentePage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;

  /* Devis ou commande : deux entrées du même cycle, un seul formulaire.
     Le type vient de l'URL et ne change plus — on n'hésite pas entre
     proposer un prix et enregistrer un engagement. */
  const estDevis = searchParams.get('type') === 'devis';
  /* L'ecran de retour est celui d'ou l'on vient, pas le site ou l'on ecrit. */
  const vientEnsemble = estEnsemble(searchParams);

  const [clients, setClients] = useState<ClientBref[]>([]);
  const [produits, setProduits] = useState<ProduitChoisissable[]>([]);
  /* Ceux nés pendant cette saisie : une pastille les signale sur leur
     ligne, pour qu'on relève avant d'enregistrer le doublon d'une
     référence mal orthographiée. */
  const [produitsNeufs, setProduitsNeufs] = useState<Set<string>>(new Set());
  /* Le formulaire de gamme, ouvert sur le nom qu'on cherchait. `null`
     quand il est fermé. */
  const [gamme, setGamme] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /* Le bouton caché n'empêche pas d'ouvrir l'adresse : la page se garde
     elle-même. `null` en rôle vaut « aucune restriction », d'où le drapeau. */
  const [role, setRole] = useState<RoleSite | null>(null);
  const [roleLu, setRoleLu] = useState(false);

  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(r => { setRole(r); setRoleLu(true); })
      .catch(() => setRoleLu(true));
  }, [user, siteId, activite?.adminUid]);

  const [clientId, setClientId] = useState('');
  /* La marchandise préparée survit au rechargement : les lignes
     cherchées une à une ne doivent pas disparaître parce que la page
     s'est rafraîchie. Le partenaire et la date ne se gardent pas — on
     ne réengage pas quelqu'un qu'on n'a pas revu. */
  const cleDraft = cleBrouillon('vente', siteId);
  const [lignes, setLignes] = useBrouillon<LigneFlux[]>(cleDraft, []);
  /* Ce qu'on accorde et ce qu'on facture en plus. Rien par défaut : la
     vente se fait au prix du catalogue tant qu'on n'a rien décidé. */
  const [montants, setMontants] = useState<MontantVente[]>([]);
  const [date, setDate] = useState(aujourdhui());
  /* Facultatif : beaucoup de commerces ne bornent pas leurs devis. Rempli,
     il protège — au-delà, le prix proposé n'engage plus. */
  const [validite, setValidite] = useState(estDevis ? dansUnMois() : '');
  const [delaiValidite, setDelaiValidite] = useState(estDevis ? 30 : 0);
  /* Ce qu'on promet au client. Facultatif : certains viennent chercher leur
     commande quand ils peuvent. Rempli, c'est lui qui dit si on est en retard. */
  const [livraisonPrevue, setLivraisonPrevue] = useState('');
  /* Deux façons de dire la même chose : « dans 5 jours » ou « le 18 ».
     On saisit dans celle qui vient à l'esprit, l'autre suit. */
  const [delaiJours, setDelaiJours] = useState(0);
  /* Un devis ne porte aucun versement : payer sur un devis, c'est l'accepter,
     donc le transformer en commande. Le champ n'existe qu'en commande. */
  const [verse, setVerse] = useState(0);
  const [note, setNote] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [partSnap, prodSnap] = await Promise.all([
        /* Le site, pas le compte : `userId` dit qui a inscrit le tiers,
           pas à qui il appartient. Filtrer dessus privait le gérant des
           partenaires créés par le propriétaire — il ne pouvait ni leur
           acheter ni leur vendre, sur un carnet pourtant commun. */
        getDocs(query(collection(db, 'partenaires'),
          where('siteId', '==', siteId))),
        produitsDuSite(siteId),
      ]);
      /* un partenaire peut cumuler les deux rôles : seul le côté client compte ici */
      setClients(partSnap.docs
        .filter(d => d.data().rolesClient)
        .map(d => ({ id: d.id, nom: d.data().nom as string })));
      /* `produitsDuSite` a deja joint le produit et la detention : les
         objets arrivent complets. */
      setProduits(prodSnap as ProduitChoisissable[]);
      setLoading(false);
    })();
  }, [siteId, user]);

  /**
   * Créer la marchandise qu'on ne trouve pas, et l'ajouter au bon.
   *
   * Une commande promet ce qu'on n'a pas encore : c'est déjà vrai des
   * quantités, qui ne sont bornées nulle part ici — on vend cent tôles
   * en n'en ayant vingt, et l'on se réapprovisionne avant de livrer. Ce
   * qui vaut pour la quantité vaut pour la référence : un client
   * commande ce qu'on ne tient pas encore, et le refuser obligeait à
   * quitter l'écran, créer ailleurs, revenir, et retrouver un bon perdu.
   *
   * Elle naît à zéro, sans stock ni coût — exactement l'état d'une ligne
   * commandée qu'on n'a pas. Rien ne s'en trouve faussé : le stock ne
   * bouge qu'à la livraison, et la préparation ne laisse sortir que ce
   * qu'on détient réellement. Il faudra donc l'avoir acheté d'ici là,
   * et c'est l'achat qui lui donnera son coût.
   */
  async function creerEtAjouter(designation: string) {
    if (!user) return;
    setErreur('');
    try {
      const siteIds = activite?.id
        ? await sitesDeLActivite(activite.id)
        : [siteId];
      const neuf = await creerProduitRapide({
        activiteId: activite?.id ?? null,
        userId: user.uid,
        designation,
        unite: 'pièce',
        siteIds: siteIds.length > 0 ? siteIds : [siteId],
        siteOrigine: siteId,
      });

      /* Il rejoint la liste sans qu'on relise tout : la relecture
         coûterait une attente pour un produit qu'on vient d'écrire. */
      const ajout = {
        id: neuf.id, siteId,
        designation: neuf.designation, unite: neuf.unite,
        codeBarre: null, categorie: null,
        emballages: [], caracteristiques: [], variantes: [],
        actif: true, stock: 0, coutMoyen: 0, prixVente: 0,
        seuilAlerte: null,
      } as unknown as ProduitChoisissable;
      setProduits(p => [...p, ajout]);
      setProduitsNeufs(n => new Set(n).add(neuf.id));

      /* Et il entre dans le bon : c'est pour cela qu'on l'a créé. Le
         prix reste à saisir — un produit neuf n'en a pas, et une ligne
         sans prix empêche d'enregistrer, ce qui le rappellera. */
      setLignes(l => [...l, {
        produitId: neuf.id,
        designation: neuf.designation,
        unite: neuf.unite,
        varianteCle: null,
        varianteLibelle: null,
        emballage: null,
        quantiteDemandee: 1,
        quantiteRecue: null,
        valeurUnitaire: 0,
        prixVente: 0,
      } as any]);
    } catch (e: any) {
      setErreur(e?.message ?? 'Le produit n’a pas pu être créé.');
    }
  }

  /**
   * Créer une gamme entière, et l'ajouter au bon.
   *
   * Le client ne commande pas « une ampoule », il commande les 15 W et
   * les 25 W. Elles entrent toutes : on vient de les décrire, c'est
   * qu'on les lui promet. Ce qu'il ne prend pas se retire d'une ligne,
   * et se retrouve par la recherche puisque le produit existe désormais.
   */
  async function creerGammeEtAjouter(saisie: {
    designation: string;
    unite: string;
    categorie: string | null;
    emballages: any[];
    caracteristiques: any[];
    declinaisons: { selection: Record<string, string> }[];
    cout: number;
    prix: number;
  }) {
    if (!user) return;
    setErreur('');
    const siteIds = activite?.id
      ? await sitesDeLActivite(activite.id)
      : [siteId];
    const neuf = await creerGammeRapide({
      activiteId: activite?.id ?? null,
      userId: user.uid,
      designation: saisie.designation,
      unite: saisie.unite,
      categorie: saisie.categorie,
      emballages: saisie.emballages,
      caracteristiques: saisie.caracteristiques,
      declinaisons: saisie.declinaisons,
      /* Le coût ne s'écrit pas d'ici. Le formulaire de gamme le demande
         parce qu'il sert aussi à l'achat, où le fournisseur l'annonce ;
         ici personne ne l'a constaté, et l'inscrire poserait un coût
         deviné que la marge prendrait ensuite pour argent comptant. Il
         viendra du premier achat, qui seul le connaît. */
      coutProduit: 0,
      prixProduit: saisie.prix,
      siteIds: siteIds.length > 0 ? siteIds : [siteId],
      siteOrigine: siteId,
    });

    /* Il rejoint la liste sans qu'on relise tout : la relecture coûterait
       une attente pour un produit qu'on vient d'écrire. */
    const ajout = {
      id: neuf.id, siteId,
      designation: neuf.designation, unite: neuf.unite,
      codeBarre: null, categorie: saisie.categorie,
      emballages: saisie.emballages,
      caracteristiques: saisie.caracteristiques,
      variantes: neuf.variantes.map(v => ({
        ...v, stock: 0, coutMoyen: 0, prixVente: v.prixVente ?? saisie.prix,
      })),
      actif: true, stock: 0, coutMoyen: 0, prixVente: saisie.prix,
      seuilAlerte: null,
    } as unknown as ProduitChoisissable;
    setProduits(p => [...p, ajout]);
    setProduitsNeufs(n => new Set(n).add(neuf.id));

    /* Une ligne par déclinaison. Sans déclinaison, une seule ligne : le
       produit nu. Le coût reste à zéro — c'est l'achat qui le pose, pas
       la vente ; seul le prix part de ce qu'on vient de décrire. */
    const nouvelles = neuf.variantes.length > 0
      ? neuf.variantes.map(v => ({
          produitId: neuf.id,
          designation: neuf.designation,
          unite: neuf.unite,
          varianteCle: v.cle,
          varianteLibelle: v.cle,
          emballage: null,
          quantiteDemandee: 1,
          quantiteRecue: null,
          valeurUnitaire: 0,
          prixVente: v.prixVente ?? saisie.prix,
        }))
      : [{
          produitId: neuf.id,
          designation: neuf.designation,
          unite: neuf.unite,
          varianteCle: null,
          varianteLibelle: null,
          emballage: null,
          quantiteDemandee: 1,
          quantiteRecue: null,
          valeurUnitaire: 0,
          prixVente: saisie.prix,
        }];
    setLignes(l => [...l, ...(nouvelles as any[])]);
    setGamme(null);
  }

  /* Créer un client sans quitter le bon de commande.
   *
   * Un client qui n'a pas encore de fiche arrivait au pire moment : il
   * fallait ouvrir les partenaires, créer, revenir, et retrouver les
   * lignes déjà saisies. La fiche naît ici, avec le nom tapé dans la
   * recherche, et le bon continue.
   *
   * Elle naît cliente, et rien d'autre : ici on ne sait qu'une chose,
   * c'est que cette personne achète.
   */
  async function creerClient(nom: string): Promise<string | null> {
    const propre = nom.trim();
    if (!propre || !user) return null;

    /* Deux fiches du même nom deviendraient deux historiques pour une
       seule personne, et la créance se lirait à moitié. On rend celle
       qui existe plutôt que d'en ouvrir une autre. */
    const cle = (x: string) => x.trim().toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
    const deja = clients.find(c => cle(c.nom) === cle(propre));
    if (deja) {
      setErreur(`« ${deja.nom} » existe déjà.`);
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

  /* Une vente se totalise au prix obtenu, jamais au coût : le coût sert
     à figer la marge, pas à dire ce que le client doit. */
  /* La marchandise au prix du catalogue : la base des pourcentages. */
  const sousTotal = lignes.reduce(
    (s, l) => s + l.quantiteDemandee * (l.prixVente ?? 0), 0);
  /* Les prix après réduction et frais annexes — le même calcul qu'au
     comptoir. Le prix rendu EST le prix de vente. */
  const { prix: prixReels } = prixApresMontants(lignes, montants);
  const total = lignes.reduce(
    (s, l, i) => s + l.quantiteDemandee * (prixReels[i] ?? l.prixVente ?? 0), 0);
  const cout = lignes.reduce((s, l) => s + l.quantiteDemandee * l.valeurUnitaire, 0);
  const benefice = total - cout;
  const reste = Math.max(0, total - verse);
  const avanceExcessive = verse > total;

  /* Une ligne sans prix passerait pour un cadeau : on bloque plutôt que
     d'enregistrer une vente à zéro que personne n'a voulue. */
  const lignesCompletes = lignes.length > 0
    && lignes.every(l => l.produitId && l.quantiteDemandee > 0 && (l.prixVente ?? 0) > 0);
  const pretAEnregistrer = !!clientId && lignesCompletes && !avanceExcessive;

  async function enregistrer() {
    setErreur('');
    if (!pretAEnregistrer) return;

    setEnCours(true);
    try {
      const c = clients.find(x => x.id === clientId);
      /* Recopié une fois, réutilisé par chaque étape du dossier. */
      const auteur = await auteurEtape(siteId, user!.uid, user!.displayName);
      const donnees = {
        reference: referenceFlux(estDevis ? 'DV' : 'CV', date),
        siteId,
        clientId,
        clientNom: c?.nom ?? '—',
        etat: estDevis ? 'devis' : 'commande',
        /* Le prix enregistré est celui d'après remise : c'est le prix
           auquel on a vendu, et c'est lui qui part au mouvement et dans
           la marge. Le document garde l'explication. */
        lignes: lignes.map((l, i) => ({
          ...l, prixVente: prixReels[i] ?? l.prixVente ?? 0,
        })),
        montants,
        /* La base des pourcentages, telle qu'elle était au moment de la
           saisie : la relecture ne peut pas la retrouver sur les lignes,
           qui portent déjà le prix d'après remise. */
        sousTotalOrigine: sousTotal,
        /* un devis n'encaisse rien : le versement n'existe qu'en commande */
        avanceVersee: estDevis ? 0 : verse,
        versements: !estDevis && verse > 0
          ? [{
              date, montant: verse, par: user!.uid, note: null,
              /* la marchandise n'est pas partie : l'argent est en dépôt */
              motif: 'avance' as const,
            }]
          : [],
        devisId: null,
        validiteDevis: estDevis ? (validite || null) : null,
        dateDevis: estDevis ? date : null,
        dateCommande: estDevis ? null : date,
        dateLivraisonPrevue: estDevis ? null : (livraisonPrevue || null),
        parDevis: estDevis ? user!.uid : null,
        parCommande: estDevis ? null : user!.uid,
        auteurDevis: estDevis ? auteur : null,
        auteurCommande: estDevis ? null : auteur,
        note: note.trim() || null,
        userId: user!.uid,
        createdAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, 'ventes'), donnees);

      /* Les produits promis entrent dans leur collection : un tableau
         imbrique ne s'interroge pas, et le besoin par produit demande de
         partir du produit, pas de la vente. */
      await synchroniserLignes({
        neuve: true,
        venteId: ref.id,
        lignes: lignes.map((l, i) => ligneDepuisVente({
          siteId, venteId: ref.id, ligneIndex: i, ligne: l,
          emballages: produits.find(x => x.id === l.produitId)?.emballages ?? [],
          clientId, clientNom: c?.nom ?? null,
        })),
      });

      /* L'origine suit le dossier : il se refermera la ou l'on a
         commence, ensemble ou site. */
      /* Le brouillon a fait son office : la marchandise est
         inscrite, le garder ferait repartir d'une préparation
         déjà envoyée. */
      oublierBrouillon(cleDraft);
      router.push(`/site/${siteId}/ventes/${ref.id}${marqueOrigine(vientEnsemble)}`);
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setEnCours(false);
    }
  }

  /* La déconnexion vide l'utilisateur avant que la navigation aboutisse. */
  if (!user) return null;

  /* Ouvrir un dossier engage le site sur un prix : ce rôle fait avancer ce
     qui existe, il ne crée pas. */
  if (roleLu && role === 'commandes') return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Ce rôle ne crée pas de dossier.</p>
      <button onClick={() => router.push(`${racineRetour(vientEnsemble, siteId)}?onglet=cycle-vente`)}
        className="px-4 py-2 text-xs font-bold text-indigo-600 hover:underline">
        Retour
      </button>
    </div>
  );

  if (loading || !roleLu) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  const Icone = estDevis ? FileText : ClipboardList;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">

      {/* Les actions restent atteignables pendant qu'on parcourt un long catalogue. */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Icone size={18} className="text-indigo-500" />
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {estDevis ? 'Nouveau devis' : 'Nouvelle commande'}
            </h1>
          </div>
          <div className="flex gap-2">
            {/* on repart sur la carte d'ou l'on venait */}
            <button onClick={() => router.push(
              `${racineRetour(vientEnsemble, siteId)}?onglet=cycle-vente&carte=${estDevis ? 'devis' : 'commande'}`)}
              className="px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors">
              Annuler
            </button>
            <button onClick={enregistrer} disabled={enCours || !pretAEnregistrer}
              className="flex items-center gap-1.5 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-colors">
              {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
            </button>
          </div>
        </div>
      </header>

      <div className="w-full p-4 sm:p-6 lg:p-8">

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Client</label>
              <SelectCherchable valeur={clientId} onChange={setClientId}
                options={clients.map(c => ({ valeur: c.id, label: c.nom }))}
                vide="Aucun client" effacable
                surCreer={creerClient} creerLibelle="Nouveau client" />
            </div>

            <div>
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Date</label>
              <input type="date" value={date} max={aujourdhui()}
                onChange={e => setDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs text-gray-400 mt-1">
                {estDevis ? 'Date de la proposition' : "Date de l'engagement du client"}
              </p>
            </div>

            {/* Une commande promet une livraison ; un devis promet un prix
                jusqu'à une date. Chacune a son échéance, pas la même. */}
            {!estDevis && (
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">
                  Livraison prévue
                </label>
                <div className="flex gap-2">
                  {/* On promet rarement une date : on promet un délai. Les
                      deux champs disent la même chose et se suivent. */}
                  <ChampNombre valeur={delaiJours}
                    onChange={n => {
                      setDelaiJours(n);
                      setLivraisonPrevue(n > 0 ? dansNJours(n) : '');
                    }}
                    className="w-20 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-center text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <span className="self-center text-xs text-gray-400 shrink-0">jours</span>
                  {/* jamais avant aujourd'hui : on ne promet pas le passé */}
                  <input type="date" value={livraisonPrevue} min={aujourdhui()}
                    onChange={e => {
                      setLivraisonPrevue(e.target.value);
                      setDelaiJours(ecartJours(e.target.value));
                    }}
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {livraisonPrevue
                    ? 'Passé cette date, la commande sera signalée en retard.'
                    : 'Facultatif : sans date, aucun retard ne sera signalé.'}
                </p>
              </div>
            )}
            {estDevis && (
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">
                  Valable jusqu'au
                </label>
                <div className="flex gap-2">
                  <ChampNombre valeur={delaiValidite}
                    onChange={n => {
                      setDelaiValidite(n);
                      setValidite(n > 0 ? dansNJours(n) : '');
                    }}
                    className="w-20 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-center text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <span className="self-center text-xs text-gray-400 shrink-0">jours</span>
                  <input type="date" value={validite} min={aujourdhui()}
                    onChange={e => {
                      setValidite(e.target.value);
                      setDelaiValidite(ecartJours(e.target.value));
                    }}
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {validite
                    ? "Au-delà, les prix proposés n'engagent plus."
                    : 'Facultatif : sans date, le devis reste ouvert.'}
                </p>
              </div>
            )}
          </div>
        </div>

        <SelecteurProduits
          produits={produits} lignes={lignes}
          onChange={l => {
            setLignes(l);
            /* le total vient de changer : un versé devenu excessif se ramène */
            const t = l.reduce((s, x) => s + x.quantiteDemandee * (x.prixVente ?? 0), 0);
            setVerse(v => Math.min(v, t));
          }}
          onCreerProduit={creerEtAjouter}
          onCreerGamme={setGamme}
          produitsNeufs={produitsNeufs}
          coutEditable={false} montrerStock labelCout="Coût" vente futur
          partsFrais={null}
        />

        {gamme !== null && (
          <ModalGammeProduit
            designationInitiale={gamme}
            onAnnuler={() => setGamme(null)}
            onCreer={creerGammeEtAjouter} />
        )}

        {lignes.length > 0 && (
          <PanneauMontants
            siteId={siteId} userId={user?.uid ?? ''}
            montants={montants} sousTotal={sousTotal}
            onChange={m => {
              setMontants(m);
              /* Le total vient de changer : un versé devenu excessif se
                 ramène, comme lorsqu'une ligne bouge. */
              const { prix } = prixApresMontants(lignes, m);
              const t = lignes.reduce(
                (s, l, i) => s + l.quantiteDemandee * (prix[i] ?? l.prixVente ?? 0), 0);
              setVerse(v => Math.min(v, t));
            }} />
        )}

        {erreur && <p className="text-xs text-red-500 mt-3">{erreur}</p>}

        <div className="mt-4 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-4 mb-4 border-b border-gray-100 dark:border-gray-800">
            {estDevis ? (
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Versement</label>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Un devis ne reçoit aucun versement : il n'engage que celui qui
                  l'émet. Payer sur un devis, c'est l'accepter — il devient alors
                  une commande, et l'avance se pose sur elle.
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-gray-500 dark:text-gray-400">
                    Avance versée à la commande
                  </label>
                  {total > 0 && (
                    <button onClick={() => setVerse(total)}
                      className="text-xs font-bold text-indigo-600 hover:underline">
                      Tout payer
                    </button>
                  )}
                </div>
                <ChampNombre valeur={verse} onChange={setVerse} max={total}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <p className={`text-xs mt-1.5 ${avanceExcessive ? 'text-red-500' : 'text-gray-400'}`}>
                  {avanceExcessive
                    ? `L'avance ne peut pas dépasser le total commandé (${formatMontant(total)}).`
                    : "Tant que la marchandise n'est pas livrée, ce versement est une avance : la créance ne naîtra qu'à la livraison."}
                </p>
              </div>
            )}

            <div>
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Note</label>
              <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Facultatif"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>

          <div className="flex justify-end">
            <div className="flex flex-col gap-1 text-sm min-w-[240px]">
              <div className="flex justify-between gap-8">
                <span className="text-gray-400">Total</span>
                <span className="font-bold text-gray-900 dark:text-gray-100">{formatMontant(total)}</span>
              </div>
              {/* La marge attendue n'est qu'une prévision : elle ne se fige
                  qu'à la livraison, au coût moyen de ce jour-là. */}
              <div className="flex justify-between gap-8">
                <span className="text-gray-400">Marge attendue</span>
                <span className={`font-medium ${benefice < 0 ? 'text-red-500' : 'text-green-600'}`}>
                  {formatMontant(benefice)}
                </span>
              </div>
              {!estDevis && (
                <>
                  <div className="flex justify-between gap-8">
                    <span className="text-gray-400">Avance</span>
                    <span className="font-medium text-gray-900 dark:text-gray-100">{formatMontant(verse)}</span>
                  </div>
                  <div className="flex justify-between gap-8 pt-1 border-t border-gray-100 dark:border-gray-800">
                    <span className="text-gray-400">Reste</span>
                    <span className={`font-bold ${reste > 0 ? 'text-orange-500' : 'text-green-600'}`}>
                      {formatMontant(reste)}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
