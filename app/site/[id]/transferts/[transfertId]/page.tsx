'use client';
import { Fragment, useEffect, useState } from 'react';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { produitsDuSite } from '@/lib/produits-site';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite } from '@/lib/roles';
import {
  enregistrerReception, annulerReception, chargerReceptions, recuParLigne,
  type Reception,
} from '@/lib/receptions';
import { auteurCourant, auteurEtape } from '@/lib/auteur';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ChampNombre } from '@/components/Champs';
import BlocIdentite from '../../components/BlocIdentite';
import {
  ArrowLeft,
  Loader2, Check, ArrowDownLeft, Truck, AlertTriangle, ShieldCheck, Package,
  CheckCheck, Info, Plus, X, Download,
} from 'lucide-react';
import { exporterPdf } from '@/lib/export-pdf';
import { useEnteteSite } from '@/lib/use-entete-site';
import {
  Transfert, EtatTransfert, LIBELLES_TRANSFERT,
  ecartValeur, aUnEcart, lignesEnEcart, produitsEnEcart, confirmerTransfert,
  peutExpedier, peutRecevoir, peutArbitrerEcart, peutAnnulerTransfert, Role,
  libelleTransfert, valeurEnvoyee,
} from '@/lib/flux-marchandise';
import {
  estEnsemble, retourHistorique, retourOnglet, fermerEcran,
} from '@/lib/retour';
import { annulerOrdre } from '@/lib/ordre-transfert';
import { formatMontant } from '@/lib/format';



const COULEURS_ETAT: Record<EtatTransfert, string> = {
  en_cours:    'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  preparation: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400',
  expedie:     'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  recu:        'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  traitement:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  a_confirmer: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  confirme:    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  annule:      'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
};

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function FicheTransfertPage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  const transfertId = params.transfertId as string;
  const entetePdf = useEnteteSite(siteId, activite?.nom);

  const [transfert, setTransfert] = useState<Transfert | null>(null);
  const [loading, setLoading] = useState(true);
  /* Ce qui a été chargé et ce qui a été compté, déclaration par déclaration.
     Un fait s'enregistre : on ajoute ce qu'on constate, on n'écrase pas un
     total. Une erreur s'annule, elle ne se corrige pas en place. */
  const [receptions, setReceptions] = useState<Reception[]>([]);
  /* La ligne dont on regarde le détail des déclarations. */
  const [detailLigne, setDetailLigne] = useState<number | null>(null);
  /* Ce que la source détient, par produit et par variante : charger sans le
     voir reviendrait à promettre une marchandise qu'on n'a peut-être pas. */
  const [stocks, setStocks] = useState<Record<string, number>>({});
  /* Ce que ce compte a le droit de faire ici. Tant qu'on ne le sait pas, on
     ne permet rien : une garde qui s'ouvre par défaut ne garde rien.
     `'recouvrement'` tient lieu de rôle muet — il ne peut ni expédier, ni
     recevoir, ni arbitrer. */
  const [ROLE_COURANT, setRole] = useState<Role | null>('recouvrement');
  /* Qui répond de l'argent voit ce que le dossier déplace. Le responsable
     des commandes fait avancer des quantités : la valeur ne lui dit rien
     de ce qu'il a à faire, et l'écran la lui cacherait ailleurs. */
  const montreArgent = ROLE_COURANT !== 'commandes';

  /* L'admin de l'activité n'est désigné par aucun membre : `roleSurSite`
     lui rend `null`, qui vaut « tout permis ». */
  useEffect(() => {
    if (!user || !siteId) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(r => setRole(r as Role | null))
      .catch(() => setRole('recouvrement'));
  }, [user, siteId, activite?.adminUid]);
  /* La ligne dont on saisit une quantité partielle, et ce qu'on y écrit.
     La saisie se fait dans la ligne, pas dans une fenêtre : un transfert
     porte autant de produits qu'un conteneur, et ouvrir puis fermer un
     modal à chacun triple les gestes. */
  const [ligneSaisie, setLigneSaisie] = useState<number | null>(null);
  const [qteSaisie, setQteSaisie] = useState(0);
  /* La ligne en train de s'écrire : elle seule montre qu'elle travaille.
     Lever `enCours` (l'état de tout le dossier) grisait l'écran entier et
     le faisait clignoter à chaque quantité ajoutée. */
  const [ligneEnCours, setLigneEnCours] = useState<number | null>(null);
  /* Le suivi du comptage : filtrer les lignes par leur état face à
     l'attendu. Réservé à l'admin — pour les autres, voir l'état d'une ligne
     reviendrait à voir l'attendu qu'on leur masque. */
  const [filtreEcart, setFiltreEcart] =
    useState<'tout' | 'conforme' | 'moins' | 'surplus' | 'attente'>('tout');
  const [noteArbitrage, setNoteArbitrage] = useState('');
  /* Le modal d'arbitrage : quand l'admin arrête des comptes qui divergent,
     on ne refuse pas en silence — on lui montre l'écart et on lui demande
     s'il veut clore là-dessus. */
  const [modalEcart, setModalEcart] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => { charger(); }, [transfertId]);

  async function charger() {
    setLoading(true);
    const snap = await getDoc(doc(db, 'transferts', transfertId));
    if (snap.exists()) {
      const t = { id: snap.id, ...snap.data() } as Transfert;
      setTransfert(t);
      setReceptions(await chargerReceptions(transfertId));

      /* Le stock de la source : on ne charge pas à l'aveugle. Celui qui
         rassemble doit voir ce dont il dispose — promettre vingt cartons
         quand il en reste trois se découvre au quai, pas avant.
         C'est le stock de l'expéditeur qui compte, jamais celui d'ici : le
         destinataire, lui, ne charge rien. */
      produitsDuSite(t.siteSourceId)
        .then(liste => {
          const parCle: Record<string, number> = {};
          for (const p of liste) {
            parCle[p.id] = p.stock ?? 0;
            /* une variante porte son propre stock */
            (p.variantes ?? []).forEach((v: any) => {
              parCle[`${p.id}:${v.cle}`] = v.stock ?? 0;
            });
          }
          setStocks(parCle);
        })
        .catch(() => setStocks({}));
    }
    setLoading(false);
  }

  /* Ce que chaque côté a déclaré, ligne par ligne. */
  const declareExp = recuParLigne(receptions, 'expedition');
  const declareRec = recuParLigne(receptions, 'reception');

  /* Les lignes réellement comptées à la réception : une déclaration active
     existe. Une somme à zéro ne distingue pas « rien reçu » de « rien
     compté » — la présence d'une déclaration, si. */
  const lignesComptees_ = new Set(
    receptions
      .filter(r => !r.annulee && (r.etape ?? 'reception') === 'reception')
      .map(r => r.ligneIndex));

  /* Le reçu réel d'une ligne, pour l'affichage — jamais une invention.
   *
     D'abord le champ figé sur la ligne (les transferts confirmés après la
     correction le portent). Sinon le comptage qui vit dans `receptions`,
     déjà chargé à l'écran : la quantité que l'employé a réellement
     constatée. Jamais comptée → null, affiché « — ». On ne retombe jamais
     sur l'expédié : ce serait inventer un reçu. */
  function recuReel(l: Transfert['lignes'][number], i: number): number | null {
    if (l.quantiteRecue != null) return l.quantiteRecue;
    if (lignesComptees_.has(i)) return declareRec[i] ?? 0;
    return null;
  }

  /* Clore fige les quantités sur celles qui ont été déclarées. Sans
     déclaration, on figerait zéro partout : un transfert de vingt cartons
     deviendrait vingt cartons perdus, et l'écart accuserait l'expéditeur
     d'une marchandise que personne n'a regardée. */
  const aDeclareExp = Object.values(declareExp).some(n => n > 0);
  const aDeclareRec = Object.values(declareRec).some(n => n > 0);

  /* La colonne Reçu ne montre que ce qui a été compté. Avant l'expédition
     rien n'est parti ; en route, personne n'a encore ouvert les cartons.
     Elle apparaît quand le comptage commence, c'est-à-dire une fois
     l'arrivée actée. */
  const aExpedie = transfert != null
    && transfert.etat !== 'en_cours' && transfert.etat !== 'preparation'
    /* En route, rien n'est compté ; arrivé mais pas encore traité non plus,
       puisque les cartons sont fermés. */
    && transfert.etat !== 'expedie' && transfert.etat !== 'recu';

  /* La déconnexion vide l'utilisateur avant que la navigation aboutisse :
     tout ce qui lit son identifiant tomberait sur du vide. */
  if (!user) return null;

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!transfert) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Transfert introuvable.</p>
    </div>
  );

  /* Le proprietaire est aux deux bouts.
   *
   * Un transfert se pilote depuis le site qu'on regarde : la source
   * rassemble et charge, la destination accuse et compte. Cette
   * position se lisait du seul `siteId` de l'adresse — or le
   * proprietaire n'ouvre pas le dossier depuis un site, il l'ouvre
   * depuis la vue d'ensemble, ou depuis l'un des deux sites qu'il
   * possede tous les deux. Il se retrouvait donc etranger a l'un des
   * bouts, et tous les boutons tombaient : le camion restait en route
   * parce que personne, de son point de vue, ne pouvait l'accueillir.
   *
   * Lui donner les deux cotes ne lui montre pas deux jeux de boutons :
   * chaque garde teste aussi l'etat, et un etat n'appartient jamais
   * qu'a un seul cote. */
  const estAdmin = ROLE_COURANT === null;
  const estSource = estAdmin || transfert.siteSourceId === siteId;
  const estDest = estAdmin || transfert.siteDestId === siteId;
  const ecart = ecartValeur(transfert.lignes);
  const enEcart = lignesEnEcart(transfert.lignes);

  /* L'export PDF du transfert. Titre = libellé d'état de l'app, selon le
     point de vue (envoi ou réception). */
  function telechargerPdf() {
    const t = transfert!;
    const sensVu: 'envoi' | 'reception' =
      t.siteDestId === siteId && !estSource ? 'reception' : 'envoi';
    exporterPdf({
      titre: libelleTransfert(t.etat, sensVu),
      reference: t.reference,
      entete: entetePdf,
      infos: [
        { libelle: 'Trajet', valeur: `${t.siteSourceNom ?? '—'} → ${t.siteDestNom ?? '—'}` },
        { libelle: 'Initié le', valeur: formatDate(t.dateInitiation) },
      ],
      colonnes: ['Produit', 'Demandé', 'Expédié', 'Reçu'],
      alignements: ['left', 'center', 'center', 'center'],
      lignes: t.lignes.map(l => ({
        cellules: [
          l.designation + (l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''),
          /* L'emballage (carton, sac…), comme sur la fiche. */
          `${l.quantiteDemandee} ${l.emballage ?? l.unite ?? 'unité'}`.trim(),
          l.quantiteExpediee != null ? String(l.quantiteExpediee) : '—',
          l.quantiteRecue != null ? String(l.quantiteRecue) : '—',
        ],
      })),
      totaux: montreArgent
        ? [{ libelle: 'Valeur transférée', valeur: formatMontant(valeurEnvoyee(t.lignes)), fort: true }]
        : [],
      note: t.note ?? null,
    });
  }

  /* Un transfert d'ordre ne se pilote pas d'ici.
   *
   * Il naît avec un bon de commande chez la source, et c'est ce bon qui
   * le fait avancer : la marchandise ne voyage pas — le client l'emporte
   * depuis la source — donc il n'y a ni colis à charger ni carton à
   * compter à l'arrivée. Laisser ses boutons permettait de l'expédier
   * ou de le recevoir à la main, et il partait alors dans un état que
   * les deux autres dossiers ne connaissaient pas. */
  const suitUnOrdre = (transfert as any).ordre === true;

  /* La source rassemble puis charge — elle ne déclare pas ce qu'elle n'a pas
     vu arriver. Le destinataire compte — il ne dit pas qu'un colis est parti. */
  const peutPreparerIci = !suitUnOrdre && transfert.etat === 'en_cours' && estSource
    && peutExpedier(ROLE_COURANT);
  const peutExpedierIci = !suitUnOrdre && transfert.etat === 'preparation' && estSource
    && peutExpedier(ROLE_COURANT);
  /* Deux gestes, pas un. Tant que la marchandise est en route, il n'y a
     rien à compter : on ne déclare pas les quantités d'un camion qui roule.
     Le destinataire acte d'abord l'arrivée, puis il compte ce qui est dans
     les cartons. */
  const peutAccuserIci = !suitUnOrdre && transfert.etat === 'expedie' && estDest
    && peutRecevoir(ROLE_COURANT);
  /* On ne traite que ce qui est arrivé : la réception ouvre le traitement,
     et c'est là seulement qu'on ouvre les cartons pour compter. */
  const peutTraiterIci = !suitUnOrdre && transfert.etat === 'recu' && estDest
    && peutRecevoir(ROLE_COURANT);
  const peutRecevoirIci = !suitUnOrdre && transfert.etat === 'traitement' && estDest
    && peutRecevoir(ROLE_COURANT);

  /* Le stock de la source se montre tant que la marchandise est chez elle :
     on rassemble, puis on charge. Une fois le camion parti, ce stock a
     bougé pour d'autres raisons et ne dit plus rien de ce dossier.
     Il s'adresse à la source : le destinataire ne puise pas dedans. */
  /* Ce que le receveur ne doit pas voir.
   *
     Celui qui recoit compte a l'aveugle : s'il voit ce qui etait demande
     et expedie, il peut declarer ces chiffres au lieu de compter ce qui
     est reellement arrive. Un ecart ne se verrait plus, et le controle
     n'aurait plus d'objet.
   *
     Cela vise le site destinataire — gerant comme responsable des
     commandes — et jamais le proprietaire, qui repond des deux bouts et
     doit voir l'ecart pour l'arbitrer. L'expediteur voit tout aussi :
     c'est lui qui annonce et charge. */
  const cacheAttendu = estDest && !estAdmin && !estSource;

  /* La colonne Écart se montre à qui connaît l'attendu (jamais au receveur
     masqué), une fois que le comptage existe : figé en « à confirmer » et
     « confirmé », vivant en traitement pour l'admin qui suit. */
  const montreEcart = !cacheAttendu && (
    transfert.etat === 'a_confirmer' || transfert.etat === 'confirme'
    || (transfert.etat === 'traitement' && estAdmin));

  const montreStock = estSource
    && (transfert.etat === 'en_cours' || transfert.etat === 'preparation');

  /** Stock disponible pour une ligne : celui de la variante s'il y en a une. */
  function stockDe(l: { produitId: string; varianteCle?: string | null }): number {
    return stocks[l.varianteCle ? `${l.produitId}:${l.varianteCle}` : l.produitId] ?? 0;
  }

  /* un accord se confirme seul ; un écart attend un tiers sans intérêt dans le litige */
  /* Arrêter les comptes : dès la réception si tout concorde, après arbitrage
     sinon. Au bout, le dossier n'attend plus que d'être clos. */
  /* Ce que vaudraient les lignes si on figeait le comptage maintenant. Le
     bouton s'en sert pour annoncer ce qu'il fera — confirmer ou envoyer en
     confirmation — avant qu'on le clique. */
  const lignesComptees = transfert.lignes.map((l, i) => ({
    ...l, quantiteRecue: declareRec[i] ?? l.quantiteRecue ?? 0,
  }));

  /* Clore le traitement. Sans écart, les comptes concordent et le dossier
     est confirmé ; avec un écart, il attend la confirmation d'un tiers qui
     n'a pas d'intérêt dans le litige. */
  const peutArreterIci = transfert.etat === 'traitement'
    && (!aUnEcart(lignesComptees) || peutArbitrerEcart(ROLE_COURANT));

  /* La confirmation applique le stock : elle ferme un dossier dont plus
     personne ne discute les comptes.
   *
     Un dossier arrive en « a confirmer » quand le receveur a trouve un
     ecart : c'est l'arbitrage d'un tiers qui n'a pas compte. Seul le
     proprietaire tranche — celui qui a declare l'ecart ne le valide pas
     lui-meme, sinon le second regard n'existe pas. */
  const peutConfirmerIci = transfert.etat === 'a_confirmer'
    && peutArbitrerEcart(ROLE_COURANT);

  /* Rien n'est appliqué au stock avant la confirmation : jusque-là, un
     comptage erroné doit pouvoir être repris par celui qui l'a déclaré. */
  const peutModifier = (transfert.etat === 'recu' || transfert.etat === 'traitement')
    && estDest;

  /* Rassembler n'est pas charger : entre les deux, la marchandise est encore
     ici, et le dossier doit le dire. */
  async function preparer() {
    setEnCours(true); setErreur('');
    try {
      await updateDoc(doc(db, 'transferts', transfertId), { etat: 'preparation' });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* L'étape que les déclarations alimentent, selon où en est le dossier :
     la source charge avant l'expédition, le destinataire compte après. */
  const etapeCourante: 'expedition' | 'reception' =
    (transfert?.etat === 'en_cours' || transfert?.etat === 'preparation')
      ? 'expedition' : 'reception';

  /**
   * L'état d'une ligne face à l'attendu, pour le suivi du comptage.
   *
   * « À compter » tant que rien n'est déclaré : une ligne vide ne manque
   * pas, elle attend — les confondre ferait paraître tout le dossier
   * incomplet dès son ouverture. Ensuite : conforme si le compte tombe
   * juste, en moins ou en surplus sinon. On lit le compte vivant de
   * l'étape courante, pas la quantité figée : le suivi sert pendant qu'on
   * compte, pas une fois les comptes arrêtés.
   */
  function etatLigne(i: number): 'conforme' | 'moins' | 'surplus' | 'attente' {
    const l = transfert!.lignes[i];
    const attendu = etapeCourante === 'expedition'
      ? l.quantiteDemandee
      : (l.quantiteExpediee ?? l.quantiteDemandee);
    const trouve = (etapeCourante === 'expedition' ? declareExp : declareRec)[i] ?? 0;
    if (trouve === 0) return 'attente';
    if (trouve === attendu) return 'conforme';
    return trouve > attendu ? 'surplus' : 'moins';
  }

  const parEtatLigne = transfert.lignes.reduce((acc, _l, i) => {
    acc[etatLigne(i)]++;
    return acc;
  }, { conforme: 0, moins: 0, surplus: 0, attente: 0 } as Record<string, number>);

  /* Le suivi n'est ouvert qu'à l'admin : lui seul voit l'attendu, donc lui
     seul peut lire un écart sans qu'on le lui souffle. Et seulement quand il
     y a quelque chose à suivre — on ne filtre pas un dossier qu'on n'est pas
     en train de compter. */
  const suiviOuvert = estAdmin
    && (etapeCourante === 'reception'
      ? (transfert.etat === 'traitement' || transfert.etat === 'a_confirmer')
      : transfert.etat === 'preparation');

  /* Ce que le filtre laisse passer. L'index d'origine voyage avec la ligne :
     tout l'écran s'y réfère — réceptions, champs, boutons. Le perdre en
     filtrant ferait saisir sur la mauvaise ligne. */
  const lignesFiltrees = transfert.lignes
    .map((l, i) => ({ l, i }))
    .filter(({ i }) => !suiviOuvert || filtreEcart === 'tout'
      || etatLigne(i) === filtreEcart);

  /**
   * Compléter une ligne, ou toutes.
   *
   * Un fait s'enregistre : on ajoute ce qu'on constate, on n'écrase pas un
   * total. Ce qui manque à la ligne se déduit de ce qui a déjà été déclaré.
   */
  async function completer(ligneIndex: number | null) {
    /* Une écriture en cours n'a pas encore rafraîchi l'affichage : le bouton
       montre toujours l'ancien reste. Sans cette garde, deux clics rapides
       déclarent deux fois la même chose. */
    if (!transfert || enCours || ligneEnCours != null) return;
    const deja = recuParLigne(receptions, etapeCourante);
    const attendu = (l: any, i: number) => etapeCourante === 'expedition'
      ? l.quantiteDemandee
      : (l.quantiteExpediee ?? l.quantiteDemandee);

    const aEcrire: { i: number; quantite: number }[] = [];
    transfert.lignes.forEach((l, i) => {
      if (ligneIndex != null && i !== ligneIndex) return;
      const manque = attendu(l, i) - (deja[i] ?? 0);
      if (manque > 0) aEcrire.push({ i, quantite: manque });
    });
    if (aEcrire.length === 0) return;

    /* « Tout » sur une ligne ne doit pas plus faire clignoter l'écran que
       la saisie d'une quantité : même geste, même discrétion. Un « tout
       recevoir » global (ligneIndex null) touche en revanche tout le
       dossier — là, l'attente visible de tous les boutons est juste. */
    const global = ligneIndex == null;
    if (global) setEnCours(true); else setLigneEnCours(ligneIndex!);
    setErreur('');
    try {
      /* Le site qui déclare n'est pas le même des deux côtés : l'auteur se
         lit là où la personne travaille. */
      const siteDeclarant = etapeCourante === 'expedition'
        ? transfert.siteSourceId : transfert.siteDestId;
      const auteur = await auteurCourant(siteDeclarant, user!.uid);
      const date = aujourdhui();
      const heure = new Date().toTimeString().slice(0, 5);
      const ecrites = await Promise.all(aEcrire.map(async ({ i, quantite }) => {
        const l = transfert.lignes[i];
        const saisie = {
          siteId: siteDeclarant,
          documentId: transfertId,
          ligneIndex: i,
          etape: etapeCourante,
          produitId: l.produitId ?? null,
          designation: l.designation,
          quantite,
          date,
          utilisateur: user!.uid,
          utilisateurNom: auteur.utilisateurNom,
          utilisateurFonction: auteur.utilisateurFonction,
          note: null,
        };
        const id = await enregistrerReception(saisie);
        return { ...saisie, id, annulee: false, heure } as Reception;
      }));
      /* On ajoute ce qu'on vient d'écrire au lieu de tout relire : un geste
         sur une ligne ne doit pas rejouer tout le dossier. */
      setReceptions(prev => [...ecrites, ...prev]);
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec.');
      setReceptions(await chargerReceptions(transfertId).catch(() => receptions));
    }
    finally { if (global) setEnCours(false); else setLigneEnCours(null); }
  }

  /* Une quantité partielle : ce qui arrive en deux fois se déclare en deux
     fois, et chaque déclaration reste un fait daté.
   *
   * Sans que l'écran tressaille. On ne lève pas `enCours` — l'état de tout
   * le dossier — et on ne recharge pas le transfert entier avec ses
   * dizaines de réceptions pour en apprendre une seule, déjà connue. Seule
   * la ligne qui s'écrit montre qu'elle travaille, et la réception rejoint
   * la liste telle qu'on vient de l'écrire. */
  async function declarer() {
    if (ligneSaisie === null || qteSaisie <= 0 || !transfert
      || ligneEnCours != null) return;
    const i = ligneSaisie;
    const quantite = qteSaisie;

    /* On ne charge pas plus que le dossier ne demande : expédier au-delà,
       c'est modifier la commande sans le dire. Recevoir plus, en revanche,
       se constate — c'est un fait, pas une décision. */
    if (etapeCourante === 'expedition') {
      const reste = transfert.lignes[i].quantiteDemandee - (declareExp[i] ?? 0);
      if (quantite > reste) {
        setErreur(`Au plus ${reste} à charger sur cette ligne.`);
        return;
      }
    }

    /* Le champ se referme tout de suite : on passe au produit suivant
       pendant que celui-ci s'inscrit. */
    setLigneSaisie(null); setQteSaisie(0);
    setLigneEnCours(i); setErreur('');
    try {
      const siteDeclarant = etapeCourante === 'expedition'
        ? transfert.siteSourceId : transfert.siteDestId;
      const auteur = await auteurCourant(siteDeclarant, user!.uid);
      const l = transfert.lignes[i];
      const saisie = {
        siteId: siteDeclarant,
        documentId: transfertId,
        ligneIndex: i,
        etape: etapeCourante,
        produitId: l.produitId ?? null,
        designation: l.designation,
        quantite,
        date: aujourdhui(),
        utilisateur: user!.uid,
        utilisateurNom: auteur.utilisateurNom,
        utilisateurFonction: auteur.utilisateurFonction,
        note: null,
      };
      const id = await enregistrerReception(saisie);
      /* Ajoutée à la main plutôt que relue : on sait exactement ce qu'on
         vient d'écrire. */
      setReceptions(prev => [{
        ...saisie, id, annulee: false,
        heure: new Date().toTimeString().slice(0, 5),
      } as Reception, ...prev]);
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec.');
      /* L'écriture a échoué : on relit les seules réceptions, pour que
         l'écran dise la base et non ce qu'on espérait. */
      setReceptions(await chargerReceptions(transfertId).catch(() => receptions));
    }
    finally { setLigneEnCours(null); }
  }

  /* Une déclaration fausse s'annule, elle ne se réécrit pas : elle reste
     lisible, barrée, et cesse de compter. */
  async function annulerDeclaration(id: string) {
    /* Annuler ne touche qu'une réception : on la barre sur place et on
       relit les seules réceptions, sans redessiner tout le dossier. */
    setErreur('');
    try {
      await annulerReception({ receptionId: id, par: user!.uid });
      setReceptions(prev => prev.map(r =>
        r.id === id ? { ...r, annulee: true } : r));
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec.');
      setReceptions(await chargerReceptions(transfertId).catch(() => receptions));
    }
  }

  /* Le plafond s'applique à la frappe, pas après.
   *
   * À l'expédition, on ne charge pas plus que le dossier ne demande :
   * laisser taper un nombre qu'on refuserait ensuite oblige à l'effacer.
   * À la réception, rien ne plafonne — recevoir plus se constate, c'est
   * un fait et non une décision. */
  function capQte(n: number, i: number): number {
    if (etapeCourante !== 'expedition') return n;
    const reste = transfert!.lignes[i].quantiteDemandee - (declareExp[i] ?? 0);
    return Math.min(n, Math.max(0, reste));
  }

  async function expedier() {
    /* Un bouton caché n'est pas une règle : la garde tient aussi ici. */
    if (!aDeclareExp) { setErreur('Chargez la marchandise avant d\'expédier.'); return; }
    setEnCours(true); setErreur('');
    try {
      /* Les quantités se figent ici : elles viennent des déclarations, jamais
         d'une saisie. C'est le départ qui arrête le compte. */
      const charge = recuParLigne(receptions, 'expedition');
      const lignes = transfert!.lignes.map((l, i) => ({ ...l, quantiteExpediee: charge[i] ?? 0 }));
      await updateDoc(doc(db, 'transferts', transfertId), {
        etat: 'expedie', lignes,
        dateExpedition: aujourdhui(), parExpedition: user!.uid,
      });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* Le camion est là : on acte son arrivée, et rien de plus. Aucune
     quantité n'est figée — personne n'a encore ouvert les cartons.
     C'est cette réception qui autorise à ouvrir le traitement. */
  async function accuserArrivee() {
    if (!transfert || enCours) return;
    setEnCours(true); setErreur('');
    try {
      await updateDoc(doc(db, 'transferts', transfertId), {
        etat: 'recu',
        dateReception: aujourdhui(), parReception: user!.uid,
        auteurReception: await auteurEtape(transfert!.siteDestId, user!.uid),
      });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* Trancher n'est pas clore : l'arbitre arrête les comptes, et le dossier
     attend encore la main qui applique le stock. Deux gestes, parce qu'entre
     les deux plus personne ne discute mais rien n'a bougé. */
  /* Ouvrir les cartons : la marchandise est là, on passe au comptage. */
  async function ouvrirTraitement() {
    if (!transfert || enCours) return;
    setEnCours(true); setErreur('');
    try {
      await updateDoc(doc(db, 'transferts', transfertId), { etat: 'traitement' });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* Les comptes figés sur ce qui a été déclaré pendant le traitement. */
  function lignesArretees() {
    const compte = recuParLigne(receptions, 'reception');
    return transfert!.lignes.map(
      (l, i) => ({ ...l, quantiteRecue: compte[i] ?? 0 }));
  }

  /**
   * Le geste « Confirmer » depuis le traitement : il décide quoi faire.
   *
   *  - Tout concorde → on confirme, le stock entre.
   *  - Un écart, et c'est l'admin qui arrête (il arbitre) → on ouvre le
   *    modal : on lui montre ce qui manque ou dépasse, et on lui demande
   *    s'il veut clore là-dessus. Ne pas refuser en silence parce qu'une
   *    ligne n'a pas été reçue : un manque est un résultat valide.
   *  - Un écart, et c'est le receveur qui arrête → le dossier part en
   *    « à confirmer », explication obligatoire, et c'est un tiers qui
   *    tranchera.
   */
  async function arreterComptes() {
    if (!transfert || enCours) return;
    if (!aDeclareRec) {
      setErreur("Comptez la marchandise avant d'arrêter les comptes.");
      return;
    }
    const lignes = lignesArretees();
    const ecarte = aUnEcart(lignes);

    if (!ecarte) {
      await appliquerArret(lignes, null);
      return;
    }

    /* L'admin arbitre : on lui demande de confirmer l'écart dans un modal,
       plutôt que de le renvoyer à un tiers. Les autres n'arbitrent pas —
       ils expliquent, et le dossier attend le second regard. */
    if (peutArbitrerEcart(ROLE_COURANT)) {
      setErreur('');
      setModalEcart(true);
      return;
    }

    if (!noteArbitrage.trim()) {
      setErreur("Un écart doit être expliqué avant d'être arrêté.");
      return;
    }
    setEnCours(true); setErreur('');
    try {
      await updateDoc(doc(db, 'transferts', transfertId), {
        etat: 'a_confirmer', lignes,
        noteArbitrage: noteArbitrage.trim() || null,
      });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* Clore le dossier et faire entrer le stock, écart arbitré ou comptes
     justes. Appelé directement quand tout concorde, et depuis le modal
     quand l'admin a confirmé l'écart. */
  async function appliquerArret(lignes: Transfert['lignes'], note: string | null) {
    setEnCours(true); setErreur('');
    try {
      await confirmerTransfert({
        transfert: { ...transfert!, lignes },
        userId: user!.uid, par: user!.uid,
        roleSite: ROLE_COURANT,
        noteArbitrage: note,
        ...(await auteurCourant(transfert!.siteDestId, user!.uid, user!.displayName)),
      });
      setModalEcart(false);
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function confirmer() {
    /* L'explication a été donnée en arrêtant les comptes : la redemander ici
       bloquerait un dossier que plus personne ne discute. */
    setEnCours(true); setErreur('');
    try {
      await confirmerTransfert({
        transfert: transfert!, userId: user!.uid, par: user!.uid,
        noteArbitrage: transfert!.noteArbitrage ?? (noteArbitrage.trim() || null),
        roleSite: ROLE_COURANT,
        ...(await auteurCourant(transfert!.siteSourceId, user!.uid, user!.displayName)),
      });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function annuler() {
    /* La garde tient aussi ici : cacher le bouton ne protège que l'écran,
       et la fonction reste appelable par d'autres chemins. */
    if (!peutAnnulerTransfert(ROLE_COURANT)) return;
    setEnCours(true); setErreur('');
    try {
      /* Un transfert qui sert une commande n'est pas seul : le bon de la
         source et la commande du client sont nés avec lui et n'ont pas
         d'existence sans lui. L'annuler ici les annule tous les trois —
         sinon le destinataire garderait une créance sur une marchandise
         que plus personne n'enverra. */
      const lien = (transfert as any).ordreLien;
      if (lien) {
        await annulerOrdre({ lien, userId: user!.uid, date: aujourdhui() });
      } else {
        await updateDoc(doc(db, 'transferts', transfertId), { etat: 'annule' });
      }
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* L'adresse de repli, en un seul endroit : les deux boutons de
     fermeture portaient chacun leur copie de ce calcul. */
  const fermer = (() => {
    const de = searchParams.get('de');
    const base = estEnsemble(searchParams) ? '/ensemble' : `/site/${siteId}`;
    if (de === 'historique' || de === 'ensemble-historique') {
      return `${base}${retourHistorique(searchParams)}`;
    }
    /* La vue quittée revient avec nous : on avait ouvert ce dossier
       depuis une étape ou un statut précis. */
    return `${base}${retourOnglet('transferts', searchParams)}`;
  })();

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
            <div className="flex items-start gap-2">
              {/* La flèche ne paraît que sur téléphone : au bureau,
                  « Fermer » reste plus clair qu'un chevron isolé. */}
              <button onClick={() => fermerEcran(router, fermer)}
                title="Fermer"
                className="-ml-1 shrink-0 rounded-xl p-2 text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 sm:hidden">
                <ArrowLeft size={18} />
              </button>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-lg font-bold text-gray-900 dark:text-gray-100">{transfert.reference}</h1>
                  {(transfert as any).ordre === true && (
                    <span title={`À remettre à ${(transfert as any).ordrePartenaireNom ?? 'un client'}`}
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                      O
                    </span>
                  )}
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${COULEURS_ETAT[transfert.etat]}`}>
                    {libelleTransfert(transfert.etat, estDest ? 'reception' : 'envoi')}
                  </span>
                </div>
                {/* D'où part la marchandise et où elle va : c'est ce qui
                    distingue deux transferts du même jour. */}
                <p className="mt-0.5 truncate text-xs text-gray-400">
                  {transfert.siteSourceNom} → {transfert.siteDestNom}
                </p>
              </div>
            </div>

          {/* Les actions : en ligne au bureau, étirées en pleine largeur
              sur téléphone où le pouce ne vise pas. */}
          <div className="mt-2.5 flex gap-2 [&>button]:flex-1 [&>button]:justify-center sm:mt-0 sm:[&>button]:flex-none">
            {/* On revient d'où l'on vient : l'historique mène aussi ici. */}
            <button onClick={() => fermerEcran(router, fermer)}
              className="hidden px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors sm:block">
              Fermer
            </button>
            {transfert.etat !== 'annule' && (
              <button onClick={telechargerPdf}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800 rounded-xl transition-colors">
                <Download size={14} /> PDF
              </button>
            )}
            {/* « Annuler le transfert », jamais « Annuler » : ici l'action détruit le dossier. */}
            {(transfert.etat === 'en_cours' || transfert.etat === 'preparation'
              || transfert.etat === 'expedie') && peutAnnulerTransfert(ROLE_COURANT) && (
              <button onClick={annuler} disabled={enCours}
                className="px-4 py-2 text-sm font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 rounded-xl transition-colors">
                Annuler le transfert
              </button>
            )}
            {peutPreparerIci && (
              <button onClick={preparer} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />} Préparer
              </button>
            )}
            {peutExpedierIci && (
              <button onClick={expedier} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Truck size={14} />} Expédier
              </button>
            )}
            {peutAccuserIci && (
              <button onClick={accuserArrivee} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownLeft size={14} />} Déclarer reçu
              </button>
            )}
            {peutTraiterIci && (
              <button onClick={ouvrirTraitement} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />} Traiter
              </button>
            )}
            {peutArreterIci && (
              <button onClick={arreterComptes} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirmer
              </button>
            )}
            {peutConfirmerIci && (
              <button onClick={confirmer} disabled={enCours}
                className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirmer
              </button>
            )}
          </div>
          </div>
        </div>
      </header>

      <div className="w-full p-4 sm:p-6 lg:p-8">

        {/* Replie, le dossier se nomme par son trajet : c'est ce qui le
            distingue des autres du jour. */}
        <BlocIdentite
          nom={`${transfert.siteSourceNom} → ${transfert.siteDestNom}`}
          lignes={transfert.lignes.length} className="mb-4">
          {/* Sur un téléphone, ces cases se rangeaient deux par deux, chacune
              avec son libellé au-dessus de sa valeur : cinq cases faisaient
              trois rangées, et deux d'entre elles ne disaient rien — un
              transfert qui n'est pas parti n'a ni date d'expédition ni date
              de réception. Elles se lisent donc en lignes, le libellé devant
              sa valeur, et les étapes non atteintes se taisent.
              Le trajet et le volume n'étaient que dans l'en-tête, qui
              disparaît au défilement : ils restent ici. */}
          <div className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3 sm:gap-2 lg:grid-cols-5">
            {([
              /* Un site ne lit que l'autre bout : il sait ou il est, il
                 veut savoir d'ou ca vient ou ou ca va. Le proprietaire
                 n'est a aucun des deux et aux deux a la fois : lui doit
                 lire le trajet entier, sinon la case nomme un site sans
                 dire lequel des deux. */
              ...(estAdmin
                ? [['Trajet',
                    `${transfert.siteSourceNom} → ${transfert.siteDestNom}`]]
                : [[transfert.siteSourceId === siteId ? 'Destination' : 'Origine',
                    transfert.siteSourceId === siteId
                      ? transfert.siteDestNom : transfert.siteSourceNom]]),
              /* À qui la marchandise est destinée, quand ce transfert
                 sert une commande. Sans ce nom, le responsable lisait
                 deux sites et devait deviner laquelle des commandes du
                 jour il avait sous les yeux. */
              ...((transfert as any).ordrePartenaireNom
                ? [['À remettre à', (transfert as any).ordrePartenaireNom]]
                : []),
              ['Produits',
                `${transfert.lignes.length} ligne${transfert.lignes.length > 1 ? 's' : ''}`],
              ['Initié', formatDate(transfert.dateInitiation)],
              /* Une étape qu'on n'a pas franchie n'a pas de date : la taire
                 vaut mieux qu'un tiret, qui occupe la place d'un fait pour
                 dire qu'il n'y en a pas. */
              ...(transfert.dateExpedition
                ? [['Transféré', formatDate(transfert.dateExpedition)]] : []),
              ...(transfert.dateReception
                ? [['Reçu', formatDate(transfert.dateReception)]] : []),
            ] as [string, string][]).map(([label, valeur]) => (
              /* Deux par ligne : le libellé reste au-dessus de sa valeur,
                 car en demi-largeur les deux côte à côte tronqueraient un
                 nom de site ou une date suivie de son auteur. */
              <div key={label} className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
                <p className="truncate text-gray-400">{label}</p>
                <p className="truncate font-medium text-gray-700 dark:text-gray-300">
                  {valeur}
                </p>
              </div>
            ))}
          </div>
        </BlocIdentite>

        {transfert.etat === 'preparation' && (
          <div className="flex items-start gap-2 px-4 py-3 mb-4 bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-200 dark:border-indigo-800/30 rounded-2xl">
            <Package size={15} className="text-indigo-500 shrink-0 mt-0.5" />
            <p className="text-xs text-indigo-700 dark:text-indigo-400">
              La marchandise se rassemble à {transfert.siteSourceNom} : elle est encore
              dans son stock, et rien n'a bougé.
            </p>
          </div>
        )}

        {/* Dire pourquoi il n'y a rien à faire ici : des boutons absents
            sans explication se lisent comme une panne. */}
        {suitUnOrdre && transfert.etat !== 'confirme'
          && transfert.etat !== 'annule' && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/30 dark:bg-amber-900/10">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
              O
            </span>
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Ce transfert sert une commande
              {(transfert as any).ordrePartenaireNom
                ? <> pour <span className="font-bold">{(transfert as any).ordrePartenaireNom}</span></>
                : null}.
              Il avance avec le bon de commande du site qui expédie, et se
              clôt quand la marchandise est remise — la marchandise ne
              voyage pas, il n'y a donc rien à charger ni à compter ici.
            </p>
          </div>
        )}

        {transfert.etat === 'expedie' && (
          <div className="flex items-start gap-2 px-4 py-3 mb-4 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 rounded-2xl">
            <Truck size={15} className="text-blue-500 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-700 dark:text-blue-400">
              La marchandise est en route : elle ne figure dans le stock d'aucun des deux sites.
            </p>
          </div>
        )}

        {/* L'écart se lit sur ce qui vient d'être compté : en traitement, les
            lignes ne portent pas encore de quantité reçue.
         *
            Ce bandeau nomme l'écart — manque, surplus, sur combien de lignes :
            c'est un indicateur, et il dirait au receveur ce qu'il aurait dû
            trouver. On le masque donc à qui compte à l'aveugle (gérant et
            responsable de commande du site qui reçoit) ; l'admin le garde. */}
        {!cacheAttendu
          && (transfert.etat === 'recu' || transfert.etat === 'traitement')
          && aUnEcart(lignesComptees) && (
          <div className={`flex items-start gap-2 px-4 py-3 mb-4 rounded-2xl border ${ecart > 0
            ? 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/30'
            : 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800/30'}`}>
            <AlertTriangle size={15} className={`shrink-0 mt-0.5 ${ecart > 0 ? 'text-amber-500' : 'text-blue-500'}`} />
            <div className={`text-xs ${ecart > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-blue-700 dark:text-blue-400'}`}>
              <p className="font-bold mb-0.5">
                {ecart > 0 ? 'Manque' : 'Surplus'} sur {enEcart.length} ligne{enEcart.length > 1 ? 's' : ''}
              </p>
              <p>La marchandise non reçue n'a jamais quitté {transfert.siteSourceNom} : aucune perte n'est constatée. Le stock ne bougera qu'après arbitrage.</p>
            </div>
          </div>
        )}

        {transfert.etat === 'a_confirmer' && (
          <div className="flex items-start gap-2 px-4 py-3 mb-4 bg-purple-50 dark:bg-purple-900/10 border border-purple-200 dark:border-purple-800/30 rounded-2xl">
            <ShieldCheck size={15} className="text-purple-500 shrink-0 mt-0.5" />
            <p className="text-xs text-purple-700 dark:text-purple-400">
              Les comptes sont arrêtés : plus personne ne les discute. Le stock
              n'a pas encore bougé — il attend la confirmation.
            </p>
          </div>
        )}

        {/* Le dossier confirmé garde la mémoire de son écart : combien de
            produits ont manqué, combien ont dépassé. Un transfert clos sur
            un écart ne doit pas se lire comme s'il était tombé juste —
            l'admin le voit, le receveur masqué non. */}
        {transfert.etat === 'confirme' && !cacheAttendu
          && aUnEcart(transfert.lignes) && (() => {
          const { manque, surplus } = produitsEnEcart(transfert.lignes);
          return (
            <div className="mb-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/30 dark:bg-amber-900/10">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <div className="text-xs text-amber-700 dark:text-amber-400">
                <p className="mb-0.5 font-bold">
                  Confirmé avec un écart
                  {manque > 0 && <> · {manque} manque{manque > 1 ? 'nt' : ''}</>}
                  {surplus > 0 && <> · {surplus} en surplus</>}
                </p>
                <p>
                  Le stock a bougé sur ce qui a été compté : ce qui manquait
                  est resté à {transfert.siteSourceNom}, ce qui dépassait y a
                  été prélevé en plus. La colonne Écart le détaille, ligne par
                  ligne.
                </p>
              </div>
            </div>
          );
        })()}

        {transfert.etat === 'traitement' && !peutArreterIci && (
          <div className="flex items-start gap-2 px-4 py-3 mb-4 bg-gray-50 dark:bg-gray-800/50 rounded-2xl">
            <ShieldCheck size={15} className="text-gray-400 shrink-0 mt-0.5" />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Un écart oppose deux sites : sa confirmation revient à un tiers qui n'a pas d'intérêt dans le litige.
            </p>
          </div>
        )}

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Marchandise</p>
            {/* Tout d'un coup : le cas courant est celui où rien ne manque.
             *
                Mais « tout » suppose de connaître l'attendu. Le gérant et le
                responsable de commande du site qui reçoit ne le voient pas :
                leur montrer ce bouton reviendrait à le leur souffler, et le
                comptage à l'aveugle n'aurait plus de sens. Eux saisissent ce
                qu'ils trouvent, ligne par ligne. */}
            {(peutExpedierIci || peutRecevoirIci) && !cacheAttendu && (() => {
              const deja = peutExpedierIci ? declareExp : declareRec;
              const total = transfert.lignes.reduce((n, l, i) => {
                const attendu = peutExpedierIci
                  ? l.quantiteDemandee
                  : (l.quantiteExpediee ?? l.quantiteDemandee);
                return n + Math.max(0, attendu - (deja[i] ?? 0));
              }, 0);
              if (total <= 0) return null;
              return (
                <button onClick={() => completer(null)} disabled={enCours}
                  className="flex items-center gap-1.5 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-40 dark:border-indigo-800/40 dark:hover:bg-indigo-900/20">
                  {enCours ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />}
                  {peutExpedierIci ? 'Tout charger' : 'Tout recevoir'}
                </button>
              );
            })()}
          </div>

          {/* Le suivi du comptage, à l'admin seul : filtrer les lignes selon
              qu'elles concordent, manquent, dépassent, ou restent à compter.
              Un compteur par état, et la catégorie vide ne se propose pas —
              un filtre qui ne rendrait rien est un bouton à lire pour rien. */}
          {suiviOuvert && (
            <div className="mb-4 flex flex-wrap items-center gap-1">
              {([
                { k: 'tout' as const, label: 'Tout', n: transfert.lignes.length,
                  couleur: 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900' },
                { k: 'conforme' as const, label: 'Conforme', n: parEtatLigne.conforme,
                  couleur: 'bg-green-600 text-white' },
                { k: 'moins' as const, label: 'En moins', n: parEtatLigne.moins,
                  couleur: 'bg-orange-500 text-white' },
                { k: 'surplus' as const, label: 'En surplus', n: parEtatLigne.surplus,
                  couleur: 'bg-blue-500 text-white' },
                { k: 'attente' as const, label: 'À compter', n: parEtatLigne.attente,
                  couleur: 'bg-gray-500 text-white' },
              ])
                .filter(o => o.k === 'tout' || o.n > 0)
                .map(o => (
                  <button key={o.k} type="button"
                    onClick={() => setFiltreEcart(o.k)}
                    className={`rounded-lg px-2 py-1 text-[11px] font-bold transition-colors ${
                      filtreEcart === o.k
                        ? o.couleur
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400'}`}>
                    {o.label}
                    <span className="ml-1 opacity-70">{o.n}</span>
                  </button>
                ))}
            </div>
          )}

          {/* Le filtre ne rend rien : le dire, plutôt qu'un tableau vide qui
              se lit comme une panne. */}
          {suiviOuvert && lignesFiltrees.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-400">
              Aucune ligne dans cet état.
            </p>
          )}

          {/* Sur téléphone, une carte par ligne.

              Le tableau pouvait porter huit colonnes : produit, unité,
              emballage, demandé, stock, expédié, reçu, boutons. Il fallait
              le faire défiler pour charger ou compter, et un défilement
              horizontal cache ce qu'il déplace. */}
          <div className="space-y-2 sm:hidden">
            {lignesFiltrees.map(({ l, i }) => {
              /* La couleur d'ecart revelerait l'attendu au receveur : en
                 moins, en surplus, c'est dire ce qu'il aurait du trouver.
                 Pour lui, pas d'ecart affiche — il voit son chiffre, nu. */
              const diverge = !cacheAttendu && l.quantiteRecue != null &&
                (l.quantiteExpediee ?? l.quantiteDemandee) !== l.quantiteRecue;
              const surplus = !cacheAttendu && l.quantiteRecue != null &&
                l.quantiteRecue > (l.quantiteExpediee ?? l.quantiteDemandee);
              const dejaExp = declareExp[i] ?? 0;
              const dejaRec = declareRec[i] ?? 0;
              const attendu = peutExpedierIci
                ? l.quantiteDemandee
                : (l.quantiteExpediee ?? l.quantiteDemandee);
              const deja = peutExpedierIci ? dejaExp : dejaRec;
              const reste = Math.max(0, attendu - deja);
              /* Annulées comprises : c'est le ⓘ qui plie le journal, et une
                 ligne dont tout a été annulé a encore un journal à replier. */
              const nbDecl = receptions.filter(
                r => r.ligneIndex === i
                  && (r.etape ?? 'reception') === etapeCourante).length;
              const dispo = montreStock ? stockDe(l) : 0;
              /* Le fond suit l'état pendant qu'on compte, pour l'admin qui
                 suit : vert conforme, bleu surplus, orange manque, neutre tant
                 que rien n'est compté. Prend le pas sur la couleur figée. */
              const teinte = suiviOuvert ? etatLigne(i) : null;
              return (
                <div key={i}
                  className={`rounded-xl border p-3 ${
                    teinte === 'conforme'
                    ? 'border-green-200 bg-green-50/50 dark:border-green-800/30 dark:bg-green-900/10'
                    : teinte === 'surplus'
                    ? 'border-blue-200 bg-blue-50/50 dark:border-blue-800/30 dark:bg-blue-900/10'
                    : teinte === 'moins'
                    ? 'border-orange-200 bg-orange-50/50 dark:border-orange-800/30 dark:bg-orange-900/10'
                    : teinte === 'attente'
                    ? 'border-gray-100 dark:border-gray-800'
                    : !diverge
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

                  {/* Le trajet de la marchandise, dans l'ordre : ce qu'on a
                      demandé, ce qui est parti, ce qui est arrivé. */}
                  <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-black/[0.06] pt-2 text-[11px] dark:border-white/10">
                    {!cacheAttendu && (
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Demandé</span>
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {l.quantiteDemandee.toLocaleString('fr-FR')}
                      </span>
                    </span>
                    )}
                    {/* Un stock qui ne couvre pas la demande appelle une
                        décision : réduire l'envoi, ou attendre. */}
                    {montreStock && (
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-gray-400">Stock</span>
                        <span className={`font-bold ${
                          dispo < l.quantiteDemandee ? 'text-orange-500' : 'text-gray-500'}`}>
                          {dispo.toLocaleString('fr-FR')}
                        </span>
                      </span>
                    )}
                    {!cacheAttendu && (
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Expédié</span>
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {peutExpedierIci
                          ? (dejaExp > 0 ? dejaExp.toLocaleString('fr-FR') : '—')
                          : (l.quantiteExpediee != null ? l.quantiteExpediee.toLocaleString('fr-FR') : '—')}
                      </span>
                      {peutExpedierIci && nbDecl > 0 && (
                        <button onClick={() => setDetailLigne(detailLigne === i ? null : i)}
                          title="Voir les déclarations"
                          className={`shrink-0 rounded p-0.5 transition-colors ${detailLigne === i
                            ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30'
                            : 'text-gray-400'}`}>
                          <Info size={12} />
                        </button>
                      )}
                    </span>
                    )}
                    {aExpedie && (
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-gray-400">Reçu</span>
                        <span className={`font-bold ${!diverge
                          ? 'text-gray-900 dark:text-gray-100'
                          : surplus ? 'text-blue-500' : 'text-orange-500'}`}>
                          {peutRecevoirIci
                            ? (dejaRec > 0 ? dejaRec.toLocaleString('fr-FR') : '—')
                            : (recuReel(l, i) != null ? recuReel(l, i)!.toLocaleString('fr-FR') : '—')}
                        </span>
                        {peutRecevoirIci && nbDecl > 0 && (
                          <button onClick={() => setDetailLigne(detailLigne === i ? null : i)}
                            title="Voir les déclarations"
                            className={`shrink-0 rounded p-0.5 transition-colors ${detailLigne === i
                              ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30'
                              : 'text-gray-400'}`}>
                            <Info size={12} />
                          </button>
                        )}
                      </span>
                    )}
                    {/* L'écart de la ligne : ce qui manque ou dépasse.
                        Hors traitement, il se lit sur la quantité reçue figée.
                        Si elle n'a jamais été inscrite (un dossier confirmé
                        sans qu'on ait figé la ligne — le stock a pourtant
                        bougé), il n'y a pas d'écart connu : un tiret, jamais
                        « reçu zéro » qui peindrait un manque total imaginaire. */}
                    {montreEcart && (() => {
                      const attenduE = l.quantiteExpediee ?? l.quantiteDemandee;
                      const enTraitement = transfert.etat === 'traitement';
                      const recuE = enTraitement ? dejaRec : recuReel(l, i);
                      const connu = enTraitement || recuE != null;
                      const e = (recuE ?? 0) - attenduE;
                      return (
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-gray-400">Écart</span>
                          <span className={`font-bold ${!connu || e === 0
                            ? 'text-gray-400'
                            : e > 0 ? 'text-blue-500' : 'text-orange-500'}`}>
                            {!connu || e === 0 ? '—' : `${e > 0 ? '+' : ''}${e.toLocaleString('fr-FR')}`}
                          </span>
                        </span>
                      );
                    })()}
                  </div>

                  {(peutExpedierIci || peutRecevoirIci) && (
                    <div className="mt-2.5 flex items-center gap-1.5">
                      {/* « Tout » sur la ligne affiche le reste attendu : caché
                          à celui qui compte sans voir l'attendu. */}
                      {reste > 0 && ligneSaisie !== i && !cacheAttendu && (
                        <button onClick={() => completer(i)}
                          disabled={enCours || ligneEnCours === i}
                          className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-2 text-xs font-bold text-white transition-colors disabled:opacity-40">
                          {ligneEnCours === i
                            ? <Loader2 size={12} className="animate-spin" />
                            : <><CheckCheck size={12} /> {reste}</>}
                        </button>
                      )}
                      {/* La quantité se tape dans la ligne, pas dans une
                          fenêtre : on valide et le produit suivant est déjà
                          sous le pouce. */}
                      {ligneSaisie === i ? (
                        <div className="flex flex-1 gap-1.5">
                          <ChampNombre valeur={qteSaisie} onChange={n => setQteSaisie(capQte(n, i))}
                            className="w-full min-w-0 rounded-lg border border-indigo-300 bg-white px-2 py-2 text-center text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-indigo-700 dark:bg-gray-800" />
                          <button onClick={declarer}
                            disabled={ligneEnCours === i || qteSaisie <= 0}
                            className="flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                            {ligneEnCours === i
                              ? <Loader2 size={12} className="animate-spin" />
                              : <Check size={12} />}
                          </button>
                          <button onClick={() => { setLigneSaisie(null); setQteSaisie(0); }}
                            className="shrink-0 rounded-lg border border-gray-300 px-2.5 py-2 text-gray-400 dark:border-gray-600">
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => { setLigneSaisie(i); setQteSaisie(0); }}
                          title="Saisir une quantité"
                          className={`flex shrink-0 items-center justify-center rounded-lg border border-gray-200 px-3 py-2 text-gray-400 transition-colors dark:border-gray-700 ${
                            !cacheAttendu && reste > 0 ? '' : 'flex-1'}`}>
                          <Plus size={12} />
                        </button>
                      )}
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
                      colonnes y repousserait les quantités hors de l'écran,
                      qui sont le travail même. */}
                  <th className="hidden sm:table-cell text-center px-3 py-2.5 font-medium">Unité</th>
                  <th className="hidden sm:table-cell text-center px-3 py-2.5 font-medium">Emballage</th>
                  {!cacheAttendu && (
                    <th className="text-center px-3 py-2.5 font-medium">Demandé</th>
                  )}
                  {/* Ce dont la source dispose : on ne charge pas à
                      l'aveugle. La colonne ne vaut que tant qu'on rassemble
                      et qu'on charge — une fois parti, le stock a bougé et
                      ce qu'il en reste ne dit plus rien de ce transfert. */}
                  {montreStock && (
                    <th className="text-center px-3 py-2.5 font-medium">Stock</th>
                  )}
                  {!cacheAttendu && (
                    <th className="text-center px-3 py-2.5 font-medium">Expédié</th>
                  )}
                  {/* Rien ne peut être reçu avant d'être parti : la colonne
                      n'apparaît qu'une fois l'expédition faite. */}
                  {aExpedie && (
                    <th className="text-center px-3 py-2.5 font-medium">Reçu</th>
                  )}
                  {/* L'écart, ligne à ligne : ce qui manque, ce qui dépasse.
                      Il révèle l'attendu, donc caché au receveur, et ne vaut
                      qu'une fois le comptage figé — avant, c'est la colonne
                      Reçu qui vit. */}
                  {montreEcart && (
                    <th className="text-center px-3 py-2.5 font-medium">Écart</th>
                  )}
                  {/* Le coût de l'unité, puis ce que la ligne déplace.
                      La valeur seule ne se laisse pas lire : à zéro, elle
                      ne dit pas si c'est la quantité ou le prix qui
                      manque. Le coût unitaire tranche, et c'est lui qu'on
                      va corriger quand il est faux. */}
                  {montreArgent && (
                    <th className="text-center px-3 py-2.5 font-medium">Coût unitaire</th>
                  )}
                  {montreArgent && (
                    <th className="text-center px-3 py-2.5 font-medium">Valeur</th>
                  )}
                  {/* Les boutons ont leur colonne : serrés contre un nombre,
                      ils le rendent illisible. Collée à droite, parce que
                      c'est par elle qu'on charge et qu'on compte, et que le
                      tableau défile sur un téléphone. */}
                  {(peutExpedierIci || peutRecevoirIci) && (
                    <th className="sticky right-0 w-24 bg-indigo-600" />
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {lignesFiltrees.map(({ l, i }) => {
                  /* Pas de couleur d'ecart pour le receveur : voir `diverge`
                     dans les cartes mobiles. */
                  const diverge = !cacheAttendu && l.quantiteRecue != null &&
                    (l.quantiteExpediee ?? l.quantiteDemandee) !== l.quantiteRecue;
                  const surplus = !cacheAttendu && l.quantiteRecue != null &&
                    l.quantiteRecue > (l.quantiteExpediee ?? l.quantiteDemandee);
                  /* Ce qui a déjà été déclaré à cette étape, et ce qu'il
                     reste à déclarer pour atteindre l'attendu. */
                  const dejaExp = declareExp[i] ?? 0;
                  const dejaRec = declareRec[i] ?? 0;
                  const attendu = peutExpedierIci
                    ? l.quantiteDemandee
                    : (l.quantiteExpediee ?? l.quantiteDemandee);
                  const deja = peutExpedierIci ? dejaExp : dejaRec;
                  const reste = Math.max(0, attendu - deja);
                  /* Annulées comprises : le ⓘ plie le journal même quand tout
                     a été annulé. */
                  const nbDecl = receptions.filter(
                    r => r.ligneIndex === i
                      && (r.etape ?? 'reception') === etapeCourante).length;
                  /* Le fond suit l'état pendant le comptage, pour l'admin qui
                     suit : il prend le pas sur la couleur figée. */
                  const teinte = suiviOuvert ? etatLigne(i) : null;
                  return (
                    <Fragment key={i}>
                    <tr className={
                      teinte === 'conforme' ? 'bg-green-50/50 dark:bg-green-900/10'
                      : teinte === 'surplus' ? 'bg-blue-50/50 dark:bg-blue-900/10'
                      : teinte === 'moins' ? 'bg-orange-50/50 dark:bg-orange-900/10'
                      : teinte === 'attente' ? ''
                      : !diverge ? '' : surplus
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
                      {/* l'unité est elle-même un emballage, celui de contenance 1 */}
                      <td className="hidden sm:table-cell px-3 py-2.5 text-center text-gray-500">
                        {l.emballage ?? l.unite ?? 'unité'}
                      </td>
                      {!cacheAttendu && (
                        <td className="px-3 py-2.5 text-center text-gray-500">{l.quantiteDemandee.toLocaleString('fr-FR')}</td>
                      )}
                      {/* Un stock qui ne couvre pas la demande se signale :
                          c'est le seul cas où ce nombre appelle une
                          décision — réduire l'envoi, ou attendre. */}
                      {montreStock && (() => {
                        const dispo = stockDe(l);
                        return (
                          <td className={`px-3 py-2.5 text-center font-medium ${
                            dispo < l.quantiteDemandee
                              ? 'text-orange-500' : 'text-gray-500'}`}>
                            {dispo.toLocaleString('fr-FR')}
                          </td>
                        );
                      })()}
                      {/* Avant l'expédition, ce qui est chargé vit dans les
                          déclarations ; après, il est figé sur la ligne.
                          Cache au receveur : c'est l'attendu qu'il ne doit
                          pas connaitre. */}
                      {!cacheAttendu && (
                      <td className="px-3 py-2.5 text-center">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-gray-600 dark:text-gray-300">
                            {peutExpedierIci
                              ? (dejaExp > 0 ? dejaExp.toLocaleString('fr-FR') : '—')
                              : (l.quantiteExpediee != null ? l.quantiteExpediee.toLocaleString('fr-FR') : '—')}
                          </span>
                          {peutExpedierIci && nbDecl > 0 && (
                            <button onClick={() => setDetailLigne(detailLigne === i ? null : i)}
                              title="Voir les déclarations"
                              className={`shrink-0 rounded p-0.5 transition-colors ${detailLigne === i
                                ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30'
                                : 'text-gray-400 hover:bg-indigo-50 hover:text-indigo-600'}`}>
                              <Info size={13} />
                            </button>
                          )}
                        </span>
                      </td>
                      )}
                      {aExpedie && (
                      <td className="px-3 py-2.5 text-center">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`font-medium ${!diverge ? 'text-gray-600 dark:text-gray-300' : surplus ? 'text-blue-500' : 'text-orange-500'}`}>
                            {peutRecevoirIci
                              ? (dejaRec > 0 ? dejaRec.toLocaleString('fr-FR') : '—')
                              : (recuReel(l, i) != null ? recuReel(l, i)!.toLocaleString('fr-FR') : '—')}
                          </span>
                          {peutRecevoirIci && nbDecl > 0 && (
                            <button onClick={() => setDetailLigne(detailLigne === i ? null : i)}
                              title="Voir les déclarations"
                              className={`shrink-0 rounded p-0.5 transition-colors ${detailLigne === i
                                ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30'
                                : 'text-gray-400 hover:bg-indigo-50 hover:text-indigo-600'}`}>
                              <Info size={13} />
                            </button>
                          )}
                        </span>
                      </td>
                      )}
                      {/* L'écart : reçu − expédié. Positif, il dépasse (bleu) ;
                          négatif, il manque (orange) ; nul, un tiret discret.
                          Le reçu vient des déclarations tant qu'on compte, de
                          la ligne figée une fois les comptes arrêtés. Jamais
                          figée (dossier confirmé sans que la ligne ait porté
                          le reçu, alors que le stock a bien bougé) : écart
                          inconnu, un tiret — pas « reçu zéro » qui inventerait
                          un manque total. */}
                      {montreEcart && (() => {
                        const attenduE = l.quantiteExpediee ?? l.quantiteDemandee;
                        const enTraitement = transfert.etat === 'traitement';
                        const recuE = enTraitement ? dejaRec : recuReel(l, i);
                        const connu = enTraitement || recuE != null;
                        const e = (recuE ?? 0) - attenduE;
                        return (
                          <td className="px-3 py-2.5 text-center">
                            <span className={`font-bold ${!connu || e === 0
                              ? 'text-gray-300 dark:text-gray-600'
                              : e > 0 ? 'text-blue-500' : 'text-orange-500'}`}>
                              {!connu || e === 0 ? '—' : `${e > 0 ? '+' : ''}${e.toLocaleString('fr-FR')}`}
                            </span>
                          </td>
                        );
                      })()}
                      {/* La même quantité que celle qui fait foi au total :
                          l'expédié quand il est connu, le demandé tant que
                          rien n'est parti. Deux façons de compter la même
                          ligne finiraient par se contredire. */}
                      {/* Un coût absent se signale au lieu de s'écrire
                          zéro : la source n'a jamais payé cette
                          marchandise — ou son prix n'a pas été repris — et
                          « 0 FCFA » se lirait comme gratuit. */}
                      {montreArgent && (
                        <td className="px-3 py-2.5 text-center">
                          {l.valeurUnitaire > 0 ? (
                            <span className="font-medium text-gray-600 dark:text-gray-300">
                              {formatMontant(l.valeurUnitaire)}
                            </span>
                          ) : (
                            <span className="text-xs font-bold text-orange-500">
                              Coût inconnu
                            </span>
                          )}
                        </td>
                      )}
                      {montreArgent && (
                        <td className="px-3 py-2.5 text-center font-medium text-gray-700 dark:text-gray-300">
                          {formatMontant(
                            (l.quantiteExpediee ?? l.quantiteDemandee) * l.valeurUnitaire)}
                        </td>
                      )}
                      {/* Une déclaration s'ajoute, elle ne s'écrase pas.
                          Fond opaque : la cellule reste lisible quand les
                          colonnes défilent dessous. */}
                      {(peutExpedierIci || peutRecevoirIci) && (
                        <td className="sticky right-0 border-l border-gray-100 bg-white px-3 py-2.5 dark:border-gray-800 dark:bg-gray-900">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Le nombre est sur le bouton : on sait ce qu'il
                                écrira sans avoir à l'ouvrir. Donc caché à qui
                                ne doit pas connaître l'attendu. */}
                            {reste > 0 && ligneSaisie !== i && !cacheAttendu && (
                              <button onClick={() => completer(i)}
                                disabled={enCours || ligneEnCours === i}
                                className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                                {ligneEnCours === i
                                  ? <Loader2 size={12} className="animate-spin" />
                                  : <><CheckCheck size={12} /> {reste}</>}
                              </button>
                            )}
                            {/* La quantité se tape dans la cellule même : pas
                                de fenêtre à ouvrir et refermer à chaque ligne
                                d'un transfert qui en porte des dizaines. */}
                            {ligneSaisie === i ? (
                              <>
                                <ChampNombre valeur={qteSaisie} onChange={n => setQteSaisie(capQte(n, i))}
                                  className="w-20 rounded-lg border border-indigo-300 bg-white px-2 py-1.5 text-center text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-indigo-700 dark:bg-gray-800" />
                                <button onClick={declarer}
                                  disabled={ligneEnCours === i || qteSaisie <= 0}
                                  className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                                  {ligneEnCours === i
                                    ? <Loader2 size={12} className="animate-spin" />
                                    : <Check size={12} />}
                                </button>
                                <button onClick={() => { setLigneSaisie(null); setQteSaisie(0); }}
                                  className="rounded-lg border border-gray-300 p-1.5 text-gray-400 dark:border-gray-600">
                                  <X size={12} />
                                </button>
                              </>
                            ) : (
                              <button onClick={() => { setLigneSaisie(i); setQteSaisie(0); }}
                                title="Saisir une quantité"
                                className="rounded-lg border border-gray-200 p-1.5 text-gray-400 transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700">
                                <Plus size={12} />
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                    {/* Le détail des déclarations : quand, combien, par qui. */}
                    {detailLigne === i && nbDecl > 0 && (
                      <tr>
                        <td colSpan={5 + (aExpedie ? 1 : 0) + (montreStock ? 1 : 0)
                          + (montreEcart ? 1 : 0)
                          + (montreArgent ? 2 : 0)
                          + ((peutExpedierIci || peutRecevoirIci) ? 1 : 0)}
                          className="px-3 pb-2">
                          <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/50">
                            {receptions
                              .filter(r => r.ligneIndex === i
                                && (r.etape ?? 'reception') === etapeCourante)
                              .map(r => (
                                <div key={r.id}
                                  className="flex items-center justify-between gap-3 py-1 text-xs">
                                  <span className={r.annulee ? 'text-gray-400 line-through' : 'text-gray-600 dark:text-gray-300'}>
                                    {r.date} · {r.heure} · {r.utilisateurNom}
                                  </span>
                                  <span className="flex items-center gap-2">
                                    <span className={`font-bold ${r.annulee ? 'text-gray-400 line-through' : 'text-gray-900 dark:text-gray-100'}`}>
                                      {r.quantite.toLocaleString('fr-FR')}
                                    </span>
                                    {/* Une déclaration fausse s'annule : elle
                                        reste lisible et cesse de compter. */}
                                    {!r.annulee && (
                                      <button onClick={() => annulerDeclaration(r.id)} disabled={enCours}
                                        title="Annuler cette déclaration"
                                        className="rounded p-0.5 text-gray-300 transition-colors hover:text-red-500 disabled:opacity-40">
                                        <X size={12} />
                                      </button>
                                    )}
                                  </span>
                                </div>
                              ))}
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

          {/* Un transfert déplace de la marchandise entre deux sites d'une même
              activité : rien ne se vend, la valeur ne quitte jamais la maison.
              Elle se dit quand même — non comme un gain, mais comme un
              poids : savoir qu'un camion emporte deux cent mille francs
              décide de qui l'accompagne et de ce qu'on vérifie. Le dossier
              le taisait, et chaque ligne le tait aussi. */}
          <div className="flex flex-col gap-1.5 pt-3 mt-3 border-t border-gray-100 dark:border-gray-800 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Produits</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {transfert.lignes.length} ligne{transfert.lignes.length > 1 ? 's' : ''}
              </span>
            </div>
            {montreArgent && (() => {
              /* Combien de lignes pèsent sans qu'on sache ce qu'elles
                 valent. Un total à zéro se lirait comme « rien de
                 précieux » alors qu'il dit « on ne sait pas » : deux
                 situations opposées, et c'est celle-là qu'il faut
                 corriger. */
              const sansCout = transfert.lignes.filter(l => !(l.valeurUnitaire > 0)).length;
              return (
                <>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Valeur</span>
                    <span className="font-bold text-gray-900 dark:text-gray-100">
                      {formatMontant(valeurEnvoyee(transfert.lignes))}
                    </span>
                  </div>
                  {sansCout > 0 && (
                    <p className="text-[11px] font-medium leading-snug text-gray-400">
                      {sansCout === transfert.lignes.length
                        ? 'Aucune ligne ne porte de coût : ce total ne vaut pas zéro, il est inconnu.'
                        : <>Dont <span className="font-bold text-orange-500">
                            {sansCout} ligne{sansCout > 1 ? 's' : ''}
                          </span> sans coût connu, comptée{sansCout > 1 ? 's' : ''} pour zéro.</>}
                    </p>
                  )}
                </>
              );
            })()}
            {transfert.lignes.some(l => l.quantiteRecue != null) && (
              <div className="flex justify-between">
                <span className="text-gray-400">Lignes en écart</span>
                <span className={`font-bold ${enEcart.length === 0 ? 'text-green-600' : 'text-orange-500'}`}>
                  {enEcart.length === 0 ? 'Aucune' : enEcart.length}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* L'explication obligatoire, ligne par ligne, n'est demandée qu'au
            receveur qui ne tranche pas : le dossier partira en « à confirmer »
            et un tiers le lira. L'admin, lui, arbitre dans le modal — l'y
            demander ici le ferait saisir deux fois. */}
        {peutArreterIci && aUnEcart(lignesComptees)
          && !peutArbitrerEcart(ROLE_COURANT) && (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
            <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">
              Explication de l'écart <span className="text-red-500">*</span>
            </label>
            <input type="text" value={noteArbitrage} onChange={e => setNoteArbitrage(e.target.value)}
              placeholder="Ce qui s'est passé"
              className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
        )}

        {transfert.noteArbitrage && (
          <div className="px-4 py-3 mb-4 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800">
            <p className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-0.5">Arbitrage</p>
            <p className="text-xs text-gray-600 dark:text-gray-300">{transfert.noteArbitrage}</p>
          </div>
        )}

        {transfert.note && (
          <p className="text-xs text-gray-500 dark:text-gray-400 px-4 py-3 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800">
            {transfert.note}
          </p>
        )}

        {erreur && <p className="text-xs text-red-500 mt-3">{erreur}</p>}
      </div>

      {/* Arbitrer un écart : l'admin confirme en connaissance de cause.
       *
          Le bouton ne refuse pas un dossier parce qu'une ligne n'a pas été
          reçue — c'est un résultat, pas une erreur. Il ouvre ce modal, dit
          ce qui manque et ce qui dépasse, et demande de continuer. Une
          explication reste possible, jamais obligatoire pour l'admin : il
          est le tiers qui tranche, pas celui qui doit se justifier. */}
      {modalEcart && (() => {
        const lignes = lignesArretees();
        const { manque, surplus } = produitsEnEcart(lignes);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-2xl bg-white p-6 dark:bg-gray-900">
              <div className="mb-3 flex items-start gap-2">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
                <div>
                  <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                    Confirmer avec un écart ?
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {manque > 0 && <>{manque} produit{manque > 1 ? 's' : ''} en moins</>}
                    {manque > 0 && surplus > 0 && <> · </>}
                    {surplus > 0 && <>{surplus} produit{surplus > 1 ? 's' : ''} en surplus</>}
                  </p>
                </div>
              </div>

              <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-snug text-amber-700 dark:bg-amber-900/10 dark:text-amber-400">
                Le stock bougera sur ce qui a été compté. Ce qui manque reste
                à {transfert.siteSourceNom} — rien n'est perdu ; ce qui dépasse
                y sera prélevé en plus. Une fois confirmé, les comptes sont
                clos.
              </p>

              <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
                Explication <span className="font-normal text-gray-400">(facultatif)</span>
              </label>
              <input type="text" value={noteArbitrage}
                onChange={e => setNoteArbitrage(e.target.value)}
                placeholder="Ce qui s'est passé"
                className="mb-4 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

              <div className="flex gap-2">
                <button onClick={() => setModalEcart(false)} disabled={enCours}
                  className="flex-1 rounded-xl py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:hover:bg-gray-800">
                  Annuler
                </button>
                <button
                  onClick={() => appliquerArret(lignes, noteArbitrage.trim() || null)}
                  disabled={enCours}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-green-600 py-2 text-sm font-bold text-white transition-colors hover:bg-green-700 disabled:opacity-40">
                  {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  Confirmer
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
