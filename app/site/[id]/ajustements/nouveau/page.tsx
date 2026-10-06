'use client';
import { useEffect, useMemo, useState } from 'react';
import { useBrouillon, cleBrouillon, oublierBrouillon } from '@/lib/brouillon';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Check, SlidersHorizontal, ChevronLeft } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { produitsDuSite } from '@/lib/produits-site';
import { useAuth } from '@/lib/auth-context';
import { auteurCourant } from '@/lib/auteur';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { formatMontant } from '@/lib/format';
import { estEnsemble, racineRetour } from '@/lib/retour';
import type { LigneFlux } from '@/lib/flux-marchandise';
import SelecteurProduits, { ProduitChoisissable } from '../../components/SelecteurProduits';
import { SelectCherchable } from '@/components/Champs';
import {
  MOTIFS_AJUSTEMENT, declarerAjustement, peutDeclarer,
  type MotifAjustement,
} from '@/lib/ajustements';

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

/**
 * Déclarer un mouvement de stock sans dossier.
 *
 * Achats, ventes, transferts et retours ont leur cycle : on commande, on
 * prépare, on confirme. Il reste ce qui n'a personne en face — le rayon
 * qu'on ouvre, la caisse de tomates pourries, l'inventaire qui ne tombe
 * pas juste. Cela se constate, et c'est cet écran.
 */
export default function NouvelAjustementPage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const params = useParams();
  const siteId = params.id as string;
  const searchParams = useSearchParams();
  const vientEnsemble = estEnsemble(searchParams);
  /* On revient d'où l'on vient : les mouvements ont leur onglet, et
     renvoyer vers l'inventaire faisait sortir de la page qu'on
     consultait. */
  const retour = `${racineRetour(vientEnsemble, siteId)}?onglet=mouvements-stock`;

  const [role, setRole] = useState<RoleSite | null>(null);
  const [roleLu, setRoleLu] = useState(false);
  const [produits, setProduits] = useState<ProduitChoisissable[]>([]);
  const [nomSite, setNomSite] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /* Le motif de depart suit l'onglet d'ou l'on vient.
   *
     La page s'ouvrait toujours sur « Stock initial », une entree — meme
     quand on arrivait depuis les sorties. Il fallait rechoisir le motif
     a chaque fois, et le faire vite menait a enregistrer une entree pour
     une casse : la marchandise rentrait au lieu de sortir.
   *
     On prend le premier motif du sens demande, pas un motif nomme : la
     table reste la seule source, et ajouter un motif demain ne demandera
     rien ici. */
  const sensVoulu = searchParams.get('sens') === 'sortie' ? 'sortie' : 'entree';
  const motifInitial = (Object.entries(MOTIFS_AJUSTEMENT)
    .find(([, r]) => r.sens === sensVoulu)?.[0] ?? 'stock_initial') as MotifAjustement;
  const [motif, setMotif] = useState<MotifAjustement>(motifInitial);
  const [date, setDate] = useState(aujourdhui());
  /* La marchandise préparée survit au rechargement : les lignes
     cherchées une à une ne doivent pas disparaître parce que la page
     s'est rafraîchie. Le partenaire et la date ne se gardent pas — on
     ne réengage pas quelqu'un qu'on n'a pas revu. */
  const cleDraft = cleBrouillon('ajustement', siteId);
  const [lignes, setLignes] = useBrouillon<LigneFlux[]>(cleDraft, []);
  const [note, setNote] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(r => { setRole(r); setRoleLu(true); })
      .catch(() => setRoleLu(true));
  }, [user, siteId, activite?.adminUid]);

  useEffect(() => {
    getDoc(doc(db, 'sites', siteId))
      .then(d => setNomSite((d.data() as any)?.nom ?? null))
      .catch(() => setNomSite(null));
  }, [siteId]);

  useEffect(() => {
    if (!user) return;
    produitsDuSite(siteId)
      .then(setProduits)
      .catch(() => setProduits([]))
      .finally(() => setLoading(false));
  }, [user, siteId]);

  /* Le sens vient du motif, il ne se choisit plus à part : une péremption
     ne fait pas entrer de marchandise. */
  const regle = MOTIFS_AJUSTEMENT[motif];
  const entree = regle.sens === 'entree';
  /* Ce qu'on ne peut pas savoir ne se saisit pas : à l'ouverture du
     compte, la quantité est un fait, le coût n'en est pas un. */
  const sansCout = motif === 'stock_initial';

  /* Déclarer un stock de départ sur un rayon qui en a déjà un.
     Le motif dit « ce qui est là quand on ouvre le compte » : sur un
     produit qui a déjà bougé, c'est presque toujours une erreur de
     motif — un recomptage se déclare en correction d'inventaire. On le
     signale sans l'interdire : le responsable peut avoir de bonnes
     raisons, et un écran qui bloque sans expliquer fait chercher. */
  const dejaApprovisionnes = !sansCout ? [] : lignes
    .map(l => produits.find(x => x.id === l.produitId))
    .filter((p): p is ProduitChoisissable =>
      !!p && ((p.stock ?? 0) > 0 || (p.coutMoyen ?? 0) > 0));

  /* Le stock ne se lit qu'à la sortie : à l'entrée il ne limite rien, et
     l'afficher ferait croire qu'il borne la saisie. */
  const valides = lignes.filter(l => (l.quantiteDemandee ?? 0) > 0);
  const pret = valides.length > 0 && !enCours;

  /* Ce que l'ajustement pèse. À l'entrée, c'est ce qu'on déclare ; à la
     sortie, le coût moyen du rayon — on ne choisit pas ce que vaut ce
     qui disparaît. */
  const valeur = useMemo(() => valides.reduce((n, l) => {
    const p = produits.find(x => x.id === l.produitId);
    const unitaire = entree ? (l.valeurUnitaire ?? 0) : (p?.coutMoyen ?? 0);
    return n + unitaire * (l.quantiteDemandee ?? 0);
  }, 0), [valides, produits, entree]);

  async function enregistrer() {
    if (!user || !pret) return;
    setEnCours(true); setErreur('');
    try {
      const auteur = await auteurCourant(siteId, user.uid, user.displayName);
      /* On déclare, on n'exécute pas : le stock attendra que le
         responsable des commandes soit allé compter. */
      const id = await declarerAjustement({
        siteId, motif, date,
        lignes: valides.map(l => ({
          produitId: l.produitId,
          varianteCle: l.varianteCle ?? null,
          designation: l.designation,
          unite: l.unite ?? null,
          quantiteDeclaree: l.quantiteDemandee ?? 0,
          emballage: l.emballage ?? null,
          /* Une sortie ne porte aucun coût saisi : elle vaut ce que le
             rayon dit qu'elle vaut.

             Un stock initial non plus : il entre en quantité, sans
             valeur. Écrire zéro dirait « ça n'a rien coûté », ce qui est
             faux ; écrire un chiffre au jugé dirait « ça a coûté ça »,
             ce qui l'est tout autant. L'absence est la seule réponse
             vraie. */
          /* La case cochée le dit : cette ligne n'a pas de coût connu.
             On n'écrit alors aucun coût — ni zéro, qui se lirait
             « gratuit », ni le coût moyen du rayon, qui n'a rien à voir
             avec ce qu'on a payé. */
          ...(entree && !l.coutInconnu ? { cout: l.valeurUnitaire ?? 0 } : {}),
          /* Le prix du rayon, figé : il dit ce que la maison n'encaissera
             pas, là où le coût dit ce qu'elle avait payé. */
          prixVente: produits.find(x => x.id === l.produitId)?.prixVente ?? null,
        })),
        note: note.trim() || null,
        roleSite: role,
        parUid: user.uid,
        parNom: auteur.utilisateurNom,
      });
      /* Le brouillon a fait son office : la marchandise est
         inscrite, le garder ferait repartir d'une préparation
         déjà envoyée. */
      oublierBrouillon(cleDraft);
      router.push(`/site/${siteId}/ajustements/${id}`);
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setEnCours(false);
    }
  }

  /* Un bouton caché n'est pas une permission : la page se garde elle-même,
     puisque l'adresse s'ouvre sans passer par le bouton. */
  if (roleLu && !peutDeclarer(role)) return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Ce rôle ne touche pas au stock.</p>
      <button onClick={() => router.push(retour)}
        className="px-4 py-2 text-xs font-bold text-indigo-600 hover:underline">
        Retour
      </button>
    </div>
  );

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-900/90">
        <div className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="min-w-0">
            {/* D'où l'on vient : la page s'ouvrait sans rien dire, et l'on
                ne savait plus à quel site elle appartenait. */}
            {/* Le fil d'Ariane ramène : sur une page de saisie, il n'y a
                pas de barre de navigation, et « Annuler » en gris ne se
                lit pas comme une sortie. */}
            <button type="button" onClick={() => router.push(retour)}
              className="mb-0.5 flex max-w-full items-center gap-1 truncate text-[11px] text-gray-400 transition-colors hover:text-indigo-600">
              <ChevronLeft size={12} className="shrink-0" />
              <span className="truncate">{nomSite ?? 'Inventaire'}</span>
              <span className="px-0.5">/</span>
              <span className="truncate text-gray-300 dark:text-gray-600">Mouvement de stock</span>
            </button>
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={18} className="shrink-0 text-indigo-500" />
              <h1 className="truncate text-lg font-bold">Mouvement de stock</h1>
              {/* Le sens se lisait en gris sous le champ, trop discret pour
                  ce qu'il engage : entrer ou sortir de la marchandise ne se
                  déduit pas d'une ligne d'aide. */}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                entree
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                {entree ? 'Entrée' : 'Sortie'}
              </span>
            </div>
          </div>
          <div className="flex gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">
            <button onClick={() => router.push(retour)}
              className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
              Annuler
            </button>
            <button onClick={enregistrer} disabled={!pret}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
              {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Enregistrer
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8">

        <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          {/* Un seul choix, qui porte le sens avec lui.
           *
           * Le sens vivait dans une bascule séparée, au-dessus d'une grille
           * de dix motifs. Cela mangeait l'écran, et surtout : changer de
           * sens vide les lignes déjà saisies. Un clic de trop effaçait le
           * travail. Le motif désigne déjà son sens — une péremption ne
           * fait pas entrer de marchandise —, alors on ne demande plus
           * deux fois la même chose. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                Motif
              </p>
              <SelectCherchable
                valeur={motif}
                onChange={v => {
                  const suivant = v as MotifAjustement;
                  /* Les lignes ne se perdent qu'en changeant de sens : une
                     sortie et une entrée ne se saisissent pas pareil. */
                  if (MOTIFS_AJUSTEMENT[suivant].sens !== regle.sens) setLignes([]);
                  setMotif(suivant);
                }}
                options={(Object.keys(MOTIFS_AJUSTEMENT) as MotifAjustement[]).map(m => ({
                  valeur: m,
                  label: `${MOTIFS_AJUSTEMENT[m].sens === 'entree' ? '↙' : '↗'} ${MOTIFS_AJUSTEMENT[m].libelle}`,
                  detail: MOTIFS_AJUSTEMENT[m].aide,
                }))}
                placeholder="Choisir un motif…"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                {entree ? 'Entrée · ' : 'Sortie · '}{regle.aide}
              </p>
            </div>
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                Date
              </p>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />
            </div>
          </div>

          <div className="mt-3">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
              Note
            </p>
            <input type="text" value={note} onChange={e => setNote(e.target.value)}
              placeholder="Facultatif"
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />
          </div>

          {/* Ce qu'une sortie détruit se dit avant de valider : une perte
              grève le bénéfice, un usage interne non. */}
          {!entree && (
            <p className={`mt-3 rounded-xl p-2.5 text-[12px] ${
              regle.perte
                ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                : 'bg-gray-50 text-gray-500 dark:bg-gray-800/50 dark:text-gray-400'}`}>
              {regle.perte
                ? 'Cette sortie est une perte : elle sera retranchée du bénéfice.'
                : 'Cette sortie est une charge : la marchandise a servi, elle n’est pas perdue.'}
            </p>
          )}

          {/* Deux lignes, pas deux paragraphes : on saisit, on ne lit pas.
              Ce qu'il faut savoir tient dans la phrase ; le reste se
              découvre en faisant. */}
          {dejaApprovisionnes.length > 0 && (
            <p className="mt-3 rounded-xl bg-orange-50 p-2.5 text-[12px] text-orange-700 dark:bg-orange-900/20 dark:text-orange-400">
              <span className="font-bold">
                {dejaApprovisionnes.length === 1
                  ? `« ${dejaApprovisionnes[0].designation} » a déjà du stock.`
                  : `${dejaApprovisionnes.length} produits ont déjà du stock.`}
              </span>{' '}
              Pour recompter, prenez « Correction d’inventaire ».
            </p>
          )}

          {sansCout && (
            <p className="mt-3 rounded-xl bg-indigo-50 p-2.5 text-[12px] text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300">
              Si vous ne savez pas ce qu’un produit a coûté, cochez
              « Coût inconnu » : le prochain achat le renseignera.
            </p>
          )}
        </div>

        <div className="mt-4">
          <SelecteurProduits
            produits={produits}
            lignes={lignes}
            onChange={setLignes}
            /* Une sortie se valorise au coût moyen du rayon. Laisser saisir
               un coût ici permettrait de décider soi-même ce que valait la
               marchandise qui disparaît — donc d'inventer une perte.

               Le stock initial, lui, garde son champ mais ne le remplit
               pas d'avance : sur certaines références le responsable a la
               facture, sur d'autres il ne l'a pas. Ce qu'il sait, il
               l'écrit ; ce qu'il ignore, il le laisse vide — et le coût
               de cette ligne-là reste inconnu jusqu'au premier achat.

               Ce qu'on évite est le chiffre posé au jugé pour remplir la
               case : il pèserait dans le coût moyen comme un coût réel,
               et la première facture ne compterait plus que pour une
               part — sur 922 unités d'origine et 375 achetées, elle n'en
               ferait que 29 %. */
            coutEditable={entree}
            coutVideParDefaut={sansCout}
            coutInconnuPossible={sansCout}
            coutInconnuParDefaut={sansCout}
            montrerStock={!entree}
            labelCout={entree ? 'Coût unitaire' : 'Coût moyen'}
          />
        </div>

        {valides.length > 0 && (
          <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-gray-400">
                {valides.length} ligne{valides.length > 1 ? 's' : ''}
              </span>
              <span className="text-sm font-bold">
                {formatMontant(valeur)}
              </span>
            </div>
          </div>
        )}

        {erreur && (
          <p className="mt-3 rounded-xl bg-red-50 p-2.5 text-[12px] text-red-600 dark:bg-red-900/20 dark:text-red-400">
            {erreur}
          </p>
        )}
      </div>
    </div>
  );
}
