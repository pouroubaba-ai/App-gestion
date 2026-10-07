'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Check, Trash2, Power, XCircle } from 'lucide-react';
import {
  compterOperations, viderOperations, type CompteOperations,
} from '@/lib/reprise';
import {
  contenuDuSite, changerEtatSite, supprimerSite, viderMeublesDuSite,
  type ContenuSite,
} from '@/lib/site-cycle';
import { type RoleSite } from '@/lib/roles';
import SectionEquipe from './SectionEquipe';

/**
 * La configuration d'un site.
 *
 * Qui y travaille et à quel titre, et le vidage des opérations — le seul
 * geste de l'app qui détruit sans retour, d'où sa confirmation écrite.
 */
export default function OngletConfiguration({
  siteId, activiteId, role, nomSite, etatSite, onEtatChange,
}: {
  siteId: string;
  activiteId?: string | null;
  /** `null` = admin : aucune restriction */
  role?: RoleSite | null;
  nomSite?: string;
  etatSite?: 'actif' | 'inactif';
  /** remonte le changement pour que l'en-tête suive sans recharger */
  onEtatChange?: (etat: 'actif' | 'inactif') => void;
}) {
  const router = useRouter();
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');

  /* Ce qui retient encore ce site. Tant qu'il porte quelque chose, le
     supprimer laisserait ces écritures sans lieu — on montre donc
     d'abord ce qu'il contient, et le bouton reste fermé. */
  const [contenu, setContenu] = useState<ContenuSite | null>(null);
  const [confirmeSuppression, setConfirmeSuppression] = useState('');
  const [etat, setEtat] = useState<'actif' | 'inactif'>(etatSite ?? 'actif');

  /* Un vidage ne se rejoue pas : on montre d'abord ce qui partirait, et on
     demande de l'écrire pour qu'aucun clic distrait ne l'emporte. */
  const [compte, setCompte] = useState<CompteOperations | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [remettreStock, setRemettreStock] = useState(true);
  const [vidage, setVidage] = useState<string | null>(null);

  useEffect(() => {
    compterOperations(siteId).then(setCompte).catch(() => setCompte(null));
    contenuDuSite(siteId).then(setContenu).catch(() => setContenu(null));
  }, [siteId]);

  useEffect(() => { if (etatSite) setEtat(etatSite); }, [etatSite]);

  async function basculerEtat() {
    const vers = etat === 'actif' ? 'inactif' : 'actif';
    setEnCours('etat'); setErreur('');
    try {
      await changerEtatSite(siteId, vers);
      setEtat(vers);
      onEtatChange?.(vers);
    } catch (e: any) {
      setErreur(e?.message ?? 'Changement d’état impossible.');
    } finally { setEnCours(null); }
  }

  /* Le ménage d'abord, le site ensuite : un site vidé garde ses
     produits, ses partenaires et son équipe — il faut les défaire pour
     qu'il devienne réellement vide. */
  async function retirer() {
    if (confirmeSuppression.trim().toUpperCase() !== 'SUPPRIMER') return;
    setEnCours('suppression'); setErreur('');
    try {
      await viderMeublesDuSite(siteId);
      await supprimerSite(siteId);
      router.push('/site');
    } catch (e: any) {
      setErreur(e?.message ?? 'Suppression impossible.');
      setContenu(await contenuDuSite(siteId).catch(() => null));
      setEnCours(null);
    }
  }

  async function vider() {
    if (confirmation.trim().toUpperCase() !== 'EFFACER') return;
    setEnCours('vidage'); setErreur(''); setVidage(null);
    try {
      const r = await viderOperations({ siteId, remettreStock });
      setVidage(`${r.supprimes} ligne(s) effacée(s)`
        + (r.produitsRemis > 0 ? `, ${r.produitsRemis} produit(s) remis à zéro.` : '.'));
      setConfirmation('');
      setCompte(await compterOperations(siteId));
    } catch (e: any) {
      setErreur(e?.message ?? 'Échec du vidage.');
    } finally {
      setEnCours(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Qui accède à ce site, et à quoi. */}
      {activiteId && <SectionEquipe siteId={siteId} activiteId={activiteId} />}

      {/* Le vidage vit à part, en rouge : les reprises réparent, celui-ci
          détruit. Les confondre serait une erreur d'un seul clic. */}
      <div className="rounded-2xl border border-red-200 bg-white p-5 dark:border-red-900 dark:bg-gray-900">
        <p className="flex items-center gap-2 text-sm font-bold text-red-600 dark:text-red-400">
          <Trash2 size={15} /> Vider les opérations
        </p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          Efface achats, ventes, transferts, mouvements, documents, versements,
          caisse et recouvrements. Les partenaires, produits et employés restent.
          Sans retour possible.
        </p>

        {compte && (
          <div className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-gray-800/60">
            {compte.total === 0 ? (
              <p className="text-xs text-gray-400">Aucune opération à effacer.</p>
            ) : (
              <>
                <p className="mb-2 text-xs font-bold text-gray-700 dark:text-gray-200">
                  {compte.total} ligne{compte.total > 1 ? 's' : ''} seront effacées
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {Object.entries(compte.parCollection).map(([col, n]) => (
                    <span key={col} className="text-[11px] text-gray-400">
                      {col} <span className="font-bold text-gray-600 dark:text-gray-300">{n}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {(compte?.total ?? 0) > 0 && (
          <>
            <label className="mt-3 flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={remettreStock}
                onChange={e => setRemettreStock(e.target.checked)}
                className="accent-red-600" />
              {/* Le stock vit sur le produit : effacer les mouvements le
                  laisserait tel quel, sans rien pour l'expliquer. */}
              <span className="text-xs text-gray-600 dark:text-gray-300">
                Remettre aussi le stock et le coût moyen des produits à zéro
              </span>
            </label>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input type="text" value={confirmation}
                onChange={e => setConfirmation(e.target.value)}
                placeholder="Écrire EFFACER pour confirmer"
                className="min-w-[200px] flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
              <button onClick={vider}
                disabled={enCours !== null || confirmation.trim().toUpperCase() !== 'EFFACER'}
                className="flex shrink-0 items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-40">
                {enCours === 'vidage'
                  ? <Loader2 size={14} className="animate-spin" />
                  : <Trash2 size={14} />}
                Effacer
              </button>
            </div>
          </>
        )}

        {vidage && (
          <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-green-600">
            <Check size={13} /> {vidage}
          </p>
        )}
      </div>

      {/* Fermer un site sans rien perdre. En gris et non en rouge : ce
          geste ne détruit rien, et il se défait d'un clic. */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <p className="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-gray-100">
          <Power size={15} /> {etat === 'actif' ? 'Désactiver le site' : 'Réactiver le site'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          {etat === 'actif'
            ? 'Le site sort des listes et des sélecteurs. Son historique reste '
              + 'lisible et ses comptes restent justes. Réversible à tout moment.'
            : 'Ce site est désactivé. Il n’apparaît plus là où l’on choisit un site.'}
        </p>
        <button onClick={basculerEtat} disabled={enCours !== null}
          className={`mt-3 flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition-colors disabled:opacity-40 ${
            etat === 'actif'
              ? 'bg-gray-800 text-white hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600'
              : 'bg-green-600 text-white hover:bg-green-700'}`}>
          {enCours === 'etat'
            ? <Loader2 size={14} className="animate-spin" />
            : <Power size={14} />}
          {etat === 'actif' ? 'Désactiver' : 'Réactiver'}
        </button>
      </div>

      {/* Retirer le site. Le dernier bloc, et le seul sans retour : on
          montre ce qui le retient avant d'ouvrir le bouton. */}
      <div className="rounded-2xl border border-red-200 bg-white p-5 dark:border-red-900 dark:bg-gray-900">
        <p className="flex items-center gap-2 text-sm font-bold text-red-600 dark:text-red-400">
          <XCircle size={15} /> Supprimer le site
        </p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          Retire {nomSite ? `« ${nomSite} »` : 'ce site'} de l’activité, avec ses
          partenaires, ses employés et son équipe. Les produits de l’activité
          restent. Sans retour possible.
        </p>

        {contenu && !contenu.vide && (
          <div className="mt-3 rounded-xl bg-amber-50 p-3 dark:bg-amber-900/20">
            {/* On ne refuse pas sans dire quoi : le propriétaire doit
                savoir ce qu'il lui reste à faire, pas seulement qu'on
                lui dit non. */}
            <p className="mb-2 text-xs font-bold text-amber-700 dark:text-amber-400">
              Ce site n’est pas vide — videz d’abord ses opérations
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(contenu.parCollection).map(([col, n]) => (
                <span key={col} className="text-[11px] text-amber-600 dark:text-amber-500">
                  {col} <span className="font-bold">{n}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {contenu?.vide && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input type="text" value={confirmeSuppression}
              onChange={e => setConfirmeSuppression(e.target.value)}
              placeholder="Écrire SUPPRIMER pour confirmer"
              className="min-w-[220px] flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
            <button onClick={retirer}
              disabled={enCours !== null
                || confirmeSuppression.trim().toUpperCase() !== 'SUPPRIMER'}
              className="flex shrink-0 items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-40">
              {enCours === 'suppression'
                ? <Loader2 size={14} className="animate-spin" />
                : <XCircle size={14} />}
              Supprimer
            </button>
          </div>
        )}
      </div>

      {erreur && (
        <p className="rounded-xl bg-red-50 dark:bg-red-900/20 px-4 py-3 text-xs text-red-600">
          {erreur}
        </p>
      )}
    </div>
  );
}
