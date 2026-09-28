'use client';
import { Fragment, useEffect, useState } from 'react';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter } from 'next/navigation';
import { Loader2, Check, Ship, ArrowRight, X, CheckCheck, Plus, Undo2, Info,
  Wallet } from 'lucide-react';
import { formatMontant, formatDate } from '@/lib/format';
import { auteurCourant, auteurEtape } from '@/lib/auteur';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import PanneauFrais from '@/app/site/[id]/components/PanneauFrais';
import {
  totalFrais, controlerRepartition, repartirFrais,
  CLE_PAR_DEFAUT, type Frais, type CleRepartition,
} from '@/lib/frais';
import {
  valeurEnvoyee, confirmerAchat, type LigneFlux,
} from '@/lib/flux-marchandise';
import { ChampNombre } from '@/components/Champs';
import {
  prixPourBenefice, beneficeActuel, coutTotal, tauxDeMarge,
} from '@/lib/benefice';
import SelecteurProduits, { type ProduitChoisissable }
  from '@/app/site/[id]/components/SelecteurProduits';
import ModalGammeProduit from '@/app/site/[id]/components/ModalGammeProduit';
import { produitsDuSite, sitesDeLActivite } from '@/lib/produits-site';
import { creerProduitRapide, creerGammeRapide } from '@/lib/produit-rapide';
import { coutMoyenApresEntree, enUnitesBase, emballagesDe } from '@/lib/mouvements';
import { chargerDisponible } from '@/lib/attente-caisse';
import DisponibleCaisse from '@/app/site/[id]/components/DisponibleCaisse';
import { ecrireEnCaisse } from '@/lib/ecrire-caisse';
import {
  enregistrerVersement, versementsDuDossier, type Versement,
} from '@/lib/versements-collection';
import {
  enregistrerReception, annulerReception, chargerReceptions, recuParLigne,
  type Reception,
} from '@/lib/receptions';
import {
  ETAPES_IMPORTATION, LIBELLES_IMPORTATION, AIDE_IMPORTATION,
  prochainEtat, peutAvancer, avancerImportation, annulerImportation,
  majFraisImportation, majPrixImportation,
  type Importation, type EtatImportation,
} from '@/lib/importations';

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

/**
 * La fiche d'une importation.
 *
 * C'est la fiche d'un achat, avec le voyage étalé : chaque étape se
 * franchit d'un geste, et la date reste. Un conteneur bloqué trois
 * semaines en douane se lit dans ces dates, pas dans son état courant.
 *
 * Les frais s'ajoutent au fil des étapes — le fret se connaît à
 * l'expédition, les droits au dédouanement — et se répartissent sur les
 * produits à la confirmation, exactement comme sur un bon d'achat.
 *
 * La confirmation passe par `confirmerAchat` : le geste est le même, et
 * deux façons de faire entrer du stock finiraient par diverger.
 */
export default function FicheImportationPage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const params = useParams();
  const importId = params.importId as string;

  const [dossier, setDossier] = useState<Importation | null>(null);
  const [role, setRole] = useState<RoleSite | null>(null);
  const [loading, setLoading] = useState(true);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  const [modalConfirmation, setModalConfirmation] = useState(false);

  /* Les frais en cours de saisie : ils ne s'inscrivent qu'au geste, sinon
     le dossier porterait un état par caractère tapé. */
  const [frais, setFrais] = useState<Frais[]>([]);
  const [fraisCorrection, setFraisCorrection] =
    useState<Record<number, number> | null>(null);
  const [fraisCle, setFraisCle] = useState<CleRepartition>(CLE_PAR_DEFAUT);
  const [fraisSales, setFraisSales] = useState(false);

  /* Ce qui est arrivé, réception par réception.
     Le reçu ne se saisit pas : il se déduit de ces faits datés. Un
     conteneur livré en deux fois laisse deux traces, pas un nombre
     écrasé. */
  const [receptions, setReceptions] = useState<Reception[]>([]);
  /* La saisie d'une quantité partielle, quand elle est ouverte. */
  /* Payer le fournisseur. L'argent sort de la caisse du site, ou de la
     main de l'admin — virement, retrait déjà fait. Dans ce second cas la
     dette s'éteint sans que le tiroir bouge : le versement porte son
     origine, pour qu'on sache toujours d'où l'argent est parti. */
  const [versements, setVersements] = useState<Versement[]>([]);
  const [modalVersement, setModalVersement] = useState(false);
  const [nouveauVersement, setNouveauVersement] = useState(0);
  const [dateVersement, setDateVersement] = useState(aujourdhui());
  const [soldeCaisseSite, setSoldeCaisseSite] = useState<number | null>(null);
  const [soldeReelCaisse, setSoldeReelCaisse] = useState<number | null>(null);
  const [engageCaisse, setEngageCaisse] = useState(0);
  /* Deux sources, et non une caisse qu'on renfloue : un virement au
     fournisseur ne passe pas par le tiroir du site. */
  const [origine, setOrigine] = useState<'caisse' | 'admin'>('caisse');

  /* La liste se complète tant que le fournisseur n'a rien confirmé : on
     se souvient d'une référence oubliée, on l'ajoute. Après « Validé »,
     la commande est partie — l'allonger ici la ferait diverger de ce que
     le fournisseur a accepté. */
  const [produits, setProduits] = useState<ProduitChoisissable[]>([]);
  const [produitsNeufs, setProduitsNeufs] = useState<Set<string>>(new Set());
  const [gamme, setGamme] = useState<string | null>(null);
  const [lignesSales, setLignesSales] = useState(false);
  const [lignes, setLignes] = useState<LigneFlux[]>([]);

  /* Le coût et les quantités se corrigent jusqu'à la confirmation : une
     facture arrive avec d'autres chiffres qu'un devis, et rouvrir le
     dossier pour cela n'aurait pas de sens. */
  const [couts, setCouts] = useState<Record<number, number>>({});
  const [qtes, setQtes] = useState<Record<number, number>>({});
  const [chiffresSales, setChiffresSales] = useState(false);

  /* Le bénéfice qu'on cherche sur le dossier entier. L'app en déduit des
     prix — produit par produit on perd le total de vue. */
  const [objectif, setObjectif] = useState(0);
  const [blocBenefice, setBlocBenefice] = useState(false);

  /* Le prix de vente, ligne par ligne. Il se décide tard : tant que le
     fret et la douane ne sont pas répartis, on ignore ce que la
     marchandise aura coûté, et un prix posé avant serait posé à
     l'aveugle. */
  const [prix, setPrix] = useState<Record<number, number>>({});
  const [prixSales, setPrixSales] = useState(false);

  /* Le détail des réceptions d'une ligne, déplié à la demande : c'est
     là qu'une quantité posée par erreur s'annule. */
  const [detailLigne, setDetailLigne] = useState<number | null>(null);
  const [ligneRecue, setLigneRecue] = useState<number | null>(null);
  const [qteRecue, setQteRecue] = useState(0);

  async function charger() {
    const snap = await getDoc(doc(db, 'importations', importId));
    if (!snap.exists()) { setDossier(null); setLoading(false); return; }
    const d = { id: snap.id, ...(snap.data() as any) } as Importation;
    setDossier(d);

    /* Les versements du seul dossier, et ce que la caisse peut encore
       laisser sortir. Les deux lectures partent ensemble : aucune ne
       dépend de l'autre. */
    const [vers, caisse] = await Promise.all([
      versementsDuDossier(importId, 'achat').catch(() => []),
      chargerDisponible(d.siteId).catch(() => null),
    ]);
    setVersements(vers);
    if (caisse) {
      setSoldeCaisseSite(caisse.disponible);
      setSoldeReelCaisse(caisse.solde);
      setEngageCaisse(caisse.engage);
    }
    setLignesSales(sale => {
      if (!sale) setLignes(d.lignes ?? []);
      return sale;
    });
    setPrixSales(sale => {
      if (!sale) {
        setPrix(Object.fromEntries(
          (d.lignes ?? []).map((l, i) => [i, l.prixVente ?? 0])));
      }
      return sale;
    });
    setChiffresSales(sale => {
      if (!sale) {
        setCouts(Object.fromEntries(
          (d.lignes ?? []).map((l, i) => [i, l.valeurUnitaire ?? 0])));
        setQtes(Object.fromEntries(
          (d.lignes ?? []).map((l, i) => [i, l.quantiteDemandee ?? 0])));
      }
      return sale;
    });
    setFraisSales(sale => {
      if (!sale) {
        setFrais(d.frais ?? []);
        setFraisCorrection(d.fraisCorrection ?? null);
        setFraisCle(d.fraisCle ?? CLE_PAR_DEFAUT);
      }
      return sale;
    });
    setLoading(false);
  }

  useEffect(() => { charger().catch(() => setLoading(false)); }, [importId]);

  useEffect(() => {
    chargerReceptions(importId).then(setReceptions).catch(() => {});
  }, [importId]);

  /* Le catalogue du site destinataire. Il sert à compléter la liste tant
     qu'elle bouge, mais aussi — à tous les états — à dire ce que le rayon
     détient déjà : son prix de vente en place, et le coût moyen que cette
     entrée va déplacer. */
  useEffect(() => {
    if (!dossier) return;
    produitsDuSite(dossier.siteId)
      .then(p => setProduits(p as ProduitChoisissable[]))
      .catch(() => {});
  }, [dossier?.siteId]);

  /* Le rôle se lit sur le site destinataire : c'est lui qui recevra la
     marchandise, et c'est son responsable des commandes qui comptera. */
  useEffect(() => {
    if (!user || !dossier) return;
    roleSurSite(dossier.siteId, user.uid)
      .then(r => setRole(r))
      .catch(() => setRole(null));
  }, [user, dossier]);

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!dossier) return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Dossier introuvable.</p>
      <button onClick={() => router.push('/ensemble?onglet=importations')}
        className="px-4 py-2 text-xs font-bold text-indigo-600 hover:underline">
        Retour
      </button>
    </div>
  );

  /* `null` désigne le propriétaire : il n'a pas de rôle sur un site
     puisqu'il les possède tous. */
  const estAdmin = role === null;
  const montreArgent = role !== 'commandes';

  /* Le reçu se déduit des réceptions, il ne se saisit pas. */
  const recu = recuParLigne(receptions);

  /* Le dossier vaut ce qui est arrivé une fois compté ; avant, ce qui
     était annoncé. */
  const compte = ETAPES_IMPORTATION.indexOf(dossier.etat)
    >= ETAPES_IMPORTATION.indexOf('recu') || dossier.etat === 'attente_confirmation';
  /* Compté, la marchandise vaut les réceptions posées, pas le champ
     figé de la ligne : c'est le registre qui dit ce qui est arrivé. */
  const marchandise = compte
    ? dossier.lignes.reduce(
        (n, l, i) => n + (recu[i] ?? l.quantiteRecue ?? 0) * l.valeurUnitaire, 0)
    : valeurEnvoyee(dossier.lignes);
  const fraisTotal = totalFrais(frais);
  const total = marchandise + fraisTotal;
  const verse = dossier.avanceVersee ?? 0;
  const reste = Math.max(0, total - verse);

  /* Les frais se modifient jusqu'à la confirmation. Après, le coût moyen
     en porte la trace : les changer réécrirait des marges déjà figées. */
  const fraisModifiables = dossier.etat !== 'confirme' && dossier.etat !== 'annule';
  const parts = fraisTotal > 0
    ? repartirFrais(dossier.lignes, frais, fraisCorrection, fraisCle) : null;

  /**
   * Ce que le rayon sait déjà de chaque ligne : son prix de vente en
   * place, son stock et son coût moyen.
   *
   * Le dossier dit ce qu'on achète ; le rayon dit ce qu'on en fera. Les
   * deux ensemble permettent de voir si le prix tient et où le coût
   * moyen va se poser.
   */
  const rayon = dossier.lignes.map(l => {
    const p = produits.find(x => x.id === l.produitId);
    if (!p) return null;
    const v = l.varianteCle
      ? (p.variantes ?? []).find((x: any) => x.cle === l.varianteCle)
      : null;
    const contenance = l.emballage
      ? (emballagesDe(p as any, l.varianteCle)
          .find(e => e.nom === l.emballage)?.quantite ?? 1)
      : 1;
    return {
      stock: v ? (v.stock ?? 0) : (p.stock ?? 0),
      coutMoyen: v ? (v.coutMoyen ?? 0) : (p.coutMoyen ?? 0),
      /* Le prix se tient à l'unité dans le rayon ; ici on raisonne dans
         l'emballage commandé — il faut les mettre au même pas. */
      prixVente: (v ? (v.prixVente ?? 0) : (p.prixVente ?? 0)) * contenance,
      contenance,
    };
  });

  /* Le prix déjà pratiqué, ramené à l'emballage du dossier. */
  const etablis: Record<number, number> = {};
  rayon.forEach((r, i) => { if (r && r.prixVente > 0) etablis[i] = r.prixVente; });

  /**
   * Où le coût moyen se posera, une fois cette entrée passée.
   *
   * C'est le chiffre qui décide de la marge, et ce n'est pas celui qu'on
   * paie : un produit acheté 900 quand le rayon en tient mille à 700 ne
   * coûtera pas 900, mais 714. Le voir avant de poser le prix évite de
   * se croire à peine rentable — ou de découvrir à la première vente que
   * le coût est passé au-dessus du prix.
   *
   * Frais compris : c'est le coût réel qui entre, pas le prix facturé.
   */
  const cumpApres = dossier.lignes.map((l, i) => {
    const r = rayon[i];
    if (!r) return null;
    const qte = compte ? (recu[i] ?? 0) : (qtes[i] ?? l.quantiteDemandee ?? 0);
    if (qte <= 0) return null;
    const part = parts?.[i] ?? 0;
    const reel = (couts[i] ?? l.valeurUnitaire ?? 0) + part / qte;
    const p = produits.find(x => x.id === l.produitId);
    const unites = p
      ? enUnitesBase(qte, l.emballage, emballagesDe(p as any, l.varianteCle))
      : qte;
    if (unites <= 0) return null;
    /* Le rayon compte à l'unité ; on y revient pour moyenner, puis on
       remonte dans l'emballage du dossier pour l'afficher. */
    const apres = coutMoyenApresEntree(
      r.stock, r.coutMoyen, unites, (reel * qte) / unites);
    return Math.round(apres * r.contenance);
  });

  /* Les frais se posent entièrement, ou le dossier n'avance pas. */
  const controle = controlerRepartition(dossier.lignes, frais, fraisCorrection, fraisCle);

  /**
   * Ce qu'une ligne peut porter au plus : tout ce que les AUTRES lignes
   * ne se sont pas vu imposer.
   *
   * On ne compte que les parts posées à la main. Les compter toutes
   * donnerait un plafond égal à la part du moment : la ligne serait
   * gelée, impossible à monter comme à baisser.
   */
  function plafondPart(i: number): number {
    return Math.max(0, fraisTotal - Object.entries(fraisCorrection ?? {})
      .reduce((n, [j, v]) => Number(j) === i ? n : n + (v ?? 0), 0));
  }

  const suivant = prochainEtat(dossier.etat, role, estAdmin);
  const peut = peutAvancer(dossier.etat, role, estAdmin);
  /* C'est à la réception qu'on compte : avant, il n'y a rien à confronter. */
  const saisieQuantites = dossier.etat === 'traitement';

  /**
   * Déclarer ce qui est arrivé : une ligne, ou tout ce qui manque.
   *
   * Rien n'est prérempli. Un reçu posé d'avance à la quantité commandée
   * ferait que personne ne compte — et le système ne servirait plus qu'à
   * recopier le bon de commande.
   */
  async function completer(ligneIndex: number | null) {
    if (!dossier || !user || enCours) return;
    const aEcrire: { i: number; quantite: number }[] = [];
    dossier.lignes.forEach((l, i) => {
      if (ligneIndex != null && i !== ligneIndex) return;
      const manque = l.quantiteDemandee - (recu[i] ?? 0);
      if (manque > 0) aEcrire.push({ i, quantite: manque });
    });
    if (aEcrire.length === 0) return;

    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurCourant(dossier.siteId, user.uid);
      const date = aujourdhui();
      await Promise.all(aEcrire.map(({ i, quantite }) => enregistrerReception({
        siteId: dossier.siteId,
        documentId: importId,
        ligneIndex: i,
        produitId: dossier.lignes[i].produitId ?? null,
        designation: dossier.lignes[i].designation,
        quantite, date,
        utilisateur: user.uid,
        utilisateurNom: auteur.utilisateurNom,
        utilisateurFonction: auteur.utilisateurFonction,
        note: null,
      })));
      setReceptions(await chargerReceptions(importId));
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /** Une quantité partielle : le conteneur n'arrive pas toujours entier. */
  async function ajouterReception() {
    if (ligneRecue == null || qteRecue <= 0 || !dossier || !user) return;
    setEnCours(true); setErreur('');
    try {
      const l = dossier.lignes[ligneRecue];
      const auteur = await auteurCourant(dossier.siteId, user.uid);
      await enregistrerReception({
        siteId: dossier.siteId,
        documentId: importId,
        ligneIndex: ligneRecue,
        produitId: l.produitId ?? null,
        designation: l.designation,
        quantite: qteRecue,
        date: aujourdhui(),
        utilisateur: user.uid,
        utilisateurNom: auteur.utilisateurNom,
        utilisateurFonction: auteur.utilisateurFonction,
        note: null,
      });
      setReceptions(await chargerReceptions(importId));
      setLigneRecue(null); setQteRecue(0);
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* On n'ajuste pas une réception : on l'annule et on en saisit une
     autre. Corriger en place effacerait la trace de l'erreur. */
  async function defaire(id: string) {
    if (!user) return;
    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurCourant(dossier!.siteId, user.uid, user.displayName);
      await annulerReception({
        receptionId: id, par: user.uid, parNom: auteur.utilisateurNom });
      setReceptions(await chargerReceptions(importId));
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* La caisse ne laisse sortir que ce qu'elle a. La poche de l'admin ne
     connaît pas cette borne : l'app ne tient pas ses comptes à lui. */
  const depasseCaisse = origine === 'caisse'
    && soldeCaisseSite != null && nouveauVersement > soldeCaisseSite;

  /**
   * Règle une part du dossier.
   *
   * Par la caisse, l'argent sort du tiroir du site et le registre le
   * voit. Par l'admin — virement, espèces déjà retirées — il ne passe
   * nulle part chez nous : inventer un aller-retour en caisse ferait
   * deux mouvements qui n'ont pas eu lieu. La dette s'éteint dans les
   * deux cas, et le versement dit lequel.
   */
  /* Le prix se fige à la confirmation : après, le coût moyen et les
     marges en portent la trace, et le changer réécrirait le passé. */
  const prixEditables = dossier.etat !== 'confirme' && dossier.etat !== 'annule'
    && montreArgent;

  /* Le coût et les quantités se corrigent tant que rien n'est figé : une
     facture arrive avec d'autres chiffres qu'un devis, et c'est elle qui
     fait foi. Après la confirmation, le coût moyen en porte la trace. */
  const chiffresEditables = prixEditables && estAdmin
    && dossier.etat !== 'en_attente';

  /* La liste ne se complète que tant que rien n'est parti : « Validé »
     dit que le fournisseur a accepté cette commande-là. */
  const lignesModifiables = dossier.etat === 'en_attente' && estAdmin;

  async function enregistrerLignes() {
    if (!dossier) return;
    if (lignes.length === 0 || lignes.some(l => !l.produitId || l.quantiteDemandee <= 0)) {
      setErreur('Chaque ligne veut un produit et une quantité.');
      return;
    }
    setEnCours(true); setErreur('');
    try {
      await majPrixImportation({ id: importId, lignes });
      setLignesSales(false);
      /* Les parts imposées désignaient d'anciennes positions : une ligne
         ajoutée au milieu les ferait porter au mauvais produit. */
      setFraisCorrection(null);
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /**
   * Créer un produit sans quitter le dossier.
   *
   * Un import apporte des références que la maison n'a jamais tenues —
   * c'est même souvent pour cela qu'on importe.
   */
  async function creerEtAjouter(designation: string) {
    if (!user || !dossier) return;
    setErreur('');
    try {
      const siteIds = activite?.id
        ? await sitesDeLActivite(activite.id)
        : [dossier.siteId];
      const neuf = await creerProduitRapide({
        activiteId: activite?.id ?? null,
        userId: user.uid,
        designation,
        unite: 'pièce',
        siteIds: siteIds.length > 0 ? siteIds : [dossier.siteId],
        siteOrigine: dossier.siteId,
      });
      setProduits(p => [...p, {
        id: neuf.id, siteId: dossier.siteId,
        designation: neuf.designation, unite: neuf.unite,
        codeBarre: null, categorie: null,
        emballages: [], caracteristiques: [], variantes: [],
        actif: true, stock: 0, coutMoyen: 0, prixVente: 0,
        seuilAlerte: null,
      } as unknown as ProduitChoisissable]);
      setProduitsNeufs(n => new Set(n).add(neuf.id));
      setLignes(l => [...l, {
        produitId: neuf.id,
        designation: neuf.designation,
        unite: neuf.unite,
        varianteCle: null, varianteLibelle: null, emballage: null,
        quantiteDemandee: 1, quantiteRecue: null,
        valeurUnitaire: 0, prixVente: 0,
      } as any]);
      setLignesSales(true);
    } catch (e: any) {
      setErreur(e?.message ?? 'Le produit n’a pas pu être créé.');
    }
  }

  /** Créer une gamme entière, et l'ajouter au dossier. */
  async function creerGammeEtAjouter(saisie: {
    designation: string; unite: string; categorie: string | null;
    emballages: any[]; caracteristiques: any[];
    declinaisons: { selection: Record<string, string> }[];
    cout: number; prix: number;
  }) {
    if (!user || !dossier) return;
    setErreur('');
    try {
      const siteIds = activite?.id
        ? await sitesDeLActivite(activite.id)
        : [dossier.siteId];
      const neuf = await creerGammeRapide({
        activiteId: activite?.id ?? null,
        userId: user.uid,
        designation: saisie.designation,
        unite: saisie.unite,
        categorie: saisie.categorie,
        emballages: saisie.emballages,
        caracteristiques: saisie.caracteristiques,
        declinaisons: saisie.declinaisons,
        coutProduit: saisie.cout,
        prixProduit: saisie.prix,
        siteIds: siteIds.length > 0 ? siteIds : [dossier.siteId],
        siteOrigine: dossier.siteId,
      });
      setProduits(p => [...p, {
        id: neuf.id, siteId: dossier.siteId,
        designation: neuf.designation, unite: neuf.unite,
        codeBarre: null, categorie: saisie.categorie,
        emballages: saisie.emballages,
        caracteristiques: saisie.caracteristiques,
        variantes: neuf.variantes.map(v => ({
          ...v, stock: 0, coutMoyen: 0, prixVente: v.prixVente ?? saisie.prix,
        })),
        actif: true, stock: 0, coutMoyen: 0, prixVente: saisie.prix,
        seuilAlerte: null,
      } as unknown as ProduitChoisissable]);
      setProduitsNeufs(n => new Set(n).add(neuf.id));
      const nouvelles = neuf.variantes.length > 0
        ? neuf.variantes.map(v => ({
            produitId: neuf.id, designation: neuf.designation, unite: neuf.unite,
            varianteCle: v.cle, varianteLibelle: v.cle, emballage: null,
            quantiteDemandee: 1, quantiteRecue: null,
            valeurUnitaire: saisie.cout, prixVente: v.prixVente ?? saisie.prix,
          }))
        : [{
            produitId: neuf.id, designation: neuf.designation, unite: neuf.unite,
            varianteCle: null, varianteLibelle: null, emballage: null,
            quantiteDemandee: 1, quantiteRecue: null,
            valeurUnitaire: saisie.cout, prixVente: saisie.prix,
          }];
      setLignes(l => [...l, ...(nouvelles as any[])]);
      setLignesSales(true);
      setGamme(null);
    } catch (e: any) {
      setErreur(e?.message ?? 'La gamme n’a pas pu être créée.');
    }
  }

  async function enregistrerPrix() {
    if (!dossier) return;
    setEnCours(true); setErreur('');
    try {
      /* Prix, coût et quantités partent ensemble : ils décrivent la même
         ligne, et les écrire séparément les ferait diverger le temps
         d'une écriture. */
      await majPrixImportation({
        id: importId,
        lignes: dossier.lignes.map((l, i) => ({
          ...l,
          prixVente: prix[i] || null,
          valeurUnitaire: couts[i] ?? l.valeurUnitaire,
          quantiteDemandee: qtes[i] ?? l.quantiteDemandee,
        })),
      });
      setPrixSales(false);
      setChiffresSales(false);
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function verser() {
    if (!user || !dossier || nouveauVersement <= 0 || depasseCaisse) return;
    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurCourant(dossier.siteId, user.uid, user.displayName);
      await enregistrerVersement({
        adminUid: activite?.adminUid ?? null,
        siteId: dossier.siteId, userId: user.uid,
        date: dateVersement,
        montant: nouveauVersement,
        /* payer un fournisseur sort de l'argent */
        sens: 'sortie',
        /* figé à la saisie : avant la confirmation c'est une avance,
           après un règlement. */
        motif: dossier.etat === 'confirme' ? 'reglement' : 'avance',
        partenaireId: dossier.fournisseurId ?? '',
        partenaireNom: dossier.fournisseurNom ?? null,
        role: 'fournisseur',
        achatId: importId,
        reference: dossier.reference ?? null,
        par: user.uid,
        origine,
        /* Le dossier vit dans `importations` : la ligne doit le dire,
           sinon la dépense se rangerait avec les achats de boutique. */
        importation: true,
        /* Hors caisse, le tiroir ne bouge pas. Et le total vit dans
           `importations`, pas dans `achats` : on l'écrit nous-mêmes. */
        sansCaisse: origine === 'admin',
        sansTotal: true,
        ...auteur,
      });
      await updateDoc(doc(db, 'importations', importId), {
        avanceVersee: (dossier.avanceVersee ?? 0) + nouveauVersement,
      });
      setNouveauVersement(0);
      setOrigine('caisse');
      setDateVersement(aujourdhui());
      setModalVersement(false);
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function avancer() {
    if (!suivant || !user) return;
    /* Un frais à moitié réparti fait disparaître de l'argent : la dette
       le porte, le coût des produits ne le porte pas, et la marge
       annoncée est fausse de la différence. Un bouton grisé ne protège
       que l'écran — la garde tient ici aussi. */
    if (!controle.juste) {
      setErreur(controle.motif ?? 'Les frais ne se répartissent pas en entier.');
      return;
    }
    /* Confirmer fait entrer le stock : ce geste a sa propre porte. */
    if (suivant === 'confirme') { setModalConfirmation(true); return; }
    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurEtape(dossier!.siteId, user.uid, user.displayName);
      await avancerImportation({
        importation: dossier!, vers: suivant, userId: user.uid,
        auteurNom: auteur.nom,
        auteurFonction: auteur.fonction,
        /* Les quantités comptées partent avec l'étape qui les a
           produites : les écrire séparément les ferait diverger. */
        /* Les quantités comptées partent avec l'étape qui les a
           produites. Elles viennent des réceptions enregistrées, jamais
           d'une saisie : c'est l'étape qui arrête le compte, puisque
           après elle plus rien ne s'ajoute. */
        lignes: saisieQuantites
          ? dossier!.lignes.map((l, i) => ({
              ...l, quantiteRecue: recu[i] ?? 0,
            }))
          : null,
      });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function confirmer() {
    setModalConfirmation(false);
    if (!user) return;
    setEnCours(true); setErreur('');
    try {
      /* Ce qui est réellement arrivé, somme des réceptions. Prendre le
         commandé ferait entrer au stock une marchandise que personne n'a
         comptée. */
      const lignes: LigneFlux[] = dossier!.lignes.map((l, i) => ({
        ...l, quantiteRecue: recu[i] ?? 0,
        /* Le prix part avec la confirmation : c'est elle qui l'écrit sur
           le produit, et un prix saisi sans partir se perdrait. */
        prixVente: prix[i] || l.prixVente || null,
      }));
      /* Le même geste qu'un achat : le stock entre, les frais se
         répartissent dans le coût, la dette naît. Deux façons de le
         faire finiraient par diverger. */
      await confirmerAchat({
        roleSite: role,
        /* Le dossier vit dans `importations` : c'est `avancerImportation`
           qui l'arrête, pas une écriture dans `achats`. */
        marquerDossier: false,
        achat: {
          ...(dossier as any),
          lignes,
          frais,
          fraisCorrection,
          fraisCle,
          etat: 'traitement',
        },
        userId: user.uid, par: user.uid,
        ...(await auteurCourant(dossier!.siteId, user.uid, user.displayName)),
      });
      const auteur = await auteurEtape(dossier!.siteId, user.uid, user.displayName);
      await avancerImportation({
        importation: dossier!, vers: 'confirme', userId: user.uid,
        auteurNom: auteur.nom,
        auteurFonction: auteur.fonction,
        lignes,
      });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function enregistrerFrais() {
    setEnCours(true); setErreur('');
    try {
      await majFraisImportation({
        id: importId, frais: frais.filter(f => f.montant > 0),
        correction: fraisCorrection, cle: fraisCle,
      });
      setFraisSales(false);
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function annuler() {
    if (!user) return;
    setEnCours(true); setErreur('');
    try {
      await annulerImportation({ id: importId, auteurNom: user.displayName });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">

      <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-900/90">
        <div className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <Ship size={18} className="text-indigo-500" />
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {dossier.reference}
            </h1>
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${
              dossier.etat === 'confirme'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : dossier.etat === 'annule'
                ? 'bg-gray-100 text-gray-500 dark:bg-gray-800'
                : dossier.etat === 'attente_confirmation'
                ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
              {LIBELLES_IMPORTATION[dossier.etat]}
            </span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push('/ensemble?onglet=importations')}
              className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
              Fermer
            </button>
            {peut && suivant && (
              <button onClick={avancer} disabled={enCours || !controle.juste}
                title={controle.juste ? undefined : controle.motif}
                className={`flex items-center gap-1.5 rounded-xl px-5 py-2 text-sm font-bold text-white transition-colors disabled:opacity-40 ${
                  suivant === 'confirme'
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                {enCours ? <Loader2 size={14} className="animate-spin" />
                  : suivant === 'confirme' ? <Check size={14} /> : <ArrowRight size={14} />}
                {suivant === 'confirme' ? 'Confirmer' : LIBELLES_IMPORTATION[suivant]}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="w-full space-y-4 p-4 sm:p-6 lg:p-8">

        {/* Ce que le dossier est, en un coup d'œil. */}
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([
              { label: 'Fournisseur', valeur: dossier.fournisseurNom },
              { label: 'Origine', valeur: dossier.origine || '—' },
              { label: 'Destination', valeur: dossier.siteNom || '—' },
              { label: 'Produits', valeur: `${dossier.lignes.length} ligne${dossier.lignes.length > 1 ? 's' : ''}` },
            ]).map(x => (
              <div key={x.label} className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800/50">
                <p className="text-[11px] font-medium text-gray-400">{x.label}</p>
                <p className="mt-0.5 truncate text-sm font-bold text-gray-900 dark:text-gray-100">
                  {x.valeur}
                </p>
              </div>
            ))}
          </div>

          {/* Le voyage, étape par étape : c'est dans ces dates qu'on lit
              si un conteneur a traîné. */}
          <div className="mt-4 flex flex-wrap gap-1.5 border-t border-gray-100 pt-4 dark:border-gray-800">
            {ETAPES_IMPORTATION.map(e => {
              const fait = !!dossier.dates?.[e];
              const ici = dossier.etat === e;
              return (
                <span key={e}
                  className={`rounded-lg px-2 py-1 text-[11px] font-medium ${ici
                    ? 'bg-indigo-600 text-white'
                    : fait
                    ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400'
                    : 'bg-gray-50 text-gray-300 dark:bg-gray-800/50 dark:text-gray-600'}`}>
                  {LIBELLES_IMPORTATION[e]}
                  {fait && (
                    <span className="ml-1 opacity-70">
                      {(dossier.dates?.[e] ?? '').split('-').reverse().join('/')}
                    </span>
                  )}
                </span>
              );
            })}
          </div>

          {AIDE_IMPORTATION[dossier.etat] && (
            <p className="mt-3 rounded-xl bg-indigo-50 p-2.5 text-[12px] text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300">
              {AIDE_IMPORTATION[dossier.etat]}
            </p>
          )}
        </div>

        {/* La marchandise. */}
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            {/* Le sélecteur porte déjà ce titre : le répéter ferait deux
                fois le même mot l'un sous l'autre. */}
            {!lignesModifiables && (
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Marchandise</p>
            )}
            {/* Tout recevoir d'un geste, quand le conteneur est conforme.
                Il n'apparaît que s'il reste quelque chose à déclarer. */}
            {saisieQuantites && peut && (() => {
              const reste = dossier.lignes.reduce(
                (n, l, i) => n + Math.max(0, l.quantiteDemandee - (recu[i] ?? 0)), 0);
              if (reste <= 0) return null;
              return (
                <button onClick={() => completer(null)} disabled={enCours}
                  className="flex items-center gap-1.5 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-40 dark:border-indigo-800/40 dark:hover:bg-indigo-900/20">
                  {enCours ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />}
                  Tout recevoir
                </button>
              );
            })()}
          </div>
          {/* Tant que le fournisseur n'a rien confirmé, la liste se
              complète : on se souvient d'une référence oubliée, on
              l'ajoute sans rouvrir un dossier. Après « Validé », la
              commande est partie — l'allonger ici la ferait diverger de
              ce que le fournisseur a accepté. */}
          {lignesModifiables ? (
            <>
              <SelecteurProduits
                produits={produits} lignes={lignes}
                onChange={l => { setLignes(l); setLignesSales(true); }}
                coutEditable montrerStock={false} labelCout="Coût d'achat"
                futur
                onCreerProduit={creerEtAjouter}
                onCreerGamme={setGamme}
                produitsNeufs={produitsNeufs}
              />
              {lignesSales && (
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  <button type="button" disabled={enCours}
                    onClick={() => { setLignes(dossier.lignes ?? []); setLignesSales(false); }}
                    className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800">
                    Annuler
                  </button>
                  <button type="button" onClick={enregistrerLignes} disabled={enCours}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                    {enCours ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    Inscrire la marchandise
                  </button>
                </div>
              )}
            </>
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-center text-sm">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  <th className="rounded-l-lg px-3 py-2.5 text-left font-medium">Produit</th>
                  <th className="px-3 py-2.5 font-medium">Emballage</th>
                  <th className="px-3 py-2.5 font-medium">Commandé</th>
                  <th className="px-3 py-2.5 font-medium">Reçu</th>
                  {montreArgent && <>
                    <th className="px-3 py-2.5 font-medium">Coût unitaire</th>
                    {parts && <>
                      <th className="px-3 py-2.5 font-medium">Part frais</th>
                      <th className="px-3 py-2.5 font-medium">Coût réel</th>
                    </>}
                    {/* Le prix du rayon, puis celui qu'on pose : on voit
                        d'un coup d'œil de combien on s'en écarte. */}
                    {/* Où le coût moyen du rayon va se poser : c'est lui
                        qui décidera de la marge, pas le prix payé. */}
                    <th className="px-3 py-2.5 font-medium">CUMP après</th>
                    <th className="px-3 py-2.5 font-medium">Prix établi</th>
                    <th className="px-3 py-2.5 font-medium">Prix de vente</th>
                    <th className="px-3 py-2.5 font-medium">Total</th>
                  </>}
                  {saisieQuantites && peut && (
                    <th className="rounded-r-lg px-3 py-2.5 font-medium" />
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {dossier.lignes.map((l, i) => {
                  /* Ce qui est arrivé : la somme des réceptions, jamais
                     le commandé. Un reçu posé d'avance ferait que
                     personne ne compte. */
                  const recuLigne = recu[i] ?? (l.quantiteRecue ?? 0);
                  const lignesRecep = receptions.filter(r => r.ligneIndex === i);
                  const nbRecep = lignesRecep.filter(r => !r.annulee).length;
                  const qte = compte ? recuLigne : l.quantiteDemandee;
                  const manque = l.quantiteDemandee - recuLigne;
                  const part = parts?.[i] ?? 0;
                  const reel = qte > 0 ? l.valeurUnitaire + part / qte : l.valeurUnitaire;
                  /* Vendre sous le coût réel, c'est vendre à perte — et le
                     coût réel n'est pas le prix facturé : il porte le
                     voyage. Un prix qui couvrait l'achat peut ne plus
                     couvrir le fret. */
                  const sousLeCout = (prix[i] ?? 0) > 0 && prix[i]! < Math.round(reel);
                  const perteLigne = sousLeCout
                    ? (Math.round(reel) - prix[i]!) * Math.max(qte, 1) : 0;
                  const ecart = compte && qte !== l.quantiteDemandee;
                  return (
                    <Fragment key={i}>
                    <tr className={ecart
                      ? (qte > l.quantiteDemandee
                        ? 'bg-blue-50/50 dark:bg-blue-900/10'
                        : 'bg-amber-50/50 dark:bg-amber-900/10')
                      : ''}>
                      <td className="px-3 py-2.5 text-left text-gray-900 dark:text-gray-100">
                        {l.designation}
                        {l.varianteLibelle && (
                          <span className="ml-1.5 text-gray-400">{l.varianteLibelle}</span>
                        )}
                        {/* La perte chiffrée, après le nom : « ce produit
                            est à perte » se corrige, « 293 000 de perte »
                            se corrige tout de suite. */}
                        {perteLigne > 0 && (
                          <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                            −{formatMontant(perteLigne)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500">
                        {l.emballage ?? l.unite ?? 'unité'}
                      </td>
                      {/* Le commandé se corrige : le fournisseur annonce
                          parfois autre chose que ce qu'on avait demandé,
                          et rouvrir le dossier pour un chiffre n'a pas
                          de sens. Figé à la confirmation. */}
                      <td className="px-3 py-2.5">
                        {chiffresEditables ? (
                          <ChampNombre valeur={qtes[i] ?? l.quantiteDemandee}
                            onChange={n => {
                              setQtes(q => ({ ...q, [i]: n }));
                              setChiffresSales(true);
                            }}
                            className="w-24 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-center text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />
                        ) : (
                          <span className="text-gray-500">
                            {l.quantiteDemandee.toLocaleString('fr-FR')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`font-medium ${!ecart
                            ? 'text-gray-600 dark:text-gray-300'
                            : qte > l.quantiteDemandee ? 'text-blue-500' : 'text-orange-500'}`}>
                            {recuLigne > 0 ? recuLigne.toLocaleString('fr-FR') : '—'}
                          </span>
                          {/* Le détail des livraisons : quand, combien, par qui —
                              et c'est de là qu'une réception s'annule. */}
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
                        {/* Le coût se corrige aussi : une facture arrive
                            avec un autre chiffre que le devis, et c'est
                            elle qui fait foi. */}
                        <td className="px-3 py-2.5">
                          {chiffresEditables ? (
                            <ChampNombre valeur={couts[i] ?? l.valeurUnitaire}
                              onChange={n => {
                                setCouts(c => ({ ...c, [i]: n }));
                                setChiffresSales(true);
                              }}
                              className="w-28 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-center text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />
                          ) : (
                            <span className="text-gray-500">
                              {formatMontant(l.valeurUnitaire)}
                            </span>
                          )}
                        </td>
                        {parts && <>
                          {/* La part se corrige à la main : la règle donne
                              une base juste, celui qui a vu le camion garde
                              le dernier mot. Une ligne ne peut prendre que
                              ce que les autres ne se sont pas vu imposer —
                              pour donner davantage à l'une, il faut d'abord
                              retirer à l'autre. */}
                          <td className="px-3 py-2.5">
                            {fraisModifiables && estAdmin ? (
                              <ChampNombre valeur={part} max={plafondPart(i)}
                                onChange={n => {
                                  setFraisCorrection(c => ({
                                    ...(c ?? {}), [i]: Math.min(n, plafondPart(i)) }));
                                  setFraisSales(true);
                                }}
                                className="w-28 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-center text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />
                            ) : (
                              <span className="text-gray-500">{formatMontant(part)}</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 font-bold text-gray-900 dark:text-gray-100">
                            {formatMontant(Math.round(reel))}
                          </td>
                        </>}
                        {/* Le coût moyen après cette entrée.
                            Un produit acheté 900 quand le rayon en tient
                            mille à 700 ne coûte pas 900 : il coûtera 714.
                            C'est ce chiffre qui décide de la marge. */}
                        <td className="px-3 py-2.5">
                          {cumpApres[i] != null ? (
                            <span className="inline-flex flex-col leading-tight">
                              <span className="font-bold text-gray-900 dark:text-gray-100">
                                {formatMontant(cumpApres[i]!)}
                              </span>
                              {rayon[i] && rayon[i]!.stock > 0 && (
                                <span className="text-[10px] text-gray-400">
                                  avant {formatMontant(
                                    rayon[i]!.coutMoyen * rayon[i]!.contenance)}
                                </span>
                              )}
                            </span>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        {/* Ce que le produit se vend déjà en rayon : le
                            point de comparaison. Sans lui, on pose un
                            prix sans savoir si le marché le suivra. */}
                        <td className="px-3 py-2.5 text-gray-400">
                          {(etablis[i] ?? 0) > 0
                            ? formatMontant(etablis[i]!) : '—'}
                        </td>
                        {/* Sous le coût réel, le champ passe en rouge :
                            c'est le seul moment où la perte se corrige
                            encore, la confirmation fige le prix. */}
                        <td className="px-3 py-2.5">
                          {prixEditables ? (
                            <ChampNombre valeur={prix[i] ?? 0}
                              onChange={n => {
                                setPrix(p => ({ ...p, [i]: n }));
                                setPrixSales(true);
                              }}
                              className={`w-28 rounded-lg border px-2 py-1 text-center text-xs focus:outline-none focus:ring-2 ${
                                sousLeCout
                                  ? 'border-red-300 bg-red-50 text-red-600 focus:ring-red-500 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400'
                                  : 'border-gray-200 bg-gray-50 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800'}`} />
                          ) : (
                            <span className={`font-medium ${sousLeCout
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-gray-500'}`}>
                              {(prix[i] ?? 0) > 0 ? formatMontant(prix[i]!) : '—'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100">
                          {formatMontant(qte * l.valeurUnitaire)}
                        </td>
                      </>}
                      {/* Déclarer ce qui est arrivé : la ligne entière, ou
                          une quantité partielle. Rien n'est prérempli. */}
                      {saisieQuantites && peut && (
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-center gap-1.5">
                            {manque > 0 && (
                              <button onClick={() => completer(i)} disabled={enCours}
                                title="Tout recevoir sur cette ligne"
                                className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                                <CheckCheck size={12} /> {manque}
                              </button>
                            )}
                            <button onClick={() => { setLigneRecue(i); setQteRecue(0); }}
                              title="Saisir une quantité"
                              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-bold text-gray-600 transition-colors hover:border-indigo-400 dark:border-gray-600 dark:text-gray-300">
                              <Plus size={12} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                    {detailLigne === i && (
                      <tr>
                        {/* Le détail s'étend sur toute la ligne : les colonnes
                            d'argent et l'action ne sont pas toujours là. */}
                        <td colSpan={4 + (montreArgent ? (parts ? 7 : 5) : 0)
                          + (saisieQuantites && peut ? 1 : 0)}
                          className="px-3 pb-3">
                          <div className="rounded-xl bg-gray-50 p-3 text-left dark:bg-gray-800/50">
                            <p className="mb-2 text-xs font-bold uppercase text-gray-400">Réceptions</p>
                            <div className="flex flex-col gap-1.5">
                              {lignesRecep.map(r => (
                                <div key={r.id}
                                  className={`flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-1.5 text-xs dark:bg-gray-900 ${
                                    r.annulee ? 'opacity-50' : ''}`}>
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className={`font-bold ${r.annulee
                                      ? 'text-gray-400 line-through'
                                      : 'text-gray-900 dark:text-gray-100'}`}>
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
                                  ) : saisieQuantites && peut ? (
                                    <button onClick={() => defaire(r.id)} disabled={enCours}
                                      className="shrink-0 text-red-500 transition-colors hover:text-red-600 disabled:opacity-40">
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
          )}

          {/* Un prix saisi et non inscrit ne vaut rien : la confirmation
              lirait l'ancien. */}
          {/* Poser les prix depuis ce qu'on veut gagner.
              Produit par produit, on perd le total de vue : en annonçant
              le bénéfice cherché sur le dossier, l'app propose des prix
              qui y mènent — en gardant les écarts du marché. */}
          {prixEditables && parts !== undefined && (() => {
            const lignesPourCalcul = dossier.lignes.map((l, i) => ({
              ...l,
              valeurUnitaire: couts[i] ?? l.valeurUnitaire,
              quantiteDemandee: qtes[i] ?? l.quantiteDemandee,
              quantiteRecue: compte ? (recu[i] ?? 0) : null,
              prixVente: prix[i] ?? l.prixVente ?? 0,
            })) as LigneFlux[];
            const cout = coutTotal(lignesPourCalcul, parts);
            const actuel = beneficeActuel(lignesPourCalcul, parts);
            const tauxActuel = tauxDeMarge(actuel, cout);
            const tauxVise = tauxDeMarge(objectif, cout);

            return (
              <div className="mt-4 rounded-xl border border-gray-100 p-4 dark:border-gray-800">
                <button type="button"
                  onClick={() => {
                    setBlocBenefice(b => !b);
                    if (!blocBenefice && objectif <= 0) setObjectif(Math.max(0, actuel));
                  }}
                  className="flex w-full items-center justify-between gap-2 text-left">
                  <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
                    Bénéfice recherché
                  </span>
                  <span className="flex items-center gap-2 text-xs text-gray-400">
                    Aux prix actuels{' '}
                    <span className={`font-bold ${actuel >= 0
                      ? 'text-green-600' : 'text-red-500'}`}>
                      {formatMontant(actuel)}
                    </span>
                    {tauxActuel != null && <span>({tauxActuel} %)</span>}
                  </span>
                </button>

                {blocBenefice && (
                  <div className="mt-3 flex flex-col gap-3">
                    <p className="text-xs leading-snug text-gray-400">
                      L’objectif se répartit au prorata de ce que chaque produit
                      marge déjà en rayon : celui qui marge bien porte plus. Les
                      prix proposés restent modifiables un à un.
                    </p>
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-gray-500 dark:text-gray-400">
                          Bénéfice voulu
                        </span>
                        <ChampNombre valeur={objectif} onChange={setObjectif}
                          className="w-40 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-right text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                      </label>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold text-gray-500 dark:text-gray-400">
                          Soit un taux de
                        </span>
                        <span className="rounded-xl bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                          {tauxVise != null ? `${tauxVise} %` : '—'}
                        </span>
                      </div>
                      <button type="button" disabled={objectif <= 0}
                        onClick={() => {
                          const proposes = prixPourBenefice(
                            lignesPourCalcul, parts, objectif,
                            dossier.lignes.map((_, i) => etablis[i] ?? null));
                          setPrix(Object.fromEntries(proposes.map((v, i) => [i, v])));
                          setPrixSales(true);
                        }}
                        className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                        Proposer les prix
                      </button>
                    </div>
                    {/* Une ligne sans prix en rayon ne pèse rien dans le
                        partage : on le dit, plutôt que de lui inventer
                        un prix sur rien. */}
                    {dossier.lignes.some((_, i) => !(etablis[i] > 0)) && (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                        Certains produits n’ont pas encore de prix en rayon : ils
                        gardent le leur, l’objectif se répartit sur les autres.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {(prixSales || chiffresSales) && (
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              <button type="button" disabled={enCours}
                onClick={() => {
                  setPrix(Object.fromEntries(
                    dossier.lignes.map((l, i) => [i, l.prixVente ?? 0])));
                  setCouts(Object.fromEntries(
                    dossier.lignes.map((l, i) => [i, l.valeurUnitaire ?? 0])));
                  setQtes(Object.fromEntries(
                    dossier.lignes.map((l, i) => [i, l.quantiteDemandee ?? 0])));
                  setPrixSales(false); setChiffresSales(false);
                }}
                className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800">
                Annuler
              </button>
              <button type="button" onClick={enregistrerPrix} disabled={enCours}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Inscrire
              </button>
            </div>
          )}

          {montreArgent && (
            <div className="mt-4 flex justify-end border-t border-gray-100 pt-3 dark:border-gray-800">
              <div className="flex min-w-[280px] flex-col gap-1.5 text-sm">
                {([
                  { label: 'Marchandise', valeur: marchandise, fort: false },
                  ...(fraisTotal > 0
                    ? [{ label: 'Frais du voyage', valeur: fraisTotal, fort: false }] : []),
                  { label: 'Total', valeur: total, fort: true },
                  { label: 'Versé', valeur: verse, fort: false },
                ]).map(x => (
                  <div key={x.label} className="flex items-baseline gap-2">
                    <span className="shrink-0 text-gray-400">{x.label}</span>
                    <span className="flex-1 border-b border-dotted border-gray-200 dark:border-gray-700" />
                    <span className={`shrink-0 ${x.fort
                      ? 'font-bold text-gray-900 dark:text-gray-100'
                      : 'font-medium text-gray-600 dark:text-gray-300'}`}>
                      {formatMontant(x.valeur)}
                    </span>
                  </div>
                ))}
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-gray-400">Reste dû</span>
                  <span className="flex-1 border-b border-dotted border-gray-200 dark:border-gray-700" />
                  <span className={`shrink-0 font-bold ${reste > 0 ? 'text-orange-500' : 'text-green-600'}`}>
                    {formatMontant(reste)}
                  </span>
                </div>
                {/* Régler : seul l'admin paie un fournisseur d'importation,
                    et seulement tant que le dossier n'est pas abandonné. */}
                {estAdmin && reste > 0 && dossier.etat !== 'annule' && (
                  <button onClick={() => {
                      setNouveauVersement(0); setOrigine('caisse');
                      setDateVersement(aujourdhui()); setModalVersement(true);
                    }}
                    className="mt-2 flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
                    <Wallet size={13} /> Verser
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Ce qui a déjà été payé, et par où l'argent est passé. */}
          {montreArgent && versements.length > 0 && (
            <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
              <p className="mb-2 text-xs font-bold uppercase text-gray-400">Versements</p>
              <div className="flex flex-col gap-1.5">
                {versements.map(v => (
                  <div key={v.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-gray-800/50">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {formatMontant(v.montant)}
                      </span>
                      <span className="text-gray-500">{formatDate(v.date)}</span>
                      <span className="truncate text-gray-400">{v.utilisateurNom}</span>
                    </span>
                    {/* D'où l'argent est sorti : un virement ne se lit pas
                        dans le registre du site, il faut le dire ici. */}
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                      v.origine === 'admin'
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
                        : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                      {v.origine === 'admin' ? 'Hors caisse' : 'Caisse'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Les frais du voyage : ils s'ajoutent quand ils tombent. */}
        {montreArgent && (
          <>
            <PanneauFrais
              frais={frais} lignes={dossier.lignes} correction={fraisCorrection}
              cle={fraisCle} lectureSeule={!fraisModifiables || !estAdmin}
              onChange={f => { setFrais(f); setFraisSales(true); }}
              onCorriger={c => { setFraisCorrection(c); setFraisSales(true); }} />

            {fraisModifiables && estAdmin && fraisSales && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" disabled={enCours}
                  onClick={() => {
                    setFrais(dossier.frais ?? []);
                    setFraisCorrection(dossier.fraisCorrection ?? null);
                    setFraisCle(dossier.fraisCle ?? CLE_PAR_DEFAUT);
                    setFraisSales(false);
                  }}
                  className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800">
                  Annuler
                </button>
                <button type="button" onClick={enregistrerFrais}
                  disabled={enCours || !controle.juste}
                  className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                  {enCours ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  Inscrire les frais
                </button>
              </div>
            )}
          </>
        )}

        {erreur && <p className="text-xs text-red-500">{erreur}</p>}

        {/* Renoncer : le dossier reste, son état dit qu'il n'ira pas plus
            loin. Seul l'admin, et seulement tant que rien n'est entré. */}
        {estAdmin && fraisModifiables && (
          <div className="flex justify-end">
            <button onClick={annuler} disabled={enCours}
              className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-400 transition-colors hover:border-red-200 hover:text-red-500 disabled:opacity-40 dark:border-gray-700">
              <X size={13} /> Annuler l’importation
            </button>
          </div>
        )}
      </div>

      {/* Une quantité partielle : le conteneur n'arrive pas toujours
          entier, et ce qui manque arrivera plus tard. */}
      {ligneRecue != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              {dossier.lignes[ligneRecue].designation}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Commandé {dossier.lignes[ligneRecue].quantiteDemandee.toLocaleString('fr-FR')}
              {' · '}déjà reçu {(recu[ligneRecue] ?? 0).toLocaleString('fr-FR')}
            </p>
            <div className="mt-3">
              <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
                Quantité arrivée
              </label>
              <ChampNombre valeur={qteRecue} onChange={setQteRecue}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-center text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />
            </div>
            <div className="mt-4 flex gap-2">
              <button onClick={() => { setLigneRecue(null); setQteRecue(0); }}
                className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-500 dark:border-gray-700">
                Annuler
              </button>
              <button onClick={ajouterReception} disabled={enCours || qteRecue <= 0}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Déclarer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Régler le fournisseur. Deux sources, parce qu'un versement
          d'importation part souvent par la banque ou de la main de
          l'admin : le faire transiter par la caisse du site inventerait
          un mouvement qui n'a pas eu lieu. */}
      {modalVersement && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {dossier.etat === 'confirme' ? 'Ajouter un règlement' : 'Ajouter une avance'}
              </p>
              <button onClick={() => setModalVersement(false)}
                className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="flex flex-col gap-3 p-5">
              <div>
                <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">Date</label>
                <input type="date" value={dateVersement} max={aujourdhui()}
                  onChange={e => setDateVersement(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
              </div>

              {/* L'origine se choisit avant le montant : c'est elle qui
                  dit si la caisse borne la saisie. */}
              <div>
                <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
                  D’où sort l’argent
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { v: 'caisse' as const, titre: 'Caisse du site',
                      aide: 'Le tiroir de la boutique' },
                    { v: 'admin' as const, titre: 'Hors caisse',
                      aide: 'Banque, ou de la main de l’admin' },
                  ]).map(o => (
                    <button key={o.v} type="button" onClick={() => setOrigine(o.v)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        origine === o.v
                          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                          : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'}`}>
                      <span className={`block text-xs font-bold ${
                        origine === o.v
                          ? 'text-indigo-700 dark:text-indigo-300'
                          : 'text-gray-700 dark:text-gray-300'}`}>
                        {o.titre}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-gray-400">
                        {o.aide}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">Montant</label>
                <ChampNombre valeur={nouveauVersement}
                  onChange={setNouveauVersement} max={reste}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-right text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                <p className="mt-1.5 text-xs text-gray-400">
                  Reste à payer{' '}
                  <span className="font-bold text-gray-600 dark:text-gray-300">
                    {formatMontant(reste)}
                  </span>
                </p>
                {/* Le tiroir ne se montre que s'il est concerné. */}
                {origine === 'caisse' && soldeCaisseSite != null && (
                  <DisponibleCaisse className="mt-2"
                    solde={soldeReelCaisse ?? soldeCaisseSite}
                    engage={engageCaisse} disponible={soldeCaisseSite} />
                )}
                {origine === 'caisse' && depasseCaisse && (
                  <p className="mt-1.5 text-xs font-bold text-red-500">
                    La caisse n’a que {formatMontant(soldeCaisseSite ?? 0)}.
                  </p>
                )}
                {origine === 'admin' && (
                  <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                    La caisse du site ne bougera pas. La dette s’éteint, et
                    la dépense se lit dans le tableau de bord d’ensemble.
                  </p>
                )}
              </div>

              {erreur && <p className="text-xs text-red-500">{erreur}</p>}
            </div>

            <div className="flex gap-2 border-t border-gray-100 px-5 py-4 dark:border-gray-800">
              <button onClick={() => setModalVersement(false)}
                className="flex-1 rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
                Annuler
              </button>
              <button onClick={verser}
                disabled={enCours || nouveauVersement <= 0 || depasseCaisse}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Ajouter
              </button>
            </div>
          </div>
        </div>
      )}

      {gamme !== null && (
        <ModalGammeProduit
          designationInitiale={gamme}
          onAnnuler={() => setGamme(null)}
          onCreer={creerGammeEtAjouter} />
      )}

      {/* Confirmer fait entrer le stock : on dit ce qui va se passer. */}
      {modalConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              Confirmer l’importation
            </p>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {dossier.lignes.length} produit{dossier.lignes.length > 1 ? 's' : ''} entre
              {dossier.lignes.length > 1 ? 'nt' : ''} au stock de{' '}
              <span className="font-bold text-gray-900 dark:text-gray-100">
                {dossier.siteNom}
              </span>, pour{' '}
              <span className="font-bold text-gray-900 dark:text-gray-100">
                {formatMontant(total)}
              </span>
              {fraisTotal > 0 && <>, dont {formatMontant(fraisTotal)} de frais du voyage</>}.
              Le coût moyen se recalcule, frais compris.
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setModalConfirmation(false)}
                className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-500 dark:border-gray-700">
                Annuler
              </button>
              <button onClick={confirmer}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-green-600 px-3 py-2 text-xs font-bold text-white hover:bg-green-700">
                <Check size={13} /> Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
