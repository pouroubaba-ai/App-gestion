'use client';

/**
 * Ce que j'ai déclaré et que la caisse n'a pas encore autorisé.
 *
 * Qui vend, encaisse ou décide d'un paiement ne tient pas le tiroir : son
 * geste attend le responsable de la caisse. Il a pourtant besoin de savoir
 * où il en est — ce qu'il a déclaré, ce qui est passé, ce qui a été refusé.
 * Sans cet écran, il faudrait le demander au caissier.
 *
 * Aucun bouton ici : on n'autorise pas ses propres écritures. C'est
 * précisément ce qui donne sa valeur à l'autorisation.
 */

import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { hankenGrotesk } from './finance/font';
import {
  Loader2, HandCoins, CheckCircle2, AlertTriangle,
  ArrowDownLeft, ArrowUpRight,
} from 'lucide-react';
import {
  attenteDuCompte, totauxEnAttente, type MouvementAttente,
} from '@/lib/attente-caisse';
import { chargerMissions, type Mission } from '@/lib/missions';
import MesMissions from './MesMissions';
import { useAuth } from '@/lib/auth-context';
import { LIBELLES_MOTIF_CAISSE } from '@/lib/caisse';
import { siteUnique } from '@/lib/portee';
import {
  useSites, FiltreSite, ToggleVue, CartesParSite, type PropsPortee,
} from './ContexteSites';

interface Props extends PropsPortee {
  userId: string;
}

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

export default function OngletRemises({ siteId, sites, userId, titre }: Props) {
  const { profile: profil, activite } = useAuth();
  /* Le propriétaire vend sur plusieurs boutiques : ses remises l'attendent
     partout, et chaque ligne doit dire laquelle. */
  const ctx = useSites(siteId, sites);
  const { ensemble, nomDe, portee } = ctx;
  const [liste, setListe] = useState<MouvementAttente[]>([]);
  /* Les paiements qu'on lui confie : ce qu'il doit aller retirer, et ce
     qu'il porte déjà. Le porteur n'a pas l'onglet du caissier — c'est ici
     qu'il vient voir ce qui l'attend. */
  const [missions, setMissions] = useState<Mission[]>([]);
  const [version, setVersion] = useState(0);
  /**
   * Ce que la liste montre.
   *
   * Les deux cartes annonçaient des chiffres que rien ne dépliait : on
   * lisait « 3 000 en attente » au-dessus d'une liste où tout se
   * mélangeait, et il fallait chercher à l'œil lesquelles. Cliquer la
   * carte montre ce qu'elle compte. Recliquer revient à tout.
   */
  const [vu, setVu] = useState<'tout' | 'en_attente' | 'autorise'>('tout');
  const [loading, setLoading] = useState(true);

  /* Aller retirer de l'argent se fait à un tiroir précis : les missions
     n'ont de sens qu'à un site désigné. Les remises, elles, se lisent
     partout où l'on a vendu. */
  const site = siteUnique(portee);

  useEffect(() => {
    attenteDuCompte(portee, userId)
      .then(setListe)
      .catch(() => setListe([]))
      .finally(() => setLoading(false));
  }, [portee, userId, version]);

  useEffect(() => {
    if (!site) { setMissions([]); return; }
    chargerMissions(site).then(setMissions).catch(() => setMissions([]));
  }, [site, version]);

  if (loading) return (
    <div className="min-h-64 flex items-center justify-center">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  /**
   * Une remise, c'est de l'argent qui rentre.
   *
   * Un retrait vers la boutique ou un apport de sa propre poche n'est pas
   * une remise : personne ne « remet » rien à la caisse, c'est le tiroir
   * qui se vide ou qu'on garnit. Les mêler ici brouillait ce que l'écran
   * existe pour dire — ce que j'ai encaissé et que la caisse n'a pas
   * encore compté. Ils restent au registre et dans la file du caissier.
   */
  const remises = liste.filter(m => m.sens === 'entree');

  const t = totauxEnAttente(remises);
  const autorises = remises.filter(m => m.etat === 'autorise');
  /* Ce que la caisse a réellement passé : le compté, pas le déclaré. */
  const passe = autorises.reduce(
    (n, m) => n + (m.montantAutorise ?? m.montant), 0);
  /* Ce qui s'est perdu entre la déclaration et le tiroir. Zéro le plus
     souvent — et c'est bien qu'il se voie quand ce n'est pas le cas. */
  const ecarts = autorises.reduce(
    (n, m) => n + Math.abs(m.montant - (m.montantAutorise ?? m.montant)), 0);
  const refuses = remises.filter(m => m.etat === 'refuse').length;

  /* Ce qu'on déroule sous les cartes. Un refus n'appartient à aucune des
     deux : il reste visible dans la vue complète. */
  const affichees = vu === 'tout' ? remises : remises.filter(m => m.etat === vu);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className={titre
          ? 'text-xl font-bold text-gray-900 dark:text-gray-100'
          : 'text-sm font-bold text-gray-900 dark:text-gray-100'}>
          {titre ?? 'Mes remises'}
        </p>
        {/* Le total dit combien on attend, jamais de quelle boutique. */}
        <div className="flex items-center gap-2">
          <ToggleVue actif={ctx.vue} onChange={ctx.setVue} visible={ctx.ensemble} />
          <FiltreSite sites={ctx.sites} valeur={ctx.filtre} onChange={ctx.setFiltre} />
        </div>
      </div>

      {/* Ce qu'il porte déjà, et lui seul.

          Confirmer la réception vivait ici aussi : le même geste s'offrait
          sur deux écrans, et celui qui l'avait fait d'un côté retrouvait
          le bouton de l'autre sans savoir s'il avait manqué quelque chose.
          Il se fait désormais dans les recouvrements, où la carte dit ce
          qu'il y a à prendre. Ici ne reste que ce qu'il a en main. */}
      {site && (
        <div className="mb-4 space-y-3">
          <MesMissions missions={missions.filter(m => m.mode === 'porte')} porteurUid={userId}
            parUid={userId} parNom={profil?.nom ?? null}
            adminUid={activite?.adminUid ?? null}
            onChange={() => setVersion(v => v + 1)} />
        </div>
      )}

      {/* La répartition : le total dit combien j'attends, jamais de quelle
          boutique. Un clic sur une carte ouvre le détail de ce site —
          sans quoi il fallait remonter au filtre chercher un nom qu'on
          avait sous les yeux. */}
      {ctx.parSite ? (
        <CartesParSite sites={ctx.sitesVus}
          onChoisir={id => { ctx.setFiltre(id); ctx.setVue('ensemble'); }}
          contenu={id => {
            const duSite = remises.filter(m => m.siteId === id);
            const attend = duSite.filter(m => m.etat === 'en_attente');
            const ok = duSite.filter(m => m.etat === 'autorise');
            const somme = (l: typeof duSite) => l.reduce((n, m) => n + m.montant, 0);
            return {
              titre: 'En attente',
              valeur: formatMontant(somme(attend)),
              dort: duSite.length === 0,
              badge: attend.length > 0
                ? {
                    texte: `${attend.length} remise${attend.length > 1 ? 's' : ''}`,
                    ton: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                  }
                : null,
              lignes: [
                {
                  label: `Passé en caisse · ${ok.length}`,
                  valeur: formatMontant(ok.reduce(
                    (n, m) => n + (m.montantAutorise ?? m.montant), 0)),
                  vide: ok.length === 0,
                },
              ],
            };
          }} />
      ) : (
      <>

      {/* Ce qui attend, ce qui est passé. Le premier appelle un geste —
          aller voir le caissier — le second n'est qu'une trace.
          Côte à côte même sur un téléphone : empilées, deux chiffres
          prenaient la moitié de l'écran. */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
        {/* Le dégradé se déplace sur la carte choisie : c'est lui qui dit ce
            qu'on regarde. Un anneau autour se lisait comme une décoration ;
            le bleu qui saute d'une carte à l'autre se voit du premier coup.
            Sans choix, il reste sur l'attente — c'est elle qui appelle un
            geste, l'autre n'est qu'une trace. */}
        <button type="button"
          onClick={() => setVu(v => v === 'en_attente' ? 'tout' : 'en_attente')}
          className={`rounded-2xl p-4 text-left shadow-sm transition-all sm:p-5 ${
            vu === 'autorise'
              ? 'border border-black/[0.06] bg-white dark:border-white/10 dark:bg-neutral-900'
              : 'text-white'}`}
          style={vu === 'autorise' ? undefined
            : { background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }}>
          <div className="flex items-start justify-between gap-3">
            <span className={`flex h-8 w-8 items-center justify-center rounded-[10px] ${
              vu === 'autorise'
                ? 'bg-neutral-100 dark:bg-neutral-800'
                : 'bg-white/15'}`}>
              <HandCoins size={16}
                className={vu === 'autorise' ? 'text-indigo-600' : undefined} />
            </span>
            {/* La pastille s'efface en demi-largeur : elle écraserait
                l'icône, et le compte se relit dans la liste. */}
            {t.nb > 0 && (
              <span className={`hidden shrink-0 rounded-lg px-2.5 py-1 text-xs font-bold sm:inline ${
                vu === 'autorise'
                  ? 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                  : 'bg-white/15 text-indigo-100'}`}>
                {t.nb} mouvement{t.nb > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <p className={`mt-3 text-[11px] font-bold uppercase tracking-wide ${
            vu === 'autorise' ? 'text-neutral-400' : 'text-indigo-100'}`}>
            En attente
          </p>
          <p className={`${hankenGrotesk.className} mt-0.5 text-[19px] font-bold leading-7 tracking-tight sm:text-[26px] sm:leading-8 ${
            vu === 'autorise' ? 'text-neutral-900 dark:text-white' : ''}`}>
            {formatMontant(t.entrees + t.sorties)}
          </p>
          {/* La phrase se raccourcit au téléphone : en demi-largeur, la
              version longue faisait quatre lignes sous le chiffre. */}
          <p className={`mt-1 text-[11px] ${
            vu === 'autorise' ? 'text-gray-400' : 'text-indigo-100'}`}>
            {t.nb > 0 ? (
              <>
                <span className="sm:hidden">{t.nb} à faire confirmer</span>
                <span className="hidden sm:inline">
                  {vu === 'en_attente'
                    ? 'Voici ce qui attend la caisse. Recliquez pour tout revoir.'
                    : 'Déclaré, en attente de confirmation par la caisse.'}
                </span>
              </>
            ) : 'Rien en attente.'}
          </p>
        </button>

        <button type="button"
          onClick={() => setVu(v => v === 'autorise' ? 'tout' : 'autorise')}
          className={`rounded-2xl p-4 text-left shadow-sm transition-all sm:p-5 ${
            vu === 'autorise'
              ? 'text-white'
              : 'border border-black/[0.06] bg-white dark:border-white/10 dark:bg-neutral-900'}`}
          style={vu === 'autorise'
            ? { background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)' }
            : undefined}>
          <div className="flex items-start justify-between gap-3">
            <span className={`flex h-8 w-8 items-center justify-center rounded-[10px] ${
              vu === 'autorise' ? 'bg-white/15' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
              <CheckCircle2 size={16}
                className={vu === 'autorise' ? 'text-white' : 'text-green-600'} />
            </span>
            {autorises.length > 0 && (
              <span className={`hidden shrink-0 rounded-lg px-2.5 py-1 text-xs font-bold sm:inline ${
                vu === 'autorise'
                  ? 'bg-white/15 text-indigo-100'
                  : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}`}>
                {autorises.length} autorisé{autorises.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <p className={`mt-3 text-[11px] font-bold uppercase tracking-wide ${
            vu === 'autorise' ? 'text-indigo-100' : 'text-neutral-400'}`}>
            Passé en caisse
          </p>
          <p className={`${hankenGrotesk.className} mt-0.5 text-[19px] font-bold leading-7 tracking-tight sm:text-[26px] sm:leading-8 ${
            vu === 'autorise' ? '' : 'text-neutral-900 dark:text-white'}`}>
            {formatMontant(passe)}
          </p>
          {(ecarts > 0 || refuses > 0) && (
            <p className={`mt-1 flex flex-wrap items-center gap-1 text-[11px] font-medium ${
              vu === 'autorise' ? 'text-amber-200' : 'text-orange-500'}`}>
              <AlertTriangle size={11} className="shrink-0" />
              {ecarts > 0 && `${formatMontant(ecarts)} d’écart`}
              {ecarts > 0 && refuses > 0 && ' · '}
              {refuses > 0 && `${refuses} refusé${refuses > 1 ? 's' : ''}`}
            </p>
          )}
        </button>
      </div>

      <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <p className="mb-4 text-sm font-bold text-gray-900 dark:text-gray-100">
          {/* Le titre dit ce qu'on regarde : sans lui, une liste filtrée
              ressemble à une liste courte. */}
          {vu === 'en_attente' ? 'En attente de la caisse'
            : vu === 'autorise' ? 'Passé en caisse'
            : 'Mes remises'}
        </p>

        {affichees.length === 0 ? (
          <p className="py-8 text-center text-xs text-gray-400">
            {vu === 'en_attente' ? 'Rien n’attend la caisse.'
              : vu === 'autorise' ? 'Rien n’est encore passé en caisse.'
              : 'Aucune remise. Ce que vous encaissez apparaîtra ici jusqu’à ce que la caisse le confirme.'}
          </p>
        ) : (
          <>
            <p className="mb-2 text-sm font-medium text-gray-500">
              {affichees.length} remise{affichees.length > 1 ? 's' : ''}
            </p>

            {/* Tablette et bureau : les colonnes du registre. */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr className="bg-indigo-600 text-white">
                    <th className="px-3 py-2.5 text-center font-medium">Motif</th>
                    {ensemble && (
                      <th className="px-3 py-2.5 text-center font-medium">Site</th>
                    )}
                    <th className="px-3 py-2.5 text-center font-medium">Sous-motif</th>
                    <th className="px-3 py-2.5 text-center font-medium">Détail</th>
                    <th className="px-3 py-2.5 text-center font-medium">Déclaré</th>
                    <th className="px-3 py-2.5 text-center font-medium">Passé</th>
                    <th className="px-3 py-2.5 text-center font-medium">Date</th>
                    <th className="px-3 py-2.5 text-center font-medium">État</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                  {affichees.map(m => (
                    <tr key={m.id}>
                      <td className="px-3 py-2.5 text-center"><Sens m={m} /></td>
                      {ensemble && (
                        <td className="px-3 py-2.5 text-center text-gray-500">
                          {nomDe(m.siteId)}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-center text-gray-500">
                        {m.sousMotif ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600 dark:text-gray-400">
                        {m.detail ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center font-bold text-gray-900 dark:text-gray-100">
                        {formatMontant(m.montant)}
                      </td>
                      <CellulePasse m={m} />
                      <td className="px-3 py-2.5 text-center text-gray-500">
                        {formatDate(m.date)} <span className="text-gray-400">{m.heure}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center"><Etat m={m} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Téléphone : une carte par déclaration. */}
            <div className="space-y-2.5 sm:hidden">
              {affichees.map(m => (
                <div key={m.id}
                  className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
                  <div className="flex items-start justify-between gap-3">
                    <p className={`text-[15px] font-bold ${
                      m.sens === 'entree' ? 'text-green-600' : 'text-red-500'}`}>
                      {formatMontant(m.montant)}
                    </p>
                    <Etat m={m} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Motif</span>
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {LIBELLES_MOTIF_CAISSE[m.motif]}
                      </span>
                    </span>
                    {ensemble && (
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-gray-400">Site</span>
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {nomDe(m.siteId)}
                        </span>
                      </span>
                    )}
                    {m.sousMotif && (
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-gray-400">Sous-motif</span>
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {m.sousMotif}
                        </span>
                      </span>
                    )}
                    {m.detail && (
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-gray-400">Détail</span>
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {m.detail}
                        </span>
                      </span>
                    )}
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-gray-400">Le</span>
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {formatDate(m.date)} {m.heure}
                      </span>
                    </span>
                  </div>
                  {/* L'écart et le refus ne se lisent que s'ils existent :
                      les taire cacherait le seul fait qui compte ici. */}
                  {m.etat === 'autorise'
                    && (m.montantAutorise ?? m.montant) !== m.montant && (
                    <p className="mt-2 border-t border-gray-100 pt-2 text-xs font-medium text-orange-500 dark:border-gray-800">
                      {formatMontant(Math.abs(m.montant - (m.montantAutorise ?? 0)))} d&apos;écart
                      {m.constat && <span className="text-gray-400"> — {m.constat}</span>}
                    </p>
                  )}
                  {m.etat === 'refuse' && m.constat && (
                    <p className="mt-2 border-t border-gray-100 pt-2 text-xs text-red-500 dark:border-gray-800">
                      {m.constat}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      </>
      )}
    </div>
  );
}

/** Ce que la caisse a passé : rien tant qu'elle ne s'est pas prononcée. */
function CellulePasse({ m }: { m: MouvementAttente }) {
  if (m.etat !== 'autorise') {
    return <td className="px-3 py-2.5 text-center text-gray-300 dark:text-gray-700">—</td>;
  }
  const passe = m.montantAutorise ?? m.montant;
  const ecart = m.montant - passe;
  return (
    <td className="px-3 py-2.5 text-center">
      <span className={`font-medium ${ecart !== 0 ? 'text-orange-500' : 'text-green-600'}`}>
        {formatMontant(passe)}
      </span>
      {ecart !== 0 && (
        <span className="ml-1.5 text-[11px] text-orange-500">
          {ecart > 0 ? '−' : '+'}{formatMontant(Math.abs(ecart))}
        </span>
      )}
    </td>
  );
}

function Sens({ m }: { m: MouvementAttente }) {
  const entree = m.sens === 'entree';
  return (
    <span className="inline-flex items-center gap-1.5">
      {entree
        ? <ArrowDownLeft size={13} className="shrink-0 text-green-600" />
        : <ArrowUpRight size={13} className="shrink-0 text-red-500" />}
      <span className="font-medium text-gray-900 dark:text-gray-100">
        {LIBELLES_MOTIF_CAISSE[m.motif]}
      </span>
    </span>
  );
}

function Etat({ m }: { m: MouvementAttente }) {
  if (m.etat === 'autorise') return (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700 dark:bg-green-900/30 dark:text-green-400">
      Autorisé
    </span>
  );
  if (m.etat === 'refuse') return (
    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-600 dark:bg-red-900/30 dark:text-red-400">
      Refusé
    </span>
  );
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
      En attente
    </span>
  );
}
