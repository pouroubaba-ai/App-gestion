'use client';
import { useVueUrl } from '@/lib/vue-url';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, ArrowDownLeft, ArrowUpRight, Download } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { auteurCourant } from '@/lib/auteur';
import { marqueOrigine } from '@/lib/retour';
import { hankenGrotesk } from './finance/font';
import { formatMontant } from '@/lib/format';
import { ChampRecherche } from '@/components/Champs';
import ListeDossiers, { type Colonne } from './ListeDossiers';
import RangeeEtapes from './RangeeEtapes';
import {
  MOTIFS_AJUSTEMENT, LIBELLES_ETAT_AJUSTEMENT, ETAPES_AJUSTEMENT,
  chargerAjustements, peutDeclarer, enCoursAjustement,
  type DossierAjustement, type EtatAjustement, type SensAjustement,
} from '@/lib/ajustements';
import type { Portee } from '@/lib/portee';
import { detentionsDe } from '@/lib/produits-site';
import {
  produitsDeLActivite, declarerStockInitial, quantitesReprise,
} from '@/lib/reprise-catalogue';

const SENS: { cle: SensAjustement; label: string; icone: typeof ArrowDownLeft }[] = [
  { cle: 'entree', label: 'Entrées', icone: ArrowDownLeft },
  { cle: 'sortie', label: 'Sorties', icone: ArrowUpRight },
];

/**
 * Les mouvements de stock déclarés.
 *
 * Même forme que les retours, et pour la même raison : ce sont des
 * dossiers qui attendent un geste. On ne lit pas cette page pour savoir
 * ce qu'il reste en rayon — l'inventaire le dit — mais pour voir ce que
 * personne n'est encore allé compter.
 */
export default function ListeMouvementsStock({
  portee, siteEcriture, ensemble, titre, role: roleRecu,
}: {
  portee: Portee;
  /** le site où écrire, `null` en vue d'ensemble */
  siteEcriture: string | null;
  ensemble: boolean;
  titre?: string;
  role?: RoleSite | null;
}) {
  const { user, activite } = useAuth();
  const router = useRouter();
  const [dossiers, setDossiers] = useState<DossierAjustement[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<RoleSite | null>(roleRecu ?? null);
  /* On ouvre sur les entrées : c'est par là qu'un rayon se garnit, et
     l'écran s'ouvrait sur les sorties — vide — pendant qu'un dossier
     d'entrée attendait juste à côté. */
  const [sens, setSens] = useState<SensAjustement>('entree');
  /* Deux façons de lire la même chose. Les dossiers répondent « qu'est-ce
     qui attend un geste » ; les motifs répondent « où part la
     marchandise » — trois cartons cassés et deux cents ne se lisent pas
     dans une liste de références. Le responsable des commandes n'a que
     les dossiers : c'est eux qu'il va compter. */
  const [vue, setVue] = useVueUrl<'dossiers' | 'motifs'>(
    'axe', 'dossiers', ['dossiers', 'motifs']);
  const [recherche, setRecherche] = useState('');
  /* Échafaudage d'essai : déclarer d'un coup le stock de départ d'un
     catalogue qu'on vient de charger. Part avec le test. */
  const [produits, setProduits] = useState<{ id: string; designation: string }[]>([]);
  const [couts, setCouts] = useState<Map<string, number>>(new Map());
  const [depart, setDepart] = useState(false);
  const [departFait, setDepartFait] = useState<string | null>(null);

  useEffect(() => {
    chargerAjustements(portee)
      .then(setDossiers)
      .catch(() => setDossiers([]))
      .finally(() => setLoading(false));
  }, [portee]);

  useEffect(() => {
    if (!activite?.id) return;
    produitsDeLActivite(activite.id)
      .then(setProduits)
      .catch(() => setProduits([]));
  }, [activite?.id]);

  /* Le coût d'une sortie vit dans le rayon, pas sur la ligne : la ligne
     ne le porte qu'à l'entrée, où il se saisit. Sans cette lecture, les
     cartes des sorties afficheraient zéro. */
  useEffect(() => {
    detentionsDe(portee)
      .then(d => setCouts(new Map(
        d.map(x => [x.produitId, x.coutMoyen ?? 0]))))
      .catch(() => setCouts(new Map()));
  }, [portee]);

  useEffect(() => {
    if (roleRecu !== undefined) { setRole(roleRecu); return; }
    if (!user || !siteEcriture) return;
    roleSurSite(user.uid, siteEcriture, activite?.adminUid)
      .then(setRole)
      .catch(() => setRole(null));
  }, [user, siteEcriture, activite?.adminUid, roleRecu]);

  /* Le responsable des commandes compte des sacs, pas des francs : ce
     qu'une perte coûte au site ne regarde pas celui qui la constate. La
     même règle que sur les retours. */
  const voitLArgent = role !== 'commandes';

  const duSens = dossiers.filter(d => d.sens === sens);
  const parEtat = (e: EtatAjustement) => duSens.filter(d => d.etat === e).length;
  /* Ce que pèse chaque étape, en argent.
   *
   * Un compte dit combien de dossiers attendent, jamais ce qu'ils
   * engagent : trois sacs cassés et deux cents n'appellent pas la même
   * attention. Rien ne se vend ici, donc on compte au coût — ce que la
   * marchandise a valu, pas ce qu'elle aurait rapporté. */
  const quantiteEtat = (e: EtatAjustement) => duSens
    .filter(d => d.etat === e)
    .reduce((n, d) => n + quantiteDossier(d), 0);

  /* Ce que pèse un dossier, en argent.
   *
   * Un seul endroit le calcule : les cartes d'étape, la colonne du
   * tableau et le regroupement par motif lisent tous cette fonction. Deux
   * calculs séparés finiraient par donner deux chiffres pour le même
   * dossier. */
  const valeurDossier = (d: DossierAjustement) =>
    d.lignes.reduce((m, l) => {
      const q = d.etat === 'confirme'
        ? (l.quantiteConstatee ?? 0) : l.quantiteDeclaree;
      /* À l'entrée, le coût est sur la ligne ; à la sortie, il vient du
         rayon. On prend celui qui existe. */
      return m + q * (l.cout ?? couts.get(l.produitId) ?? 0);
    }, 0);

  const quantiteDossier = (d: DossierAjustement) =>
    d.lignes.reduce((n, l) => n + (d.etat === 'confirme'
      ? (l.quantiteConstatee ?? 0) : l.quantiteDeclaree), 0);

  const valeurEtat = (e: EtatAjustement) => duSens
    .filter(d => d.etat === e)
    .reduce((n, d) => n + valeurDossier(d), 0);

  /* Ce que chaque motif pèse, sur le sens regardé.
   *
   * Seuls les dossiers confirmés comptent. Un motif dit ce que la maison
   * a perdu ou gagné par cette voie — ce qui est réellement sorti du
   * rayon. Une casse déclarée n'a encore rien cassé : la marchandise est
   * là, personne n'est allé compter, et l'inscrire gonflerait la perte
   * d'un dossier qui peut être annulé ou corrigé au comptage. C'est la
   * confirmation qui fait le fait.
   *
   * Les motifs sans aucun dossier confirmé ne paraissent pas : une ligne
   * à zéro n'apprend rien. Ce qui attend se lit dans la vue dossiers, et
   * dans les cartes d'étape juste au-dessus. */
  const parMotif = Object.entries(MOTIFS_AJUSTEMENT)
    .filter(([, r]) => r.sens === sens)
    .map(([cle, regle]) => {
      const siens = duSens.filter(d => d.motif === cle && d.etat === 'confirme');
      return {
        cle, regle,
        nb: siens.length,
        quantite: siens.reduce((n, d) => n + quantiteDossier(d), 0),
        valeur: siens.reduce((n, d) => n + valeurDossier(d), 0),
        /* Ce qui n'a pas encore été confirmé sur ce motif : pas compté
           dans la valeur, mais dit à part — sinon on croirait qu'il n'y
           a rien en route. */
        attente: duSens.filter(
          d => d.motif === cle && d.etat !== 'confirme' && d.etat !== 'annule').length,
      };
    })
    .filter(m => m.nb > 0 || m.attente > 0)
    .sort((a, b) => b.valeur - a.valeur || b.nb - a.nb);

  const totalMotifs = parMotif.reduce((n, m) => n + m.valeur, 0);

  const terme = recherche.trim().toLowerCase();
  const affiches = duSens.filter(d => !terme
    || d.reference.toLowerCase().includes(terme)
    || (MOTIFS_AJUSTEMENT[d.motif]?.libelle ?? '').toLowerCase().includes(terme)
    || d.lignes.some(l => l.designation.toLowerCase().includes(terme)));

  const colonnes: Colonne<DossierAjustement>[] = [
    {
      cle: 'reference', label: 'Référence', rang: 'titre',
      rendu: d => <span className="font-mono text-xs">{d.reference}</span>,
    },
    {
      cle: 'etat', label: 'État', rang: 'marque',
      rendu: d => (
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
          d.etat === 'confirme'
            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            : d.etat === 'annule'
            ? 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
          {LIBELLES_ETAT_AJUSTEMENT[d.etat]}
        </span>
      ),
    },
    {
      cle: 'motif', label: 'Motif', rang: 'corps',
      rendu: d => MOTIFS_AJUSTEMENT[d.motif]?.libelle ?? d.motif,
    },
    {
      cle: 'produits', label: 'Produits', rang: 'corps',
      rendu: d => d.lignes.length,
    },
    {
      cle: 'quantite', label: 'Quantité', rang: 'corps',
      /* Le constaté ne s'affiche qu'une fois confirmé : avant, il
         annoncerait un comptage qui n'a pas eu lieu. */
      rendu: d => <span className="font-bold">{quantiteDossier(d)}</span>,
    },
    /* Ce que le mouvement engage. Le responsable des commandes compte des
       sacs, pas des francs : la colonne ne paraît pas pour lui. */
    ...(voitLArgent ? [{
      cle: 'valeur', label: 'Valeur', rang: 'corps' as const,
      rendu: (d: DossierAjustement) => (
        <span className="font-bold">{formatMontant(valeurDossier(d))}</span>
      ),
    }] : []),
    {
      cle: 'par', label: 'Déclaré par', rang: 'pied',
      rendu: d => d.parNom ?? '—',
    },
    {
      cle: 'date', label: 'Date', rang: 'pied',
      rendu: d => (d.date ?? '').split('-').reverse().join('/'),
    },
  ];

  /* Le stock de départ n'a de sens qu'une fois : tant qu'aucun produit
     n'existe, il n'y a rien à déclarer ; une fois déclaré, le dossier
     est là et le refaire doublerait le rayon. */
  const dejaDeclare = dossiers.some(d => d.motif === 'stock_initial');
  const peutDeclarerDepart = produits.length > 0 && !dejaDeclare
    && sens === 'entree' && siteEcriture && peutDeclarer(role);

  async function declarerDepart() {
    if (!siteEcriture || !user || depart) return;
    setDepart(true);
    try {
      /* Qui déclare doit être nommé.
       *
       * Le dossier s'inscrivait au nom de « Reprise », qui n'est
       * personne. Or c'est sur cet auteur que repose la séparation : on
       * ne confirme pas le mouvement qu'on a déclaré. Un nom inventé
       * rendait la règle invérifiable à la lecture. */
      const a = await auteurCourant(siteEcriture, user.uid, user.displayName);
      const r = await declarerStockInitial({
        siteId: siteEcriture,
        quantites: quantitesReprise(),
        produits,
        parUid: user.uid,
        parNom: a.utilisateurNom,
      });
      setDepartFait(r
        ? `Dossier déclaré : ${r.lignes} ligne${r.lignes > 1 ? 's' : ''}. `
          + 'Le responsable des commandes doit le confirmer.'
        : 'Aucune quantité à déclarer.');
      setDossiers(await chargerAjustements(portee));
    } catch (e: any) {
      setDepartFait(e?.message ?? 'Déclaration impossible.');
    }
    setDepart(false);
  }

  if (loading) return (
    <div className="flex min-h-48 items-center justify-center">
      <Loader2 size={20} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'text-sm font-bold text-gray-900 dark:text-gray-100'}>
          {titre ?? 'Mouvements de stock'}
        </p>
        {/* Le responsable des commandes ne déclare pas : il constate ce
            qu'on lui signale. Décider qu'une marchandise disparaît revient
            à qui répond du site. */}
        {peutDeclarerDepart && (
          <button type="button" onClick={declarerDepart} disabled={depart}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            {depart ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            Créer le stock initial
          </button>
        )}
        {peutDeclarer(role) && siteEcriture && (
          <button type="button"
            onClick={() => router.push(
              `/site/${siteEcriture}/ajustements/nouveau${marqueOrigine(ensemble, false)}`)}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
            <Plus size={14} /> Nouveau mouvement
          </button>
        )}
      </div>

      {departFait && (
        <p className="mb-3 rounded-xl bg-gray-50 p-2.5 text-[12px] text-gray-600 dark:bg-gray-800/50 dark:text-gray-300">
          {departFait}
        </p>
      )}

      {/* Ce qui entre, ce qui sort. Les deux n'ont ni les mêmes motifs ni
          le même effet : les mêler obligerait à relire le sens à chaque
          ligne. */}
      <div className="mb-4 flex items-center gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
        {SENS.map(t => {
          const n = dossiers.filter(
            d => d.sens === t.cle && enCoursAjustement(d)).length;
          return (
            <button key={t.cle} type="button"
              onClick={() => { setSens(t.cle); setRecherche(''); }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                sens === t.cle
                  ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                  : 'text-gray-400 hover:text-gray-600'}`}>
              <t.icone size={13} />
              {t.label}
              {n > 0 && (
                <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Une tuile par étape : on lit ce qui attend le même geste, plutôt
          qu'un mélange qu'il faut retrier à l'œil. */}
      <RangeeEtapes grille={`sm:grid-cols-${ETAPES_AJUSTEMENT.length}`}>
        {ETAPES_AJUSTEMENT.map(e => (
          <div key={e}
            className="block rounded-2xl border border-black/[0.06] bg-white p-3 text-left shadow-sm dark:border-white/10 dark:bg-neutral-900 sm:p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-neutral-400">
              {LIBELLES_ETAT_AJUSTEMENT[e]}
            </p>
            <p className={`${hankenGrotesk.className} mt-1 text-[22px] font-bold leading-7`}>
              {parEtat(e)}
            </p>
            {/* La valeur sous le compte, et seulement pour qui voit
                l'argent. Aux commandes, on dit ce qu'il y a à compter. */}
            <p className="mt-0.5 text-[12px] font-medium text-neutral-400">
              {voitLArgent
                ? formatMontant(valeurEtat(e))
                : `${quantiteEtat(e)} article${quantiteEtat(e) > 1 ? 's' : ''}`}
            </p>
          </div>
        ))}
      </RangeeEtapes>

      {/* Le tableau vit dans une carte, comme sur les retours et les
          achats : posé à même le fond, il n'aurait plus de bord où
          s'arrêter. */}
      <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {/* Deux angles sur la même matière. Le choix ne paraît que pour
              qui voit l'argent : aux commandes, il n'y a qu'une liste à
              aller compter. */}
          {voitLArgent && (
            <div className="flex items-center rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
              {([
                { cle: 'dossiers' as const, label: 'Dossiers' },
                { cle: 'motifs' as const, label: 'Par motif' },
              ]).map(o => (
                <button key={o.cle} type="button" onClick={() => setVue(o.cle)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                    vue === o.cle
                      ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-700 dark:text-indigo-400'
                      : 'text-gray-400 hover:text-gray-600'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {/* Chercher une référence n'a de sens que dans la liste : la
              vue par motif tient en quelques lignes. */}
          {(!voitLArgent || vue === 'dossiers') && (
            <ChampRecherche valeur={recherche} onChange={setRecherche}
              placeholder="Référence, motif, produit…"
              className="min-w-[200px] flex-1" />
          )}
        </div>

        {voitLArgent && vue === 'motifs' ? (
          parMotif.length === 0 ? (
            <p className="py-10 text-center text-xs text-gray-400">
              Aucun mouvement confirmé sur ce sens.
            </p>
          ) : (
            <>
              {/* Le compte seul : le total redisait la colonne Valeur,
                  mot pour mot quand il n'y a qu'un motif. */}
              <p className="mb-3 text-xs text-gray-400">
                {parMotif.filter(m => m.nb > 0).length} motif
                {parMotif.filter(m => m.nb > 0).length > 1 ? 's' : ''}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-center text-xs">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="rounded-l-lg px-3 py-2.5 text-left font-bold">Motif</th>
                      <th className="px-3 py-2.5 font-bold">Mouvements</th>
                      <th className="px-3 py-2.5 font-bold">Articles</th>
                      <th className="px-3 py-2.5 font-bold">Valeur</th>
                      <th className="rounded-r-lg px-3 py-2.5 font-bold">Part</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parMotif.map(m => {
                      const part = totalMotifs > 0
                        ? Math.round((m.valeur / totalMotifs) * 100) : 0;
                      return (
                        <tr key={m.cle}
                          className="border-b border-gray-50 last:border-0 dark:border-gray-800">
                          <td className="px-3 py-3 text-left">
                            <span className="font-bold text-gray-900 dark:text-gray-100">
                              {m.regle.libelle}
                            </span>
                            {/* Ce qui appauvrit la maison se dit : une
                                casse n'est pas un usage interne. */}
                            {m.regle.perte && (
                              <span className="ml-2 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-600 dark:bg-red-900/20 dark:text-red-400">
                                Perte
                              </span>
                            )}
                            {/* Ce qui attend n'entre pas dans la valeur :
                                on le dit à part, sinon on croirait que
                                rien n'est en route. */}
                            {m.attente > 0 && (
                              <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                {m.attente} en attente
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-gray-500">{m.nb}</td>
                          <td className="px-3 py-3 text-gray-500">{m.quantite}</td>
                          <td className={`px-3 py-3 font-bold ${m.regle.perte
                            ? 'text-red-500'
                            : 'text-gray-900 dark:text-gray-100'}`}>
                            {formatMontant(m.valeur)}
                          </td>
                          <td className="px-3 py-3">
                            {/* La part se voit d'un coup d'œil : deux
                                nombres côte à côte demandent une division
                                de tête. */}
                            <div className="mx-auto flex max-w-[110px] items-center gap-2">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                                <div className={`h-full rounded-full ${m.regle.perte
                                  ? 'bg-red-400' : 'bg-indigo-500'}`}
                                  style={{ width: `${part}%` }} />
                              </div>
                              <span className="w-8 text-right text-[11px] font-medium text-gray-400">
                                {part}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : (
          <ListeDossiers
            dossiers={affiches}
            colonnes={colonnes}
            cleDe={d => d.id}
            onOuvrir={d => router.push(
              `/site/${d.siteId}/ajustements/${d.id}${marqueOrigine(ensemble, false)}`)}
            compte={`${affiches.length} mouvement${affiches.length > 1 ? 's' : ''}`}
          />
        )}
      </div>
    </div>
  );
}
