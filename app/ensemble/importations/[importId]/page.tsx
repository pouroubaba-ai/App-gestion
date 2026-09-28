'use client';
import { Fragment, useEffect, useState } from 'react';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter } from 'next/navigation';
import { Loader2, Check, Ship, ArrowRight, X, CheckCheck, Plus, Undo2, Info } from 'lucide-react';
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
  enregistrerReception, annulerReception, chargerReceptions, recuParLigne,
  type Reception,
} from '@/lib/receptions';
import {
  ETAPES_IMPORTATION, LIBELLES_IMPORTATION, AIDE_IMPORTATION,
  prochainEtat, peutAvancer, avancerImportation, annulerImportation,
  majFraisImportation,
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
  const { user } = useAuth();
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

  async function avancer() {
    if (!suivant || !user) return;
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

  const controle = controlerRepartition(dossier.lignes, frais, fraisCorrection, fraisCle);

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
              <button onClick={avancer} disabled={enCours}
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
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Marchandise</p>
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
                      </td>
                      <td className="px-3 py-2.5 text-gray-500">
                        {l.emballage ?? l.unite ?? 'unité'}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500">
                        {l.quantiteDemandee.toLocaleString('fr-FR')}
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
                        <td className="px-3 py-2.5 text-gray-500">
                          {formatMontant(l.valeurUnitaire)}
                        </td>
                        {parts && <>
                          <td className="px-3 py-2.5 text-gray-500">{formatMontant(part)}</td>
                          <td className="px-3 py-2.5 font-bold text-gray-900 dark:text-gray-100">
                            {formatMontant(Math.round(reel))}
                          </td>
                        </>}
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
                        <td colSpan={4 + (montreArgent ? (parts ? 4 : 2) : 0)
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
