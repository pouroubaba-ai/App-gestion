'use client';
import { useEffect, useState } from 'react';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter } from 'next/navigation';
import { Loader2, Check, Ship, ArrowRight, X } from 'lucide-react';
import { formatMontant } from '@/lib/format';
import { auteurCourant, auteurEtape } from '@/lib/auteur';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import PanneauFrais from '@/app/site/[id]/components/PanneauFrais';
import {
  totalFrais, controlerRepartition, repartirFrais,
  CLE_PAR_DEFAUT, type Frais, type CleRepartition,
} from '@/lib/frais';
import {
  valeurEnvoyee, valeurRecue, confirmerAchat, type LigneFlux,
} from '@/lib/flux-marchandise';
import { ChampNombre } from '@/components/Champs';
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

  /* Les quantités comptées à la réception. */
  const [comptees, setComptees] = useState<Record<number, number>>({});

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

  /* Le dossier vaut ce qui est arrivé une fois compté ; avant, ce qui
     était annoncé. */
  const compte = ETAPES_IMPORTATION.indexOf(dossier.etat)
    >= ETAPES_IMPORTATION.indexOf('recu') || dossier.etat === 'attente_confirmation';
  const marchandise = compte ? valeurRecue(dossier.lignes) : valeurEnvoyee(dossier.lignes);
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
        lignes: saisieQuantites
          ? dossier!.lignes.map((l, i) => ({
              ...l,
              quantiteRecue: comptees[i] ?? l.quantiteRecue ?? l.quantiteDemandee,
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
      const lignes: LigneFlux[] = dossier!.lignes.map((l, i) => ({
        ...l,
        quantiteRecue: comptees[i] ?? l.quantiteRecue ?? l.quantiteDemandee,
      }));
      /* Le même geste qu'un achat : le stock entre, les frais se
         répartissent dans le coût, la dette naît. Deux façons de le
         faire finiraient par diverger. */
      await confirmerAchat({
        roleSite: role,
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
          <p className="mb-3 text-sm font-bold text-gray-900 dark:text-gray-100">Marchandise</p>
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
                    <th className="rounded-r-lg px-3 py-2.5 font-medium">Total</th>
                  </>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {dossier.lignes.map((l, i) => {
                  const qte = compte
                    ? (comptees[i] ?? l.quantiteRecue ?? l.quantiteDemandee)
                    : l.quantiteDemandee;
                  const part = parts?.[i] ?? 0;
                  const reel = qte > 0 ? l.valeurUnitaire + part / qte : l.valeurUnitaire;
                  const ecart = compte && qte !== l.quantiteDemandee;
                  return (
                    <tr key={i} className={ecart
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
                        {saisieQuantites && peut ? (
                          <div className="mx-auto w-24">
                            <ChampNombre
                              valeur={comptees[i] ?? l.quantiteRecue ?? l.quantiteDemandee}
                              onChange={n => setComptees(c => ({ ...c, [i]: n }))}
                              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-center text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800" />
                          </div>
                        ) : (
                          <span className={`font-medium ${!ecart
                            ? 'text-gray-600 dark:text-gray-300'
                            : qte > l.quantiteDemandee ? 'text-blue-500' : 'text-orange-500'}`}>
                            {compte ? qte.toLocaleString('fr-FR') : '—'}
                          </span>
                        )}
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
                    </tr>
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
