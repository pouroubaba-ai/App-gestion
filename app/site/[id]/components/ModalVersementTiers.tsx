'use client';
import { useEffect, useState } from 'react';
import { X, Loader2, Check } from 'lucide-react';
import { ChampNombre, ChampRecherche } from '@/components/Champs';
import { formatMontant, abregeMontant } from '@/lib/format';
import { auteurCourant } from '@/lib/auteur';
import {
  chargerCaisseDuSite, soldeCaisse,
} from '@/lib/caisse';
import { hankenGrotesk } from './finance/font';
import { ecrireEnCaisse } from '@/lib/ecrire-caisse';
import { chargerDisponible } from '@/lib/attente-caisse';
import { peutReglerFournisseur, type RoleSite } from '@/lib/roles';
import DisponibleCaisse from './DisponibleCaisse';
import { useAuth } from '@/lib/auth-context';
import {
  RoleTiers, CouvertureTiers, couvertureTiers, repartition, verserAuTiers,
} from '@/lib/versements';

export interface TiersVersable {
  id: string;
  nom: string;
  /** ce qu'il doit dans le rôle affiché ; seuls les débiteurs sont proposés */
  du: number;
}

/**
 * Verser sur le compte d'un tiers, depuis la liste des partenaires.
 *
 * Passer par la fiche de chacun pour encaisser oblige à savoir d'avance qui
 * vient payer. Ici on choisit le tiers au moment où il se présente, et l'app
 * répartit le montant comme elle le ferait depuis sa fiche.
 */
export default function ModalVersementTiers({
  siteId, userId, role, tiers, onFermer, onVerse, parRemise = false,
  roleSite = null,
}: {
  siteId: string;
  userId: string;
  role: RoleTiers;
  /** les partenaires du rôle qui doivent encore quelque chose */
  tiers: TiersVersable[];
  onFermer: () => void;
  onVerse: (partenaireId: string, montant: number) => void;
  /* Celui qui encaisse ne tient pas la caisse : l'argent qu'il reçoit
     attend d'être remis, et le registre ne le comptera qu'après. */
  parRemise?: boolean;
  /* Le rôle de celui qui verse : régler un fournisseur n'appartient pas à
     qui recouvre. */
  roleSite?: RoleSite | null;
}) {
  /* L'admin de l'activité n'a pas de rôle de site : son identifiant sert
     à le reconnaître quand la caisse cherche qui agit. */
  const { activite } = useAuth();
  const [choisi, setChoisi] = useState('');
  const [recherche, setRecherche] = useState('');
  const [montant, setMontant] = useState(0);
  const [couverture, setCouverture] = useState<CouvertureTiers | null>(null);
  const [chargement, setChargement] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  /* Payer un fournisseur sort de l'argent : sans voir la caisse, on saisit
     un montant sans savoir s'il est possible. Encaisser un client fait
     entrer de l'argent — la question ne se pose pas de ce côté. */
  const sortDeCaisse = role === 'fournisseur';
  const [soldeCaisseSite, setSoldeCaisseSite] = useState<number | null>(null);
  /* Ce qu'on peut encore laisser sortir : le solde moins ce qui est déjà
     déclaré et pas encore passé par le tiroir. Comparé au seul solde, les
     sorties s'enchaînaient sur un chiffre qui ne bougeait pas. */
  const [engageCaisse, setEngageCaisse] = useState(0);
  const [soldeReelCaisse, setSoldeReelCaisse] = useState<number | null>(null);

  const [avecApport, setAvecApport] = useState(false);
  const [apport, setApport] = useState(0);
  const [detailApport, setDetailApport] = useState('');

  useEffect(() => {
    if (!sortDeCaisse) return;
    chargerDisponible(siteId)
      .then(d => {
        setSoldeCaisseSite(d.disponible);
        setSoldeReelCaisse(d.solde);
        setEngageCaisse(d.engage);
      })
      .catch(() => setSoldeCaisseSite(null));
  }, [siteId, sortDeCaisse]);

  const tiersChoisi = tiers.find(t => t.id === choisi);

  /* Les plus gros débiteurs d'abord : c'est là que se joue l'essentiel de
     ce qu'il y a à recouvrer. */
  const listeFiltree = tiers
    .filter(t => !recherche.trim() || t.nom.toLowerCase().includes(recherche.trim().toLowerCase()))
    .sort((a, b) => b.du - a.du);

  /* La couverture se charge à la sélection : sans elle, on ne saurait ni
     quoi plafonner ni sur quoi imputer. */
  useEffect(() => {
    if (!tiersChoisi) { setCouverture(null); return; }
    setChargement(true);
    couvertureTiers(siteId, tiersChoisi.id, role, tiersChoisi.du)
      .then(c => { setCouverture(c); setChargement(false); })
      .catch(e => { setErreur(e?.message ?? 'Chargement impossible.'); setChargement(false); });
  }, [choisi, siteId, role, tiersChoisi]);

  async function enregistrer() {
    if (!tiersChoisi || !couverture || montant <= 0 || !apportSuffit) return;
    /* La garde tient aussi ici : cacher un bouton ne ferme pas l'écriture
       qu'il déclenche, et payer un fournisseur ne relève pas de qui
       recouvre. */
    if (role === 'fournisseur' && !peutReglerFournisseur(roleSite)) return;
    setEnCours(true);
    setErreur('');
    try {
      /* L'apport d'abord : l'ordre inverse ferait passer la caisse en
         négatif entre les deux écritures, et chaque mouvement porte son
         solde — la ligne négative resterait dans l'historique. */
      if (depasseCaisse && avecApport && apport > 0) {
        const auteur = await auteurCourant(siteId, userId);
        await ecrireEnCaisse({
          siteId, sens: 'entree', motif: 'apport',
          sousMotif: 'Complément de caisse',
          detail: detailApport.trim() || `Pour régler ${tiersChoisi.nom}`,
          montant: apport,
          date: new Date().toISOString().split('T')[0],
          utilisateur: userId,
          utilisateurNom: auteur.utilisateurNom,
          utilisateurFonction: auteur.utilisateurFonction,
        }, userId, activite?.adminUid ?? null);
      }

      const verse = await verserAuTiers({
        siteId, userId, partenaireId: tiersChoisi.id, role,
        partenaireNom: tiersChoisi.nom,
        montant, couverture, parRemise,
        adminUid: activite?.adminUid ?? null,
        ...(await auteurCourant(siteId, userId)),
      });
      onVerse(tiersChoisi.id, verse);
      onFermer();
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setEnCours(false);
    }
  }

  const apercu = couverture && montant > 0
    ? repartition(Math.min(montant, couverture.du), couverture)
    : null;

  const depasseCaisse = sortDeCaisse && soldeCaisseSite != null
    && montant > soldeCaisseSite;
  const manque = depasseCaisse ? montant - (soldeCaisseSite ?? 0) : 0;
  const apportSuffit = !depasseCaisse || (avecApport && apport >= manque);

  /* Le complément par défaut : mettre moins laisserait le paiement
     impossible, mettre plus approvisionne la caisse d'un coup. */
  useEffect(() => {
    if (avecApport && apport < manque) setApport(manque);
  }, [avecApport, manque, apport]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      {/* Hauteur bornée, pied fixe : l'aperçu grandit avec le nombre
          d'échéances et emporterait Confirmer avec lui. */}
      <div className="flex h-[520px] max-h-[85vh] w-full max-w-sm flex-col rounded-2xl bg-white dark:bg-gray-900 p-5 shadow-xl">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
            Verser — {role === 'fournisseur' ? 'Fournisseur' : 'Client'}
          </h2>
          <button onClick={onFermer} className="p-1 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">

          {/* Tant qu'aucun tiers n'est choisi, le modal est un annuaire : on
              voit qui doit quoi et on cherche dedans. Une liste déroulante
              obligeait à connaître le nom d'avance, et sur deux cents
              comptes elle ne montrait rien. */}
          {!tiersChoisi ? (
            tiers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-3 py-10 text-center">
                <p className="text-sm font-medium text-gray-500">Aucun compte à régler</p>
                <p className="mt-0.5 text-xs text-gray-400">
                  {role === 'fournisseur'
                    ? 'Vous ne devez rien à vos fournisseurs.'
                    : 'Aucun client ne vous doit quoi que ce soit.'}
                </p>
              </div>
            ) : (
              <>
                <ChampRecherche
                  placeholder={`Rechercher un ${role === 'fournisseur' ? 'fournisseur' : 'client'}…`}
                  valeur={recherche}
                  onChange={setRecherche}
                  className="w-full mb-2"
                />
                <p className="mb-2 text-xs font-medium text-gray-500">
                  {listeFiltree.length} compte{listeFiltree.length > 1 ? 's' : ''} à régler
                  <span className="ml-2 text-gray-400">
                    · {formatMontant(listeFiltree.reduce((n, t) => n + t.du, 0))}
                  </span>
                </p>
                {listeFiltree.length === 0 ? (
                  <p className="py-8 text-center text-xs text-gray-400">Aucun résultat.</p>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-gray-100 dark:border-gray-800 divide-y divide-gray-50 dark:divide-gray-800">
                    {listeFiltree.map(t => (
                      <button key={t.id} type="button"
                        onClick={() => { setChoisi(t.id); setMontant(0); }}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {t.nom}
                        </span>
                        <span className="shrink-0 text-sm font-bold text-orange-500">
                          {formatMontant(t.du)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )
          ) : (
            <>
              {/* Le compte choisi reste visible : on doit pouvoir vérifier à
                  qui l'on verse sans fermer le modal. */}
              <button type="button"
                onClick={() => { setChoisi(''); setMontant(0); }}
                className="mb-3 flex w-full items-center justify-between gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-left transition-colors hover:border-indigo-300">
                <span className="min-w-0">
                  <span className="block text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    {role === 'fournisseur' ? 'Fournisseur' : 'Client'}
                  </span>
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {tiersChoisi.nom}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-medium text-indigo-600 dark:text-indigo-400">
                  Changer
                </span>
              </button>

              {chargement && (
                <div className="flex justify-center py-6">
                  <Loader2 size={18} className="animate-spin text-indigo-500" />
                </div>
              )}

              {couverture && !chargement && (
                <>
                  {/* Ce qu'il y a en caisse, au même endroit que ce qui est dû :
                  les deux ensemble disent si le paiement est possible. */}
              {sortDeCaisse && soldeCaisseSite != null && (
                <DisponibleCaisse className="mb-2"
                  solde={soldeReelCaisse ?? soldeCaisseSite}
                  engage={engageCaisse} disponible={soldeCaisseSite} />
              )}

              <p className="mb-1 text-xs font-bold uppercase text-gray-400">Montant</p>
                  {/* Dû, planifié, reste : un plafond seul ne dit pas d'où il
                      vient ni s'il reste des échéances à honorer. */}
                  <div className={`${hankenGrotesk.className} mb-3 grid grid-cols-3 gap-2`}>
                    {([
                      { label: 'Dû', valeur: couverture.du, fort: false },
                      { label: 'Planifié', valeur: couverture.planifie, fort: false },
                      { label: 'Reste', valeur: couverture.reste, fort: true },
                    ]).map(i => (
                      <div key={i.label}
                        className="rounded-xl bg-gray-50 dark:bg-gray-800/60 px-2.5 py-2 text-center"
                        title={formatMontant(i.valeur)}>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{i.label}</p>
                        <p className={`mt-0.5 text-sm font-bold leading-5 tracking-tight ${
                          i.fort
                            ? i.valeur > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400'
                            : 'text-gray-900 dark:text-gray-100'}`}>
                          {abregeMontant(i.valeur)}
                        </p>
                      </div>
                    ))}
                  </div>

                  <ChampNombre
                    valeur={montant}
                    onChange={setMontant} max={couverture.du}
                    className="mb-1 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <p className="mb-3 text-xs text-gray-400">
                    Réparti sur les échéances ouvertes, des plus anciennes aux plus récentes.
                  </p>

              {/* Plutôt que de renvoyer vers Fonds disponible et de faire
                  recommencer la saisie, l'apport se fait ici. */}
              {depasseCaisse && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-900/20">
                  <p className="mb-2 text-xs font-bold text-red-600 dark:text-red-400">
                    Manque {formatMontant(manque)}
                  </p>
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
                        className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-amber-800 dark:bg-gray-800 dark:text-gray-100" />
                      <p className={`mt-1 text-[11px] ${
                        apport < manque ? 'text-red-500' : 'text-amber-700 dark:text-amber-400'}`}>
                        {apport < manque
                          ? `Minimum ${formatMontant(manque)}`
                          : `Caisse après ${formatMontant((soldeCaisseSite ?? 0) + apport - montant)}`}
                      </p>
                      <input type="text" value={detailApport}
                        onChange={e => setDetailApport(e.target.value)}
                        placeholder="Détail"
                        className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-amber-600/50 dark:border-amber-800 dark:bg-gray-800 dark:text-gray-100" />
                    </div>
                  )}
                </div>
              )}

                  {apercu && (apercu.parEcheance.length > 0 || apercu.horsEcheance > 0) && (
                    <div className="mb-4 overflow-hidden rounded-xl border border-gray-100 dark:border-gray-800">
                      <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 px-3 py-2 text-xs">
                        <span className="font-bold text-gray-700 dark:text-gray-200">
                          {apercu.parEcheance.length} échéance{apercu.parEcheance.length > 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="max-h-28 divide-y divide-gray-50 dark:divide-gray-800 overflow-y-auto">
                        {apercu.parEcheance.map(({ e, part }) => (
                          <div key={e.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                            <span className="text-gray-500">
                              {new Date(e.date).toLocaleDateString('fr-FR')}
                              {part >= e.reste && <span className="ml-1.5 font-medium text-green-600">sera soldée</span>}
                            </span>
                            <span className="font-bold text-gray-700 dark:text-gray-200">{formatMontant(part)}</span>
                          </div>
                        ))}
                      </div>
                      {apercu.horsEcheance > 0 && (
                        <div className="flex items-center justify-between border-t border-gray-100 dark:border-gray-800 px-3 py-2 text-xs">
                          <span className="text-gray-500">Hors échéance</span>
                          <span className="font-bold text-gray-700 dark:text-gray-200">
                            {formatMontant(apercu.horsEcheance)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {erreur && <p className="mb-3 text-xs text-red-500">{erreur}</p>}
        </div>

        {/* Tant qu'aucun compte n'est choisi, le modal ne fait que montrer :
            la croix suffit à le quitter, et un pied de page n'aurait rien à
            valider. Il n'apparaît qu'au moment de saisir. */}
        {tiersChoisi && (
          <div className="flex shrink-0 gap-3 pt-4">
            <button onClick={onFermer}
              className="flex-1 rounded-xl border border-gray-200 dark:border-gray-700 py-2.5 text-sm font-medium text-gray-500">
              Annuler
            </button>
            <button onClick={enregistrer}
              disabled={enCours || !couverture || montant <= 0 || !apportSuffit}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
              {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Confirmer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
