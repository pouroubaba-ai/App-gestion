'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { doc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { viderExploitation, type BilanPurge } from '@/lib/purge';
import {
  simulerMigration, migrerProduits, type BilanMigration,
} from '@/lib/migration-produits';
import { signOut } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import AppLayout from '@/components/AppLayout';
import { Loader2, Check, LogOut, Trash2, AlertTriangle, Package } from 'lucide-react';

/**
 * Les paramètres de l'activité.
 *
 * Elle est au-dessus des sites : son nom, son propriétaire, et plus tard les
 * comptes qui y travaillent. Ce qui relève d'un site se règle dans son
 * propre onglet Configuration.
 */
export default function ParametrePage() {
  const { user, activite, profile, loading } = useAuth();
  const router = useRouter();
  const [nom, setNom] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [enregistre, setEnregistre] = useState(false);

  /* La purge : on regarde d'abord ce qui partirait, on confirme ensuite.
     Firestore n'a pas de corbeille — ce qui est supprimé ne revient pas,
     et il n'y a pas de seconde chance pour s'en apercevoir. */
  const [bilan, setBilan] = useState<BilanPurge | null>(null);
  const [purgeEnCours, setPurgeEnCours] = useState(false);

  /* La migration des produits : on regarde ce qui fusionnerait avant
     d'écrire, parce qu'un rapprochement par le nom peut se tromper. */
  const [migBilan, setMigBilan] = useState<BilanMigration | null>(null);
  const [migEnCours, setMigEnCours] = useState(false);
  const [migFaite, setMigFaite] = useState<BilanMigration | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [purgeFaite, setPurgeFaite] = useState<BilanPurge | null>(null);
  const [erreurPurge, setErreurPurge] = useState('');
  /* Ce qu'on efface : ce que la boutique a fait, ou tout ce qu'elle a. */
  const [complet, setComplet] = useState(false);

  /** Les sites de l'activité : c'est sur eux que porte la purge. */
  async function sitesDeLActivite(): Promise<string[]> {
    const snap = await getDocs(query(
      collection(db, 'sites'), where('activiteId', '==', activite!.id)));
    return snap.docs.map(d => d.id);
  }

  /* Compter sans rien écrire : le seul moyen de savoir ce qu'on s'apprête
     à perdre, puisqu'on ne pourra pas le rattraper après. */
  async function simuler() {
    setPurgeEnCours(true); setErreurPurge(''); setPurgeFaite(null);
    try {
      setBilan(await viderExploitation(await sitesDeLActivite(), true, complet));
    } catch (e: any) { setErreurPurge(e?.message ?? 'Échec de la lecture.'); }
    finally { setPurgeEnCours(false); }
  }

  async function vider() {
    /* Le nom de l'activité se retape à la main : un bouton seul se clique
       par accident, un nom recopié ne s'écrit pas sans le vouloir. */
    if (confirmation.trim() !== activite!.nom) return;
    setPurgeEnCours(true); setErreurPurge('');
    try {
      const fait = await viderExploitation(await sitesDeLActivite(), false, complet);
      setPurgeFaite(fait);
      setBilan(null);
      setConfirmation('');
    } catch (e: any) { setErreurPurge(e?.message ?? 'Échec de la suppression.'); }
    finally { setPurgeEnCours(false); }
  }

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push('/login'); return; }
    /* Cet écran gère l'activité : la renommer, purger ses données. Un
       membre n'en a aucune — l'envoyer vers `/activite` le faisait
       rebondir vers `/site`, puis vers son onglet de départ. Trois sauts
       pour revenir au point de départ. On l'y ramène directement. */
    if (!activite) {
      router.replace(profile?.role === 'membre' ? '/site' : '/activite');
      return;
    }
    setNom(activite.nom);
  }, [user, activite, profile?.role, loading, router]);

  async function enregistrer() {
    if (!activite || !nom.trim() || nom.trim() === activite.nom) return;
    setEnCours(true);
    await updateDoc(doc(db, 'activites', activite.id), { nom: nom.trim() });
    setEnCours(false);
    setEnregistre(true);
    /* La confirmation s'efface d'elle-même : un bandeau qui reste finit par
       ne plus se voir. */
    setTimeout(() => setEnregistre(false), 2000);
  }

  if (loading || !activite) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <AppLayout>
      <div className="w-full p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Paramètre</h1>
        <p className="mt-0.5 text-sm text-gray-400">Ce qui vaut pour toute l&apos;activité</p>

        <div className="mt-5 max-w-lg rounded-2xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 shadow-sm">
          <p className="text-xs font-bold uppercase text-gray-400 mb-1">Nom de l&apos;activité</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={nom}
              onChange={e => setNom(e.target.value)}
              className="flex-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={enregistrer}
              disabled={enCours || !nom.trim() || nom.trim() === activite.nom}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40"
            >
              {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {enregistre ? 'Enregistré' : 'Enregistrer'}
            </button>
          </div>

          <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-4">
            <p className="text-xs text-gray-400">
              Compte <span className="font-medium text-gray-600 dark:text-gray-300">{user?.email}</span>
            </p>
          </div>
        </div>

        {/* Faire passer les produits du site à l'activité. Une fois faite,
            la carte n'a plus rien à proposer : elle ne s'affiche que tant
            qu'il reste des fiches à migrer. */}
        <div className="mt-5 max-w-lg rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5 dark:border-indigo-900/40 dark:bg-indigo-900/10">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase text-indigo-600 dark:text-indigo-400">
            <Package size={13} /> Produits de l'activité
          </p>
          <p className="mt-2.5 text-xs text-gray-500 dark:text-gray-400">
            Un produit appartenait à un site : deux « Mangue » sur deux
            boutiques étaient deux objets sans lien, et un transfert entre
            elles n'arrivait jamais à destination. Cette opération réunit
            les fiches de même nom en un seul produit, et donne à chaque
            site ce qu'il en détient.
          </p>

          {migFaite ? (
            <div className="mt-3 rounded-xl border border-green-200 bg-white px-3 py-2.5 dark:border-green-900/40 dark:bg-gray-900">
              <p className="text-xs font-bold text-green-600 dark:text-green-400">
                {migFaite.produitsApres} produit{migFaite.produitsApres > 1 ? 's' : ''} ·{' '}
                {migFaite.detentionsCreees} détention{migFaite.detentionsCreees > 1 ? 's' : ''}
                {migFaite.mouvementsReliés > 0
                  && ` · ${migFaite.mouvementsReliés} ligne${migFaite.mouvementsReliés > 1 ? 's' : ''} reliée${migFaite.mouvementsReliés > 1 ? 's' : ''}`}.
              </p>
            </div>
          ) : migBilan ? (
            <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
              {migBilan.produitsAvant === 0 ? (
                <p className="text-xs text-gray-400">
                  Rien à migrer : les produits appartiennent déjà à l'activité.
                </p>
              ) : (
                <>
                  <p className="text-xs text-gray-600 dark:text-gray-300">
                    <span className="font-bold">{migBilan.produitsAvant}</span> fiches deviendront{' '}
                    <span className="font-bold">{migBilan.produitsApres}</span> produits,
                    et <span className="font-bold">{migBilan.detentionsCreees}</span> détentions.
                  </p>
                  {migBilan.fusions.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="text-[11px] font-bold uppercase text-gray-400">
                        Fiches réunies
                      </p>
                      {migBilan.fusions.map(f => (
                        <p key={f.cle} className="text-[11px] text-gray-500">
                          {f.designation} · {f.fiches.length} fiches
                        </p>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : null}

          <div className="mt-3 flex gap-2">
            <button
              onClick={async () => {
                setMigEnCours(true);
                try { setMigBilan(await simulerMigration()); }
                finally { setMigEnCours(false); }
              }}
              disabled={migEnCours}
              className="flex items-center gap-1.5 rounded-xl border border-indigo-200 px-3 py-2 text-xs font-bold text-indigo-600 transition-colors hover:bg-white disabled:opacity-40 dark:border-indigo-900">
              {migEnCours ? <Loader2 size={13} className="animate-spin" /> : null}
              Regarder
            </button>
            {migBilan && migBilan.produitsAvant > 0 && !migFaite && (
              <button
                onClick={async () => {
                  setMigEnCours(true);
                  try {
                    setMigFaite(await migrerProduits({
                      userId: user!.uid, activiteId: activite?.id ?? null,
                    }));
                  } finally { setMigEnCours(false); }
                }}
                disabled={migEnCours}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {migEnCours ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Migrer
              </button>
            )}
          </div>
        </div>

        {/* Vider l'exploitation. À part, en rouge, en bas : ce n'est pas un
            réglage, c'est une démolition. */}
        <div className="mt-5 max-w-lg rounded-2xl border border-red-200 bg-red-50/40 p-5 dark:border-red-900/40 dark:bg-red-900/10">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase text-red-600 dark:text-red-400">
            <AlertTriangle size={13} /> Vider les données
          </p>
          {/* Deux étendues, deux intentions : repartir d'un compte propre,
              ou tout raser. Le choix se fait avant de compter, sinon le
              bilan ne dit pas ce qu'on croit. */}
          <div className="mt-3 flex items-center rounded-xl bg-white p-1 dark:bg-gray-900">
            {([
              { cle: false, label: 'Exploitation' },
              { cle: true, label: 'Tout' },
            ]).map(o => (
              <button key={String(o.cle)}
                onClick={() => { setComplet(o.cle); setBilan(null); setPurgeFaite(null); setConfirmation(''); }}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                  complet === o.cle
                    ? 'bg-red-600 text-white'
                    : 'text-gray-400 hover:text-gray-600'}`}>
                {o.label}
              </button>
            ))}
          </div>

          <p className="mt-2.5 text-xs text-gray-500 dark:text-gray-400">
            {complet
              ? <>Efface <span className="font-bold">tout</span> : l'activité de
                tous les sites, mais aussi les produits, partenaires,
                employés, configurations, et les sites eux-mêmes. Seuls
                l'activité et ton compte restent — il faudra recréer les
                sites.</>
              : <>Efface ce que l'activité a fait — ventes, achats, transferts,
                caisse, versements, recouvrements — sur tous ses sites, et
                remet les stocks à zéro. Les sites, produits, partenaires et
                employés restent.</>}
            {' '}<span className="font-bold text-red-600 dark:text-red-400">
            Cette opération ne peut pas être annulée.</span>
          </p>

          {purgeFaite ? (
            <div className="mt-3 rounded-xl border border-green-200 bg-white px-3 py-2.5 dark:border-green-900/40 dark:bg-gray-900">
              <p className="text-xs font-bold text-green-600 dark:text-green-400">
                {purgeFaite.total.toLocaleString('fr-FR')} document{purgeFaite.total > 1 ? 's' : ''} supprimé{purgeFaite.total > 1 ? 's' : ''}
                {purgeFaite.produitsRemisAZero > 0
                  && `, ${purgeFaite.produitsRemisAZero} produit${purgeFaite.produitsRemisAZero > 1 ? 's' : ''} remis à zéro`}.
              </p>
            </div>
          ) : bilan ? (
            <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
              {bilan.total === 0 && bilan.produitsRemisAZero === 0 ? (
                <p className="text-xs text-gray-400">Rien à supprimer.</p>
              ) : (
                <>
                  <p className="mb-2 text-xs font-bold text-gray-900 dark:text-gray-100">
                    {bilan.total.toLocaleString('fr-FR')} document{bilan.total > 1 ? 's' : ''} seront supprimés
                  </p>
                  <div className="mb-3 max-h-40 space-y-1 overflow-y-auto">
                    {Object.entries(bilan.parCollection).map(([nom, n]) => (
                      <div key={nom} className="flex justify-between gap-2 text-xs">
                        <span className="text-gray-400">{nom}</span>
                        <span className="font-bold text-gray-700 dark:text-gray-300">
                          {n.toLocaleString('fr-FR')}
                        </span>
                      </div>
                    ))}
                    {bilan.produitsRemisAZero > 0 && (
                      <div className="flex justify-between gap-2 border-t border-gray-100 pt-1 text-xs dark:border-gray-800">
                        <span className="text-gray-400">stocks remis à zéro</span>
                        <span className="font-bold text-gray-700 dark:text-gray-300">
                          {bilan.produitsRemisAZero}
                        </span>
                      </div>
                    )}
                  </div>

                  <label className="mb-1.5 block text-xs text-gray-500 dark:text-gray-400">
                    Tape <span className="font-bold text-gray-900 dark:text-gray-100">{activite.nom}</span> pour confirmer
                  </label>
                  <input type="text" value={confirmation}
                    onChange={e => setConfirmation(e.target.value)}
                    placeholder={activite.nom}
                    className="mb-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" />

                  <div className="flex gap-2">
                    <button onClick={() => { setBilan(null); setConfirmation(''); }}
                      className="flex-1 rounded-xl py-2 text-xs font-bold text-gray-500 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800">
                      Annuler
                    </button>
                    <button onClick={vider}
                      disabled={purgeEnCours || confirmation.trim() !== activite.nom}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-600 py-2 text-xs font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-40">
                      {purgeEnCours ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      Supprimer définitivement
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button onClick={simuler} disabled={purgeEnCours}
              className="mt-3 flex items-center gap-1.5 rounded-xl border border-red-300 px-3 py-2 text-xs font-bold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-900/20">
              {purgeEnCours ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              {/* Compter traverse une vingtaine de collections : sans ce
                  mot, le bouton paraît ne rien faire pendant ce temps. */}
              {purgeEnCours ? 'Lecture en cours…' : 'Vider les données'}
            </button>
          )}

          {erreurPurge && (
            <p className="mt-2 text-xs font-medium text-red-600">{erreurPurge}</p>
          )}
        </div>

        <button
          onClick={async () => { await signOut(auth); router.push('/login'); }}
          className="mt-4 flex items-center gap-1.5 rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-500 transition-colors hover:text-red-600"
        >
          <LogOut size={14} /> Se déconnecter
        </button>
      </div>
    </AppLayout>
  );
}
