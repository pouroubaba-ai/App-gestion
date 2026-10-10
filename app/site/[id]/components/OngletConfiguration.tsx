'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { ref as storageRefFn, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import {
  Loader2, Check, Trash2, Power, XCircle, Store, Warehouse,
  ImagePlus, Pencil, Info, AlertTriangle,
} from 'lucide-react';
import {
  compterOperations, viderOperations, type CompteOperations,
} from '@/lib/reprise';
import {
  contenuDuSite, changerEtatSite, supprimerSite, viderMeublesDuSite,
  type ContenuSite,
} from '@/lib/site-cycle';
import { type RoleSite } from '@/lib/roles';
import SectionEquipe from './SectionEquipe';

type TypeSite = 'boutique' | 'depot';

interface InfosSite {
  nom: string;
  type: TypeSite;
  adresse: string;
  numero: string;
  imageUrl: string;
}

/**
 * La configuration d'un site.
 *
 * Trois régions, de la plus anodine à la plus lourde :
 *   — les informations du site, qu'on modifie librement ;
 *   — qui y travaille et à quel titre ;
 *   — les gestes sensibles, réunis à part : fermer, vider, retirer.
 * Les mêmer sans hiérarchie laissait le vidage à portée d'un clic
 * distrait, au milieu de réglages sans conséquence.
 */
export default function OngletConfiguration({
  siteId, activiteId, role, nomSite, etatSite, onEtatChange, onNomChange,
}: {
  siteId: string;
  activiteId?: string | null;
  /** `null` = admin : aucune restriction */
  role?: RoleSite | null;
  nomSite?: string;
  etatSite?: 'actif' | 'inactif';
  /** remonte le changement pour que l'en-tête suive sans recharger */
  onEtatChange?: (etat: 'actif' | 'inactif') => void;
  /** remonte le nom modifié pour que l'en-tête suive sans recharger */
  onNomChange?: (nom: string) => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');

  /* Seul l'admin (role null) ou le gérant touche aux réglages lourds du
     site. Les autres voient la fiche mais pas les boutons qui détruisent. */
  const estResponsable = role == null || role === 'gerant';

  /* - Informations du site : lues ici, modifiables sur place - */
  const [infos, setInfos] = useState<InfosSite | null>(null);
  const [editionInfos, setEditionInfos] = useState(false);
  const [brouillon, setBrouillon] = useState<InfosSite | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [apercu, setApercu] = useState<string | null>(null);
  const [infosOk, setInfosOk] = useState(false);
  const champImage = useRef<HTMLInputElement>(null);

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
    getDoc(doc(db, 'sites', siteId)).then(s => {
      if (!s.exists()) return;
      const d = s.data() as any;
      setInfos({
        nom: d.nom ?? '',
        type: d.type === 'depot' ? 'depot' : 'boutique',
        adresse: d.adresse ?? '',
        numero: d.numero ?? '',
        imageUrl: d.imageUrl ?? '',
      });
    }).catch(() => setInfos(null));
  }, [siteId]);

  useEffect(() => { if (etatSite) setEtat(etatSite); }, [etatSite]);

  function ouvrirEdition() {
    if (!infos) return;
    setBrouillon({ ...infos });
    setImageFile(null);
    setApercu(null);
    setInfosOk(false);
    setErreur('');
    setEditionInfos(true);
  }

  function choisirImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImageFile(f);
    setApercu(URL.createObjectURL(f));
  }

  async function enregistrerInfos() {
    if (!brouillon) return;
    if (!brouillon.nom.trim()) { setErreur('Le nom du site est requis.'); return; }
    if (!brouillon.adresse.trim()) { setErreur('L’adresse est requise.'); return; }
    setEnCours('infos'); setErreur('');
    try {
      let imageUrl = brouillon.imageUrl;
      if (imageFile) {
        const chemin = storageRefFn(
          storage, `sites/${user?.uid ?? 'inconnu'}/${Date.now()}_${imageFile.name}`);
        await uploadBytes(chemin, imageFile);
        imageUrl = await getDownloadURL(chemin);
      }
      /* Le type ne se modifie pas après création : un dépôt devenu
         boutique bouleverserait son stock et ses droits. On ne réécrit
         donc que ce qui se corrige. */
      const maj = {
        nom: brouillon.nom.trim(),
        adresse: brouillon.adresse.trim(),
        numero: brouillon.numero.trim(),
        imageUrl,
      };
      await updateDoc(doc(db, 'sites', siteId), maj);
      setInfos({ type: infos?.type ?? brouillon.type, ...maj });
      onNomChange?.(maj.nom);
      setEditionInfos(false);
      setInfosOk(true);
      setTimeout(() => setInfosOk(false), 2500);
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
    } finally { setEnCours(null); }
  }

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

  const champClasse =
    'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm '
    + 'text-gray-900 placeholder:text-gray-400 outline-none focus:border-indigo-400 '
    + 'dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

  return (
    <div className="space-y-4">
      {/* ─────────── 1. Informations du site ─────────── */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-start justify-between gap-3">
          <p className="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-gray-100">
            <Info size={15} className="text-indigo-500" /> Informations du site
          </p>
          {infos && !editionInfos && estResponsable && (
            <button onClick={ouvrirEdition}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-indigo-600 transition-colors hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900/30">
              <Pencil size={13} /> Modifier
            </button>
          )}
        </div>

        {infosOk && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-green-600">
            <Check size={13} /> Informations enregistrées.
          </p>
        )}

        {/* Lecture */}
        {infos && !editionInfos && (
          <div className="mt-4 flex items-start gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100 dark:bg-gray-800">
              {infos.imageUrl
                ? <img src={infos.imageUrl} alt={infos.nom} className="h-full w-full object-cover" />
                : (infos.type === 'depot'
                    ? <Warehouse size={24} className="text-gray-400" />
                    : <Store size={24} className="text-gray-400" />)}
            </div>
            <div className="min-w-0 flex-1 space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-bold text-gray-900 dark:text-gray-50">{infos.nom || '—'}</span>
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">
                  {infos.type === 'depot' ? 'Dépôt' : 'Boutique'}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Adresse</p>
                  <p className="text-sm text-gray-700 dark:text-gray-200">{infos.adresse || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Téléphone</p>
                  <p className="text-sm text-gray-700 dark:text-gray-200">{infos.numero || '—'}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {!infos && (
          <p className="mt-4 flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={13} className="animate-spin" /> Chargement…
          </p>
        )}

        {/* Édition */}
        {infos && editionInfos && brouillon && (
          <div className="mt-4 space-y-4">
            {/* Logo */}
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => champImage.current?.click()}
                className="group relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100 ring-1 ring-gray-200 transition hover:ring-indigo-300 dark:bg-gray-800 dark:ring-gray-700">
                {apercu || brouillon.imageUrl
                  ? <img src={apercu ?? brouillon.imageUrl} alt="" className="h-full w-full object-cover" />
                  : <ImagePlus size={22} className="text-gray-400" />}
                <span className="absolute inset-0 hidden items-center justify-center bg-black/40 text-[10px] font-semibold text-white group-hover:flex">
                  Changer
                </span>
              </button>
              <input ref={champImage} type="file" accept="image/*" onChange={choisirImage} className="hidden" />
              <p className="text-xs text-gray-500">Logo du site — s’affiche sur la fiche et sur les PDF.</p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Nom du site</label>
                <input type="text" value={brouillon.nom} className={champClasse}
                  onChange={e => setBrouillon({ ...brouillon, nom: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Adresse</label>
                <input type="text" value={brouillon.adresse} className={champClasse}
                  onChange={e => setBrouillon({ ...brouillon, adresse: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Téléphone</label>
                <input type="text" value={brouillon.numero} className={champClasse}
                  placeholder="Facultatif"
                  onChange={e => setBrouillon({ ...brouillon, numero: e.target.value })} />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={enregistrerInfos} disabled={enCours !== null}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {enCours === 'infos'
                  ? <Loader2 size={14} className="animate-spin" />
                  : <Check size={14} />}
                Enregistrer
              </button>
              <button onClick={() => { setEditionInfos(false); setErreur(''); }}
                disabled={enCours !== null}
                className="rounded-xl px-4 py-2 text-sm font-semibold text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800">
                Annuler
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─────────── 2. Équipe : qui accède, et à quoi ─────────── */}
      {activiteId && <SectionEquipe siteId={siteId} activiteId={activiteId} />}

      {/* ─────────── 3. Zone sensible : fermer, vider, retirer ───────────
          Réunis sous un même intitulé, à l'écart des réglages ordinaires :
          ces gestes engagent, et deux d'entre eux ne se défont pas. */}
      {estResponsable && (
        <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-5 dark:border-gray-700 dark:bg-gray-900/40">
          <p className="flex items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-200">
            <AlertTriangle size={15} className="text-amber-500" /> Zone sensible
          </p>
          <p className="mt-1 text-xs text-gray-400">
            Fermer le site, effacer ses opérations ou le retirer. Les deux
            derniers gestes sont sans retour.
          </p>

          <div className="mt-4 space-y-4">
            {/* Désactiver — réversible, en neutre. */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
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

            {/* Vider les opérations — destructif. */}
            <div className="rounded-xl border border-red-200 bg-white p-4 dark:border-red-900 dark:bg-gray-900">
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

            {/* Supprimer le site — destructif, et seulement si vide. */}
            <div className="rounded-xl border border-red-200 bg-white p-4 dark:border-red-900 dark:bg-gray-900">
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
          </div>
        </div>
      )}

      {erreur && (
        <p className="rounded-xl bg-red-50 dark:bg-red-900/20 px-4 py-3 text-xs text-red-600">
          {erreur}
        </p>
      )}
    </div>
  );
}
