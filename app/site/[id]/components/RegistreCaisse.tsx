'use client';

/**
 * Le registre de caisse : ce qui est passé par le tiroir.
 *
 * Il sert deux écrans qui ne se ressemblent pas. Le caissier lui donne une
 * page entière — il ne fait que cela, et il travaille au téléphone. Le
 * gérant et le propriétaire le lisent sous leurs chiffres, dans « Fonds de
 * caisse » : pour eux la caisse est une partie du travail, pas le travail.
 *
 * Le tableau, les filtres, la contre-passation et la saisie vivent donc
 * ici, une seule fois. Deux copies auraient fini par diverger, et c'est le
 * genre d'écran où une divergence se lit comme une erreur de comptes.
 */

import { useState, type ReactNode } from 'react';
import { formatMontant } from '@/lib/format';
import {
  ArrowDownLeft, ArrowUpRight, Plus, Filter, ArrowUpDown, Undo2, Loader2,
  HandCoins,
} from 'lucide-react';
import ModalMouvementCaisse from './ModalMouvementCaisse';
import {
  LIBELLES_MOTIF_CAISSE, annulableEnCaisse, annulerMouvementCaisse,
  type MouvementCaisse,
} from '@/lib/caisse';
import {
  peutDeclarerMouvement, peutAnnulerMouvement, type RoleSite,
} from '@/lib/roles';
import { ChampRecherche } from '@/components/Champs';
import FeuilleFiltreStatut from './FeuilleFiltreStatut';
import { CelluleSite } from './ContexteSites';

interface Props {
  /** Déjà restreints à la période : le registre ne filtre pas le temps. */
  mouvements: MouvementCaisse[];
  userId: string;
  roleSite: RoleSite | null;
  /** Le site où écrire ; vide en vue d'ensemble tant qu'aucun n'est choisi. */
  siteEcriture: string | null;
  /** Présent en vue d'ensemble : sans lui, on ne sait plus quelle caisse. */
  nomDuSite: ((id?: string | null) => string) | null;
  /** Relire : le registre a bougé. */
  onChange: () => void;
  /**
   * Ce que l'écran hôte pose sur la ligne de recherche.
   *
   * Le caissier y constate un écart ; les autres écrans n'ont rien à y
   * mettre. Le bouton vivait au-dessus, sur une ligne à lui, loin du
   * registre qu'il concerne.
   */
  actions?: ReactNode;
}

function formatDate(s?: string): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function RegistreCaisse({
  mouvements, userId, roleSite, siteEcriture, nomDuSite, onChange, actions,
}: Props) {
  const [recherche, setRecherche] = useState('');
  const [modalMouvement, setModalMouvement] = useState(false);
  const [filtreSens, setFiltreSens] = useState<'tous' | 'entree' | 'sortie'>('tous');
  /* Le filtre vit dans une feuille : sur un téléphone, trois onglets et
     une recherche ne tiennent pas sur la même ligne. */
  const [feuilleFiltre, setFeuilleFiltre] = useState(false);
  /* Une contre-passation est définitive : elle ajoute une ligne qui ne
     s'efface pas non plus. On confirme avant. */
  const [aAnnuler, setAAnnuler] = useState<MouvementCaisse | null>(null);
  const [annulation, setAnnulation] = useState(false);
  const [erreurAnnul, setErreurAnnul] = useState('');
  const [tri, setTri] = useState<'numero' | 'date' | 'montant' | null>(null);
  const [ordre, setOrdre] = useState<'asc' | 'desc'>('desc');
  /* Un mouvement déclaré qui attend la caisse n'apparaît pas au registre :
     sans un mot, on croit la saisie perdue. */
  const [enAttente, setEnAttente] = useState(false);

  const ensemble = !!nomDuSite;
  const nbEntrees = mouvements.filter(m => m.sens === 'entree').length;
  const nbSorties = mouvements.filter(m => m.sens === 'sortie').length;

  /** Le motif du mouvement, tel qu'on le relit. */
  const motifDe = (m: MouvementCaisse) => LIBELLES_MOTIF_CAISSE[m.motif];
  /** Le détail, ou à défaut le motif : une ligne dit toujours quelque chose. */
  const detailDe = (m: MouvementCaisse) => m.detail || LIBELLES_MOTIF_CAISSE[m.motif];

  /* Les détails qu'on a ouverts. Une phrase longue est rare et précieuse
     — on ne la perd pas, on la replie. */
  const [deplies, setDeplies] = useState<string[]>([]);

  const filtres = mouvements.filter(m => {
    if (filtreSens !== 'tous' && m.sens !== filtreSens) return false;
    const q = recherche.trim().toLowerCase();
    if (!q) return true;
    return motifDe(m).toLowerCase().includes(q)
      || detailDe(m).toLowerCase().includes(q)
      || (m.sousMotif ?? '').toLowerCase().includes(q)
      || (m.utilisateurNom ?? '').toLowerCase().includes(q);
  });

  /* Sans tri choisi, le plus récent d'abord : c'est ce qu'on vient voir. */
  const affiches = tri
    ? [...filtres].sort((a, b) => {
        const sens = ordre === 'asc' ? 1 : -1;
        if (tri === 'montant') return sens * (a.montant - b.montant);
        /* le numéro porte l'année puis le rang : son tri alphabétique
           donne l'ordre d'écriture. Une ligne sans numéro se range après. */
        if (tri === 'numero') {
          return sens * (a.numero ?? '￿').localeCompare(b.numero ?? '￿');
        }
        return sens * (a.date ?? '').localeCompare(b.date ?? '');
      })
    : filtres;

  function basculer(col: NonNullable<typeof tri>) {
    if (tri === col) setOrdre(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setTri(col); setOrdre('desc'); }
  }

  function Th({ cle, label }: { cle: NonNullable<typeof tri>; label: string }) {
    return (
      <th className="px-3 py-2.5 font-medium">
        <button onClick={() => basculer(cle)}
          className="flex w-full items-center justify-center gap-1 transition-opacity hover:opacity-80">
          {label}
          <ArrowUpDown size={12} className={tri === cle ? 'opacity-100' : 'opacity-40'} />
        </button>
      </th>
    );
  }

  /* Seuls les mouvements qui ne découlent d'aucun acte se saisissent ici :
     apport, retrait, frais de boutique. Un mouvement s'écrit dans une
     caisse : la vue d'ensemble n'en désigne aucune tant qu'un site n'est
     pas choisi.

     Et le caissier ne déclare pas : un mouvement est voulu par quelqu'un,
     et celui qui tient le tiroir n'est pas celui qui décide. */
  const peutSaisir = !!siteEcriture && peutDeclarerMouvement(roleSite);
  /* Annuler écrit le mouvement inverse : c'est déclarer, pas corriger.
     Le caissier constate une erreur, il ne la contre-passe pas seul. */
  const peutAnnuler = peutAnnulerMouvement(roleSite);

  return (
    <>
      {/* Déclarer n'est pas payer : tant que le responsable de la caisse
          n'a pas ouvert le tiroir, l'argent n'a pas bougé et le registre
          ne porte rien. Le dire, sinon la saisie paraît avoir échoué. */}
      {enAttente && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/30 dark:bg-amber-900/10">
          <HandCoins size={15} className="mt-0.5 shrink-0 text-amber-500" />
          <p className="text-xs text-amber-800 dark:text-amber-300">
            <span className="font-bold">Mouvement déclaré.</span> Il entrera au
            registre quand le responsable de la caisse l&apos;aura autorisé —
            il figure d&apos;ici là dans les mouvements à confirmer.
          </p>
        </div>
      )}

      {/* Tout sur une ligne : la recherche, le filtre, et ce que l'écran
          permet de faire.

          Les trois sens s'étalaient sur une rangée à part, qui prenait une
          ligne entière pour trois mots et repoussait le registre. Ils
          tiennent dans une feuille qu'on ouvre — leur compte y est lisible,
          là où la rangée le serrait entre deux parenthèses. */}
      <div className="mb-4 flex items-center gap-2">
        <ChampRecherche placeholder="Motif, détail, auteur…"
          valeur={recherche} onChange={setRecherche} className="min-w-0 flex-1" />

        <button type="button" onClick={() => setFeuilleFiltre(true)}
          className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
            filtreSens !== 'tous'
              ? 'border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-800/40 dark:bg-indigo-900/20 dark:text-indigo-400'
              : 'border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-700 dark:text-gray-300'}`}>
          <Filter size={13} />
          {/* Le sens retenu se lit sur le bouton : un filtre actif qu'il
              faut ouvrir pour connaître se laisse oublier. */}
          <span className="hidden sm:inline">
            {filtreSens === 'tous' ? 'Filtrer'
              : filtreSens === 'entree' ? 'Entrées' : 'Sorties'}
          </span>
        </button>

        {/* Ce que l'écran hôte pose sur cette ligne — constater un écart,
            pour le caissier. Il l'avait au-dessus, sur une ligne à lui. */}
        {actions}

        {peutSaisir && (
          <button onClick={() => setModalMouvement(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700">
            <Plus size={14} />
            <span className="hidden sm:inline">Mouvement</span>
          </button>
        )}
      </div>

      {/* Les trois sens, avec leur compte : un filtre vide se voit avant
          d'être choisi. */}
      {feuilleFiltre && (
        <FeuilleFiltreStatut
          options={[
            { cle: 'entree', label: 'Entrées', n: nbEntrees },
            { cle: 'sortie', label: 'Sorties', n: nbSorties },
          ]}
          /* La feuille coche plusieurs cases ; le registre n'en retient
             qu'une — les deux ensemble, c'est « tous ». */
          choisis={filtreSens === 'tous' ? [] : [filtreSens]}
          onChange={c => setFiltreSens(
            c.length === 1 ? (c[0] as 'entree' | 'sortie') : 'tous')}
          onFermer={() => setFeuilleFiltre(false)} />
      )}

      {mouvements.length === 0 ? (
        <p className="py-8 text-center text-xs text-gray-400">
          Aucun mouvement sur cette période.
        </p>
      ) : affiches.length === 0 ? (
        <p className="py-8 text-center text-xs text-gray-400">Aucun résultat.</p>
      ) : (
        <>
          <p className="mb-2 text-sm font-medium text-gray-500">
            {affiches.length} mouvement{affiches.length > 1 ? 's' : ''}
          </p>

          {/* Tablette et bureau : le registre entier, colonne par colonne. */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full whitespace-nowrap text-sm">
              <thead>
                <tr className="bg-indigo-600 text-white">
                  {/* le numéro se cite et sa continuité se vérifie :
                      un trou prouve qu'une ligne manque */}
                  <Th cle="numero" label="N°" />
                  <Th cle="date" label="Date" />
                  {/* Deux caisses distinctes dans un même tableau : sans
                      cette colonne, on ne sait plus laquelle bouge. */}
                  {ensemble && <th className="px-3 py-2.5 text-center font-medium">Site</th>}
                  <th className="px-3 py-2.5 text-center font-medium">Sens</th>
                  {/* Sans les deux, une sortie d'argent ne désigne
                      personne : la fonction dit à quel titre, le nom
                      dit qui. */}
                  <th className="px-3 py-2.5 text-center font-medium">Fonction</th>
                  <th className="px-3 py-2.5 text-center font-medium">Auteur</th>
                  <th className="px-3 py-2.5 text-center font-medium">Motif</th>
                  {/* le sous-motif précise le motif ; vide pour les
                      mouvements qui n'en portent pas */}
                  <th className="px-3 py-2.5 text-center font-medium">Sous-motif</th>
                  <th className="px-3 py-2.5 text-center font-medium">Détail</th>
                  {/* Chaque site tient sa propre caisse : un solde qui
                      enchaînerait les leurs sauterait à chaque ligne. */}
                  {!ensemble && <th className="px-3 py-2.5 text-center font-medium">Fonds en caisse</th>}
                  <Th cle="montant" label="Montant" />
                  <th className="sticky right-0 bg-indigo-600 px-2 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {affiches.map(m => {
                  /* Une ligne annulée reste au registre : on la barre
                     pour dire qu'elle ne compte plus, on ne l'efface
                     pas — effacer ferait mentir la suite des soldes. */
                  const annule = !!m.annuleParId;
                  const contrepassation = !!m.annuleId;
                  return (
                    <tr key={m.id} className={`transition-colors ${
                      annule
                        ? 'bg-gray-50/60 text-gray-400 line-through dark:bg-gray-800/30'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                      <td className="px-3 py-2.5 text-center font-mono text-xs text-gray-400">
                        {m.numero || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">{formatDate(m.date)}</td>
                      {ensemble && <CelluleSite nom={nomDuSite!(m.siteId)} />}
                      <td className="px-3 py-2.5 text-center">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${
                          m.sens === 'entree'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>
                          {m.sens === 'entree' ? <ArrowDownLeft size={10} /> : <ArrowUpRight size={10} />}
                          {m.sens === 'entree' ? 'Entrée' : 'Sortie'}
                        </span>
                      </td>
                      {/* « Système » quand l'opération découle d'un acte :
                          personne ne l'a saisie, l'app l'a déduite. */}
                      <td className="px-3 py-2.5 text-center text-gray-400">
                        {m.utilisateurFonction || 'Système'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-500">
                        {m.utilisateurNom || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600 dark:text-gray-400">{motifDe(m)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-400">{m.sousMotif || '—'}</td>
                      {/* Le détail est du texte libre : sans borne, une
                          phrase de trois lignes étire la table et pousse le
                          montant hors de l'écran. On en montre une ligne,
                          le reste au survol. */}
                      <td className="px-3 py-2.5 text-center text-gray-500">
                        <span title={detailDe(m)}
                          className="mx-auto block max-w-[220px] truncate">
                          {detailDe(m)}
                        </span>
                      </td>
                      {/* le solde figé à l'écriture : ce qu'il y avait
                          vraiment dans le tiroir à cet instant */}
                      {!ensemble && (
                        <td className={`px-3 py-2.5 text-center font-bold ${
                          (m.soldeAvant ?? 0) >= 0
                            ? 'text-gray-900 dark:text-gray-100' : 'text-red-500'}`}>
                          {formatMontant(m.soldeAvant ?? 0)}
                        </td>
                      )}
                      <td className={`px-3 py-2.5 text-center font-medium ${
                        m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
                        {m.sens === 'entree' ? '+' : '−'}{formatMontant(m.montant)}
                      </td>
                      <td className="sticky right-0 bg-white px-2 py-2.5 text-center dark:bg-gray-900">
                        {peutAnnuler && annulableEnCaisse(m) ? (
                          <button onClick={() => { setAAnnuler(m); setErreurAnnul(''); }}
                            title="Annuler ce mouvement"
                            className="p-1 text-gray-300 transition-colors hover:text-red-500">
                            <Undo2 size={14} />
                          </button>
                        ) : contrepassation ? (
                          <span className="text-[10px] font-medium text-gray-400 no-underline">annul.</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Téléphone : une carte par écriture. Le tableau à dix colonnes
              y demandait deux balayages pour lire un montant. */}
          <div className="space-y-2 sm:hidden">
            {affiches.map(m => {
              const annule = !!m.annuleParId;
              const contrepassation = !!m.annuleId;
              return (
                <div key={m.id}
                  className={`rounded-xl border p-3 ${
                    annule
                      ? 'border-gray-100 bg-gray-50/60 text-gray-400 dark:border-gray-800 dark:bg-gray-800/30'
                      : 'border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {m.sens === 'entree'
                        ? <ArrowDownLeft size={13} className="shrink-0 text-green-600" />
                        : <ArrowUpRight size={13} className="shrink-0 text-red-500" />}
                      <span className={`truncate text-[13px] font-bold ${
                        annule ? 'line-through' : 'text-gray-900 dark:text-gray-100'}`}>
                        {motifDe(m)}
                      </span>
                    </span>
                    <span className={`shrink-0 text-[15px] font-bold ${
                      annule ? 'line-through'
                        : m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
                      {m.sens === 'entree' ? '+' : '−'}{formatMontant(m.montant)}
                    </span>
                  </div>

                  {/* Ce qui est vide disparaît : un « — » par champ absent
                      remplissait la carte de rien. */}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                    {m.sousMotif && <Info label="Sous-motif" valeur={m.sousMotif} />}
                    <Info label="Le" valeur={formatDate(m.date)} />
                    <Info label="Par"
                      valeur={`${m.utilisateurNom || '—'}${
                        m.utilisateurFonction ? ` · ${m.utilisateurFonction}` : ''}`} />
                    {!ensemble && (
                      <Info label="Fonds" valeur={formatMontant(m.soldeAvant ?? 0)} />
                    )}
                    {ensemble && <Info label="Site" valeur={nomDuSite!(m.siteId)} />}
                    {m.numero && <Info label="N°" valeur={m.numero} />}
                  </div>

                  {/* Le détail sur sa propre ligne : mêlé aux champs de trois
                      mots, une phrase de vingt lignes noyait la date, le
                      fonds et le numéro. Deux lignes suffisent à savoir de
                      quoi il s'agit ; une tape donne le reste. */}
                  {m.detail && (
                    <button type="button"
                      onClick={() => setDeplies(x => x.includes(m.id)
                        ? x.filter(i => i !== m.id) : [...x, m.id])}
                      className="mt-1.5 block w-full text-left text-[13px]">
                      <span className="text-gray-400">Détail </span>
                      <span className={`font-medium text-gray-900 dark:text-gray-100 ${
                        deplies.includes(m.id) ? '' : 'line-clamp-2'}`}>
                        {m.detail}
                      </span>
                    </button>
                  )}

                  {peutAnnuler && annulableEnCaisse(m) ? (
                    <button onClick={() => { setAAnnuler(m); setErreurAnnul(''); }}
                      className="mt-2.5 flex items-center gap-1.5 text-xs font-bold text-gray-400 transition-colors hover:text-red-500">
                      <Undo2 size={13} /> Annuler
                    </button>
                  ) : contrepassation ? (
                    <p className="mt-2.5 text-[11px] font-medium text-gray-400">
                      Écriture d&apos;annulation
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Une erreur ne s'efface pas, elle se contre-passe : on ajoute
          l'écriture inverse, et les deux lignes restent. Un registre qu'on
          peut vider ne prouve rien. */}
      {aAnnuler && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 dark:bg-neutral-900">
            <p className="mb-2 text-sm font-bold text-neutral-900 dark:text-neutral-100">
              Annuler ce mouvement
            </p>
            <p className="mb-4 text-xs text-neutral-500 dark:text-neutral-400">
              {aAnnuler.numero} · {formatMontant(aAnnuler.montant)}
              <br />
              Le mouvement reste au registre. Une écriture inverse est ajoutée
              pour le neutraliser — les deux lignes resteront visibles.
            </p>
            {erreurAnnul && <p className="mb-3 text-xs text-red-500">{erreurAnnul}</p>}
            <div className="flex gap-2">
              <button onClick={() => setAAnnuler(null)} disabled={annulation}
                className="flex-1 rounded-xl border border-black/10 py-2 text-sm font-bold text-neutral-500 transition-colors hover:bg-neutral-50 disabled:opacity-50 dark:border-white/10 dark:hover:bg-neutral-800">
                Fermer
              </button>
              <button
                onClick={async () => {
                  /* La garde tient aussi ici : cacher un bouton ne ferme
                     pas l'écriture qu'il déclenche. */
                  if (!peutAnnuler) return;
                  setAnnulation(true);
                  setErreurAnnul('');
                  try {
                    await annulerMouvementCaisse({
                      mouvement: aAnnuler,
                      utilisateur: userId,
                      utilisateurNom: 'Admin',
                      utilisateurFonction: 'Admin',
                    });
                    setAAnnuler(null);
                    onChange();
                  } catch (e: any) {
                    setErreurAnnul(e?.message ?? 'Annulation impossible.');
                  }
                  setAnnulation(false);
                }}
                disabled={annulation}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-600 py-2 text-sm font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-50">
                {annulation && <Loader2 size={14} className="animate-spin" />}
                Annuler le mouvement
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Écrire demande un site : la vue d'ensemble n'ouvre le modal qu'une
          fois un site choisi au filtre. */}
      {modalMouvement && peutSaisir && siteEcriture && (
        <ModalMouvementCaisse
          siteId={siteEcriture}
          utilisateur={userId}
          roleSite={roleSite}
          onFermer={() => setModalMouvement(false)}
          onEnregistre={applique => { setEnAttente(!applique); onChange(); }}
        />
      )}
    </>
  );
}

/** Un couple libellé-valeur, aligné sur la ligne de base. */
function Info({ label, valeur }: { label: string; valeur: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-gray-400">{label}</span>
      <span className="font-medium text-gray-900 dark:text-gray-100">{valeur}</span>
    </span>
  );
}
