'use client';

/**
 * Un retour, et ce qu'on peut en faire.
 *
 * Le même écran pour deux métiers. Celui qui a ouvert le dossier le
 * regarde avancer sans pouvoir le confirmer ; celui qui traite le fait
 * avancer sans l'avoir décidé. C'est cette séparation qui ferme la
 * fraude : un retour déclaré mais jamais parti reste sous les yeux de
 * celui qui aurait dû le voir partir.
 *
 * La dernière étape ne ressemble pas aux autres. Les précédentes ne font
 * que déplacer un état ; celle-là fait bouger le stock, éteint des dettes
 * ou envoie de l'argent au caissier. Elle a donc son bouton, son ton, et
 * son refus quand c'est le mauvais qui la demande.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { auteurCourant } from '@/lib/auteur';
import LigneTotal from '../../components/LigneTotal';
import { retourHistorique } from '@/lib/retour';
import { formatMontant } from '@/lib/format';
import {
  Loader2, ArrowLeft, Check, X, ChevronRight, Undo2, AlertTriangle,
} from 'lucide-react';
import {
  chargerRetour, avancerRetour, confirmerRetour, annulerRetour,
  annulable, etatFinal, ETAPES_RETOUR, LIBELLES_ETAT_RETOUR, peutTraiter,
  type DossierRetour,
} from '@/lib/retours-dossiers';

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function FicheRetourPage() {
  const { user, activite, profile } = useAuth();
  const router = useRouter();
  const params = useParams();
  const siteId = params.id as string;
  const retourId = params.retourId as string;
  const searchParams = useSearchParams();
  /* L'origine se transmet au dossier choisi : « Fermer » doit encore
     savoir d'où l'on venait. */
  const search = searchParams.toString();

  const [d, setD] = useState<DossierRetour | null>(null);
  const [role, setRole] = useState<RoleSite | null>(null);
  const [loading, setLoading] = useState(true);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  const [confirmeAnnul, setConfirmeAnnul] = useState(false);
  const [motifAnnul, setMotifAnnul] = useState('');
  const [bilan, setBilan] = useState<string | null>(null);

  /**
   * Qui voit l'argent.
   *
   * Le responsable des commandes constate une marchandise : il compte des
   * sacs, pas des francs. Lui montrer ce que vaut le retour ne l'aide pas
   * à faire son travail et lui apprend ce que le site doit — or c'est
   * précisément la séparation qui fait tenir le cycle. Le gérant, qui a
   * décidé du retour, et le propriétaire gardent les montants.
   */
  const voitLArgent = role !== 'commandes';
  const totalQuantite = (d?.lignes ?? [])
    .reduce((n, l) => n + (l.quantite ?? 0), 0);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      chargerRetour(retourId),
      roleSurSite(user.uid, siteId, activite?.adminUid),
    ])
      .then(([dossier, r]) => { setD(dossier); setRole(r); })
      .catch(() => setD(null))
      .finally(() => setLoading(false));
  }, [user, retourId, siteId, activite?.adminUid]);

  async function recharger() {
    const frais = await chargerRetour(retourId);
    setD(frais);
  }

  async function avancer() {
    if (!d || !user) return;
    setEnCours(true); setErreur('');
    try {
      /* Le nom vient de la fiche du site, pas du profil du compte : le
         profil porte parfois l'email en guise de nom, et le registre
         affichait alors une adresse là où on attend une personne. */
      const a = await auteurCourant(siteId, user.uid, profile?.nom ?? user.email);
      await avancerRetour({
        dossier: d, parUid: user.uid,
        parNom: a.utilisateurNom,
        roleSite: role,
      });
      await recharger();
    } catch (e: any) {
      setErreur(e?.message ?? 'L’opération a échoué.');
    } finally { setEnCours(false); }
  }

  async function confirmer() {
    if (!d || !user) return;
    setEnCours(true); setErreur('');
    try {
      /* La confirmation signe un mouvement que le caissier lira : il doit
         y voir une personne et sa fonction, pas une adresse électronique. */
      const a = await auteurCourant(siteId, user.uid, profile?.nom ?? user.email);
      const r = await confirmerRetour({
        dossier: d, parUid: user.uid,
        parNom: a.utilisateurNom,
        utilisateurFonction: a.utilisateurFonction,
        adminUid: activite?.adminUid ?? null,
        roleSite: role,
      });
      /* Aux commandes on annonce le stock, pas l'argent : c'est leur
         effet à eux, et le seul qu'ils puissent constater. */
      setBilan(
        !voitLArgent
          ? 'Le stock a été mis à jour.'
          : r.rembourse > 0
          ? `${formatMontant(r.rembourse)} partent en caisse, à confirmer par le caissier.`
          : r.deduit > 0
          ? `${formatMontant(r.deduit)} imputés sur les factures les plus anciennes.`
          : 'Le stock a été mis à jour.');
      await recharger();
    } catch (e: any) {
      setErreur(e?.message ?? 'La confirmation a échoué.');
    } finally { setEnCours(false); }
  }

  async function annuler() {
    if (!d || !user) return;
    setEnCours(true); setErreur('');
    try {
      const a = await auteurCourant(siteId, user.uid, profile?.nom ?? user.email);
      await annulerRetour({
        dossier: d, parUid: user.uid,
        parNom: a.utilisateurNom,
        motif: motifAnnul,
      });
      setConfirmeAnnul(false);
      await recharger();
    } catch (e: any) {
      setErreur(e?.message ?? 'L’annulation a échoué.');
    } finally { setEnCours(false); }
  }

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  /* Un retour introuvable est un retour introuvable.
   *
   * Il a existé des mouvements de retour qui portaient le `documentId`
   * du bon qu'ils défaisaient — une adresse d'historique pouvait donc
   * viser un achat. Ce n'est plus le cas : chaque retour est un document
   * qui se désigne lui-même. Les liens restés dans d'anciennes lignes
   * mènent ici, et l'on renvoie à la liste plutôt que de deviner. */
  if (!d) return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-900/90">
        <div className="w-full px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Retour introuvable
            </h1>
            <button type="button"
              onClick={() => router.push(`/site/${siteId}?onglet=retours`)}
              className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
              Fermer
            </button>
          </div>
        </div>
      </header>

      <div className="w-full px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <div className="rounded-2xl border border-gray-100 bg-white p-10 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
            Ce dossier de retour n’existe pas.
          </p>
          <button type="button"
            onClick={() => router.push(`/site/${siteId}?onglet=retours`)}
            className="mt-5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700">
            Voir les retours
          </button>
        </div>
      </div>
    </div>
  );

  const etapes = ETAPES_RETOUR[d.type];
  const i = etapes.indexOf(d.etat);
  const clos = d.etat === etatFinal(d.type) || d.etat === 'annule';
  /* L'avant-dernière étape mène à la confirmation, qui fait tout bouger :
     elle ne se franchit pas comme les autres. */
  const aConfirmer = i === etapes.length - 2;
  /* Jamais celui qui a décidé. L'écriture le refuse aussi — un bouton
     caché n'est pas une permission — mais le dire ici évite un clic qui
     ne pouvait que échouer. */
  const sonPropreDossier = d.parUid === user?.uid;
  /* Un retour confirmé qui n'a rien éteint ni rien rendu n'a pas été
     réglé : la marchandise est rentrée, mais la dette n'a pas bougé.
     On offre de reprendre le règlement seul — le stock, lui, ne se
     rejoue jamais. */
  const aRegler = d.etat === etatFinal(d.type) && d.type !== 'transfert'
    && (d.deduit ?? 0) <= 0 && (d.rembourse ?? 0) <= 0;
  /* La même règle que pour ouvrir ou annuler un retour, posée ici plutôt
     qu'importée : la tirer de l'onglet des retours créait un import croisé
     entre deux composants clients, et la page tombait à l'exécution sur un
     « peutOuvrirRetour is not defined ». */
  const peutReprendre = role === null || role === undefined || role === 'gerant';

  /* On revient d'où l'on vient.
   *
   * Un retour s'ouvre depuis son onglet, mais aussi depuis l'historique
   * ou depuis la vue d'ensemble. Renvoyer toujours au même endroit ferait
   * perdre la liste qu'on parcourait. L'origine voyage dans l'URL, seul
   * endroit qui survit à un rechargement. */
  const origine = searchParams.get('de');
  const fermer = origine === 'historique' || origine === 'ensemble-historique'
    ? `${origine === 'ensemble-historique' ? '/ensemble' : `/site/${siteId}`}${retourHistorique(searchParams)}`
    : `${origine === 'ensemble' ? '/ensemble' : `/site/${siteId}`}?onglet=retours&retours=${d.type}`;

  return (
    /* La même page qu'un achat ou une vente : fond gris, en-tête collant,
       pleine largeur. Une fiche ouverte depuis l'historique ne doit pas
       changer d'aspect selon le dossier qu'on regarde. */
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">

      {/* Les actions restent atteignables pendant qu'on parcourt les
          lignes : sur un long dossier, il faudrait sinon remonter. */}
      <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-900/90">
        <div className="w-full px-4 py-3 sm:px-6 lg:px-8">
          <div className="sm:flex sm:items-center sm:justify-between sm:gap-3">
            <div className="flex items-center gap-2">
              {/* La flèche ne paraît que sur téléphone : au bureau,
                  « Fermer » reste plus clair qu'un chevron isolé. */}
              <button type="button" onClick={() => router.push(fermer)}
                title="Fermer"
                className="-ml-1 shrink-0 rounded-xl p-2 text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 sm:hidden">
                <ArrowLeft size={18} />
              </button>

              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-bold text-gray-900 dark:text-gray-100">
                  {d.reference}
                </h1>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${
                  d.etat === 'annule'
                    ? 'bg-gray-100 text-gray-500 dark:bg-gray-800'
                    : clos
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                  {LIBELLES_ETAT_RETOUR[d.etat]}
                </span>
              </div>
            </div>

            {/* L'action du dossier vit dans l'en-tête, comme sur un achat
                ou une vente : elle reste sous la main pendant qu'on
                parcourt les lignes, au lieu d'attendre en bas de page. */}
            <div className="mt-2.5 flex gap-2 [&>button]:flex-1 [&>button]:justify-center sm:mt-0 sm:[&>button]:flex-none">
              <button type="button" onClick={() => router.push(fermer)}
                className="hidden rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 sm:block">
                Fermer
              </button>

              {/* Le responsable des commandes fait avancer, il n'annule
                  pas : annuler défait une décision qu'il n'a pas prise.
                  Cela reste au gérant et au propriétaire. */}
              {/* Réparer une écriture manquante n'est pas confirmer un
                  retour : le cycle est déjà allé à son terme, et le
                  responsable des commandes a constaté la marchandise. Ce
                  qui manque est comptable, donc cela revient à qui
                  répond des comptes — le gérant et le propriétaire, les
                  mêmes qui peuvent annuler. */}
              {aRegler && peutReprendre && (
                <button type="button" onClick={confirmer} disabled={enCours}
                  title="La marchandise est rentrée, mais aucune écriture n’a suivi."
                  className="flex items-center gap-1.5 rounded-xl bg-amber-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-amber-700 disabled:opacity-40">
                  {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  Reprendre le règlement
                </button>
              )}

              {!clos && peutTraiter(role) && (
                aConfirmer ? (
                  <button type="button" onClick={confirmer}
                    disabled={enCours || sonPropreDossier}
                    title={sonPropreDossier
                      ? 'On ne confirme pas le retour qu’on a ouvert soi-même.'
                      : undefined}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                    {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    Confirmer · {LIBELLES_ETAT_RETOUR[etatFinal(d.type)]}
                  </button>
                ) : (
                  <button type="button" onClick={avancer} disabled={enCours}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                    {enCours ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
                    Passer à « {LIBELLES_ETAT_RETOUR[etapes[i + 1]]} »
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="w-full px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      {/* Le chemin parcouru, et ce qui reste. Un dossier qui n'avance pas
          se voit alors sans lire les dates. */}
      {d.etat !== 'annule' && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {etapes.map((e, n) => (
            <span key={e} className="flex items-center gap-1.5">
              <span className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${
                n <= i
                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
                  : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>
                {LIBELLES_ETAT_RETOUR[e]}
              </span>
              {n < etapes.length - 1 && (
                <ChevronRight size={12} className="text-gray-300" />
              )}
            </span>
          ))}
        </div>
      )}

      {/* Les mêmes tuiles que sur un achat ou une vente, dans la même
          carte : posées à nu sur le fond gris, elles flottaient, alors
          que la fiche d'une vente les encadre. Deux dossiers ouverts
          depuis le même historique doivent se ressembler. */}
      <div className="mb-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4 sm:gap-2">
        <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
          <p className="truncate text-gray-400">
            {d.type === 'transfert' ? 'Site lié' : 'Partenaire'}
          </p>
          <p className="truncate font-medium text-gray-700 dark:text-gray-300">
            {d.partenaireNom ?? '—'}
          </p>
        </div>
        <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
          <p className="truncate text-gray-400">Produits</p>
          <p className="font-medium text-gray-700 dark:text-gray-300">
            {d.lignes.length} ligne{d.lignes.length > 1 ? 's' : ''}
          </p>
        </div>
        <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
          <p className="truncate text-gray-400">Ouvert</p>
          <p className="font-medium text-gray-700 dark:text-gray-300">
            {formatDate(d.date)}
          </p>
        </div>
        {/* La quatrième tuile dit ce que chacun doit savoir : ce que le
            retour vaut, ou ce qu'il y a à sortir du dépôt. */}
        <div className="rounded-xl bg-gray-50 px-3 py-1.5 dark:bg-gray-800/50 sm:py-2">
          <p className="truncate text-gray-400">
            {voitLArgent ? 'Règlement' : 'À sortir'}
          </p>
          <p className="truncate font-medium text-gray-700 dark:text-gray-300">
            {voitLArgent
              ? (d.type === 'transfert'
                  ? '—'
                  /* Avant confirmation, le règlement n'est qu'une
                     intention : elle ne porte que sur un éventuel
                     surplus. On la donne au futur pour ne pas la faire
                     passer pour un fait accompli. */
                  : d.rembourse != null
                    ? (d.rembourse > 0
                        ? `Remboursé ${formatMontant(d.rembourse)}`
                        : 'Porté sur la dette')
                    : d.reglement === 'deduire'
                      ? 'Surplus sur la dette'
                      : 'Surplus remboursé')
              : `${totalQuantite} article${totalQuantite > 1 ? 's' : ''}`}
          </p>
        </div>
      </div>

        <p className="mt-2 text-[11px] text-gray-400">
          Ouvert par {d.parNom ?? '—'}
        </p>
      </div>

      <div className="mb-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Marchandise
          </p>
          <span className="text-xs font-medium text-gray-400">
            {d.lignes.length} ligne{d.lignes.length > 1 ? 's' : ''}
          </span>
        </div>

        {/* Sur téléphone, une carte par ligne : le tableau y demanderait
            un défilement latéral, et ce qu'on déplace, on ne le voit
            plus. Les mêmes données, empilées. */}
        <div className="space-y-2 sm:hidden">
          {d.lignes.map((l, n) => (
            <div key={n} className="rounded-xl border border-gray-100 p-3 dark:border-gray-800">
              <p className="text-[13px] font-medium text-gray-900 dark:text-gray-100">
                {l.designation}
              </p>
              {l.emballage && (
                <p className="text-[11px] text-gray-400">{l.emballage}</p>
              )}
              <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                <span className="text-gray-400">
                  Qté <span className="font-bold text-gray-900 dark:text-gray-100">{l.quantite}</span>
                </span>
                {voitLArgent && (
                  <>
                    <span className="text-gray-400">
                      Coût <span className="text-gray-500">{formatMontant(l.cout ?? 0)}</span>
                    </span>
                    <span className="text-gray-400">
                      Prix <span className="text-gray-600 dark:text-gray-300">{formatMontant(l.prixUnitaire)}</span>
                    </span>
                    <span className="text-gray-400">
                      Total <span className="font-bold text-gray-900 dark:text-gray-100">
                        {formatMontant(l.quantite * l.prixUnitaire)}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Au-delà du téléphone, le tableau : la largeur y est, et une
            grille se lit mieux que des cartes quand on compare. */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full whitespace-nowrap text-sm">
            <thead>
              {/* Les mêmes colonnes que sur une vente ou un transfert :
                  une sortie se lit toujours de la même façon, quel que
                  soit son motif. Le transfert n'a pas de prix — sa
                  colonne reste, à zéro, et c'est le coût qui porte la
                  valeur de ce qui part. */}
              <tr className="bg-indigo-600 text-white">
                <th className="px-3 py-2.5 text-center font-medium">Produit</th>
                <th className="hidden px-3 py-2.5 text-center font-medium sm:table-cell">Unité</th>
                <th className="hidden px-3 py-2.5 text-center font-medium sm:table-cell">Emballage</th>
                <th className="px-3 py-2.5 text-center font-medium">Quantité</th>
                {voitLArgent && (
                  <>
                    <th className="px-3 py-2.5 text-center font-medium">Coût</th>
                    <th className="px-3 py-2.5 text-center font-medium">Prix unitaire</th>
                    <th className="px-3 py-2.5 text-center font-medium">Total</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {d.lignes.map((l, n) => (
                <tr key={n}>
                  <td className="px-3 py-3 text-center text-gray-900 dark:text-gray-100">
                    {l.designation}
                  </td>
                  <td className="hidden px-3 py-3 text-center text-gray-400 sm:table-cell">
                    {l.unite ?? '—'}
                  </td>
                  <td className="hidden px-3 py-3 text-center text-gray-400 sm:table-cell">
                    {l.emballage ?? '—'}
                  </td>
                  <td className="px-3 py-3 text-center font-bold text-gray-900 dark:text-gray-100">
                    {l.quantite}
                  </td>
                  {voitLArgent && (
                    <>
                      {/* Le coût s'efface : il éclaire le prix sans le
                          concurrencer. */}
                      <td className="px-3 py-3 text-center text-gray-400">
                        {formatMontant(l.cout ?? 0)}
                      </td>
                      <td className="px-3 py-3 text-center text-gray-600 dark:text-gray-300">
                        {formatMontant(l.prixUnitaire)}
                      </td>
                      <td className="px-3 py-3 text-center font-bold text-gray-900 dark:text-gray-100">
                        {formatMontant(l.quantite * l.prixUnitaire)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Les totaux alignés à droite, en pointillés : la même lecture
            que sur un achat ou une vente. */}
        <div className="mt-4 flex justify-end border-t border-gray-100 pt-4 dark:border-gray-800">
          <div className="w-full space-y-1.5 text-sm sm:max-w-xs">
            <LigneTotal label="Articles" valeur={String(totalQuantite)} />
            {voitLArgent && (
              <LigneTotal label="Valeur" valeur={formatMontant(d.valeurTotale)}
                classeValeur="font-bold text-gray-900 dark:text-gray-100" />
            )}
            {/* Ce que le retour a fait, une fois qu'il l'a fait.
             *
             * Ces deux lignes affichaient `valeurTotale` sous l'étiquette
             * du règlement choisi : un retour marqué « Remboursé »
             * annonçait donc sa valeur entière à rembourser, alors qu'un
             * retour éteint d'abord la dette du bon qu'il défait et ne
             * rend que le surplus — le plus souvent rien. Tant que le
             * dossier n'est pas confirmé, `deduit` et `rembourse` sont à
             * null : on ne montre alors que la valeur, sans promettre un
             * partage qui n'a pas eu lieu. */}
            {voitLArgent && d.type !== 'transfert' && d.deduit != null && (
              <LigneTotal label="Éteint la dette"
                valeur={formatMontant(d.deduit)}
                classeValeur="font-medium text-gray-600 dark:text-gray-300" />
            )}
            {voitLArgent && d.type !== 'transfert' && d.rembourse != null
              && d.rembourse > 0 && (
              <LigneTotal label="Remboursé"
                valeur={formatMontant(d.rembourse)}
                classeValeur="font-bold text-green-600" />
            )}
          </div>
        </div>

        {d.motif && (
          <p className="mt-3 border-t border-gray-100 pt-3 text-[12px] text-gray-500 dark:border-gray-800">
            <span className="text-gray-400">Motif </span>{d.motif}
          </p>
        )}
      </div>

      {clos && d.etat !== 'annule' && (
        <div className="mt-4 rounded-2xl border border-green-200 bg-green-50 p-4 dark:border-green-800/30 dark:bg-green-900/10">
          <p className="text-[13px] font-medium text-green-800 dark:text-green-400">
            Confirmé par {d.confirmeParNom ?? '—'} le {formatDate(d.confirmeA)}.
            {voitLArgent && (d.deduit ?? 0) > 0 && ` ${formatMontant(d.deduit!)} imputés sur les dettes.`}
            {voitLArgent && (d.rembourse ?? 0) > 0 && ` ${formatMontant(d.rembourse!)} partis en caisse.`}
          </p>
        </div>
      )}

      {d.etat === 'annule' && (
        <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/40">
          <p className="text-[13px] text-gray-600 dark:text-gray-300">
            Annulé par {d.annuleParNom ?? '—'}
            {d.motifAnnulation ? ` — ${d.motifAnnulation}` : ''}.
            Rien n’a bougé.
          </p>
        </div>
      )}

      {bilan && (
        <p className="mt-3 rounded-xl bg-indigo-50 p-3 text-xs font-medium text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300">
          {bilan}
        </p>
      )}

      {erreur && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-xs font-medium text-red-600 dark:bg-red-900/20">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {erreur}
        </p>
      )}

      {/* Le gérant et le propriétaire ouvrent, ils ne font pas avancer :
          dire « c'est prêt », puis « c'est parti », revient à celui qui
          manipule la marchandise. Ils gardent l'annulation — défaire sa
          propre décision tant que rien n'a bougé leur appartient. */}
      {!clos && !peutTraiter(role) && annulable(d) && (
        <button type="button" onClick={() => setConfirmeAnnul(true)}
          disabled={enCours}
          className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-xl border border-gray-200 px-4 py-3 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700">
          <X size={15} /> Annuler ce retour
        </button>
      )}

      {!clos && !peutTraiter(role) && (
        <p className="mt-2 text-[11px] text-gray-400">
          Le responsable des commandes traite ce retour et le confirme.
        </p>
      )}

      {sonPropreDossier && aConfirmer && !clos && peutTraiter(role) && (
        <p className="mt-2 text-[11px] text-gray-400">
          Vous avez ouvert ce retour : un autre doit le confirmer.
        </p>
      )}
      </div>

      {confirmeAnnul && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setConfirmeAnnul(false)}>
          <div onClick={e => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl bg-white p-5 dark:bg-gray-900">
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
              Annuler ce retour ?
            </p>
            <p className="mt-1 text-xs text-gray-400">
              La marchandise n’a pas encore changé de mains : rien ne sera
              défait. Le dossier reste au registre, annulé.
            </p>
            <input value={motifAnnul} onChange={e => setMotifAnnul(e.target.value)}
              placeholder="Pourquoi ? (facultatif)"
              className="mt-3 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800" />
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setConfirmeAnnul(false)}
                className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-xs font-bold text-gray-600 dark:border-gray-700">
                Garder
              </button>
              <button type="button" onClick={annuler} disabled={enCours}
                className="flex-1 rounded-xl bg-red-500 px-3 py-2.5 text-xs font-bold text-white hover:bg-red-600 disabled:opacity-40">
                Annuler le retour
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
