'use client';
import { useEffect, useState, Fragment } from 'react';
import { doc, getDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { produitsDuSite } from '@/lib/produits-site';
import { useAuth } from '@/lib/auth-context';
import { ecrireEnCaisse } from '@/lib/ecrire-caisse';
import { chargerDisponible } from '@/lib/attente-caisse';
import DisponibleCaisse from '../../components/DisponibleCaisse';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import {
  enregistrerVersement, chargerVersementsDuSite,
  LIBELLES_MOTIF_VERSEMENT, type Versement,
} from '@/lib/versements-collection';
import {
  chargerCaisseDuSite, soldeCaisse,
} from '@/lib/caisse';
import { auteurCourant, auteurEtape } from '@/lib/auteur';
import {
  enregistrerReception, annulerReception, chargerReceptions,
  recuParLigne, type Reception,
} from '@/lib/receptions';
import { ChampNombre } from '@/components/Champs';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import {
  ArrowLeft, Loader2, CheckCheck, Check, ArrowDownLeft, Clock, Wallet, X, Info, Plus } from 'lucide-react';
import {
  Achat, EtatAchat, LIBELLES_ACHAT,
  valeurEnvoyee, valeurRecue, ecartValeur, aUnEcart, lignesEnEcart, confirmerAchat,
  VersementAchat, peutAnnulerDossier, type Role,
} from '@/lib/flux-marchandise';
import { estEnsemble, retourHistorique } from '@/lib/retour';
import ModalPlanification from '../../components/ModalPlanification';
import {
  appliquerPlanification, lireChoix, type Planification,
} from '@/lib/planification';

const COULEURS_ETAT: Record<EtatAchat, string> = {
  en_attente: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  recu:       'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  traitement: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  confirme:   'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  annule:     'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
};

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Une ligne de pied de document : libellé à gauche, montant à droite.
 * Les points de conduite relient les deux — sans eux, l'œil perd la ligne
 * en traversant le vide et lit un montant en face du mauvais libellé.
 */
function LigneTotal({ label, valeur, classeValeur = 'font-medium text-gray-900 dark:text-gray-100' }: {
  label: React.ReactNode;
  valeur: string;
  classeValeur?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-gray-400 shrink-0">{label}</span>
      <span className="flex-1 border-b border-dotted border-gray-200 dark:border-gray-700" />
      <span className={`shrink-0 whitespace-nowrap ${classeValeur}`}>{valeur}</span>
    </div>
  );
}

export default function FicheAchatPage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  /* On revient d'où l'on vient : la carte et l'axe ouverts dans l'onglet
     Achats voyagent dans l'URL, sinon fermer un dossier en attente
     renvoyait sur les achats reçus. */
  /* La query du retour : la même carte et le même axe qu'on a quittés.
     Revenir sur « En attente » quand on parcourait les confirmés ferait
     perdre le fil du travail. */
  const retourAchats = (() => {
    /* Un dossier s'ouvre aussi depuis l'historique : y renvoyer aux achats
       ferait perdre la liste qu'on parcourait. */
    const de = searchParams.get('de');
    if (de === 'historique' || de === 'ensemble-historique') {
      return retourHistorique(searchParams);
    }
    const params = new URLSearchParams({ onglet: 'achats' });
    const carte = searchParams.get('carte');
    const axe = searchParams.get('axe');
    if (carte) params.set('carte', carte);
    if (axe) params.set('axe', axe);
    return `?${params.toString()}`;
  })();
  const params = useParams();
  const siteId = params.id as string;
  const achatId = params.achatId as string;

  const [achat, setAchat] = useState<Achat | null>(null);
  const [loading, setLoading] = useState(true);
  /* Le responsable des commandes fait avancer des dossiers, il ne répond pas
     des dépenses du site : les montants ne lui apprennent rien et exposent ce
     que l'activité engage. L'onglet les lui cachait déjà — la fiche les
     montrait encore, ce qui revenait à ne rien cacher du tout. */
  const [role, setRole] = useState<RoleSite | null>(null);

  /* L'admin de l'activité n'est désigné par aucun membre : `roleSurSite`
     lui rend `null`, qui vaut « tout permis ». */
  useEffect(() => {
    if (!user || !siteId) return;
    roleSurSite(user.uid, siteId, activite?.adminUid).then(setRole).catch(() => {});
  }, [user, siteId, activite?.adminUid]);

  const montreArgent = role !== 'commandes';
  const [quantites, setQuantites] = useState<Record<number, number>>({});
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  const [retour, setRetour] = useState<number | null>(null);
  /* Ce qui reste dû au fournisseur une fois l'achat confirmé. Tant qu'il
     est posé, on demande comment cette dette sera réglée : c'est à cet
     instant qu'on le sait, et revenir le poser dans Recouvrements est un
     geste qu'on ne fait pas.
     Déclaré ici, avec les autres : un hook placé après un `return` n'est
     pas appelé à tous les rendus, et React perd le compte. */
  const [aPlanifier, setAPlanifier] = useState<number | null>(null);
  /* On n'édite pas par inadvertance : il faut le demander, et on peut
     abandonner sans que rien ne soit écrit. */

  /* Les réceptions, une ligne par livraison. Le reçu en est la somme : il ne
     se saisit plus, il se déduit. */
  const [receptions, setReceptions] = useState<Reception[]>([]);
  const [ligneRecue, setLigneRecue] = useState<number | null>(null);
  const [qteRecue, setQteRecue] = useState(0);
  const [noteRecue, setNoteRecue] = useState('');
  const [detailLigne, setDetailLigne] = useState<number | null>(null);
  const [modalAvance, setModalAvance] = useState(false);
  /* consulter et ajouter sont deux gestes distincts : le premier n'engage
     rien, le second écrit. Les mêler ferait d'une lecture une action. */
  const [modalVersement, setModalVersement] = useState(false);
  const [nouveauVersement, setNouveauVersement] = useState(0);
  const [dateVersement, setDateVersement] = useState(aujourdhui());

  /* Le coût moyen de chaque produit, pour dire avant de confirmer si un
     prix de vente passerait sous lui. */
  const [coutsMoyens, setCoutsMoyens] = useState<Record<string, number>>({});
  /* Les versements ne vivent plus dans le dossier : ils ont leur collection,
     et c'est elle qui porte la caisse, le motif et l'auteur. */
  const [versements, setVersements] = useState<Versement[]>([]);
  const [soldeCaisseSite, setSoldeCaisseSite] = useState<number | null>(null);
  /* Ce qu'on peut encore laisser sortir : le solde moins ce qui est déjà
     déclaré et pas encore passé par le tiroir. Comparé au seul solde, les
     sorties s'enchaînaient sur un chiffre qui ne bougeait pas. */
  const [engageCaisse, setEngageCaisse] = useState(0);
  const [soldeReelCaisse, setSoldeReelCaisse] = useState<number | null>(null);

  /* Régler un fournisseur sort de l'argent : si la caisse ne suffit pas,
     l'apport se fait ici plutôt que d'obliger à quitter le dossier. */
  const [avecApport, setAvecApport] = useState(false);
  const [apport, setApport] = useState(0);
  const [detailApport, setDetailApport] = useState('');
  /* passe à true quand l'alerte a été montrée : le second clic confirme */
  /* Confirmer fait entrer le stock et fige le coût moyen : ça ne se défait
     pas. Le modal montre toujours ce qu'on valide, écart ou non. */
  const [modalConfirmation, setModalConfirmation] = useState(false);

  useEffect(() => { charger(); }, [achatId]);

  /* Un achat se confirme de deux façons : depuis cette fiche, ou dès la
     création quand la livraison est immédiate. Les deux aboutissent ici,
     c'est donc ici qu'on demande comment la dette sera réglée — une seule
     fois, et seulement si rien n'est encore planifié.
     Le poser dans la confirmation n'aurait couvert qu'un des deux chemins. */
  const [planifDemandee, setPlanifDemandee] = useState(false);

  /* Un fait s'enregistre : on a pose la question, ce jour-la. */
  async function cloreQuestion() {
    if (!achat || achat.planifieLe) return;
    try {
      await updateDoc(doc(db, 'achats', achat.id), {
        planifieLe: new Date().toISOString(),
      });
    } catch { /* le marqueur est un confort, pas une ecriture critique */ }
  }

  useEffect(() => {
    /* Poser la question une seule fois par dossier. Se fier au cycle ne
       suffit pas : poser une regle sans la demarrer aujourd'hui n'ouvre
       aucune echeance, et le dossier redemanderait a chaque ouverture. */
    if (!achat || planifDemandee || achat.planifieLe) return;
    if (achat.etat !== 'confirme' || !achat.fournisseurId) return;
    const du = valeurRecue(achat.lignes) - (achat.avanceVersee ?? 0);
    if (du <= 0) return;

    let vivant = true;
    lireChoix(siteId, achat.fournisseurId, 'fournisseur').then(c => {
      /* Un cycle déjà lancé sait quoi faire : ne rien demander évite de
         reposer la question à chaque ouverture du dossier. */
      if (!vivant || c.cycleEnCours) return;
      setPlanifDemandee(true);
      setAPlanifier(du);
    }).catch(() => {});
    return () => { vivant = false; };
  }, [achat, planifDemandee, siteId]);

  async function charger() {
    setLoading(true);
    const snap = await getDoc(doc(db, 'achats', achatId));
    if (snap.exists()) {
      const a = { id: snap.id, ...snap.data() } as Achat;
      setAchat(a);
      setQuantites(Object.fromEntries(
        a.lignes.map((l, i) => [i, l.quantiteRecue ?? l.quantiteDemandee])));

      /* Le coût moyen appartient à la détention, pas au produit : lire
         `produits` filtré par `siteId` datait du modèle où le produit
         appartenait au site. La requête ne ramenait plus rien, et tous les
         coûts valaient zéro — la marge annoncée à la réception était donc
         égale au prix de vente entier. */
      const prod = await produitsDuSite(a.siteId);
      setCoutsMoyens(Object.fromEntries(
        prod.map(p => [p.id, p.coutMoyen ?? 0])));

      chargerReceptions(achatId).then(setReceptions).catch(() => setReceptions([]));
      const [vers, caisse] = await Promise.all([
        chargerVersementsDuSite(a.siteId),
        chargerDisponible(a.siteId),
      ]);
      setVersements(vers.filter(v => v.achatId === achatId));
      setSoldeCaisseSite(caisse.disponible);
      setSoldeReelCaisse(caisse.solde);
      setEngageCaisse(caisse.engage);
    }
    setLoading(false);
  }

  /**
   * Les lignes dont le prix de vente passerait sous le coût moyen.
   *
   * Confirmer un achat fixe le nouveau coût du produit. Si le prix de vente
   * est resté sous ce coût, chaque unité vendue sera vendue à perte — et on
   * ne s'en apercevrait qu'à la première vente.
   */
  function lignesAPerte() {
    if (!achat) return [];
    return achat.lignes
      .map(l => ({ l, cout: coutsMoyens[l.produitId] ?? 0 }))
      .filter(x => (x.l.prixVente ?? 0) > 0 && x.l.prixVente! < x.cout);
  }

  /* La déconnexion vide l'utilisateur avant que la navigation aboutisse :
     tout ce qui lit son identifiant tomberait sur du vide. */
  if (!user) return null;

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!achat) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Achat introuvable.</p>
    </div>
  );

  const ecart = ecartValeur(achat.lignes);
  const enEcart = lignesEnEcart(achat.lignes);
  const recu = valeurRecue(achat.lignes);
  const commande = valeurEnvoyee(achat.lignes);
  /* l'avance non consommée revient en caisse : la laisser chez le fournisseur
     en ferait une dette à suivre, hors du périmètre de l'app */
  const retourPrevu = Math.max(0, (achat.avanceVersee ?? 0) - recu);
  /* après réception, ce qui reste à payer porte sur le reçu, jamais sur le commandé :
     on ne doit au fournisseur que la marchandise qu'il a livrée */
  const resteDu = Math.max(0, recu - (achat.avanceVersee ?? 0));

  /* Un versement ne peut pas dépasser ce qui reste à payer. Avant réception on
     se règle sur le commandé ; après, sur le reçu — seule la marchandise
     livrée est due. */
  const basePaiement = achat.etat === 'en_attente' ? commande : recu;
  const resteAPayer = Math.max(0, basePaiement - (achat.avanceVersee ?? 0));

  /* Le cycle suit la marchandise : elle arrive, on la traite, on l'accepte.
     Trois gestes distincts, parce qu'entre chacun il reste quelque chose à
     faire — et que le stock, lui, n'entre qu'à la fin. */
  const peutReceptionner = achat.etat === 'en_attente';
  const peutTraiter = achat.etat === 'recu';
  const peutConfirmer = achat.etat === 'traitement';
  /* Rien n'est appliqué au stock avant la confirmation : tant qu'elle n'a pas
     eu lieu, une quantité mal comptée doit pouvoir être reprise. On compte
     pendant le traitement — c'est là qu'on vérifie ce qui est arrivé. */
  const quantitesEditables = achat.etat === 'recu' || achat.etat === 'traitement';

  /* La marchandise est arrivée : on le constate, on ne compte pas encore. */
  async function receptionner() {
    setEnCours(true); setErreur('');
    try {
      await updateDoc(doc(db, 'achats', achatId), {
        etat: 'recu',
        dateReception: aujourdhui(),
        parReception: user!.uid,
        auteurReception: await auteurEtape(siteId, user!.uid, user!.displayName),
      });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* On ouvre le comptage : c'est ici qu'un écart apparaîtra, s'il y en a un. */
  async function traiter() {
    setEnCours(true); setErreur('');
    try {
      await updateDoc(doc(db, 'achats', achatId), { etat: 'traitement' });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function confirmer() {
    setModalConfirmation(false);
    setEnCours(true); setErreur('');
    try {
      /* Les quantités reçues se figent ici : elles viennent des réceptions
         enregistrées, jamais d'une saisie. C'est la confirmation qui arrête
         le compte, puisqu'après elle plus rien ne s'ajoute. */
      const recu = recuParLigne(receptions);
      const lignes = achat!.lignes.map((l, i) => ({
        ...l,
        quantiteRecue: receptions.some(r => r.ligneIndex === i)
          ? (recu[i] ?? 0) : (l.quantiteRecue ?? 0),
      }));
      const auteur = await auteurEtape(achat!.siteId, user!.uid);
      await updateDoc(doc(db, 'achats', achatId), {
        lignes,
        dateReception: aujourdhui(),
        parReception: user!.uid,
        auteurReception: auteur,
      });

      const { retourCaisse } = await confirmerAchat({
        achat: { ...achat!, lignes }, userId: user!.uid, par: user!.uid,
        ...(await auteurCourant(achat!.siteId, user!.uid, user!.displayName)),
      });
      /* l'app ne demande pas : elle informe de ce qu'elle a fait */
      if (retourCaisse > 0) setRetour(retourCaisse);
      await charger();

    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* Le total n'est jamais saisi à part : il se recalcule depuis les
     versements, pour qu'un montant et son détail ne divergent jamais. */
  const depasseCaisse = soldeCaisseSite != null && nouveauVersement > soldeCaisseSite;
  const manqueCaisse = depasseCaisse ? nouveauVersement - (soldeCaisseSite ?? 0) : 0;
  const apportSuffit = !depasseCaisse || (avecApport && apport >= manqueCaisse);

  /**
   * Complète une ligne, ou toutes.
   *
   * Aucune limite de stock ici : c'est le fournisseur qui livre, et ce qu'il
   * apporte entre chez nous. Le raccourci écrit de vraies réceptions, datées
   * et signées — le même fait que la saisie, sans les clics.
   */
  async function completer(ligneIndex: number | null) {
    /* Une écriture en cours n'a pas encore rafraîchi l'affichage : le bouton
       montre toujours l'ancien reste. Sans cette garde, deux clics rapides
       déclarent deux fois la même chose. */
    if (!achat || enCours) return;
    const recu = recuParLigne(receptions);
    const aEcrire: { i: number; quantite: number }[] = [];

    achat.lignes.forEach((l, i) => {
      if (ligneIndex != null && i !== ligneIndex) return;
      const manque = l.quantiteDemandee - (recu[i] ?? 0);
      if (manque > 0) aEcrire.push({ i, quantite: manque });
    });

    if (aEcrire.length === 0) return;
    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurCourant(achat.siteId, user!.uid);
      const date = aujourdhui();
      await Promise.all(aEcrire.map(({ i, quantite }) => {
        const l = achat.lignes[i];
        return enregistrerReception({
          siteId: achat.siteId,
          documentId: achatId,
          ligneIndex: i,
          produitId: l.produitId ?? null,
          designation: l.designation,
          quantite,
          date,
          utilisateur: user!.uid,
          utilisateurNom: auteur.utilisateurNom,
          utilisateurFonction: auteur.utilisateurFonction,
          note: null,
        });
      }));
      setReceptions(await chargerReceptions(achatId));
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /** Une réception s'ajoute ; elle ne remplace jamais la précédente. */
  async function ajouterReception() {
    if (ligneRecue == null || qteRecue <= 0) return;
    setEnCours(true); setErreur('');
    try {
      const l = achat!.lignes[ligneRecue];
      const auteur = await auteurCourant(achat!.siteId, user!.uid);
      await enregistrerReception({
        siteId: achat!.siteId,
        documentId: achatId,
        ligneIndex: ligneRecue,
        produitId: l.produitId ?? null,
        designation: l.designation,
        quantite: qteRecue,
        date: aujourdhui(),
        utilisateur: user!.uid,
        utilisateurNom: auteur.utilisateurNom,
        utilisateurFonction: auteur.utilisateurFonction,
        note: noteRecue.trim() || null,
      });
      setReceptions(await chargerReceptions(achatId));
      setLigneRecue(null); setQteRecue(0); setNoteRecue('');
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* On n'ajuste pas une réception : on l'annule et on en saisit une autre.
     Le registre montre alors qu'une erreur a été faite et corrigée. */
  async function annulerUneReception(id: string) {
    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurCourant(achat!.siteId, user!.uid);
      await annulerReception({ receptionId: id, par: user!.uid, parNom: auteur.utilisateurNom });
      setReceptions(await chargerReceptions(achatId));
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function ajouterVersement() {
    if (nouveauVersement <= 0) return;
    setEnCours(true); setErreur('');
    try {
      /* L'apport d'abord : sans lui la caisse passerait en négatif entre les
         deux écritures, et chaque mouvement garde son solde. */
      if (depasseCaisse && avecApport && apport > 0) {
        const auteur = await auteurCourant(achat!.siteId, user!.uid);
        await ecrireEnCaisse({
          siteId: achat!.siteId, sens: 'entree', motif: 'apport',
          sousMotif: 'Complément de caisse',
          detail: detailApport.trim() || `Pour régler ${achat!.fournisseurNom ?? 'le fournisseur'}`,
          montant: apport, date: dateVersement,
          utilisateur: user!.uid,
          utilisateurNom: auteur.utilisateurNom,
          utilisateurFonction: auteur.utilisateurFonction,
        }, user!.uid, activite?.adminUid ?? null);
      }

      await enregistrerVersement({
        adminUid: activite?.adminUid ?? null,
        siteId: achat!.siteId, userId: user!.uid,
        date: dateVersement,
        montant: nouveauVersement,
        /* payer un fournisseur sort de l'argent */
        sens: 'sortie',
        /* figé à la saisie : avant réception c'est une avance, après un règlement */
        motif: achat!.etat === 'confirme' ? 'reglement' : 'avance',
        partenaireId: achat!.fournisseurId ?? '',
        partenaireNom: achat!.fournisseurNom ?? null,
        role: 'fournisseur',
        achatId,
        reference: achat!.reference ?? null,
        par: user!.uid,
        ...(await auteurCourant(achat!.siteId, user!.uid)),
      });
      setNouveauVersement(0);
      setAvecApport(false);
      setApport(0);
      setDetailApport('');
      setDateVersement(aujourdhui());
      setModalVersement(false);
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function annuler() {
    /* La garde tient aussi ici : cacher le bouton ne protège que l'écran,
       et la fonction reste appelable par d'autres chemins. */
    if (!peutAnnulerDossier(role as Role | null)) return;
    setEnCours(true); setErreur('');
    try {
      await updateDoc(doc(db, 'achats', achatId), { etat: 'annule' });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">

      {/* Les actions du dossier restent atteignables pendant qu'on parcourt les lignes. */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
        {/* Sur téléphone, l'en-tête se lit en deux temps : quel dossier,
            puis ce qu'on peut en faire.

            Une seule rangée qui se replie, c'était l'écran du bureau
            rétréci : « Fermer » prenait la largeur d'un vrai bouton pour un
            geste de retour, et l'action du dossier tombait à la ligne
            suivante sans jamais atteindre le bord.

            Le retour redevient une flèche, là où le pouce la cherche ; le
            titre prend la place libérée ; l'action passe en pleine largeur
            dessous, où elle ne se manque pas. */}
        <div className="w-full px-4 sm:px-6 lg:px-8 py-3">
          <div className="sm:flex sm:items-center sm:justify-between sm:gap-3">
            <div className="flex items-center gap-2">
              {/* La flèche ne paraît que sur téléphone : au bureau,
                  « Fermer » reste plus clair qu'un chevron isolé. */}
              <button onClick={() => router.push(
                estEnsemble(searchParams)
                  ? `/ensemble${retourAchats}`
                  : `/site/${siteId}${retourAchats}`)}
                title="Fermer"
                className="-ml-1 shrink-0 rounded-xl p-2 text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 sm:hidden">
                <ArrowLeft size={18} />
              </button>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-bold text-gray-900 dark:text-gray-100">{achat.reference}</h1>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${COULEURS_ETAT[achat.etat]}`}>
                  {LIBELLES_ACHAT[achat.etat]}
                </span>
              </div>
            </div>

          {/* Les actions : en ligne au bureau, étirées en pleine largeur
              sur téléphone où le pouce ne vise pas. */}
          <div className="mt-2.5 flex gap-2 [&>button]:flex-1 [&>button]:justify-center sm:mt-0 sm:[&>button]:flex-none">
            {/* Ouvert depuis la vue d'ensemble, le dossier y retourne :
                le renvoyer dans le site ferait changer d'écran sans l'avoir
                demandé. */}
            {/* Ouvert depuis la vue d'ensemble, le dossier y retourne — avec
                la carte et l'axe qu'on regardait. */}
            <button onClick={() => router.push(
              estEnsemble(searchParams)
                ? `/ensemble${retourAchats}`
                : `/site/${siteId}${retourAchats}`)}
              className="hidden px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors sm:block">
              Fermer
            </button>
            {/* « Annuler la commande », jamais « Annuler » : ici l'action détruit le dossier. */}
            {achat.etat === 'en_attente' && peutAnnulerDossier(role as Role | null) && (
              <button onClick={annuler} disabled={enCours}
                className="px-4 py-2 text-sm font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 rounded-xl transition-colors">
                Annuler la commande
              </button>
            )}
            {peutReceptionner && (
              <button onClick={receptionner} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Déclarer reçu
              </button>
            )}
            {peutTraiter && (
              <button onClick={traiter} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Traiter
              </button>
            )}
            {peutConfirmer && (
              <button onClick={() => setModalConfirmation(true)} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirmer
              </button>
            )}
          </div>
          </div>
        </div>
      </header>

      <div className="w-full p-4 sm:p-6 lg:p-8">


        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">

          {/* Sur un téléphone, ces cases se rangeaient deux par deux, chacune
              avec son libellé au-dessus de sa valeur : beaucoup de hauteur
              pour des faits courts. Elles se lisent donc en lignes, le
              libellé devant sa valeur.
              Le fournisseur n'était que dans l'en-tête, qui disparaît au
              défilement : il reste ici. */}
          <div className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4 sm:gap-2">
            {/* Deux par ligne : le libellé reste au-dessus de sa valeur, car
                en demi-largeur les deux côte à côte tronqueraient un nom de
                fournisseur ou une date suivie de son auteur. */}
            <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
              <p className="truncate text-gray-400">Fournisseur</p>
              <p className="truncate font-medium text-gray-700 dark:text-gray-300">{achat.fournisseurNom}</p>
            </div>
            <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
              <p className="truncate text-gray-400">Produits</p>
              <p className="font-medium text-gray-700 dark:text-gray-300">
                {achat.lignes.length} ligne{achat.lignes.length > 1 ? 's' : ''}
              </p>
            </div>
            {/* Chaque étape avec qui l'a franchie : sur une plateforme
                partagée, une date sans auteur ne désigne personne. */}
            {([
              ['Commandé', achat.dateCommande, achat.auteurCommande],
              ['Reçu', achat.dateReception, achat.auteurReception],
              ['Confirmé', achat.dateConfirmation, achat.auteurConfirmation],
            ] as const).filter(([, d]) => d).map(([label, d, a]) => (
              <div key={label} className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
                <p className="truncate text-gray-400">{label}</p>
                <p className="truncate font-medium text-gray-700 dark:text-gray-300">{formatDate(d)}</p>
                {a?.nom && (
                  <p className="truncate text-[11px] text-gray-400">
                    {a.nom}
                    {a.fonction && a.fonction !== a.nom && ` · ${a.fonction}`}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        {achat.etat === 'en_attente' && (
          <div className="flex items-start gap-2 px-4 py-3 mb-4 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 rounded-2xl">
            <Clock size={15} className="text-blue-500 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-700 dark:text-blue-400">
              La marchandise n'est pas arrivée : rien n'est entré en stock, et l'achat n'existe pas encore au nom du fournisseur.
            </p>
          </div>
        )}

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Marchandise</p>
            {/* Tout recevoir d'un coup : le cas courant est celui où le
                fournisseur a livré ce qui était commandé. */}
            {quantitesEditables && (() => {
              const recu = recuParLigne(receptions);
              const total = achat.lignes.reduce(
                (n, l, i) => n + Math.max(0, l.quantiteDemandee - (recu[i] ?? 0)), 0);
              if (total <= 0) return null;
              return (
                <button onClick={() => completer(null)} disabled={enCours}
                  className="flex items-center gap-1.5 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-40 dark:border-indigo-800/40 dark:hover:bg-indigo-900/20">
                  {enCours ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />}
                  Tout recevoir
                </button>
              );
            })()}
          </div>
          {/* Sur téléphone, une carte par ligne.

              Le tableau défilait latéralement pour atteindre les boutons
              de réception : on déclarait une livraison sans voir la
              marchandise qu'on déclarait. */}
          <div className="space-y-2 sm:hidden">
            {achat.lignes.map((l, i) => {
              const reference = l.quantiteRecue ?? null;
              const diverge = reference != null && l.quantiteDemandee !== reference;
              const surplus = reference != null && reference > l.quantiteDemandee;
              const lignesRecep = receptions.filter(r => r.ligneIndex === i);
              const nbRecep = lignesRecep.filter(r => !r.annulee).length;
              const recuLigne = lignesRecep.length > 0
                ? lignesRecep.filter(r => !r.annulee).reduce((n, r) => n + r.quantite, 0)
                : (l.quantiteRecue ?? 0);
              const qte = quantitesEditables ? recuLigne : (l.quantiteRecue ?? l.quantiteDemandee);
              const reste = l.quantiteDemandee - recuLigne;
              return (
                <div key={i}
                  className={`rounded-xl border p-3 ${!diverge
                    ? 'border-gray-100 dark:border-gray-800'
                    : surplus
                    ? 'border-blue-200 bg-blue-50/50 dark:border-blue-800/30 dark:bg-blue-900/10'
                    : 'border-amber-200 bg-amber-50/50 dark:border-amber-800/30 dark:bg-amber-900/10'}`}>
                  <p className="text-[13px] font-bold text-gray-900 dark:text-gray-100">
                    {l.designation}
                    {l.varianteLibelle && (
                      <span className="ml-1.5 font-normal text-gray-400">{l.varianteLibelle}</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {l.emballage ?? l.unite ?? 'unité'}
                  </p>

                  {/* Commandé et reçu côte à côte : c'est leur écart qui
                      fait tout le travail de cet écran. */}
                  <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-black/[0.06] pt-2 text-[11px] dark:border-white/10">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Commandé</span>
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {l.quantiteDemandee.toLocaleString('fr-FR')}
                      </span>
                    </span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Reçu</span>
                      <span className={`font-bold ${!diverge
                        ? 'text-gray-900 dark:text-gray-100'
                        : surplus ? 'text-blue-500' : 'text-orange-500'}`}>
                        {recuLigne > 0 || l.quantiteRecue != null
                          ? recuLigne.toLocaleString('fr-FR') : '—'}
                      </span>
                      {nbRecep > 0 && (
                        <button onClick={() => setDetailLigne(detailLigne === i ? null : i)}
                          title="Voir les réceptions"
                          className={`shrink-0 rounded p-0.5 transition-colors ${
                            detailLigne === i
                              ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30'
                              : 'text-gray-400'}`}>
                          <Info size={12} />
                        </button>
                      )}
                    </span>
                    {montreArgent && (
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-gray-400">Total</span>
                        <span className="font-bold text-gray-900 dark:text-gray-100">
                          {formatMontant(qte * l.valeurUnitaire)}
                        </span>
                      </span>
                    )}
                  </div>

                  {/* Le détail des livraisons, sous la ligne qu'il concerne. */}
                  {detailLigne === i && nbRecep > 0 && (
                    <div className="mt-2 rounded-lg bg-gray-50 p-2 dark:bg-gray-800/50">
                      {lignesRecep.map(r => (
                        <div key={r.id}
                          className={`flex items-center justify-between gap-2 py-1 text-[11px] ${
                            r.annulee ? 'opacity-50' : ''}`}>
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className={`font-bold ${
                              r.annulee ? 'text-gray-400 line-through' : 'text-gray-900 dark:text-gray-100'}`}>
                              {r.quantite.toLocaleString('fr-FR')}
                            </span>
                            <span className="truncate text-gray-400">
                              {formatDate(r.date)} · {r.utilisateurNom}
                            </span>
                          </span>
                          {r.annulee ? (
                            <span className="shrink-0 text-gray-400">Annulée</span>
                          ) : quantitesEditables ? (
                            <button onClick={() => annulerUneReception(r.id)} disabled={enCours}
                              className="shrink-0 text-red-500">Annuler</button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {quantitesEditables && (
                    <div className="mt-2.5 flex items-center gap-1.5">
                      {reste > 0 && (
                        <button onClick={() => completer(i)} disabled={enCours}
                          className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-2 text-xs font-bold text-white transition-colors disabled:opacity-40">
                          <CheckCheck size={12} /> {reste}
                        </button>
                      )}
                      <button onClick={() => { setLigneRecue(i); setQteRecue(0); setNoteRecue(''); }}
                        title="Saisir une quantité"
                        className={`flex shrink-0 items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-600 dark:border-gray-600 dark:text-gray-300 ${
                          reste > 0 ? '' : 'flex-1'}`}>
                        <Plus size={12} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Au-delà du téléphone, le tableau. */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  <th className="text-center px-3 py-2.5 font-medium">Produit</th>
                  {/* L'unité se déduit de l'emballage, et l'emballage se lit
                      sous le produit sur un téléphone : garder les deux
                      colonnes y repousserait le compté et le reçu hors de
                      l'écran, qui sont le travail même. */}
                  <th className="hidden sm:table-cell text-center px-3 py-2.5 font-medium">Unité</th>
                  <th className="hidden sm:table-cell text-center px-3 py-2.5 font-medium">Emballage</th>
                  <th className="text-center px-3 py-2.5 font-medium">Commandé</th>
                  <th className="text-center px-3 py-2.5 font-medium">Reçu</th>
                  {montreArgent && <>
                    <th className="text-center px-3 py-2.5 font-medium">Coût unitaire</th>
                    <th className="text-center px-3 py-2.5 font-medium">Total</th>
                  </>}
                  {/* Les actions ont leur place : serrées sous le chiffre reçu,
                      elles étaient illisibles et écrasaient la colonne. Pas
                      d'en-tête, ce ne sont pas des données. */}
                  {/* Collée à droite : c'est par elle qu'on déclare une
                      réception, et le tableau défile sur un téléphone —
                      sans cela, les boutons restaient hors de l'écran. */}
                  {quantitesEditables && (
                    <th className="sticky right-0 bg-indigo-600 px-3 py-2.5" />
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {achat.lignes.map((l, i) => {
                  const reference = l.quantiteRecue ?? null;
                  const diverge = reference != null && l.quantiteDemandee !== reference;
                  const surplus = reference != null && reference > l.quantiteDemandee;
                  /* Le reçu est la somme des réceptions non annulées. */
                  const lignesRecep = receptions.filter(r => r.ligneIndex === i);
                  const nbRecep = lignesRecep.filter(r => !r.annulee).length;
                  /* Les dossiers antérieurs aux réceptions n'en ont aucune :
                     leur quantité enregistrée reste la seule trace. */
                  const recuLigne = lignesRecep.length > 0
                    ? lignesRecep.filter(r => !r.annulee).reduce((n, r) => n + r.quantite, 0)
                    : (l.quantiteRecue ?? 0);
                  const qte = quantitesEditables ? recuLigne : (l.quantiteRecue ?? l.quantiteDemandee);
                  return (
                    <Fragment key={i}>
                    <tr className={!diverge ? '' : surplus
                      ? 'bg-blue-50/50 dark:bg-blue-900/10'
                      : 'bg-amber-50/50 dark:bg-amber-900/10'}>
                      <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100 text-center">
                        {l.designation}
                        {l.varianteLibelle && <span className="text-gray-400 ml-1.5">{l.varianteLibelle}</span>}
                        {/* Sur téléphone, l'emballage descend sous le produit :
                            la colonne y a disparu, l'information non. */}
                        <span className="block text-xs text-gray-400 sm:hidden">
                          {l.emballage ?? l.unite ?? 'unité'}
                        </span>
                      </td>
                      {/* l'unité appartient au produit ; l'emballage dit seulement
                          combien d'unités la quantité saisie représente */}
                      <td className="hidden sm:table-cell px-3 py-2.5 text-center text-gray-500">{l.unite ?? 'unité'}</td>
                      {/* l'unité est elle-même un emballage, celui de contenance 1 :
                          une ligne saisie à l'unité n'est pas une ligne sans emballage */}
                      <td className="hidden sm:table-cell px-3 py-2.5 text-center text-gray-500">
                        {l.emballage ?? l.unite ?? 'unité'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{l.quantiteDemandee.toLocaleString('fr-FR')}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`font-medium ${!diverge ? 'text-gray-600 dark:text-gray-300' : surplus ? 'text-blue-500' : 'text-orange-500'}`}>
                            {recuLigne > 0 || l.quantiteRecue != null
                              ? recuLigne.toLocaleString('fr-FR') : '—'}
                          </span>
                          {/* Le détail des livraisons : quand, combien, par qui. */}
                          {nbRecep > 0 && (
                            <button onClick={() => setDetailLigne(detailLigne === i ? null : i)}
                              title="Voir les réceptions"
                              className={`shrink-0 rounded p-0.5 transition-colors ${
                                detailLigne === i
                                  ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30'
                                  : 'text-gray-400 hover:bg-indigo-50 hover:text-indigo-600'}`}>
                              <Info size={13} />
                            </button>
                          )}
                        </span>
                      </td>
                      {montreArgent && <>
                        <td className="px-3 py-2.5 text-center text-gray-500">{formatMontant(l.valeurUnitaire)}</td>
                        <td className="px-3 py-2.5 text-center font-medium text-gray-900 dark:text-gray-100">
                          {formatMontant(qte * l.valeurUnitaire)}
                        </td>
                      </>}
                      {/* Une réception s'ajoute, elle ne s'écrase pas. Après la
                          confirmation, le compte est arrêté : plus d'action. */}
                      {quantitesEditables && (
                        /* Fond opaque : la cellule reste lisible quand les
                           colonnes défilent dessous. */
                        <td className="sticky right-0 border-l border-gray-100 bg-white px-3 py-2.5 dark:border-gray-800 dark:bg-gray-900">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Le nombre est sur le bouton : on sait ce qu'il
                                écrira sans avoir à l'ouvrir. */}
                            {l.quantiteDemandee - recuLigne > 0 && (
                              <button onClick={() => completer(i)} disabled={enCours}
                                className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                                <CheckCheck size={12} /> {l.quantiteDemandee - recuLigne}
                              </button>
                            )}
                            <button onClick={() => { setLigneRecue(i); setQteRecue(0); setNoteRecue(''); }}
                              title="Saisir une quantité"
                              className="flex items-center rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-bold text-gray-600 transition-colors hover:border-green-400 hover:bg-green-50 hover:text-green-700 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-green-900/20">
                              <Plus size={12} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                    {detailLigne === i && (
                      <tr key={`d-${i}`}>
                        {/* Le détail s'étend sur toute la ligne : deux colonnes
                            de moins quand les montants sont cachés. */}
                        <td colSpan={(montreArgent ? 7 : 5) + (quantitesEditables ? 1 : 0)}
                          className="px-3 pb-3">
                          <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800/50">
                            <p className="mb-2 text-xs font-bold uppercase text-gray-400">Réceptions</p>
                            <div className="flex flex-col gap-1.5">
                              {lignesRecep.map(r => (
                                <div key={r.id}
                                  className={`flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-1.5 text-xs dark:bg-gray-900 ${
                                    r.annulee ? 'opacity-50' : ''}`}>
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className={`font-bold ${r.annulee ? 'text-gray-400 line-through' : 'text-gray-900 dark:text-gray-100'}`}>
                                      {r.quantite.toLocaleString('fr-FR')}
                                    </span>
                                    <span className="text-gray-500">{formatDate(r.date)}</span>
                                    <span className="text-gray-400">{r.heure}</span>
                                    <span className="truncate text-gray-500">
                                      {r.utilisateurNom}
                                      {r.utilisateurFonction && r.utilisateurFonction !== r.utilisateurNom
                                        && <span className="ml-1 text-gray-400">· {r.utilisateurFonction}</span>}
                                    </span>
                                    {r.note && <span className="truncate text-gray-400">— {r.note}</span>}
                                  </span>
                                  {r.annulee ? (
                                    <span className="shrink-0 text-gray-400">Annulée</span>
                                  ) : quantitesEditables ? (
                                    <button onClick={() => annulerUneReception(r.id)} disabled={enCours}
                                      className="shrink-0 text-red-500 transition-colors hover:text-red-600">
                                      Annuler
                                    </button>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Les totaux s'adressent à celui qui répond des dépenses. Le
              responsable des commandes, lui, compte des produits : l'onglet
              les lui cache déjà, la fiche doit en faire autant. */}
          {montreArgent && (
          <div className="flex flex-col gap-1.5 pt-3 mt-3 border-t border-gray-100 dark:border-gray-800 text-sm">
            <LigneTotal label="Commandé" valeur={formatMontant(commande)} />
            {achat.lignes.some(l => l.quantiteRecue != null) && (
              <>
                <LigneTotal label="Reçu" valeur={formatMontant(recu)} />
                <LigneTotal
                  label={ecart < 0 ? 'Surplus reçu' : 'Écart'}
                  valeur={formatMontant(Math.abs(ecart))}
                  classeValeur={`font-bold ${ecart === 0 ? 'text-gray-400' : ecart > 0 ? 'text-orange-500' : 'text-blue-500'}`} />
              </>
            )}
            <div className="flex items-baseline gap-2">
              <span className="flex flex-wrap items-center gap-1.5 text-gray-400 shrink-0">
                {/* la ligne additionne avances et règlements : « Versé » les couvre
                    tous les deux, « Avance » n'en nommait qu'un */}
                Versé
                {/* des boutons pâles passaient inaperçus : ils portent une action */}
                <button onClick={() => setModalAvance(true)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 transition-colors">
                  <Info size={11} /> Détail
                </button>
                {/* Une facture reçue et impayée doit pouvoir être réglée :
                    c'est le reste dû qui ouvre le versement, pas l'état. */}
                {achat.etat !== 'annule' && resteAPayer > 0 && (
                  <button onClick={() => setModalVersement(true)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 transition-colors">
                    <Plus size={11} /> {achat.etat === 'en_attente' ? 'Avance' : 'Règlement'}
                  </button>
                )}
              </span>
              <span className="flex-1 border-b border-dotted border-gray-200 dark:border-gray-700" />
              <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap shrink-0">
                {formatMontant(achat.avanceVersee ?? 0)}
              </span>
            </div>
            {achat.etat !== 'en_attente' && achat.etat !== 'annule' && resteDu > 0 && (
              <LigneTotal label="Reste dû au fournisseur" valeur={formatMontant(resteDu)}
                classeValeur="font-bold text-orange-500" />
            )}
            {achat.etat === 'confirme' && (achat.retourCaisse ?? 0) > 0 && (
              <LigneTotal label="Retourné en caisse" valeur={formatMontant(achat.retourCaisse)}
                classeValeur="font-bold text-green-600" />
            )}
            {peutConfirmer && retourPrevu > 0 && (
              <LigneTotal label="Reviendra en caisse" valeur={formatMontant(retourPrevu)}
                classeValeur="font-bold text-green-600" />
            )}
          </div>
          )}
        </div>

        {achat.note && (
          <p className="text-xs text-gray-500 dark:text-gray-400 px-4 py-3 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800">
            {achat.note}
          </p>
        )}

        {erreur && <p className="text-xs text-red-500 mt-3">{erreur}</p>}
      </div>

      {modalAvance && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Versements</p>
              <button onClick={() => setModalAvance(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {versements.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-6">Aucun versement.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {versements.map(v => (
                    <div key={v.id} className="flex justify-between items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/50 rounded-xl text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-gray-500">{formatDate(v.date)}</span>
                        {/* avance ou règlement : l'un était récupérable, l'autre non */}
                        <span className={`px-1.5 rounded text-[10px] font-bold ${v.motif === 'avance'
                          ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'}`}>
                          {LIBELLES_MOTIF_VERSEMENT[v.motif] ?? v.motif}
                        </span>
                        {/* Nom et fonction : plusieurs personnes peuvent
                            tenir le même rôle, et le rôle seul ne dit pas
                            qui a fait le versement. */}
                        {v.utilisateurNom && (
                          <span className="truncate text-xs text-gray-500">
                            {v.utilisateurNom}
                            {v.utilisateurFonction && v.utilisateurFonction !== v.utilisateurNom && (
                              <span className="ml-1 text-gray-400">· {v.utilisateurFonction}</span>
                            )}
                          </span>
                        )}
                      </span>
                      <span className="font-medium text-gray-900 dark:text-gray-100 shrink-0">{formatMontant(v.montant)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between items-center px-3 pt-2 mt-1 border-t border-gray-100 dark:border-gray-800 text-sm">
                    <span className="text-gray-400">Total</span>
                    <span className="font-bold text-gray-900 dark:text-gray-100">{formatMontant(achat.avanceVersee ?? 0)}</span>
                  </div>
                </div>
              )}

              {erreur && <p className="text-xs text-red-500 mt-3">{erreur}</p>}
            </div>
          </div>
        </div>
      )}

      {/* Ce qu'on s'apprête à valider, ligne par ligne. Toujours montré :
          confirmer fait entrer le stock et fige le coût moyen. */}
      {modalConfirmation && achat && (() => {
        const recu = recuParLigne(receptions);
        const lignes = achat.lignes.map((l, i) => {
          const r = receptions.some(x => x.ligneIndex === i)
            ? (recu[i] ?? 0) : (l.quantiteRecue ?? 0);
          return { l, recu: r, ecart: r - l.quantiteDemandee };
        });
        const enEcart = lignes.filter(x => x.ecart !== 0);
        const aPerte = lignesAPerte();

        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl dark:bg-gray-900">
              <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Confirmer la réception</p>
                <button onClick={() => setModalConfirmation(false)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {/* Sans écart, rien à détailler : la commande est arrivée
                    telle qu'elle a été passée, on le dit et on confirme. */}
                {enEcart.length === 0 ? (
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    {lignes.length} produit{lignes.length > 1 ? 's' : ''} reçu{lignes.length > 1 ? 's' : ''}
                    {' '}comme commandé{lignes.length > 1 ? 's' : ''}, pour{' '}
                    <span className="font-bold text-gray-900 dark:text-gray-100">
                      {formatMontant(lignes.reduce((n, x) => n + x.recu * x.l.valeurUnitaire, 0))}
                    </span>.
                    {' '}Le stock va entrer et le coût moyen se recalculer.
                  </p>
                ) : (
                  <>
                    {/* Seuls les produits en écart : les lignes conformes
                        n'appellent aucune décision. */}
                    <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">
                      {enEcart.length} produit{enEcart.length > 1 ? 's' : ''} sur {lignes.length}
                      {' '}n&apos;{enEcart.length > 1 ? 'ont' : 'a'} pas été reçu
                      {enEcart.length > 1 ? 's' : ''} comme commandé
                      {enEcart.length > 1 ? 's' : ''}.
                    </p>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-400">
                          <th className="pb-2 text-left font-medium">Produit</th>
                          <th className="pb-2 text-center font-medium">Commandé</th>
                          <th className="pb-2 text-center font-medium">Reçu</th>
                          <th className="pb-2 text-center font-medium">Écart</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                        {enEcart.map((x, i) => (
                          <tr key={i}>
                            <td className="py-2 text-gray-900 dark:text-gray-100">
                              {x.l.designation}
                              {x.l.varianteLibelle && <span className="ml-1.5 text-gray-400">{x.l.varianteLibelle}</span>}
                            </td>
                            <td className="py-2 text-center text-gray-500">{x.l.quantiteDemandee}</td>
                            <td className="py-2 text-center font-medium text-gray-900 dark:text-gray-100">{x.recu}</td>
                            {/* Reçu en deçà : il manque. Au-delà : surplus. */}
                            <td className={`py-2 text-center font-bold ${
                              x.ecart < 0 ? 'text-orange-500' : 'text-blue-500'}`}>
                              {x.ecart > 0 ? '+' : ''}{x.ecart}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                      Le stock entrera pour ce qui a été reçu.
                    </p>
                  </>
                )}

                {/* Le coût moyen va changer : un prix de vente resté dessous
                    ferait vendre à perte, et on ne s'en apercevrait qu'à la
                    première vente. */}
                {aPerte.length > 0 && (
                  <div className="mt-3 rounded-xl bg-red-50 p-3 dark:bg-red-900/20">
                    <p className="text-xs font-bold text-red-700 dark:text-red-400">
                      Prix de vente sous le coût
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {aPerte.map((x, i) => (
                        <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                          <span className="font-medium text-red-700 dark:text-red-300">{x.l.designation}</span>
                          <span className="text-red-600 dark:text-red-400">
                            vente {formatMontant(x.l.prixVente ?? 0)} · coût {formatMontant(x.cout)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 gap-2 border-t border-gray-100 px-5 py-4 dark:border-gray-800">
                <button onClick={() => setModalConfirmation(false)}
                  className="flex-1 rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
                  Annuler
                </button>
                <button onClick={confirmer} disabled={enCours}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-white transition-colors disabled:opacity-40 ${
                    aPerte.length > 0 ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}>
                  {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {aPerte.length > 0 ? 'Confirmer quand même' : 'Confirmer'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Recevoir une quantité : elle s'ajoute aux précédentes. */}
      {ligneRecue != null && achat && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                Recevoir — {achat.lignes[ligneRecue]?.designation}
              </p>
              <button onClick={() => setLigneRecue(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="p-5 flex flex-col gap-3">
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Quantité</label>
                <ChampNombre valeur={qteRecue} onChange={setQteRecue}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-right text-gray-900 dark:text-gray-100" />
                {(() => {
                  const l = achat.lignes[ligneRecue];
                  const deja = receptions
                    .filter(r => r.ligneIndex === ligneRecue && !r.annulee)
                    .reduce((n, r) => n + r.quantite, 0);
                  const attendu = Math.max(0, l.quantiteDemandee - deja);
                  return (
                    <p className="text-xs text-gray-400 mt-1.5">
                      Commandé <span className="font-bold text-gray-600 dark:text-gray-300">{l.quantiteDemandee}</span>
                      {' · '}Déjà reçu <span className="font-bold text-gray-600 dark:text-gray-300">{deja}</span>
                      {attendu > 0 && <>{' · '}Attendu <span className="font-bold text-gray-600 dark:text-gray-300">{attendu}</span></>}
                    </p>
                  );
                })()}
              </div>

              <input type="text" value={noteRecue}
                onChange={e => setNoteRecue(e.target.value)}
                placeholder="Note"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />

              {erreur && <p className="text-xs text-red-500">{erreur}</p>}
            </div>

            <div className="flex gap-2 px-5 py-4 border-t border-gray-100 dark:border-gray-800">
              <button onClick={() => setLigneRecue(null)}
                className="flex-1 px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors">
                Annuler
              </button>
              <button onClick={ajouterReception} disabled={enCours || qteRecue <= 0}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Recevoir
              </button>
            </div>
          </div>
        </div>
      )}

      {modalVersement && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {achat.etat === 'en_attente' ? 'Ajouter une avance' : 'Ajouter un règlement'}
              </p>
              <button onClick={() => setModalVersement(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="p-5 flex flex-col gap-3">
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Date</label>
                <input type="date" value={dateVersement} max={aujourdhui()}
                  onChange={e => setDateVersement(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />
              </div>
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Montant</label>
                <ChampNombre valeur={nouveauVersement}
                  onChange={setNouveauVersement} max={resteAPayer}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-right text-gray-900 dark:text-gray-100" />
                <p className="text-xs text-gray-400 mt-1.5">
                  Reste à payer <span className="font-bold text-gray-600 dark:text-gray-300">{formatMontant(resteAPayer)}</span>
                </p>
                {/* Le calcul en entier quand quelque chose est engagé : un
                    tiroir qui affiche 50 000 et refuse 40 000 se lit comme
                    une panne tant qu'on ne dit pas ce qui est promis. */}
                {soldeCaisseSite != null && (
                  <DisponibleCaisse className="mt-2"
                    solde={soldeReelCaisse ?? soldeCaisseSite}
                    engage={engageCaisse} disponible={soldeCaisseSite} />
                )}
              </div>

              {/* Payer sort de l'argent : si la caisse ne suffit pas, l'apport
                  se fait ici plutôt que d'obliger à quitter le dossier. */}
              {depasseCaisse && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-900/20">
                  <p className="mb-2 text-xs font-bold text-red-600 dark:text-red-400">
                    Manque {formatMontant(manqueCaisse)}
                  </p>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={avecApport}
                      onChange={e => { setAvecApport(e.target.checked); if (e.target.checked) setApport(manqueCaisse); }}
                      className="accent-amber-600" />
                    <span className="text-xs font-bold text-amber-800 dark:text-amber-400">
                      Compléter par un apport
                    </span>
                  </label>
                  {avecApport && (
                    <div className="mt-2.5">
                      <ChampNombre valeur={apport} onChange={setApport}
                        className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-right text-gray-900 dark:border-amber-800 dark:bg-gray-800 dark:text-gray-100" />
                      <p className={`mt-1 text-[11px] ${
                        apport < manqueCaisse ? 'text-red-500' : 'text-amber-700 dark:text-amber-400'}`}>
                        {apport < manqueCaisse
                          ? `Minimum ${formatMontant(manqueCaisse)}`
                          : `Caisse après ${formatMontant((soldeCaisseSite ?? 0) + apport - nouveauVersement)}`}
                      </p>
                      <input type="text" value={detailApport}
                        onChange={e => setDetailApport(e.target.value)}
                        placeholder="Détail"
                        className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-amber-600/50 dark:border-amber-800 dark:bg-gray-800 dark:text-gray-100" />
                    </div>
                  )}
                </div>
              )}

              {erreur && <p className="text-xs text-red-500">{erreur}</p>}
            </div>

            <div className="flex gap-2 px-5 py-4 border-t border-gray-100 dark:border-gray-800">
              <button onClick={() => setModalVersement(false)}
                className="flex-1 px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors">
                Annuler
              </button>
              <button onClick={ajouterVersement} disabled={enCours || nouveauVersement <= 0 || !apportSuffit}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ajouter
              </button>
            </div>
          </div>
        </div>
      )}

      {retour !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Wallet size={18} className="text-green-500" />
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Différence retournée en caisse</p>
              </div>
              <button onClick={() => setRetour(null)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>
            <p className="text-2xl font-bold text-green-600 mb-2">{formatMontant(retour)}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              L'avance versée dépassait la marchandise reçue. La différence est rentrée en caisse : le dossier est clos, aucun solde ne reste ouvert chez le fournisseur.
            </p>
            <button onClick={() => setRetour(null)}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl transition-colors">
              Compris
            </button>
          </div>
        </div>
      )}

      {/* Comment cette dette sera réglée : demandé au moment où elle naît. */}
      {aPlanifier != null && achat.fournisseurId && (
        <ModalPlanification
          siteId={siteId}
          partenaireId={achat.fournisseurId}
          partenaireNom={achat.fournisseurNom}
          role="fournisseur"
          montant={aPlanifier}
          onFermer={() => { setAPlanifier(null); void cloreQuestion(); }}
          onValider={async (plan: Planification) => {
            setAPlanifier(null);
            /* Repondre clot la question, « plus tard » compris : c'est une
               reponse, et la reposer a chaque ouverture serait la harceler. */
            void cloreQuestion();
            try {
              await appliquerPlanification({
                siteId, userId: user!.uid,
                partenaireId: achat.fournisseurId!,
                role: 'fournisseur', plan,
              });
            } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
          }}
        />
      )}
    </div>
  );
}
