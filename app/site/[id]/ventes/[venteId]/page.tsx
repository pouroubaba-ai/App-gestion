'use client';
import { useEffect, useState, Fragment } from 'react';
import {
  doc, getDoc, updateDoc, addDoc, collection, serverTimestamp, query, where, getDocs,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { produitsDuSite } from '@/lib/produits-site';
import { useAuth } from '@/lib/auth-context';
import {
  peutPlanifierReglement, roleSurSite, type RoleSite,
} from '@/lib/roles';
import { auteurCourant, auteurEtape } from '@/lib/auteur';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import {
  enregistrerVersement, versementsDuDossier, LIBELLES_MOTIF_VERSEMENT,
  type Versement,
} from '@/lib/versements-collection';
import { ChampNombre } from '@/components/Champs';
import {
  enregistrerPreparation, annulerPreparation, chargerPreparations,
  prepareParLigne, type Preparation,
  reserveParProduit,
} from '@/lib/preparations';
import { enUnitesBase } from '@/lib/mouvements';
import {
  ligneDepuisVente, synchroniserLignes, supprimerLignesDeVente,
} from '@/lib/lignes-vente';
import {
  ArrowLeft,
  Loader2, Check, CheckCheck, ArrowRight, Truck, X, Plus, Info, Download,
} from 'lucide-react';
import { exporterPdf } from '@/lib/export-pdf';
import { useEnteteSite } from '@/lib/use-entete-site';
import {
  Vente, EtatVente, LIBELLES_VENTE, SUITE_VENTE, valeurVente, beneficeAttendu,
  devisExpire, livrerVente, referenceFlux, VersementAchat, joursRestants,
  peutAnnulerDossier, type Role,
} from '@/lib/flux-marchandise';
import {
  sousTotalOrigine, piedDocument, valeurEnFrancs, LIBELLES_SENS,
} from '@/lib/reductions';
import {
  estEnsemble, retourHistorique, marqueOrigine, racineRetour, fermerEcran,
} from '@/lib/retour';
import {
  propagerEtapeOrdre, remettreOrdre, annulerOrdre,
} from '@/lib/ordre-transfert';
import { confirmerTransfert } from '@/lib/flux-marchandise';
import ModalPlanification from '../../components/ModalPlanification';
import BlocIdentite from '../../components/BlocIdentite';
import {
  appliquerPlanification, lireChoix, type Planification,
} from '@/lib/planification';

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

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

const COULEURS_ETAT: Record<EtatVente, string> = {
  devis:       'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  commande:    'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  preparation: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  pret:        'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400',
  livre:       'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  annule:      'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
};

/** Ligne de total, reliée par des pointillés : sans eux, l'œil perd
    la correspondance entre le libellé et le montant à l'autre bout. */
function LigneTotal({ label, valeur, classeValeur = 'font-medium text-gray-900 dark:text-gray-100' }: {
  label: string; valeur: string; classeValeur?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-gray-400 shrink-0">{label}</span>
      <span className="flex-1 border-b border-dotted border-gray-200 dark:border-gray-700" />
      <span className={`shrink-0 whitespace-nowrap ${classeValeur}`}>{valeur}</span>
    </div>
  );
}

export default function FicheVentePage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  const venteId = params.venteId as string;
  const entetePdf = useEnteteSite(siteId, activite?.nom);

  const [vente, setVente] = useState<Vente | null>(null);
  /* Le site qui a servi la marchandise, quand ce n'est pas celui-ci.
     Les dossiers récents le portent en clair ; les plus anciens n'ont
     que l'identifiant du transfert, et on va alors chercher le nom
     là-bas plutôt que de laisser la case vide. */
  const [siteServeur, setSiteServeur] = useState<string | null>(null);
  /* Et le site qui facture, vu depuis le bon de la source : la
     marchandise part d'ici, mais le client et la facture sont là-bas.
     Sans ce nom, le responsable remet des cartons sans savoir à quel
     compte ils seront portés. */
  const [siteFacture, setSiteFacture] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /* Le responsable des commandes fait avancer des dossiers : les montants ne
     lui apprennent rien et exposent la marge de l'activité. */
  const [role, setRole] = useState<RoleSite | null>(null);
  /* `null` vaut « aucune restriction » autant que « pas encore lu » :
     sans ce drapeau, la question s'ouvrirait pendant le battement. */
  const [roleLu, setRoleLu] = useState(false);

  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(setRole).catch(() => {}).finally(() => setRoleLu(true));
  }, [user, siteId, activite?.adminUid]);
  const [enCours, setEnCours] = useState(false);
  /* Ce qui reste dû par le client une fois livré. Tant qu'il est posé, on
     demande comment cette créance sera recouvrée. */
  const [aPlanifier, setAPlanifier] = useState<number | null>(null);
  /* L'édition du recouvrement prévu d'un ordre, côté destination : le
     gérant ou l'admin le règle avant que la source confirme. */
  const [editRecouvre, setEditRecouvre] = useState(false);
  const [recActif, setRecActif] = useState(false);
  const [recMontant, setRecMontant] = useState(0);
  const [recDate, setRecDate] = useState('');
  const [erreur, setErreur] = useState('');
  /* Les versements ont leur collection : le tableau imbriqué ne sert plus. */
  const [versements, setVersements] = useState<Versement[]>([]);
  const [retour, setRetour] = useState<number | null>(null);

  const [modalVersement, setModalVersement] = useState(false);
  const [nouveauVersement, setNouveauVersement] = useState(0);
  const [dateVersement, setDateVersement] = useState(aujourdhui());
  const [modalDetail, setModalDetail] = useState(false);
  /* Transformer un devis, c'est prendre un engagement de livraison : la date
     se demande à ce moment-là, pas après. */
  const [modalTransformer, setModalTransformer] = useState(false);
  const [livraisonPrevue, setLivraisonPrevue] = useState('');
  const [delaiJours, setDelaiJours] = useState(0);

  /* Stock par produit, et par variante quand il y en a. Préparer sans voir
     ce qu'on a en magasin oblige à ouvrir un autre écran pour chaque ligne. */
  const [stocks, setStocks] = useState<Record<string, number>>({});
  /* La contenance d'un emballage se fige sur la ligne : il faut donc la
     connaitre au moment ou on ecrit. */
  const [emballages, setEmballages] = useState<Record<string, { nom: string; quantite: number }[]>>({});
  /* Ce que les autres dossiers ont déjà mis de côté. Le stock ne bouge qu'à
     la livraison : sans ce compte, deux commandes promettent le même carton. */
  const [reserve, setReserve] = useState<Record<string, number>>({});
  /* Les préparations, une ligne par prélèvement. Le préparé en est la somme :
     il ne se saisit plus, il se déduit. */
  const [preparations, setPreparations] = useState<Preparation[]>([]);
  const [lignePreparee, setLignePreparee] = useState<number | null>(null);
  const [qtePreparee, setQtePreparee] = useState(0);
  const [notePreparee, setNotePreparee] = useState('');
  const [detailLigne, setDetailLigne] = useState<number | null>(null);

  /* Marquer prêt fige le préparé et arrête le travail : le modal montre
     toujours ce qu'on valide, écart ou non. */
  const [modalPret, setModalPret] = useState(false);

  useEffect(() => { charger(); }, [venteId]);

  /* Une vente se livre de deux façons : depuis cette fiche, ou d'emblée au
     comptoir. Les deux aboutissent ici, c'est donc ici qu'on demande comment
     la créance sera recouvrée — une seule fois, et seulement si rien n'est
     encore planifié. */
  const [planifDemandee, setPlanifDemandee] = useState(false);

  /* Un fait s'enregistre : on a pose la question, ce jour-la. */
  async function cloreQuestion() {
    if (!vente || vente.planifieLe) return;
    try {
      await updateDoc(doc(db, 'ventes', vente.id), {
        planifieLe: new Date().toISOString(),
      });
    } catch { /* le marqueur est un confort, pas une ecriture critique */ }
  }

  useEffect(() => {
    /* Poser la question une seule fois par dossier. Se fier au cycle ne
       suffit pas : poser une regle sans la demarrer aujourd'hui n'ouvre
       aucune echeance, et le dossier redemanderait a chaque ouverture. */
    if (!vente || planifDemandee || vente.planifieLe) return;
    if (vente.etat !== 'livre' || !vente.clientId) return;
    /* Fixer quand le client paiera est une décision de trésorerie : le
       responsable des commandes livre, il ne négocie pas les termes. */
    if (!roleLu || !peutPlanifierReglement(role)) return;
    const du = valeurVente(vente.lignes) - (vente.avanceVersee ?? 0);
    if (du <= 0) return;

    let vivant = true;
    lireChoix(siteId, vente.clientId, 'client').then(c => {
      /* Un cycle déjà lancé sait quoi faire : ne rien demander évite de
         reposer la question à chaque ouverture du dossier. */
      if (!vivant || c.cycleEnCours) return;
      setPlanifDemandee(true);
      setAPlanifier(du);
    }).catch(() => {});
    return () => { vivant = false; };
  }, [vente, planifDemandee, siteId, roleLu, role]);

  async function charger() {
    /* Le spinner ne remplace l'écran qu'à la première venue : après un
       avancement, tout était déjà là, et le faire disparaître donnait le
       sentiment d'un rechargement complet. */
    setLoading(l => (vente ? l : true));

    /* Les quatre lectures partent ensemble : aucune ne dépend du résultat
       d'une autre, et les enchaîner ajoutait trois attentes à la suite.
       Les versements sont demandés par dossier plutôt que filtrés après
       coup — on ne rapatrie plus toute la collection du site pour en
       garder trois lignes. */
    /* Ce qui ne sert qu'à préparer ne se lit que tant qu'on prépare.
     *
     * Le stock disponible et ce que les autres dossiers retiennent
     * n'éclairent qu'un geste : décider combien on peut encore prélever.
     * Une fois le dossier livré ou annulé, plus rien ne se prélève — et
     * ces deux lectures continuaient de partir à chaque ouverture, dont
     * celle qui suit la livraison. `reserveParProduit` lit toutes les
     * préparations du site, une collection qui ne fait que grossir.
     *
     * L'état se lit d'abord sur ce qu'on a déjà affiché : au premier
     * chargement on l'ignore, et on lit tout — c'est le seul cas où le
     * dossier peut encore être ouvert sans qu'on le sache. */
    const closDejaVu = vente
      && (vente.etat === 'livre' || vente.etat === 'annule');
    const [snap, produits, ventesSnap, vers] = await Promise.all([
      getDoc(doc(db, 'ventes', venteId)),
      produitsDuSite(siteId),
      closDejaVu ? Promise.resolve(null)
        : getDocs(query(collection(db, 'ventes'),
          where('siteId', '==', siteId),
          /* Seuls les dossiers ouverts retiennent du stock : les demander
             au serveur évite de rapatrier tout l'historique des ventes. */
          where('etat', 'in', ['preparation', 'pret']))),
      versementsDuDossier(venteId, 'vente').catch(() => []),
    ]);

    if (snap.exists()) {
      const d = snap.data() as any;
      /* Un dossier sans marchandise ne doit pas entrer sans ses lignes :
         un document de test, une vente interrompue avant sa premiere
         ligne, et toute la fiche tombe sur `lignes.reduce`. Le tableau
         vide dit la verite — ce dossier ne porte rien. */
      setVente({ id: snap.id, ...d, lignes: d.lignes ?? [] } as Vente);

      /* Qui a servi : écrit sur le dossier depuis peu, à retrouver sur
         le transfert pour ceux d'avant. */
      if (d.ordreSiteSourceNom) setSiteServeur(d.ordreSiteSourceNom);
      else setSiteServeur(null);
      if (d.ordreSiteFactureNom) setSiteFacture(d.ordreSiteFactureNom);
      else setSiteFacture(null);

      /* Les dossiers d'avant ne portent que l'identifiant du transfert :
         on y lit les deux noms d'un coup plutôt que de laisser les cases
         vides. */
      if (d.ordreLien?.transfertId
        && !(d.ordreSiteSourceNom || d.ordreSiteFactureNom)) {
        getDoc(doc(db, 'transferts', d.ordreLien.transfertId))
          .then(t => {
            if (!t.exists()) return;
            const x = t.data() as any;
            if (d.ordre === true) setSiteFacture(x.siteDestNom ?? null);
            else setSiteServeur(x.siteSourceNom ?? null);
          })
          .catch(() => {});
      }
      chargerPreparations(venteId).then(setPreparations).catch(() => setPreparations([]));
      setVersements(vers);
    }

    /* Le stock vit sur la détention, pas sur le produit : il faut aller le
       chercher, et il a pu bouger depuis que la commande a été prise.
       Lire `produits` filtré par `siteId` datait du modèle où le produit
       appartenait au site — depuis la refonte, il appartient à l'activité
       et ne porte plus ni site ni stock. La requête ne ramenait donc rien,
       et tout stock s'affichait à zéro : on ne pouvait plus rien préparer
       d'un produit pourtant présent en rayon. */
    const parCle: Record<string, number> = {};
    const parProduit: Record<string, { nom: string; quantite: number }[]> = {};
    produits.forEach(p => {
      parProduit[p.id] = p.emballages ?? [];
      parCle[p.id] = p.stock ?? 0;
      /* une variante porte son propre stock : celui du produit est leur somme */
      (p.variantes ?? []).forEach((v: any) => {
        parCle[`${p.id}:${v.cle}`] = v.stock ?? 0;
      });
    });
    setStocks(parCle);
    setEmballages(parProduit);

    /* Seuls les dossiers en préparation ou prêts retiennent du stock : un
       dossier livré est déjà sorti, un dossier annulé ne promet plus rien. */
    if (ventesSnap) {
      const ouverts = new Set(ventesSnap.docs.map(d => d.id));
      reserveParProduit(siteId, ouverts).then(setReserve).catch(() => setReserve({}));
    }
    setLoading(false);
  }

  /** Stock disponible pour une ligne : celui de la variante s'il y en a une. */
  function stockDe(l: { produitId: string; varianteCle?: string | null }): number {
    return stocks[l.varianteCle ? `${l.produitId}:${l.varianteCle}` : l.produitId] ?? 0;
  }

  /**
   * Ce qui manque encore sur une ligne, dans la limite du stock.
   *
   * Deux lignes peuvent porter le même produit : `dejaPris` retient ce que
   * les lignes précédentes ont déjà réservé dans le même geste, sinon un
   * complément global promettrait deux fois le même stock.
   */
  /**
   * Ce qu'il reste vraiment en magasin pour un produit.
   *
   * Le stock ne bouge qu'à la livraison : il porte encore tout ce que les
   * dossiers en préparation ou prêts ont mis de côté, celui-ci compris.
   * `dejaPris` retient ce qu'un même geste a déjà réservé sur les lignes
   * précédentes, sinon un complément global promettrait deux fois.
   */
  function disponibleDe(
    l: { produitId: string; varianteCle?: string | null },
    dejaPris?: Record<string, number>,
  ): number {
    const cle = l.varianteCle ? `${l.produitId}:${l.varianteCle}` : l.produitId;
    return stockDe(l) - (reserve[cle] ?? 0) - (dejaPris?.[cle] ?? 0);
  }

  function completementPossible(
    l: { produitId: string; varianteCle?: string | null; quantiteDemandee: number },
    i: number,
    dejaPris?: Record<string, number>,
  ): number {
    const manque = Math.max(0, l.quantiteDemandee - (prepareParIdx[i] ?? 0));
    return Math.max(0, Math.min(manque, disponibleDe(l, dejaPris)));
  }

  /**
   * Complète une ligne, ou toutes.
   *
   * Le raccourci écrit de vraies préparations, datées et signées : c'est le
   * même fait que la saisie manuelle, on épargne seulement les clics. Rien
   * n'est marqué « complet » sur la ligne.
   */
  async function completer(ligneIndex: number | null) {
    /* Une écriture en cours n'a pas encore rafraîchi l'affichage : le bouton
       montre toujours l'ancien reste. Sans cette garde, deux clics rapides
       déclarent deux fois la même chose. */
    if (!vente || enCours) return;
    /* Une ligne sans stock n'est pas une erreur : on complète ce qu'on peut
       et on laisse le reste manquant. */
    const dejaPris: Record<string, number> = {};
    const aEcrire: { i: number; quantite: number }[] = [];

    vente.lignes.forEach((l, i) => {
      if (ligneIndex != null && i !== ligneIndex) return;
      const q = completementPossible(l, i, dejaPris);
      if (q <= 0) return;
      const cle = l.varianteCle ? `${l.produitId}:${l.varianteCle}` : l.produitId;
      dejaPris[cle] = (dejaPris[cle] ?? 0) + q;
      aEcrire.push({ i, quantite: q });
    });

    if (aEcrire.length === 0) return;
    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurCourant(vente.siteId, user!.uid);
      const date = aujourdhui();
      await Promise.all(aEcrire.map(({ i, quantite }) => {
        const l = vente.lignes[i];
        return enregistrerPreparation({
          siteId: vente.siteId,
          documentId: venteId,
          ligneIndex: i,
          produitId: l.produitId ?? null,
          varianteCle: l.varianteCle ?? null,
          designation: l.designation,
          quantite,
          ...emballageDe(l, quantite),
          date,
          utilisateur: user!.uid,
          utilisateurNom: auteur.utilisateurNom,
          utilisateurFonction: auteur.utilisateurFonction,
          note: null,
        });
      }));
      setPreparations(await chargerPreparations(venteId));
    } catch (e: any) { setErreur(e?.message ?? 'Enregistrement impossible.'); }
    finally { setEnCours(false); }
  }

  /**
   * L'emballage d'une ligne, figé au moment du prélèvement.
   *
   * Deux dossiers peuvent prélever le même produit dans des emballages
   * différents : sans la conversion en unités, leurs quantités ne
   * s'additionnent pas et le réservé serait faux.
   */
  function emballageDe(l: { produitId: string; emballage?: string | null }, quantite: number) {
    const contenance = l.emballage
      ? enUnitesBase(1, l.emballage, emballages[l.produitId] ?? []) : 1;
    return {
      emballage: l.emballage ?? null,
      contenance,
      quantiteUnites: quantite * contenance,
    };
  }

  /** Une préparation s'ajoute ; elle ne remplace jamais la précédente. */
  async function ajouterPreparation() {
    if (!vente || lignePreparee == null || qtePreparee <= 0) return;
    setEnCours(true); setErreur('');
    try {
      const l = vente.lignes[lignePreparee];
      const auteur = await auteurCourant(vente.siteId, user!.uid);
      await enregistrerPreparation({
        siteId: vente.siteId,
        documentId: venteId,
        ligneIndex: lignePreparee,
        produitId: l.produitId ?? null,
        varianteCle: l.varianteCle ?? null,
        designation: l.designation,
        quantite: qtePreparee,
        ...emballageDe(l, qtePreparee),
        date: aujourdhui(),
        utilisateur: user!.uid,
        utilisateurNom: auteur.utilisateurNom,
        utilisateurFonction: auteur.utilisateurFonction,
        note: notePreparee.trim() || null,
      });
      setPreparations(await chargerPreparations(venteId));
      setLignePreparee(null); setQtePreparee(0); setNotePreparee('');
    } catch (e: any) { setErreur(e?.message ?? 'Enregistrement impossible.'); }
    finally { setEnCours(false); }
  }

  /* On n'ajuste pas une préparation : on l'annule et on en saisit une autre.
     Le registre montre alors qu'une erreur a été faite et corrigée. */
  async function annulerUnePreparation(id: string) {
    if (!vente) return;
    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurCourant(vente.siteId, user!.uid);
      await annulerPreparation({
        preparationId: id, par: user!.uid, parNom: auteur.utilisateurNom,
      });
      setPreparations(await chargerPreparations(venteId));
    } catch (e: any) { setErreur(e?.message ?? 'Annulation impossible.'); }
    finally { setEnCours(false); }
  }

  /**
   * Marque le dossier prêt. C'est ici que le préparé se fige : il vient des
   * préparations enregistrées, jamais d'une saisie. Après ce geste, plus rien
   * ne s'ajoute — ce qui manque devient un non-livré assumé.
   */
  async function marquerPret() {
    if (!vente) return;
    setModalPret(false);
    setEnCours(true); setErreur('');
    try {
      const prep = prepareParLigne(preparations);
      const lignes = vente.lignes.map((l, i) => ({
        ...l, quantiteRecue: prep[i] ?? 0,
      }));
      await updateDoc(doc(db, 'ventes', venteId), {
        etat: 'pret',
        lignes,
        datePret: aujourdhui(),
        datePreparation: vente.datePreparation ?? aujourdhui(),
        parPreparation: user!.uid,
        auteurPreparation: await auteurEtape(vente.siteId, user!.uid),
      });

      /* Le passage à « prêt » entraîne les deux autres dossiers, comme
         les autres étapes. Il vit dans sa propre fonction — la
         préparation se clôt par un décompte, pas par un simple cran — et
         la propagation n'y avait pas été posée : les trois repartaient
         ensemble jusqu'ici, puis le destinataire restait en préparation
         pendant que la source était prête. */
      const lien = (vente as any).ordreLien;
      if (lien && (vente as any).ordre === true) {
        await propagerEtapeOrdre({
          lien, etat: 'pret', userId: user!.uid, date: aujourdhui(),
        });
      }
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Opération impossible.'); }
    finally { setEnCours(false); }
  }

  /**
   * Avance d'un cran dans le cycle. On ne saute pas d'étape : un état n'est
   * atteint que parce que le travail du précédent a été fait.
   */
  async function avancer() {
    if (!vente) return;
    const suivant = SUITE_VENTE[vente.etat];
    if (!suivant) return;
    /* La garde tient à l'écriture, pas seulement à l'écran : cacher un
       bouton ne ferme pas la porte par laquelle on appelle. */
    if ((vente as any).ordreLien && (vente as any).ordre !== true) return;

    setEnCours(true);
    setErreur('');
    try {
      /* Le bon de commande d'un ordre ne livre pas comme une vente.
       *
       * Sa marchandise part par le transfert, qui la sort d'ici et la
       * fait entrer là-bas ; la vente du site qui facture l'en fera
       * ressortir. Le livrer ici écrirait une seconde sortie pour un
       * seul ventilateur remis. Il n'a pas de créance non plus : elle
       * appartient au dossier d'en face. */
      const lienOrdre = (vente as any).ordreLien;
      const estSourceOrdre = !!lienOrdre && (vente as any).ordre === true;

      if (suivant === 'livre' && estSourceOrdre) {
        const auteur = await auteurCourant(
          vente.siteId, user!.uid, user!.displayName);

        /* La marchandise bouge avant que le bon se dise livré.
         *
         * L'ordre inverse a laissé un dossier à mi-chemin : le bon
         * passait à « livré », puis la confirmation du transfert
         * échouait — et plus rien ne la relançait. Le bon se disait
         * remis, le transfert restait en préparation, aucun stock
         * n'avait bougé, et l'écran ne montrait plus de bouton pour
         * reprendre. Deux lots séparés ne peuvent pas être annulés
         * ensemble ; l'ordre dans lequel on les écrit est donc le seul
         * filet qu'on ait. On écrit d'abord ce qui est difficile — les
         * mouvements des deux sites — et on ne clôt le bon que si cela
         * a réussi. Un échec laisse alors un dossier qu'on peut
         * simplement relancer. */
        const tSnap = await getDoc(doc(db, 'transferts', lienOrdre.transfertId));
        if (!tSnap.exists()) {
          throw new Error("Le transfert de cet ordre est introuvable.");
        }

        /* Les quantités remises doivent être sur le transfert avant qu'il
           les applique : c'est `remettreOrdre` qui les y pose, mais lui
           seul peut le faire sans clore le bon. On les pose donc ici, et
           la clôture du bon suit la confirmation. */
        await updateDoc(doc(db, 'transferts', lienOrdre.transfertId), {
          /* Ce qui part est ce qui a ete prepare, pas ce qui a ete
             demande. */
          lignes: vente.lignes.map(l => {
            const remis = l.quantiteRecue ?? l.quantiteDemandee;
            return { ...l, quantiteExpediee: remis, quantiteRecue: remis };
          }),
        });

        /* Chaque etape se saute si elle est deja faite.
         *
           Une remise qui echoue au milieu laisse des etapes acquises et
           d'autres non. Au second clic, `confirmerTransfert` levait
           « Seul un transfert recu peut etre confirme » — le dossier
           restait bloque pour toujours, stock entre chez le destinataire
           sans jamais ressortir, client non facture. Reprendre doit etre
           possible : une etape deja franchie n'est pas une erreur, c'est
           du travail en moins. */
        const tFrais = await getDoc(doc(db, 'transferts', lienOrdre.transfertId));
        if ((tFrais.data() as any)?.etat !== 'confirme') {
          await confirmerTransfert({
            transfert: { id: tFrais.id, ...tFrais.data() } as any,
            userId: user!.uid, par: user!.uid,
            utilisateurNom: auteur.utilisateurNom,
            utilisateurFonction: auteur.utilisateurFonction,
          });
        }

        /* La vente du client sort son stock, et l'achat prend sa dette :
           c'est le dernier geste coûteux, donc il passe avant la clôture
           du bon. Un échec ici laisse le bon à « prêt », et l'on reclique.
           Fait après, il laissait un bon livré, une marchandise déplacée
           entre les sites, et rien de sorti chez le client — facturé
           pourtant, et toujours en rayon. */
        await propagerEtapeOrdre({
          lien: lienOrdre, etat: 'livre', userId: user!.uid,
          date: aujourdhui(),
          utilisateurNom: auteur.utilisateurNom,
          utilisateurFonction: auteur.utilisateurFonction,
          transfertDejaClos: true,
        });

        /* Tout a bougé : le bon peut enfin se dire livré. C'est la seule
           écriture dont la perte ne coûte rien — elle se rejoue. */
        await remettreOrdre({
          lien: lienOrdre,
          lignes: vente.lignes,
          userId: user!.uid,
          date: aujourdhui(),
          utilisateurNom: auteur.utilisateurNom,
          utilisateurFonction: auteur.utilisateurFonction,
        });

      /* La livraison n'est pas un simple changement d'état : c'est là que le
         stock sort et que la créance naît. */
      } else if (suivant === 'livre') {
        const r = await livrerVente({
          vente, userId: user!.uid, par: user!.uid,
          ...(await auteurCourant(vente.siteId, user!.uid, user!.displayName)),
        });
        if (r.retourCaisse > 0) setRetour(r.retourCaisse);

      } else {
        const champDate = suivant === 'preparation' ? 'datePreparation'
          : suivant === 'pret' ? 'datePret' : 'dateCommande';
        await updateDoc(doc(db, 'ventes', venteId), {
          etat: suivant,
          [champDate]: aujourdhui(),
          ...(suivant === 'preparation'
            ? { parPreparation: user!.uid,
                auteurPreparation: await auteurEtape(vente.siteId, user!.uid) }
            : {}),
        });
      }

      /* Un bon de commande né d'un ordre entraîne les deux autres
         dossiers : le gérant d'en face n'a rien à pousser, et le
         transfert se clôt au moment où la marchandise est remise. */
      /* « livré » est traité plus haut, dans son propre ordre : ici ne
         restent que les crans qui n'écrivent qu'un état. */
      if (lienOrdre && estSourceOrdre
        && (suivant === 'preparation' || suivant === 'pret')) {
        /* La livraison d'en face porte le nom de qui l'a déclenchée :
           une archive doit dire qui a fait le geste, même des mois
           après. */
        const parQui = await auteurCourant(
          vente.siteId, user!.uid, user!.displayName);
        await propagerEtapeOrdre({
          lien: lienOrdre, etat: suivant, userId: user!.uid,
          date: aujourdhui(),
          utilisateurNom: parQui.utilisateurNom,
          utilisateurFonction: parQui.utilisateurFonction,
        });
      }
      await charger();
    } catch (e: any) {
      setErreur(e?.message ?? 'Opération impossible.');
    }
    setEnCours(false);
  }

  /**
   * Transforme un devis en commande. Le devis n'est pas consommé : il reste,
   * avec son état propre, et la commande garde un lien vers lui. Sans ce
   * geste, aucun lien n'existe et le taux de devis aboutis ne veut rien dire.
   */
  async function transformerEnCommande() {
    if (!vente) return;
    setEnCours(true);
    setErreur('');
    try {
      const date = aujourdhui();
      const ref = await addDoc(collection(db, 'ventes'), {
        reference: referenceFlux('CV', date),
        siteId: vente.siteId,
        clientId: vente.clientId ?? null,
        clientNom: vente.clientNom,
        etat: 'commande',
        /* les prix du devis sont repris tels quels : on s'est engagé dessus,
           les réécrire au tarif du jour contredirait la proposition */
        lignes: vente.lignes,
        avanceVersee: 0,
        versements: [],
        devisId: vente.id,
        validiteDevis: null,
        dateDevis: vente.dateDevis ?? null,
        dateCommande: date,
        dateLivraisonPrevue: livraisonPrevue || null,
        parDevis: vente.parDevis ?? null,
        parCommande: user!.uid,
        auteurCommande: await auteurEtape(vente.siteId, user!.uid),
        note: vente.note ?? null,
        userId: user!.uid,
        createdAt: serverTimestamp(),
      });
      /* La commande engage la marchandise : ses lignes entrent dans la
         collection. Celles du devis y restent aussi, mais son acceptation
         les ecarte du compte — sans quoi le produit serait promis deux fois. */
      await synchroniserLignes({
        neuve: true,
        venteId: ref.id,
        lignes: vente.lignes.map((l, i) => ligneDepuisVente({
          siteId: vente.siteId, venteId: ref.id, ligneIndex: i, ligne: l,
          emballages: emballages[l.produitId] ?? [],
          clientId: vente.clientId ?? null, clientNom: vente.clientNom,
        })),
      });

      /* Le devis reste un devis : l'annuler le rangerait avec les refusés,
         et le taux de transformation ne voudrait plus rien dire. Il porte
         seulement la marque de son acceptation. */
      await updateDoc(doc(db, 'ventes', venteId), {
        accepte: true, dateAcceptation: date, commandeId: ref.id,
      });
      /* La commande nee du devis herite de son origine : sans elle, on
         la fermerait dans le site alors qu'on venait de l'ensemble. */
      router.push(
        `/site/${siteId}/ventes/${ref.id}${marqueOrigine(estEnsemble(searchParams))}`);
    } catch (e: any) {
      setErreur(e?.message ?? 'Transformation impossible.');
      setEnCours(false);
    }
  }

  async function ajouterVersement() {
    if (!vente || nouveauVersement <= 0) return;
    setEnCours(true);
    try {
      await enregistrerVersement({
        adminUid: activite?.adminUid ?? null,
        siteId: vente.siteId, userId: user!.uid,
        date: dateVersement,
        montant: nouveauVersement,
        /* encaisser un client fait entrer de l'argent */
        sens: 'entree',
        /* Le motif est figé à la saisie, et trois cas se distinguent :
           tant que la marchandise n'est pas partie, l'argent est en dépôt —
           c'est une avance ; payé le jour où elle part, il achète — c'est
           une vente ; payé plus tard, il éteint une dette déjà née — c'est
           un règlement. */
        motif: vente.etat !== 'livre' ? 'avance'
          : dateVersement === (vente.dateLivraison ?? '') ? 'vente'
          : 'reglement',
        partenaireId: vente.clientId ?? '',
        partenaireNom: vente.clientNom ?? null,
        role: 'client',
        venteId,
        reference: vente.reference ?? null,
        par: user!.uid,
        ...(await auteurCourant(vente.siteId, user!.uid)),
      });
      setModalVersement(false);
      setNouveauVersement(0);
      await charger();
    } catch (e: any) {
      setErreur(e?.message ?? 'Versement impossible.');
    }
    setEnCours(false);
  }

  async function annuler() {
    if (!vente) return;
    /* La garde tient aussi ici : cacher le bouton ne protège que l'écran,
       et la fonction reste appelable par d'autres chemins. */
    if (!peutAnnulerDossier(role as Role | null)) return;
    setEnCours(true);
    try {
      /* Les trois dossiers d'un ordre tombent ensemble. Ils n'existent
         que parce qu'un transfert devait partir : annuler celui-ci seul
         laisserait la source préparer une marchandise que plus personne
         n'attend, et le transfert partir vers une commande annulée.
         L'autre porte est le transfert, chez la source — son bon de
         commande, lui, ne s'annule pas de son propre chef. */
      const lien = (vente as any).ordreLien;
      if (lien) {
        await annulerOrdre({ lien, userId: user!.uid, date: aujourdhui() });
        await charger();
        setEnCours(false);
        return;
      }
      await updateDoc(doc(db, 'ventes', venteId), { etat: 'annule' });
      /* Plus rien n'est promis : les lignes sortent du compte. */
      await supprimerLignesDeVente(venteId);
      await charger();
    } catch (e: any) {
      setErreur(e?.message ?? 'Annulation impossible.');
    }
    setEnCours(false);
  }

  /* Un dossier se fait avancer sans connaître les prix : ce rôle prépare,
     il ne négocie pas. */
  const montreArgent = role !== 'commandes';

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!vente) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-500">Dossier introuvable.</p>
      <button onClick={() => router.push(
        `${racineRetour(estEnsemble(searchParams), siteId)}?onglet=cycle-vente`)}
        className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl">
        Retour au cycle de vente
      </button>
    </div>
  );

  const total = valeurVente(vente.lignes);
  const marge = beneficeAttendu(vente.lignes);
  /* Ce qui a été accordé et facturé en plus.

     Les lignes portent le prix D APRES remise : on ne peut donc pas
     relire le sous-total sur elles. On le retrouve à l envers, du total
     encaissé — remettre ce qu on a cédé, retirer ce qu on a facturé.
     Un pourcentage se résout alors sur cette base, la même qu au jour
     de la saisie. */
  /* Enregistré à la saisie. Les documents antérieurs ne le portent pas :
     on le reconstitue alors du total, à quelques francs d'arrondi près. */
  const stDoc = vente.sousTotalOrigine ?? sousTotalOrigine(total, vente.montants);
  const pied = piedDocument(stDoc, total, vente.montants);
  const reductionDoc = pied.reduction;
  const fraisDoc = pied.frais;
  /* `avanceVersee` porte les deux : l'argent reçu et ce qu'un retour a
     éteint. On les sépare — la fiche annonçait « versé » une
     marchandise revenue, et le client passait pour avoir payé. */
  const retourDoc = versements
    .filter(v => v.motif === 'retour_marchandise')
    .reduce((n, v) => n + (v.montant ?? 0), 0);
  const verse = Math.max(0, (vente.avanceVersee ?? 0) - retourDoc);
  const reste = Math.max(0, total - verse - retourDoc);
  const expire = devisExpire(vente);
  const suivant = SUITE_VENTE[vente.etat];

  /* Le dossier qui suit, et celui qui mène.
   *
   * Un ordre tient trois dossiers ensemble, et c'est la source qui les
   * fait avancer : elle tient la marchandise, elle la prépare, elle la
   * remet. La commande du destinataire ne décide de rien — elle
   * constate, pour que son gérant sache où en est la commande de son
   * client sans appeler l'autre site.
   *
   * Elle gardait pourtant son bouton. On pouvait donc la pousser de son
   * côté, et les trois dossiers se mettaient à avancer séparément :
   * l'un livré, l'autre en préparation, le transfert encore en attente.
   * Trois états pour une seule marchandise, et aucun moyen de savoir
   * lequel disait vrai. */
  const ordreSuit = !!(vente as any).ordreLien && (vente as any).ordre !== true;

  /* On ne peut plus annuler seul après la livraison : la marchandise appartient
     au client, il faudrait un retour — et un retour se fait à deux. */
  /* La saisie des quantités trouvées n'a lieu que pendant la préparation :
     avant, rien n'est rassemblé ; après, c'est figé. */
  const enPreparation = vente.etat === 'preparation';
  /* Un dossier pret se lit comme un dossier en preparation : meme colonnes,
     meme historique. Seule la saisie s'arrete — le prepare y est fige, et la
     prochaine etape est la livraison. */
  const detaillePreparation = enPreparation || vente.etat === 'pret';
  const restants = joursRestants(vente);
  /* Le préparé est la somme des prélèvements non annulés. Une fois le
     dossier prêt, il est figé sur la ligne : on lit alors celle-ci. */
  const prepareParIdx = prepareParLigne(preparations);
  function prepareDe(l: { quantiteRecue?: number | null; quantiteDemandee: number }, i: number): number {
    return enPreparation ? (prepareParIdx[i] ?? 0) : (l.quantiteRecue ?? l.quantiteDemandee);
  }
  /* Annuler revient sur un engagement pris envers le client : cela relève
     de qui répond du site, pas de qui fait avancer les dossiers. */
  const peutAnnuler = vente.etat !== 'livre' && vente.etat !== 'annule'
    && peutAnnulerDossier(role as Role | null)
    /* Le bon de commande d'un ordre ne renonce pas de son propre chef :
       il n'a pas de client et ne porte aucune dette, il n'est que l'outil
       de travail de la source. Ce qui s'annule de ce côté, c'est le
       transfert — et son annulation emporte les trois. */
    && (vente as any).ordre !== true;
  /* un annule n'a pas de carte : il se consulte depuis celle des livres */
  /* La carte qu'on regardait, pas celle où le dossier a atterri : un devis
     transformé en commande se ferme sur Devis, là où on l'a ouvert. */
  const carteRetour = searchParams.get('carte')
    ?? (vente.etat === 'annule' ? 'livre' : vente.etat);
  /* On revient d'où l'on vient. Un dossier s'ouvre depuis le cycle, mais
     aussi depuis l'historique : y renvoyer au cycle ferait perdre la liste
     qu'on parcourait. L'origine voyage dans l'URL, seul endroit qui survit
     à un rechargement. */
  const origine = searchParams.get('de');
  /* On revient d'où l'on vient : l'historique, la vue d'ensemble, ou la
     carte du cycle qu'on parcourait. */
  const fermer = origine === 'historique' || origine === 'ensemble-historique'
    ? `${origine === 'ensemble-historique' ? '/ensemble' : `/site/${siteId}`}${retourHistorique(searchParams)}`
    : `${origine === 'ensemble' ? '/ensemble' : `/site/${siteId}`}?onglet=cycle-vente&carte=${carteRetour}`;
  /* Un versement reste possible tant qu'il reste dû, y compris après livraison. */
  const peutVerser = vente.etat !== 'annule' && vente.etat !== 'devis' && reste > 0;

  /* Le recouvrement prévu de cet ordre, tel qu'il est posé sur la commande. */
  const recouvrePrevu = (vente as any).recouvrementPrevu as
    { valeur: number; date: string } | null | undefined;
  /* Qui peut le régler : le gérant ou l'admin du site qui facture, tant
     que rien n'est confirmé (la source n'a pas encore remis). Le
     responsable des commandes, lui, ne répond pas de ce client. */
  const peutReglerRecouvre = ordreSuit
    && (role === null || role === 'gerant')
    && vente.etat !== 'livre' && vente.etat !== 'annule';

  function ouvrirEditRecouvre() {
    setRecActif(recouvrePrevu != null);
    setRecMontant(recouvrePrevu?.valeur ?? valeurVente(vente!.lignes));
    setRecDate(recouvrePrevu?.date ?? aujourdhui());
    setEditRecouvre(true);
  }

  async function enregistrerRecouvre() {
    setErreur('');
    setEnCours(true);
    try {
      const prevu = recActif && recMontant > 0
        ? { valeur: recMontant, date: recDate || aujourdhui() }
        : null;
      await updateDoc(doc(db, 'ventes', venteId), { recouvrementPrevu: prevu });
      setEditRecouvre(false);
      await charger();
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
    } finally {
      setEnCours(false);
    }
  }

  /* L'export PDF du dossier. Le titre suit l'état, via le libellé déjà
     défini dans l'app — aucun nom inventé ici. */
  function telechargerPdf() {
    const v = vente!;
    const estDevis = v.etat === 'devis';
    /* Une vente livrée, c'est le moment où l'on remet une facture : le
       papier s'appelle « Facture », là où l'app suit l'étape du dossier
       (« Livré »). Les autres états gardent leur libellé. */
    const titrePdf = v.etat === 'livre' ? 'Facture' : LIBELLES_VENTE[v.etat];
    exporterPdf({
      titre: titrePdf,
      reference: v.reference,
      entete: entetePdf,
      infos: [
        { libelle: 'Client', valeur: v.clientNom ?? '—' },
        { libelle: estDevis ? 'Devis' : 'Commande',
          valeur: formatDate(v.dateDevis ?? v.dateCommande) },
        ...(v.dateLivraison
          ? [{ libelle: 'Livré le', valeur: formatDate(v.dateLivraison) }] : []),
        ...(siteServeur ? [{ libelle: 'Servie par', valeur: siteServeur }] : []),
      ],
      colonnes: ['Produit', 'Qté', 'Prix unitaire', 'Total'],
      alignements: ['left', 'center', 'right', 'right'],
      lignes: v.lignes.map(l => {
        const qte = l.quantiteRecue ?? l.quantiteDemandee;
        const pu = l.prixVente ?? 0;
        return {
          cellules: [
            l.designation + (l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''),
            `${qte} ${l.unite ?? ''}`.trim(),
            formatMontant(pu),
            formatMontant(qte * pu),
          ],
        };
      }),
      totaux: [
        { libelle: 'Total', valeur: formatMontant(total) },
        ...((v.avanceVersee ?? 0) > 0
          ? [{ libelle: v.etat === 'livre' ? 'Versé' : 'Avance',
               valeur: formatMontant(v.avanceVersee) }] : []),
        ...(reste > 0
          ? [{ libelle: 'Reste à payer', valeur: formatMontant(reste), fort: true }]
          : [{ libelle: 'Soldé', valeur: formatMontant(total), fort: true }]),
      ],
      note: v.note ?? null,
    });
  }

  const LIBELLE_ACTION: Record<string, string> = {
    commande: 'Transformer en commande',
    preparation: 'Lancer la préparation',
    pret: 'Marquer prêt',
    livre: 'Livrer',
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">

      {/* Les actions du dossier restent atteignables pendant qu'on parcourt les lignes. */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
        {/* Sur téléphone, l'en-tête se lit en deux temps : qui l'on regarde,
            puis ce qu'on peut en faire.

            Une seule rangée qui se replie, c'était l'écran du bureau rétréci :
            « Fermer » prenait la largeur d'un vrai bouton pour un geste de
            retour, et l'action du dossier tombait à la ligne suivante sans
            jamais atteindre le bord.

            Le retour redevient une flèche, là où le pouce la cherche ; le
            titre prend la place libérée ; l'action passe en pleine largeur
            dessous, où elle ne se manque pas. */}
        <div className="w-full px-4 sm:px-6 lg:px-8 py-3">
          <div className="sm:flex sm:items-center sm:justify-between sm:gap-3">
            <div className="flex items-center gap-2">
            {/* La flèche ne paraît que sur téléphone : au bureau, « Fermer »
                reste plus clair qu'un chevron isolé. */}
            <button onClick={() => fermerEcran(router, fermer)}
              title="Fermer"
              className="-ml-1 shrink-0 rounded-xl p-2 text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 sm:hidden">
              <ArrowLeft size={18} />
            </button>

            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-bold text-gray-900 dark:text-gray-100">{vente.reference}</h1>
              {/* La pastille suit le dossier jusque dans sa fiche : elle
                  le distinguait dans la liste, et l'ouvrir la faisait
                  disparaître — on ne savait plus ce qu'on lisait. */}
              {(vente as any).ordreLien && (
                <span title={(vente as any).ordre === true
                  ? `À remettre à ${(vente as any).ordrePartenaireNom ?? 'un client'} — facturé par l'autre site`
                  : 'Servie par un autre site'}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                  O
                </span>
              )}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${
                expire ? 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400' : COULEURS_ETAT[vente.etat]}`}>
                {expire ? 'Devis expiré' : LIBELLES_VENTE[vente.etat]}
              </span>
            </div>

          </div>

          {/* Les actions : en ligne au bureau, empilées en pleine largeur
              sur téléphone où le pouce ne vise pas. */}
          <div className="mt-2.5 flex gap-2 [&>button]:flex-1 [&>button]:justify-center sm:mt-0 sm:[&>button]:flex-none">
            {/* on revient sur la carte du dossier qu'on quitte, pas sur
                une carte par defaut : sinon on perd le fil de son travail */}
            <button onClick={() => fermerEcran(router, fermer)}
              className="hidden px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors sm:block">
              Fermer
            </button>
            {montreArgent && vente.etat !== 'annule' && (
              <button onClick={telechargerPdf}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800 rounded-xl transition-colors">
                <Download size={14} /> PDF
              </button>
            )}
            {peutAnnuler && (
              <button onClick={annuler} disabled={enCours}
                className="px-4 py-2 text-sm font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 rounded-xl transition-colors">
                {vente.etat === 'devis' ? 'Refuser le devis' : 'Annuler'}
              </button>
            )}
            {/* Le devis ne progresse pas dans le cycle : il le rejoint en
                devenant une commande, qui naît à côté de lui. */}
            {vente.etat === 'devis' ? (
              <button onClick={() => setModalTransformer(true)} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                Transformer en commande
              </button>
            ) : ordreSuit ? (
              /* Rien à pousser ici : ce dossier suit celui de la source.
                 Le dire vaut mieux qu'un bouton absent, qui laisserait
                 croire à une panne. */
              <p className="text-xs font-medium text-gray-400">
                Avance avec le dossier du site qui expédie
              </p>
            ) : enPreparation ? (
              /* Une seule action : le préparé se déclare ligne par ligne, il
                 ne s'enregistre plus en bloc. */
              <button onClick={() => setModalPret(true)} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                Marquer prêt
              </button>
            ) : suivant && (
              <button onClick={avancer} disabled={enCours}
                className={`flex items-center gap-1.5 px-4 py-2 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors ${
                  suivant === 'livre' ? 'bg-green-600 hover:bg-green-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                {enCours ? <Loader2 size={14} className="animate-spin" />
                  : suivant === 'livre' ? <Truck size={14} /> : <ArrowRight size={14} />}
                {LIBELLE_ACTION[suivant]}
              </button>
            )}
          </div>
          </div>
        </div>
      </header>

      <div className="w-full p-4 sm:p-6 lg:p-8">

        <BlocIdentite nom={vente.clientNom} lignes={vente.lignes.length}
          className="mb-4">
          {/* Sur un téléphone, ces cases se rangeaient deux par deux, chacune
              avec son libellé au-dessus de sa valeur : beaucoup de hauteur
              pour des faits courts. Elles se lisent donc en lignes, le
              libellé devant sa valeur.
              Le client n'était que dans l'en-tête, qui disparaît au
              défilement : il reste ici. */}
          <div className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4 sm:gap-2">
            {/* Deux par ligne : le libellé reste au-dessus de sa valeur, car
                en demi-largeur les deux côte à côte tronqueraient un nom de
                client ou une date suivie de son échéance. */}
            <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
              <p className="truncate text-gray-400">Client</p>
              <p className="truncate font-medium text-gray-700 dark:text-gray-300">{vente.clientNom}</p>
            </div>
            {/* Qui a servi la marchandise, quand ce n'est pas ce site.
                La commande est d'ici, le client est d'ici, la facture
                aussi — mais les cartons sont sortis d'ailleurs, et sans
                ce nom on cherche dans son propre stock un mouvement qui
                n'y est jamais passé. */}
            {siteServeur && (
              <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
                <p className="truncate text-gray-400">Servie par</p>
                <p className="truncate font-medium text-gray-700 dark:text-gray-300">
                  {siteServeur}
                </p>
              </div>
            )}
            {siteFacture && (
              <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
                <p className="truncate text-gray-400">Facturée par</p>
                <p className="truncate font-medium text-gray-700 dark:text-gray-300">
                  {siteFacture}
                </p>
              </div>
            )}
            <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
              <p className="truncate text-gray-400">Produits</p>
              <p className="font-medium text-gray-700 dark:text-gray-300">
                {vente.lignes.length} ligne{vente.lignes.length > 1 ? 's' : ''}
              </p>
            </div>
            <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
              <p className="truncate text-gray-400">{vente.etat === 'devis' ? 'Proposé' : 'Commandé'}</p>
              <p className="font-medium text-gray-700 dark:text-gray-300">
                {formatDate(vente.dateDevis ?? vente.dateCommande)}
              </p>
            </div>
            {/* L'échéance du dossier : un devis court vers son expiration,
                une commande vers la livraison promise. Tant qu'aucune date
                n'est posée, la case se tait plutôt que d'afficher un tiret. */}
            {(vente.etat === 'devis' ? vente.validiteDevis
              : vente.etat === 'livre' ? vente.dateLivraison
              : vente.dateLivraisonPrevue) && (
              <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
                <p className="truncate text-gray-400">
                  {vente.etat === 'devis' ? "Valable jusqu'au"
                    : vente.etat === 'livre' ? 'Livré'
                    : 'Livraison prévue'}
                </p>
                <p className={`truncate font-medium ${
                  restants != null && restants < 0
                    ? 'text-red-500' : 'text-gray-700 dark:text-gray-300'}`}>
                  {formatDate(vente.etat === 'devis' ? vente.validiteDevis
                    : vente.etat === 'livre' ? vente.dateLivraison
                    : vente.dateLivraisonPrevue)}
                  {restants != null && <span className="font-normal"> · {restants} j</span>}
                </p>
              </div>
            )}
          </div>
        </BlocIdentite>

        {/* Le recouvrement prévu à la confirmation de l'ordre.
            La source remettra la marchandise et confirmera ; c'est à ce
            moment que la dette du client naît ici. Le gérant ou l'admin de
            ce site dit, à l'avance, ce qui se mettra alors en recouvrement
            — et peut le changer tant que rien n'est confirmé. */}
        {ordreSuit && montreArgent && (
          <div className="mb-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                Recouvrement à la confirmation
              </p>
              {peutReglerRecouvre && !editRecouvre && (
                <button onClick={ouvrirEditRecouvre}
                  className="rounded-xl px-3 py-1.5 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900/20">
                  Modifier
                </button>
              )}
            </div>

            {!editRecouvre && (
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                {recouvrePrevu && recouvrePrevu.valeur > 0 ? (
                  <>
                    <span className="font-bold text-gray-900 dark:text-gray-100">
                      {formatMontant(recouvrePrevu.valeur)}
                    </span>{' '}
                    en recouvrement, échéance le{' '}
                    <span className="font-bold text-gray-900 dark:text-gray-100">
                      {formatDate(recouvrePrevu.date)}
                    </span>
                    . Posé sur ce qui restera dû après les avances.
                  </>
                ) : (
                  <span className="text-gray-400">
                    Aucun recouvrement automatique prévu.
                  </span>
                )}
              </p>
            )}

            {editRecouvre && (
              <div className="mt-3 space-y-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={recActif}
                    onChange={e => setRecActif(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                  <span className="text-xs font-bold text-gray-500 dark:text-gray-400">
                    Mettre en recouvrement à la confirmation
                  </span>
                </label>
                {recActif && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-gray-400">Montant</label>
                      <ChampNombre valeur={recMontant}
                        max={valeurVente(vente.lignes) > 0 ? valeurVente(vente.lignes) : undefined}
                        onChange={setRecMontant}
                        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-gray-400">Échéance</label>
                      <input type="date" value={recDate}
                        onChange={e => setRecDate(e.target.value)}
                        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={enregistrerRecouvre} disabled={enCours}
                    className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
                    {enCours ? 'Enregistrement…' : 'Enregistrer'}
                  </button>
                  <button onClick={() => setEditRecouvre(false)} disabled={enCours}
                    className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
                    Annuler
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Marchandise</p>
            {/* Tout préparer d'un coup : le cas courant est celui où le stock
                couvre la commande et où il n'y a rien à arbitrer. */}
            {enPreparation && (() => {
              const pris: Record<string, number> = {};
              const total = vente.lignes.reduce((n, l, i) => {
                const q = completementPossible(l, i, pris);
                const cle = l.varianteCle ? `${l.produitId}:${l.varianteCle}` : l.produitId;
                pris[cle] = (pris[cle] ?? 0) + q;
                return n + q;
              }, 0);
              if (total <= 0) return null;
              return (
                <button onClick={() => completer(null)} disabled={enCours}
                  className="flex items-center gap-1.5 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-40 dark:border-indigo-800/40 dark:hover:bg-indigo-900/20">
                  {enCours ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />}
                  Tout préparer
                </button>
              );
            })()}
          </div>
          {/* Sur téléphone, une carte par ligne.

              Le tableau comptait jusqu'à onze colonnes : masquer l'unité
              et l'emballage ne suffisait pas, et il fallait le faire
              défiler latéralement pour atteindre les boutons. Un défilement
              horizontal cache ce qu'il déplace — on prépare une commande
              sans voir ce qu'on prépare.

              Les mêmes données, empilées : ce qui se lit d'abord en haut,
              les chiffres en ligne, les boutons à la fin. */}
          <div className="space-y-2 sm:hidden">
            {vente.lignes.map((l, i) => {
              const qte = l.quantiteRecue ?? l.quantiteDemandee;
              const dispo = stockDe(l);
              const lignesPrep = preparations.filter(x => x.ligneIndex === i);
              const nbPrep = lignesPrep.filter(x => !x.annulee).length;
              const prepareLigne = prepareDe(l, i);
              const manque = Math.max(0, l.quantiteDemandee - prepareLigne);
              const encorePossible = completementPossible(l, i);
              return (
                <div key={i}
                  className={`rounded-xl border p-3 ${
                    detaillePreparation && manque > 0
                      ? 'border-amber-200 bg-amber-50/50 dark:border-amber-800/30 dark:bg-amber-900/10'
                      : 'border-gray-100 dark:border-gray-800'}`}>
                  {/* Ce qu'on prépare : le nom porte la carte. */}
                  <p className="text-[13px] font-bold text-gray-900 dark:text-gray-100">
                    {l.designation}
                    {l.varianteLibelle && (
                      <span className="ml-1.5 font-normal text-gray-400">{l.varianteLibelle}</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {l.emballage ?? l.unite ?? 'unité'}
                  </p>

                  {/* Les chiffres en ligne : ils se comparent d'un regard,
                      ce qu'une liste verticale interdirait. */}
                  <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-black/[0.06] pt-2 text-[11px] dark:border-white/10">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">
                        {detaillePreparation ? 'Demandé' : 'Quantité'}
                      </span>
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {detaillePreparation ? l.quantiteDemandee : qte}
                      </span>
                    </span>
                    {detaillePreparation && (
                      <>
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-gray-400">Stock</span>
                          <span className={`font-bold ${
                            dispo >= l.quantiteDemandee ? 'text-gray-500' : 'text-orange-500'}`}>
                            {dispo}
                          </span>
                        </span>
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-gray-400">Préparé</span>
                          <span className={`font-bold ${
                            manque > 0 ? 'text-orange-500' : 'text-gray-900 dark:text-gray-100'}`}>
                            {prepareLigne > 0 ? prepareLigne.toLocaleString('fr-FR') : '—'}
                          </span>
                          {nbPrep > 0 && (
                            <button onClick={() => setDetailLigne(detailLigne === i ? null : i)}
                              title="Voir les préparations"
                              className={`shrink-0 rounded p-0.5 transition-colors ${
                                detailLigne === i
                                  ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30'
                                  : 'text-gray-400'}`}>
                              <Info size={12} />
                            </button>
                          )}
                        </span>
                        {manque > 0 && (
                          <span className="flex items-baseline gap-1.5">
                            <span className="text-gray-400">
                              {enPreparation ? 'Manque' : 'Non livré'}
                            </span>
                            <span className="font-bold text-orange-500">{manque}</span>
                          </span>
                        )}
                      </>
                    )}
                    {montreArgent && (
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-gray-400">Total</span>
                        <span className="font-bold text-gray-900 dark:text-gray-100">
                          {formatMontant(qte * (l.prixVente ?? 0))}
                        </span>
                      </span>
                    )}
                  </div>

                  {/* Le détail des prélèvements, sous la carte qu'il
                      concerne : ailleurs, on ne saurait plus de quelle
                      ligne il parle. */}
                  {detailLigne === i && nbPrep > 0 && (
                    <div className="mt-2 rounded-lg bg-gray-50 p-2 dark:bg-gray-800/50">
                      {lignesPrep.map(x => (
                        <div key={x.id}
                          className={`flex items-center justify-between gap-2 py-1 text-[11px] ${
                            x.annulee ? 'opacity-50' : ''}`}>
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className={`font-bold ${
                              x.annulee ? 'text-gray-400 line-through' : 'text-gray-900 dark:text-gray-100'}`}>
                              {x.quantite.toLocaleString('fr-FR')}
                            </span>
                            <span className="truncate text-gray-400">
                              {formatDate(x.date)} · {x.utilisateurNom}
                            </span>
                          </span>
                          {x.annulee ? (
                            <span className="shrink-0 text-gray-400">Annulée</span>
                          ) : enPreparation ? (
                            <button onClick={() => annulerUnePreparation(x.id)} disabled={enCours}
                              className="shrink-0 text-red-500">Annuler</button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Les boutons à la fin, et en pleine largeur : c'est par
                      eux que le dossier avance, et le pouce les trouve sans
                      viser. */}
                  {enPreparation && encorePossible > 0 && (
                    <div className="mt-2.5 flex items-center gap-1.5">
                      <button onClick={() => completer(i)} disabled={enCours}
                        className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-2 text-xs font-bold text-white transition-colors disabled:opacity-40">
                        <CheckCheck size={12} /> {encorePossible}
                      </button>
                      <button onClick={() => {
                        setLignePreparee(i); setQtePreparee(0); setNotePreparee('');
                      }}
                        title="Saisir une quantité"
                        className="flex shrink-0 items-center rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-600 dark:border-gray-600 dark:text-gray-300">
                        <Plus size={12} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Au-delà du téléphone, le tableau : la largeur y est, et une
              grille se lit mieux que des cartes quand on compare. */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  <th className="text-center px-3 py-2.5 font-medium">Produit</th>
                  {/* L'unité se déduit de l'emballage, et l'emballage se lit
                      sous le produit sur un téléphone : garder les deux
                      colonnes y repousserait les quantités hors de l'écran,
                      qui sont le travail même. */}
                  <th className="hidden sm:table-cell text-center px-3 py-2.5 font-medium">Unité</th>
                  <th className="hidden sm:table-cell text-center px-3 py-2.5 font-medium">Emballage</th>
                  <th className="text-center px-3 py-2.5 font-medium">
                    {detaillePreparation ? 'Demandé' : 'Quantité'}
                  </th>
                  {/* Trois colonnes qui n'existent que pendant la préparation :
                      ce qu'on a, ce qu'on a trouvé, ce qui manque. */}
                  {detaillePreparation && (
                    <>
                      <th className="text-center px-3 py-2.5 font-medium">Stock</th>
                      <th className="text-center px-3 py-2.5 font-medium">Préparé</th>
                      {/* Ce qui manque devient, une fois le dossier pret, ce
                          qui ne sera pas livre : le chiffre est le meme. */}
                      <th className="text-center px-3 py-2.5 font-medium">
                        {enPreparation ? 'Manque' : 'Non livré'}
                      </th>
                    </>
                  )}
                  {montreArgent && <>
                    <th className="text-center px-3 py-2.5 font-medium">Coût</th>
                    <th className="text-center px-3 py-2.5 font-medium">Prix unitaire</th>
                    <th className="text-center px-3 py-2.5 font-medium">Total</th>
                  </>}
                  {/* Les actions ont leur place : serrées sous le chiffre
                      préparé, elles étaient illisibles et écrasaient la
                      colonne. Pas d'en-tête, ce ne sont pas des données. */}
                  {/* Collée à droite : c'est par elle qu'on prépare, et le
                      tableau défile sur un téléphone — sans cela, les deux
                      boutons restaient hors de l'écran et le dossier ne
                      pouvait plus avancer. */}
                  {enPreparation && (
                    <th className="sticky right-0 bg-indigo-600 px-3 py-2.5" />
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {vente.lignes.map((l, i) => {
                  const qte = l.quantiteRecue ?? l.quantiteDemandee;
                  const dispo = stockDe(l);
                  /* Les prélèvements de cette ligne : le préparé leur somme. */
                  const lignesPrep = preparations.filter(x => x.ligneIndex === i);
                  const nbPrep = lignesPrep.filter(x => !x.annulee).length;
                  const prepareLigne = prepareDe(l, i);
                  const manque = Math.max(0, l.quantiteDemandee - prepareLigne);
                  /* Ce qu'on peut encore prélever : ni au-delà du commandé,
                     ni au-delà de ce qu'il y a en magasin. */
                  /* Une seule source pour ce qui reste prenable : le bouton
                     doit dire exactement ce que le clic ecrira. */
                  const encorePossible = completementPossible(l, i);
                  return (
                    <Fragment key={i}>
                    <tr className={detaillePreparation && manque > 0
                      ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}>
                      <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">
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
                      {/* l'unité est elle-même un emballage, celui de contenance 1 */}
                      <td className="hidden sm:table-cell px-3 py-2.5 text-center text-gray-500">
                        {l.emballage ?? l.unite ?? 'unité'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">
                        {detaillePreparation ? l.quantiteDemandee : qte}
                      </td>
                      {detaillePreparation && (
                        <>
                          <td className={`px-3 py-2.5 text-center ${
                            dispo >= l.quantiteDemandee ? 'text-gray-500' : 'text-orange-500 font-medium'}`}>
                            {dispo}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className="inline-flex items-center gap-1.5">
                              <span className={`font-medium ${
                                manque > 0 ? 'text-orange-500' : 'text-gray-900 dark:text-gray-100'}`}>
                                {prepareLigne > 0 ? prepareLigne.toLocaleString('fr-FR') : '—'}
                              </span>
                              {/* Le détail des prélèvements : quand, combien, par qui. */}
                              {nbPrep > 0 && (
                                <button onClick={() => setDetailLigne(detailLigne === i ? null : i)}
                                  title="Voir les préparations"
                                  className={`shrink-0 rounded p-0.5 transition-colors ${
                                    detailLigne === i
                                      ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30'
                                      : 'text-gray-400 hover:bg-indigo-50 hover:text-indigo-600'}`}>
                                  <Info size={13} />
                                </button>
                              )}
                            </span>
                          </td>
                          <td className={`px-3 py-2.5 text-center ${
                            manque > 0 ? 'text-orange-500 font-bold' : 'text-gray-300 dark:text-gray-700'}`}>
                            {manque > 0 ? manque : '—'}
                          </td>
                        </>
                      )}
                      {montreArgent && <>
                        <td className="px-3 py-2.5 text-center text-gray-400">{formatMontant(l.valeurUnitaire)}</td>
                        <td className="px-3 py-2.5 text-center text-gray-900 dark:text-gray-100">
                          {formatMontant(l.prixVente ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 text-center font-bold text-gray-900 dark:text-gray-100">
                          {formatMontant(qte * (l.prixVente ?? 0))}
                        </td>
                      </>}
                      {/* Une préparation s'ajoute, elle ne s'écrase pas. Une fois
                          le dossier prêt, le compte est arrêté : plus d'action. */}
                      {enPreparation && (
                        /* Fond opaque : la cellule reste lisible quand les
                           colonnes défilent dessous. */
                        <td className="sticky right-0 border-l border-gray-100 bg-white px-3 py-2.5 dark:border-gray-800 dark:bg-gray-900">
                          {encorePossible > 0 && (
                            <div className="flex items-center justify-end gap-1.5">
                              {/* Le nombre est sur le bouton : on sait ce qu'il
                                  écrira sans avoir à l'ouvrir. */}
                              <button onClick={() => completer(i)} disabled={enCours}
                                className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                                <CheckCheck size={12} /> {encorePossible}
                              </button>
                              <button onClick={() => {
                                setLignePreparee(i); setQtePreparee(0); setNotePreparee('');
                              }}
                                title="Saisir une quantité"
                                className="flex items-center rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-bold text-gray-600 transition-colors hover:border-green-400 hover:bg-green-50 hover:text-green-700 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-green-900/20">
                                <Plus size={12} />
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                    {detailLigne === i && (
                      <tr>
                        <td colSpan={enPreparation ? 11 : 10} className="px-3 pb-3">
                          <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800/50">
                            <p className="mb-2 text-xs font-bold uppercase text-gray-400">Préparations</p>
                            <div className="flex flex-col gap-1.5">
                              {lignesPrep.map(x => (
                                <div key={x.id}
                                  className={`flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-1.5 text-xs dark:bg-gray-900 ${
                                    x.annulee ? 'opacity-50' : ''}`}>
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className={`font-bold ${
                                      x.annulee ? 'text-gray-400 line-through' : 'text-gray-900 dark:text-gray-100'}`}>
                                      {x.quantite.toLocaleString('fr-FR')}
                                    </span>
                                    <span className="text-gray-500">{formatDate(x.date)}</span>
                                    <span className="text-gray-400">{x.heure}</span>
                                    <span className="truncate text-gray-500">
                                      {x.utilisateurNom}
                                      {x.utilisateurFonction && x.utilisateurFonction !== x.utilisateurNom
                                        && <span className="ml-1 text-gray-400">· {x.utilisateurFonction}</span>}
                                    </span>
                                    {x.note && <span className="truncate text-gray-400">— {x.note}</span>}
                                  </span>
                                  {x.annulee ? (
                                    <span className="shrink-0 text-gray-400">Annulée</span>
                                  ) : enPreparation ? (
                                    <button onClick={() => annulerUnePreparation(x.id)} disabled={enCours}
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

          {erreur && <p className="text-xs text-red-500 mt-3">{erreur}</p>}

          {/* Tout ce bloc n'est que de l'argent : totaux, marge, versé, reste. */}
          {montreArgent && <div className="flex justify-end mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
            <div className="flex flex-col gap-1.5 text-sm min-w-[280px]">
              {/* Comment on est arrivé à ce total. Les lignes portent
                  déjà le prix d'après remise — ceci n'explique que le
                  chemin. Sans cette trace, relire la vente six mois plus
                  tard laisserait croire à un prix catalogue plus bas
                  qu'il n'était. */}
              {(vente.montants ?? []).length > 0 && (() => {
                const st = total + reductionDoc - fraisDoc;
                return (
                  <>
                    <LigneTotal label="Sous-total" valeur={formatMontant(st)}
                      classeValeur="text-gray-500" />
                    {(vente.montants ?? []).map((m, i) => (
                      <LigneTotal key={i}
                        label={m.libelle || LIBELLES_SENS[m.sens]}
                        valeur={`${m.sens === 'reduction' ? '−' : '+'}${formatMontant(valeurEnFrancs(m, st))}`}
                        classeValeur={m.sens === 'reduction'
                          ? 'font-medium text-red-500'
                          : 'font-medium text-indigo-600'} />
                    ))}
                  </>
                );
              })()}
              <LigneTotal label="Total" valeur={formatMontant(total)}
                classeValeur="font-bold text-gray-900 dark:text-gray-100" />
              {/* La marge n'est figée qu'à la livraison, au coût moyen de ce
                  jour-là : avant, ce n'est qu'une prévision. */}
              <LigneTotal label={vente.etat === 'livre' ? 'Marge' : 'Marge attendue'}
                valeur={formatMontant(marge)}
                classeValeur={`font-medium ${marge < 0 ? 'text-red-500' : 'text-green-600'}`} />
              {vente.etat !== 'devis' && (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-gray-400 shrink-0">Versé</span>
                    <span className="flex-1 border-b border-dotted border-gray-200 dark:border-gray-700" />
                    <span className="flex items-center gap-2 shrink-0">
                      {versements.length > 0 && (
                        <button onClick={() => setModalDetail(true)}
                          className="text-xs font-bold text-indigo-600 hover:underline">
                          Détail
                        </button>
                      )}
                      {peutVerser && (
                        <button onClick={() => setModalVersement(true)}
                          className="flex items-center gap-0.5 text-xs font-bold text-indigo-600 hover:underline">
                          <Plus size={11} /> {vente.etat === 'livre' ? 'Règlement' : 'Avance'}
                        </button>
                      )}
                      <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {formatMontant(verse)}
                      </span>
                    </span>
                  </div>
                  <LigneTotal label="Reste dû" valeur={formatMontant(reste)}
                    classeValeur={`font-bold ${reste > 0 ? 'text-orange-500' : 'text-green-600'}`} />
                </>
              )}
            </div>
          </div>}
        </div>

        {vente.note && (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
            <p className="text-xs font-bold text-gray-400 mb-1">Note</p>
            <p className="text-sm text-gray-700 dark:text-gray-300">{vente.note}</p>
          </div>
        )}
      </div>

      {/* Le trop-perçu revient au client : le garder en ferait une dette
          envers lui, or l'app gère une activité, pas des créances. */}
      {retour !== null && montreArgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-sm">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Retour en caisse</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              L'avance dépassait la valeur livrée. La différence de{' '}
              <span className="font-bold text-gray-900 dark:text-gray-100">{formatMontant(retour)}</span>{' '}
              revient au client.
            </p>
            <button onClick={() => setRetour(null)}
              className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl transition-colors">
              Compris
            </button>
          </div>
        </div>
      )}

      {modalTransformer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Transformer en commande</p>
              <button onClick={() => setModalTransformer(false)}
                className="p-1 text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Le client s'engage à prendre, nous à livrer. Les prix du devis
              sont repris tels quels.
            </p>
            <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">
              Livraison prévue
            </label>
            <div className="flex gap-2 mb-2">
              {/* On promet plus souvent un délai qu'une date : les deux
                  champs disent la même chose et se suivent. */}
              <ChampNombre valeur={delaiJours}
                onChange={n => {
                  setDelaiJours(n);
                  setLivraisonPrevue(n > 0 ? dansNJours(n) : '');
                }}
                className="w-20 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-center text-gray-900 dark:text-gray-100" />
              <span className="self-center text-xs text-gray-400 shrink-0">jours</span>
              <input type="date" value={livraisonPrevue} min={aujourdhui()}
                onChange={e => {
                  setLivraisonPrevue(e.target.value);
                  setDelaiJours(ecartJours(e.target.value));
                }}
                className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />
            </div>
            <p className="text-xs text-gray-400 mb-4">
              {livraisonPrevue
                ? 'Passé cette date, la commande sera signalée en retard.'
                : 'Facultatif : sans date, aucun retard ne sera signalé.'}
            </p>
            <button onClick={transformerEnCommande} disabled={enCours}
              className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
              {enCours ? 'Transformation…' : 'Créer la commande'}
            </button>
          </div>
        </div>
      )}

      {/* Prélever une quantité : elle s'ajoute aux précédentes. */}
      {lignePreparee !== null && vente && (() => {
        const l = vente.lignes[lignePreparee];
        const dejaPret = prepareParIdx[lignePreparee] ?? 0;
        const resteAFournir = Math.max(0, l.quantiteDemandee - dejaPret);
        /* Ce que le magasin contient, ce qui y est déjà promis, et ce qui
           reste vraiment. Le stock seul ne dit pas la vérité : il porte
           encore la marchandise que d'autres dossiers ont mise de côté. */
        const cleStock = l.varianteCle ? `${l.produitId}:${l.varianteCle}` : l.produitId;
        const enStock = stockDe(l);
        const enPreparation = reserve[cleStock] ?? 0;
        const dispo = Math.max(0, enStock - enPreparation);
        const maximum = completementPossible(l, lignePreparee);

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 dark:bg-gray-900">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Préparer</p>
                <button onClick={() => setLignePreparee(null)}
                  className="p-1 text-gray-400 hover:text-gray-600"><X size={16} /></button>
              </div>

              <p className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                {l.designation}
                {l.varianteLibelle && <span className="ml-1.5 text-gray-400">{l.varianteLibelle}</span>}
              </p>

              {/* Ce que le dossier attend, avant de saisir. */}
              <div className="mb-4">
                <div className="rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-800/60">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Le dossier
                  </p>
                  <div className="flex justify-between text-xs">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Commandé</span>
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {l.quantiteDemandee.toLocaleString('fr-FR')}
                      </span>
                    </span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Reste à fournir</span>
                      <span className={`font-bold ${
                        resteAFournir > 0 ? 'text-orange-500' : 'text-green-600'}`}>
                        {resteAFournir.toLocaleString('fr-FR')}
                      </span>
                    </span>
                  </div>
                </div>

              </div>

              <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
                Quantité
              </label>
              <ChampNombre valeur={qtePreparee}
                onChange={setQtePreparee} max={maximum}
                className="mb-3 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

              {/* Ce que le site peut fournir : il se lit juste après la
                  quantité, au moment où l'on se demande si elle passe. */}
                <div className="mb-3 rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-800/60">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Le site
                  </p>
                  <div className="flex justify-between gap-2 text-xs">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Stock</span>
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {enStock.toLocaleString('fr-FR')}
                      </span>
                    </span>
                    {/* Promis à d'autres dossiers : encore là, mais plus libre. */}
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">En préparation</span>
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {enPreparation.toLocaleString('fr-FR')}
                      </span>
                    </span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Disponible</span>
                      <span className={`font-bold ${
                        dispo > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-red-500'}`}>
                        {dispo.toLocaleString('fr-FR')}
                      </span>
                    </span>
                  </div>
                </div>
              <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
                Détail
              </label>
              <input value={notePreparee} onChange={e => setNotePreparee(e.target.value)}
                placeholder="Facultatif"
                className="mb-4 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

              <p className="mb-4 text-xs text-gray-400">Maximum {maximum.toLocaleString('fr-FR')}</p>

              <button onClick={ajouterPreparation} disabled={enCours || qtePreparee <= 0}
                className="w-full rounded-xl bg-indigo-600 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </div>
          </div>
        );
      })()}

      {/* Ce qu'on s'apprête à valider, ligne par ligne. Toujours montré :
          marquer prêt arrête la préparation, ce qui manque devient un
          non-livré assumé. */}
      {modalPret && vente && (() => {
        const lignes = vente.lignes.map((l, i) => {
          const prep = prepareParIdx[i] ?? 0;
          return { l, prep, manque: Math.max(0, l.quantiteDemandee - prep) };
        });
        const enManque = lignes.filter(x => x.manque > 0);
        const valeurManque = enManque.reduce(
          (n, x) => n + x.manque * (x.l.prixVente ?? 0), 0);
        const rienPrepare = lignes.every(x => x.prep === 0);

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl dark:bg-gray-900">
              <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Marquer prêt</p>
                <button onClick={() => setModalPret(false)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {/* Sans ecart, il n'y a rien a arbitrer : le detail par produit
                    ne ferait que repeter la commande. On demande alors une
                    simple confirmation, et on ne montre le tableau que quand
                    il y a une decision a prendre. */}
                {enManque.length === 0 ? (
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {vente.lignes.length} produit{vente.lignes.length > 1 ? 's' : ''} préparé{vente.lignes.length > 1 ? 's' : ''} en entier.
                    Le dossier passe en attente de livraison.
                  </p>
                ) : (
                  <>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-400">
                          <th className="pb-2 text-left font-medium">Produit</th>
                          <th className="pb-2 text-center font-medium">Commandé</th>
                          <th className="pb-2 text-center font-medium">Préparé</th>
                          <th className="pb-2 text-center font-medium">Manque</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                        {/* Seuls les produits en ecart : ceux qui sont complets
                            n'appellent aucune decision. */}
                        {enManque.map((x, i) => (
                          <tr key={i}>
                            <td className="py-2 text-gray-900 dark:text-gray-100">
                              {x.l.designation}
                              {x.l.varianteLibelle && <span className="ml-1.5 text-gray-400">{x.l.varianteLibelle}</span>}
                            </td>
                            <td className="py-2 text-center text-gray-500">
                              {x.l.quantiteDemandee.toLocaleString('fr-FR')}
                            </td>
                            <td className="py-2 text-center font-medium text-gray-900 dark:text-gray-100">
                              {x.prep.toLocaleString('fr-FR')}
                            </td>
                            <td className="py-2 text-center font-bold text-orange-500">
                              {x.manque.toLocaleString('fr-FR')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Ce qui manque ici ne se rattrapera plus : apres ce geste
                        la preparation est close. */}
                    <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                      {enManque.length} produit{enManque.length > 1 ? 's' : ''} en manque
                      {montreArgent ? `, soit ${formatMontant(valeurManque)}` : ''}.
                      {' '}Le client ne recevra que ce qui est préparé.
                    </p>
                  </>
                )}

                {rienPrepare && (
                  <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
                    Rien n'est préparé : le dossier serait prêt sans marchandise.
                  </p>
                )}
              </div>

              <div className="flex shrink-0 gap-2 border-t border-gray-100 px-5 py-4 dark:border-gray-800">
                <button onClick={() => setModalPret(false)}
                  className="flex-1 rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
                  Annuler
                </button>
                <button onClick={marquerPret} disabled={enCours || rienPrepare}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-white transition-colors disabled:opacity-40 ${
                    enManque.length > 0 ? 'bg-amber-600 hover:bg-amber-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                  {enCours ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                  {enManque.length > 0 ? 'Marquer prêt quand même' : 'Marquer prêt'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {modalVersement && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {vente.etat === 'livre' ? 'Nouveau règlement' : 'Nouvelle avance'}
              </p>
              <button onClick={() => setModalVersement(false)}
                className="p-1 text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>
            <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Montant</label>
            <ChampNombre valeur={nouveauVersement} onChange={setNouveauVersement} max={reste}
              className="w-full px-3 py-2 mb-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />
            <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Date</label>
            <input type="date" value={dateVersement} max={aujourdhui()}
              onChange={e => setDateVersement(e.target.value)}
              className="w-full px-3 py-2 mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100" />
            <p className="text-xs text-gray-400 mb-4">
              {vente.etat === 'livre'
                ? "La marchandise est livrée : ce versement éteint une dette."
                : "La marchandise n'est pas partie : cet argent est en dépôt."}
            </p>
            <button onClick={ajouterVersement} disabled={enCours || nouveauVersement <= 0}
              className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors">
              {enCours ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </div>
      )}

      {modalDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Versements</p>
              <button onClick={() => setModalDetail(false)}
                className="p-1 text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="text-center font-medium pb-2">Date</th>
                  <th className="text-center font-medium pb-2">Motif</th>
                  <th className="text-center font-medium pb-2">Montant</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {versements.map((v, i) => (
                  <tr key={i}>
                    <td className="py-2 text-center text-gray-500">{formatDate(v.date)}</td>
                    <td className="py-2 text-center text-gray-500">
                      {LIBELLES_MOTIF_VERSEMENT[v.motif] ?? 'Avance'}
                    </td>
                    <td className="py-2 text-center font-medium text-gray-900 dark:text-gray-100">
                      {formatMontant(v.montant)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Comment cette créance sera recouvrée : demandé au moment où elle
          naît, pas dans un écran où l'on ne revient pas. */}
      {aPlanifier != null && vente.clientId && (
        <ModalPlanification
          siteId={siteId}
          partenaireId={vente.clientId}
          partenaireNom={vente.clientNom}
          role="client"
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
                partenaireId: vente.clientId!,
                role: 'client', plan,
              });
            } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
          }}
        />
      )}
    </div>
  );
}
