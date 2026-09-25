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
import {
  ArrowLeft,
  Loader2, Check, ArrowDownLeft, Truck, AlertTriangle, ShieldCheck, Package,
  CheckCheck, Info, Plus, X,
} from 'lucide-react';
import {
  Transfert, EtatTransfert, LIBELLES_TRANSFERT,
  ecartValeur, aUnEcart, lignesEnEcart, confirmerTransfert,
  peutExpedier, peutRecevoir, peutArbitrerEcart, peutAnnulerDossier, Role,
  libelleTransfert,
} from '@/lib/flux-marchandise';
import { estEnsemble, retourHistorique } from '@/lib/retour';



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

  /* L'admin de l'activité n'est désigné par aucun membre : `roleSurSite`
     lui rend `null`, qui vaut « tout permis ». */
  useEffect(() => {
    if (!user || !siteId) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(r => setRole(r as Role | null))
      .catch(() => setRole('recouvrement'));
  }, [user, siteId, activite?.adminUid]);
  /* La ligne dont on saisit une quantité partielle, et ce qu'on y écrit. */
  const [ligneSaisie, setLigneSaisie] = useState<number | null>(null);
  const [qteSaisie, setQteSaisie] = useState(0);
  const [noteArbitrage, setNoteArbitrage] = useState('');
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

  const estSource = transfert.siteSourceId === siteId;
  const estDest = transfert.siteDestId === siteId;
  const ecart = ecartValeur(transfert.lignes);
  const enEcart = lignesEnEcart(transfert.lignes);

  /* La source rassemble puis charge — elle ne déclare pas ce qu'elle n'a pas
     vu arriver. Le destinataire compte — il ne dit pas qu'un colis est parti. */
  const peutPreparerIci = transfert.etat === 'en_cours' && estSource
    && peutExpedier(ROLE_COURANT);
  const peutExpedierIci = transfert.etat === 'preparation' && estSource
    && peutExpedier(ROLE_COURANT);
  /* Deux gestes, pas un. Tant que la marchandise est en route, il n'y a
     rien à compter : on ne déclare pas les quantités d'un camion qui roule.
     Le destinataire acte d'abord l'arrivée, puis il compte ce qui est dans
     les cartons. */
  const peutAccuserIci = transfert.etat === 'expedie' && estDest
    && peutRecevoir(ROLE_COURANT);
  /* On ne traite que ce qui est arrivé : la réception ouvre le traitement,
     et c'est là seulement qu'on ouvre les cartons pour compter. */
  const peutTraiterIci = transfert.etat === 'recu' && estDest
    && peutRecevoir(ROLE_COURANT);
  const peutRecevoirIci = transfert.etat === 'traitement' && estDest
    && peutRecevoir(ROLE_COURANT);

  /* Le stock de la source se montre tant que la marchandise est chez elle :
     on rassemble, puis on charge. Une fois le camion parti, ce stock a
     bougé pour d'autres raisons et ne dit plus rien de ce dossier.
     Il s'adresse à la source : le destinataire ne puise pas dedans. */
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
     personne ne discute les comptes. */
  const peutConfirmerIci = transfert.etat === 'a_confirmer';

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
   * Compléter une ligne, ou toutes.
   *
   * Un fait s'enregistre : on ajoute ce qu'on constate, on n'écrase pas un
   * total. Ce qui manque à la ligne se déduit de ce qui a déjà été déclaré.
   */
  async function completer(ligneIndex: number | null) {
    /* Une écriture en cours n'a pas encore rafraîchi l'affichage : le bouton
       montre toujours l'ancien reste. Sans cette garde, deux clics rapides
       déclarent deux fois la même chose. */
    if (!transfert || enCours) return;
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

    setEnCours(true); setErreur('');
    try {
      /* Le site qui déclare n'est pas le même des deux côtés : l'auteur se
         lit là où la personne travaille. */
      const siteDeclarant = etapeCourante === 'expedition'
        ? transfert.siteSourceId : transfert.siteDestId;
      const auteur = await auteurCourant(siteDeclarant, user!.uid);
      const date = aujourdhui();
      await Promise.all(aEcrire.map(({ i, quantite }) => {
        const l = transfert.lignes[i];
        return enregistrerReception({
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
        });
      }));
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* Une quantité partielle : ce qui arrive en deux fois se déclare en deux
     fois, et chaque déclaration reste un fait daté. */
  async function declarer() {
    if (ligneSaisie === null || qteSaisie <= 0 || !transfert || enCours) return;
    const i = ligneSaisie;

    /* On ne charge pas plus que le dossier ne demande : expédier au-delà,
       c'est modifier la commande sans le dire. Recevoir plus, en revanche,
       se constate — c'est un fait, pas une décision. */
    if (etapeCourante === 'expedition') {
      const reste = transfert.lignes[i].quantiteDemandee - (declareExp[i] ?? 0);
      if (qteSaisie > reste) {
        setErreur(`Au plus ${reste} à charger sur cette ligne.`);
        return;
      }
    }

    setEnCours(true); setErreur('');
    try {
      const siteDeclarant = etapeCourante === 'expedition'
        ? transfert.siteSourceId : transfert.siteDestId;
      const auteur = await auteurCourant(siteDeclarant, user!.uid);
      const l = transfert.lignes[i];
      await enregistrerReception({
        siteId: siteDeclarant,
        documentId: transfertId,
        ligneIndex: i,
        etape: etapeCourante,
        produitId: l.produitId ?? null,
        designation: l.designation,
        quantite: qteSaisie,
        date: aujourdhui(),
        utilisateur: user!.uid,
        utilisateurNom: auteur.utilisateurNom,
        utilisateurFonction: auteur.utilisateurFonction,
        note: null,
      });
      setLigneSaisie(null);
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  /* Une déclaration fausse s'annule, elle ne se réécrit pas : elle reste
     lisible, barrée, et cesse de compter. */
  async function annulerDeclaration(id: string) {
    setEnCours(true); setErreur('');
    try {
      await annulerReception({ receptionId: id, par: user!.uid });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
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

  async function arreterComptes() {
    if (!transfert || enCours) return;
    /* Les comptes se figent ici, sur ce qui a été déclaré pendant le
       traitement. Sans déclaration, on figerait zéro partout et la
       marchandise passerait pour perdue. */
    if (!aDeclareRec) {
      setErreur("Comptez la marchandise avant d'arrêter les comptes.");
      return;
    }
    const compte = recuParLigne(receptions, 'reception');
    const lignes = transfert.lignes.map(
      (l, i) => ({ ...l, quantiteRecue: compte[i] ?? 0 }));

    /* Un écart n'est pas une erreur de saisie qu'on corrige : c'est un
       désaccord entre deux sites, et il s'explique avant d'être arrêté. */
    const ecarte = aUnEcart(lignes);
    if (ecarte && !noteArbitrage.trim()) {
      setErreur("Un écart doit être expliqué avant d'être arrêté.");
      return;
    }

    setEnCours(true); setErreur('');
    try {
      /* Les comptes concordent : le dossier est confirmé et le stock entre.
         Ils divergent : il attend la confirmation d'un tiers. */
      if (!ecarte) {
        await confirmerTransfert({
          transfert: { ...transfert, lignes },
          userId: user!.uid, par: user!.uid,
          noteArbitrage: null,
          ...(await auteurCourant(transfert.siteDestId, user!.uid, user!.displayName)),
        });
      } else {
        await updateDoc(doc(db, 'transferts', transfertId), {
          etat: 'a_confirmer', lignes,
          noteArbitrage: noteArbitrage.trim() || null,
        });
      }
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
        ...(await auteurCourant(transfert!.siteSourceId, user!.uid, user!.displayName)),
      });
      await charger();
    } catch (e: any) { setErreur(e?.message ?? 'Échec.'); }
    finally { setEnCours(false); }
  }

  async function annuler() {
    /* La garde tient aussi ici : cacher le bouton ne protège que l'écran,
       et la fonction reste appelable par d'autres chemins. */
    if (!peutAnnulerDossier(ROLE_COURANT)) return;
    setEnCours(true); setErreur('');
    try {
      await updateDoc(doc(db, 'transferts', transfertId), { etat: 'annule' });
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
            <div className="flex items-start gap-2">
              {/* La flèche ne paraît que sur téléphone : au bureau,
                  « Fermer » reste plus clair qu'un chevron isolé. */}
              <button onClick={() => router.push((() => {
                const de = searchParams.get('de');
                const base = estEnsemble(searchParams) ? '/ensemble' : `/site/${siteId}`;
                if (de === 'historique' || de === 'ensemble-historique') {
                  return `${base}${retourHistorique(searchParams)}`;
                }
                return `${base}?onglet=transferts`;
              })())}
                title="Fermer"
                className="-ml-1 shrink-0 rounded-xl p-2 text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 sm:hidden">
                <ArrowLeft size={18} />
              </button>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-lg font-bold text-gray-900 dark:text-gray-100">{transfert.reference}</h1>
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
            <button onClick={() => router.push((() => {
              const de = searchParams.get('de');
              const base = estEnsemble(searchParams) ? '/ensemble' : `/site/${siteId}`;
              if (de === 'historique' || de === 'ensemble-historique') {
                return `${base}${retourHistorique(searchParams)}`;
              }
              return `${base}?onglet=transferts`;
            })())}
              className="hidden px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors sm:block">
              Fermer
            </button>
            {/* « Annuler le transfert », jamais « Annuler » : ici l'action détruit le dossier. */}
            {(transfert.etat === 'en_cours' || transfert.etat === 'preparation'
              || transfert.etat === 'expedie') && peutAnnulerDossier(ROLE_COURANT) && (
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

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
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
              [estSource ? 'Destination' : 'Origine',
                estSource ? transfert.siteDestNom : transfert.siteSourceNom],
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
        </div>

        {transfert.etat === 'preparation' && (
          <div className="flex items-start gap-2 px-4 py-3 mb-4 bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-200 dark:border-indigo-800/30 rounded-2xl">
            <Package size={15} className="text-indigo-500 shrink-0 mt-0.5" />
            <p className="text-xs text-indigo-700 dark:text-indigo-400">
              La marchandise se rassemble à {transfert.siteSourceNom} : elle est encore
              dans son stock, et rien n'a bougé.
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
            lignes ne portent pas encore de quantité reçue. */}
        {(transfert.etat === 'recu' || transfert.etat === 'traitement')
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
            {/* Tout d'un coup : le cas courant est celui où rien ne manque. */}
            {(peutExpedierIci || peutRecevoirIci) && (() => {
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
          {/* Sur téléphone, une carte par ligne.

              Le tableau pouvait porter huit colonnes : produit, unité,
              emballage, demandé, stock, expédié, reçu, boutons. Il fallait
              le faire défiler pour charger ou compter, et un défilement
              horizontal cache ce qu'il déplace. */}
          <div className="space-y-2 sm:hidden">
            {transfert.lignes.map((l, i) => {
              const diverge = l.quantiteRecue != null &&
                (l.quantiteExpediee ?? l.quantiteDemandee) !== l.quantiteRecue;
              const surplus = l.quantiteRecue != null &&
                l.quantiteRecue > (l.quantiteExpediee ?? l.quantiteDemandee);
              const dejaExp = declareExp[i] ?? 0;
              const dejaRec = declareRec[i] ?? 0;
              const attendu = peutExpedierIci
                ? l.quantiteDemandee
                : (l.quantiteExpediee ?? l.quantiteDemandee);
              const deja = peutExpedierIci ? dejaExp : dejaRec;
              const reste = Math.max(0, attendu - deja);
              const nbDecl = receptions.filter(
                r => r.ligneIndex === i && !r.annulee
                  && (r.etape ?? 'reception') === etapeCourante).length;
              const dispo = montreStock ? stockDe(l) : 0;
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

                  {/* Le trajet de la marchandise, dans l'ordre : ce qu'on a
                      demandé, ce qui est parti, ce qui est arrivé. */}
                  <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-black/[0.06] pt-2 text-[11px] dark:border-white/10">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Demandé</span>
                      <span className="font-bold text-gray-900 dark:text-gray-100">
                        {l.quantiteDemandee.toLocaleString('fr-FR')}
                      </span>
                    </span>
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
                    {aExpedie && (
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-gray-400">Reçu</span>
                        <span className={`font-bold ${!diverge
                          ? 'text-gray-900 dark:text-gray-100'
                          : surplus ? 'text-blue-500' : 'text-orange-500'}`}>
                          {peutRecevoirIci
                            ? (dejaRec > 0 ? dejaRec.toLocaleString('fr-FR') : '—')
                            : (l.quantiteRecue != null ? l.quantiteRecue.toLocaleString('fr-FR') : '—')}
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
                  </div>

                  {(peutExpedierIci || peutRecevoirIci) && (
                    <div className="mt-2.5 flex items-center gap-1.5">
                      {reste > 0 && (
                        <button onClick={() => completer(i)} disabled={enCours}
                          className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-2 text-xs font-bold text-white transition-colors disabled:opacity-40">
                          <CheckCheck size={12} /> {reste}
                        </button>
                      )}
                      <button onClick={() => { setLigneSaisie(i); setQteSaisie(0); }}
                        title="Saisir une quantité"
                        className={`flex shrink-0 items-center justify-center rounded-lg border border-gray-200 px-3 py-2 text-gray-400 transition-colors dark:border-gray-700 ${
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
                      colonnes y repousserait les quantités hors de l'écran,
                      qui sont le travail même. */}
                  <th className="hidden sm:table-cell text-center px-3 py-2.5 font-medium">Unité</th>
                  <th className="hidden sm:table-cell text-center px-3 py-2.5 font-medium">Emballage</th>
                  <th className="text-center px-3 py-2.5 font-medium">Demandé</th>
                  {/* Ce dont la source dispose : on ne charge pas à
                      l'aveugle. La colonne ne vaut que tant qu'on rassemble
                      et qu'on charge — une fois parti, le stock a bougé et
                      ce qu'il en reste ne dit plus rien de ce transfert. */}
                  {montreStock && (
                    <th className="text-center px-3 py-2.5 font-medium">Stock</th>
                  )}
                  <th className="text-center px-3 py-2.5 font-medium">Expédié</th>
                  {/* Rien ne peut être reçu avant d'être parti : la colonne
                      n'apparaît qu'une fois l'expédition faite. */}
                  {aExpedie && (
                    <th className="text-center px-3 py-2.5 font-medium">Reçu</th>
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
                {transfert.lignes.map((l, i) => {
                  const diverge = l.quantiteRecue != null &&
                    (l.quantiteExpediee ?? l.quantiteDemandee) !== l.quantiteRecue;
                  const surplus = l.quantiteRecue != null &&
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
                  const nbDecl = receptions.filter(
                    r => r.ligneIndex === i && !r.annulee
                      && (r.etape ?? 'reception') === etapeCourante).length;
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
                      {/* l'unité est elle-même un emballage, celui de contenance 1 */}
                      <td className="hidden sm:table-cell px-3 py-2.5 text-center text-gray-500">
                        {l.emballage ?? l.unite ?? 'unité'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{l.quantiteDemandee.toLocaleString('fr-FR')}</td>
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
                          déclarations ; après, il est figé sur la ligne. */}
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
                      {aExpedie && (
                      <td className="px-3 py-2.5 text-center">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`font-medium ${!diverge ? 'text-gray-600 dark:text-gray-300' : surplus ? 'text-blue-500' : 'text-orange-500'}`}>
                            {peutRecevoirIci
                              ? (dejaRec > 0 ? dejaRec.toLocaleString('fr-FR') : '—')
                              : (l.quantiteRecue != null ? l.quantiteRecue.toLocaleString('fr-FR') : '—')}
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
                      {/* Une déclaration s'ajoute, elle ne s'écrase pas.
                          Fond opaque : la cellule reste lisible quand les
                          colonnes défilent dessous. */}
                      {(peutExpedierIci || peutRecevoirIci) && (
                        <td className="sticky right-0 border-l border-gray-100 bg-white px-3 py-2.5 dark:border-gray-800 dark:bg-gray-900">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Le nombre est sur le bouton : on sait ce qu'il
                                écrira sans avoir à l'ouvrir. */}
                            {reste > 0 && (
                              <button onClick={() => completer(i)} disabled={enCours}
                                className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                                <CheckCheck size={12} /> {reste}
                              </button>
                            )}
                            <button onClick={() => { setLigneSaisie(i); setQteSaisie(0); }}
                              title="Saisir une quantité"
                              className="rounded-lg border border-gray-200 p-1.5 text-gray-400 transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700">
                              <Plus size={12} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                    {/* Le détail des déclarations : quand, combien, par qui. */}
                    {detailLigne === i && nbDecl > 0 && (
                      <tr>
                        <td colSpan={5 + (aExpedie ? 1 : 0) + (montreStock ? 1 : 0)
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
              Ce qui se compte, ce sont les lignes et les produits. */}
          <div className="flex flex-col gap-1.5 pt-3 mt-3 border-t border-gray-100 dark:border-gray-800 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Produits</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {transfert.lignes.length} ligne{transfert.lignes.length > 1 ? 's' : ''}
              </span>
            </div>
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

        {peutArreterIci && aUnEcart(lignesComptees) && (
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
      {/* Saisir une quantité partielle : on ne reçoit pas toujours tout d'un
          coup, et ce qui arrive en deux fois se déclare en deux fois. */}
      {ligneSaisie !== null && transfert.lignes[ligneSaisie] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 dark:bg-gray-900">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {peutExpedierIci ? 'Charger' : 'Recevoir'}
              </p>
              <button onClick={() => setLigneSaisie(null)}
                className="p-1 text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>

            <p className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">
              {transfert.lignes[ligneSaisie].designation}
              {transfert.lignes[ligneSaisie].varianteLibelle && (
                <span className="ml-1.5 text-gray-400">
                  {transfert.lignes[ligneSaisie].varianteLibelle}
                </span>
              )}
            </p>

            {/* Ce que la ligne attend, et ce qui a déjà été déclaré : sans eux,
                on saisit à l'aveugle. */}
            {(() => {
              const l = transfert.lignes[ligneSaisie];
              const attendu = peutExpedierIci
                ? l.quantiteDemandee
                : (l.quantiteExpediee ?? l.quantiteDemandee);
              const deja = (peutExpedierIci ? declareExp : declareRec)[ligneSaisie] ?? 0;
              return (
                <div className="mb-3 flex justify-between rounded-xl bg-gray-50 px-3 py-2 text-xs dark:bg-gray-800">
                  <span className="text-gray-400">
                    Attendu <span className="font-bold text-gray-700 dark:text-gray-200">{attendu}</span>
                  </span>
                  <span className="text-gray-400">
                    Déjà déclaré <span className="font-bold text-gray-700 dark:text-gray-200">{deja}</span>
                  </span>
                </div>
              );
            })()}

            <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
              Quantité
            </label>
            {/* Le plafond s'applique à la frappe : laisser saisir un nombre
                qu'on refusera ensuite oblige à effacer. */}
            <ChampNombre valeur={qteSaisie} min={1}
              onChange={n => setQteSaisie(etapeCourante === 'expedition'
                ? Math.min(n, Math.max(0,
                    transfert.lignes[ligneSaisie].quantiteDemandee
                    - (declareExp[ligneSaisie] ?? 0)))
                : n)}
              className="mb-4 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-center text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />

            <div className="flex gap-2">
              <button onClick={() => setLigneSaisie(null)}
                className="flex-1 rounded-xl py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
                Annuler
              </button>
              <button onClick={declarer} disabled={enCours || qteSaisie <= 0}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
