'use client';
import { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { ChampNombre } from '@/components/Champs';
import {
  SensCaisse, MotifCaisse, MOTIFS_MANUELS, LIBELLES_MOTIF_CAISSE,
  chargerCaisseDuSite, soldeCaisse,
} from '@/lib/caisse';
import { ecrireEnCaisse } from '@/lib/ecrire-caisse';
import {
  chargerAttente, disponibleEnCaisse, type MouvementAttente,
} from '@/lib/attente-caisse';
import { useAuth } from '@/lib/auth-context';
import { formatMontant } from '@/lib/format';
import {
  peutDisposerDuCapital, peutDeclarerMouvement, type RoleSite,
} from '@/lib/roles';

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

/**
 * Saisie d'un mouvement de caisse.
 *
 * Seuls les motifs qui ne découlent d'aucun acte se saisissent ici : un
 * apport, un retrait, un frais de boutique. Une vente ou un versement
 * naissent de leur propre écran — les ressaisir créerait un doublon que
 * rien ne raccorderait au document d'origine.
 */
export default function ModalMouvementCaisse({
  siteId, utilisateur, utilisateurNom, utilisateurFonction,
  sousMotifs, onFermer, onEnregistre, roleSite = null,
}: {
  siteId: string;
  utilisateur?: string | null;
  utilisateurNom?: string | null;
  utilisateurFonction?: string | null;
  /** la liste que l'utilisateur gère ; vide tant qu'il n'en a créé aucun */
  sousMotifs?: string[];
  onFermer: () => void;
  /** `applique` dit si l'argent a bougé, ou s'il attend la caisse. */
  onEnregistre: (applique: boolean) => void;
  /* Le caissier tient le tiroir : il ne déclare aucun mouvement, et ne
     dispose pas de l'argent du propriétaire. */
  roleSite?: RoleSite | null;
}) {
  /* L'admin de l'activité n'a pas de rôle de site : son identifiant sert
     à le reconnaître quand on cherche qui agit. */
  const { activite } = useAuth();
  const [sens, setSens] = useState<SensCaisse>('sortie');
  const [motif, setMotif] = useState<MotifCaisse>('boutique');
  const [sousMotif, setSousMotif] = useState('');
  const [detail, setDetail] = useState('');
  const [montant, setMontant] = useState(0);
  const [date, setDate] = useState(aujourdhui());
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  /* Ce qu'il y a dans le tiroir : on ne saisit pas une sortie à l'aveugle. */
  const [solde, setSolde] = useState<number | null>(null);
  /* Ce qui est déjà promis et pas encore sorti : le tiroir le contient
     encore, mais il ne s'en dispose plus. */
  const [attente, setAttente] = useState<MouvementAttente[]>([]);

  useEffect(() => {
    chargerCaisseDuSite(siteId).then(m => setSolde(soldeCaisse(m)));
    chargerAttente(siteId).then(setAttente).catch(() => setAttente([]));
  }, [siteId]);

  /* On ne sort pas d'un tiroir plus qu'il ne contient — ni plus qu'il ne
     contiendra une fois honoré ce qui est déjà déclaré. Comparé au seul
     solde, trois sorties de 40 000 passaient sur un tiroir de 50 000, et
     le caissier découvrait le trou en ouvrant. */
  const compte = disponibleEnCaisse(solde ?? 0, attente);
  const depasse = sens === 'sortie' && solde != null && montant > compte.disponible;
  /* Ce qui manque pour que la sortie passe. */
  const manque = depasse ? montant - compte.disponible : 0;

  /* L'apport qui comblera le manque.
     « Ça vient de ma poche » n'est pas un état de la caisse : c'est une
     annotation qui laisse le solde faux et ne dit jamais combien le
     propriétaire a réellement injecté. Un apport, lui, est un fait — il
     entre, puis il sort, et le solde reste vrai à chaque instant. */
  const [avecApport, setAvecApport] = useState(false);
  const [apport, setApport] = useState(0);
  /* D'où vient l'argent apporté : une vente personnelle, un prêt, une
     réserve. L'app ne peut pas le deviner, et c'est précisément ce qu'on
     voudra relire dans six mois. */
  const [detailApport, setDetailApport] = useState('');

  /* Le complément par défaut : mettre moins laisserait la sortie
     impossible, mettre plus approvisionne la caisse d'un coup. */
  useEffect(() => {
    if (avecApport && apport < manque) setApport(manque);
  }, [avecApport, manque, apport]);

  const apportSuffit = !depasse || (avecApport && apport >= manque);

  /* Apport et retrait disposent du capital : ils reviennent au propriétaire
     ou au gérant. */
  const capital = peutDisposerDuCapital(roleSite);
  const motifsPossibles = MOTIFS_MANUELS[sens].filter(
    m => capital || (m !== 'apport' && m !== 'retrait'));

  function changerSens(s: SensCaisse) {
    setSens(s);
    /* Le motif courant peut ne pas exister dans l'autre sens — ni être
       permis à ce rôle : on prend le premier qui l'est. */
    const permis = MOTIFS_MANUELS[s].filter(
      m => capital || (m !== 'apport' && m !== 'retrait'));
    setMotif(permis[0] ?? MOTIFS_MANUELS[s][0]);
    setSousMotif('');
  }

  async function enregistrer() {
    if (montant <= 0 || !apportSuffit) return;
    /* Les gardes tiennent aussi ici : cacher un écran ne ferme pas
       l'écriture qu'il déclenche. */
    if (!peutDeclarerMouvement(roleSite)) return;
    if (!capital && (motif === 'apport' || motif === 'retrait')) return;
    setEnCours(true);
    setErreur('');
    try {
      /* L'apport d'abord, la sortie ensuite : l'ordre inverse ferait passer
         la caisse en négatif entre les deux, et chaque mouvement porte son
         solde — une ligne négative resterait dans l'historique même une fois
         la sortie enregistrée. */
      if (depasse && avecApport && apport > 0) {
        await ecrireEnCaisse({
          siteId, sens: 'entree', motif: 'apport',
          sousMotif: 'Complément de caisse',
          /* À défaut de précision, on dit au moins à quoi il a servi. */
          detail: detailApport.trim()
            || `Pour ${LIBELLES_MOTIF_CAISSE[motif].toLowerCase()}`,
          montant: apport, date,
          utilisateur: utilisateur ?? null,
          utilisateurNom: utilisateurNom ?? 'Admin',
          utilisateurFonction: utilisateurFonction ?? 'Admin',
        }, utilisateur ?? null, activite?.adminUid ?? null);
      }

      /* Le mouvement ne va pas droit au registre : dès que le site a un
         responsable de la caisse, il attend qu'il ouvre le tiroir. Décider
         d'une dépense et la payer sont deux gestes. */
      const { applique } = await ecrireEnCaisse({
        siteId, sens, motif,
        sousMotif: sousMotif.trim() || null,
        detail: detail.trim() || null,
        montant, date,
        utilisateur: utilisateur ?? null,
        utilisateurNom: utilisateurNom ?? 'Admin',
        utilisateurFonction: utilisateurFonction ?? 'Admin',
      }, utilisateur ?? null, activite?.adminUid ?? null);

      /* Dire ce qui s'est passé : sans cela, celui qui vient de déclarer
         une sortie croit l'argent parti alors qu'il attend au tiroir. */
      onEnregistre(applique);
      onFermer();
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setEnCours(false);
    }
  }

  /* Un formulaire qu'on remplit pour rien est pire qu'un écran absent :
     on n'ouvre pas la saisie à qui ne peut pas déclarer. */
  if (!peutDeclarerMouvement(roleSite)) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      {/* Hauteur fixe : le champ sous-motif n'existe que pour le motif
          Boutique, et sans elle la fenêtre sautait à chaque changement de
          motif — le bouton Enregistrer se dérobant sous le curseur. */}
      <div className="flex h-[560px] max-h-[90vh] w-full max-w-sm flex-col rounded-2xl bg-white p-6 dark:bg-neutral-900">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <p className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
            Nouveau mouvement
          </p>
          <button onClick={onFermer} className="p-1 text-neutral-400 hover:text-neutral-600">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">

        <label className="mb-1.5 block text-xs font-bold text-neutral-500 dark:text-neutral-400">
          Sens
        </label>
        <div className="mb-3 flex overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
          {([
            { key: 'sortie' as const, label: 'Sortie' },
            { key: 'entree' as const, label: 'Entrée' },
          ]).map(o => (
            <button key={o.key} type="button" onClick={() => changerSens(o.key)}
              className={`flex-1 px-2 py-2 text-xs font-bold transition-colors ${
                sens === o.key
                  ? 'bg-indigo-600 text-white'
                  : 'text-neutral-500 hover:text-indigo-600'}`}>
              {o.label}
            </button>
          ))}
        </div>

        <label className="mb-1.5 block text-xs font-bold text-neutral-500 dark:text-neutral-400">
          Motif
        </label>
        {/* Pleine largeur, en grille : à trois motifs, une demi-largeur
            coupait les libellés et faisait défiler la fenêtre. */}
        <div className="mb-3 grid grid-cols-3 gap-2">
          {motifsPossibles.map(m => (
            <button key={m} type="button" onClick={() => { setMotif(m); setSousMotif(''); }}
              className={`rounded-xl border px-1 py-2 text-xs font-bold transition-colors ${
                motif === m
                  ? 'border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20'
                  : 'border-black/10 text-neutral-500 hover:border-indigo-300 dark:border-white/10'}`}>
              {LIBELLES_MOTIF_CAISSE[m]}
            </button>
          ))}
        </div>

        {/* Le sous-motif ne concerne que les frais de boutique : un apport
            ou un retrait n'a rien à préciser. */}
        {motif === 'boutique' && (
          <>
            <label className="mb-1.5 block text-xs font-bold text-neutral-500 dark:text-neutral-400">
              Sous-motif
            </label>
            {sousMotifs && sousMotifs.length > 0 ? (
              <select value={sousMotif} onChange={e => setSousMotif(e.target.value)}
                className="mb-3 w-full rounded-xl border border-black/10 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-100">
                <option value="">— Aucun —</option>
                {sousMotifs.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : (
              <p className="mb-3 text-xs text-neutral-400">
                Aucun sous-motif configuré. Le détail suffit pour le moment.
              </p>
            )}
          </>
        )}

        <label className="mb-1.5 block text-xs font-bold text-neutral-500 dark:text-neutral-400">
          Détail
        </label>
        <input type="text" value={detail} onChange={e => setDetail(e.target.value)}
          placeholder="Facultatif"
          className="mb-3 w-full rounded-xl border border-black/10 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-100" />

        <div className="mb-1.5 flex items-baseline justify-between">
          <label className="text-xs font-bold text-neutral-500 dark:text-neutral-400">
            Montant
          </label>
          {/* Le disponible plutôt que le solde, quand les deux diffèrent :
              c'est lui qui commande la saisie, et annoncer l'autre ferait
              croire à une erreur au moment du blocage. */}
          <span className="text-xs text-neutral-400">
            {sens === 'sortie' && compte.engage > 0 ? 'Disponible' : 'En caisse'}{' '}
            <span className="font-bold text-neutral-700 dark:text-neutral-200">
              {solde == null ? '…' : formatMontant(
                sens === 'sortie' && compte.engage > 0 ? compte.disponible : solde)}
            </span>
          </span>
        </div>
        <ChampNombre valeur={montant} onChange={setMontant}
          className={`w-full rounded-xl border bg-neutral-50 px-3 py-2 text-sm text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100 ${
            depasse ? 'border-red-400 dark:border-red-500' : 'border-black/10 dark:border-white/10'}`} />
        <p className={`mt-1 text-xs ${depasse ? 'text-red-500' : 'text-neutral-400'}`}>
          {depasse
            ? `Manque ${formatMontant(manque)}`
            : 'La sortie ne peut dépasser la caisse.'}
        </p>

        {/* Le calcul, quand quelque chose est engagé : sans lui, le
            blocage paraît faux — le tiroir affiche 50 000 et refuse 40 000,
            et personne ne devine pourquoi. */}
        {sens === 'sortie' && compte.engage > 0 && (
          <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 dark:bg-amber-900/10">
            <p className="flex justify-between text-[11px] text-amber-700 dark:text-amber-400">
              <span>En caisse</span>
              <span className="font-medium">{formatMontant(compte.solde)}</span>
            </p>
            <p className="flex justify-between text-[11px] text-amber-700 dark:text-amber-400">
              <span>Sorties en attente</span>
              <span className="font-medium">−{formatMontant(compte.engage)}</span>
            </p>
            <p className="mt-1 flex justify-between border-t border-amber-200 pt-1 text-[11px] font-bold text-amber-800 dark:border-amber-800/40 dark:text-amber-300">
              <span>Disponible</span>
              <span>{formatMontant(compte.disponible)}</span>
            </p>
          </div>
        )}

        <div className="mb-3" />

        {/* Plutôt que de renvoyer vers l'onglet Fonds et de faire recommencer
            la saisie, l'apport se fait ici. C'est le même acte, au moment où
            le besoin apparaît. */}
        {/* Ce complément écrit un apport : il suit donc le même droit. Sans
            lui, le caissier contournerait la règle par ce raccourci. */}
        {depasse && capital && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-900/20">
            <label className="flex cursor-pointer items-start gap-2">
              <input type="checkbox" checked={avecApport}
                onChange={e => { setAvecApport(e.target.checked); if (e.target.checked) setApport(manque); }}
                className="mt-0.5 accent-amber-600" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-amber-800 dark:text-amber-400">
                  Compléter par un apport
                </span>
              </span>
            </label>

            {avecApport && (
              <div className="mt-2.5">
                <ChampNombre valeur={apport} onChange={setApport}
                  className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-amber-800 dark:bg-neutral-800 dark:text-neutral-100" />
                <p className={`mt-1 text-[11px] ${
                  apport < manque ? 'text-red-500' : 'text-amber-700 dark:text-amber-400'}`}>
                  {apport < manque
                    ? `Minimum ${formatMontant(manque)}`
                    : `Caisse après ${formatMontant((solde ?? 0) + apport - montant)}`}
                </p>

                <input type="text" value={detailApport}
                  onChange={e => setDetailApport(e.target.value)}
                  placeholder="Détail"
                  className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-amber-600/50 dark:border-amber-800 dark:bg-neutral-800 dark:text-neutral-100" />
              </div>
            )}
          </div>
        )}

        <label className="mb-1.5 block text-xs font-bold text-neutral-500 dark:text-neutral-400">
          Date
        </label>
        <input type="date" value={date} max={aujourdhui()}
          onChange={e => setDate(e.target.value)}
          className="w-full rounded-xl border border-black/10 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-100" />

        </div>

        {/* Le bouton reste au bas de la fenêtre, jamais emporté par le
            défilement des champs. */}
        <div className="shrink-0 pt-4">
          {erreur && <p className="mb-3 text-xs text-red-500">{erreur}</p>}
          <button onClick={enregistrer} disabled={enCours || montant <= 0 || !apportSuffit}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
            {enCours && <Loader2 size={14} className="animate-spin" />}
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
