'use client';
import { useEffect, useState } from 'react';
import {
  doc, getDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { auteurCourant } from '@/lib/auteur';
import {
  simulerCompensation, compenser, peutCompenser,
  type ApercuCompensation,
} from '@/lib/compensation';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { soldeTiers, type SoldeTiers } from '@/lib/soldes';
import { employesDuSite, type Apporteur, type EmployeChoix } from '@/lib/apporteur';
import {
  ArrowLeft, Pencil, Trash2, Loader2, X, Check,
  Phone, Building2,
} from 'lucide-react';
import { SelectCherchable } from '@/components/Champs';
import SectionRecouvrement from './components/SectionRecouvrement';
import { hankenGrotesk } from '../../components/finance/font';

type Role = 'fournisseur' | 'client';

interface Categorie {
  id: string;
  nom: string;
  role: Role;
}

interface Partenaire {
  id: string;
  nom: string;
  contact?: string;
  rolesFournisseur: boolean;
  rolesClient: boolean;
  categoriesFournisseur: string[];
  categoriesClient: string[];
  dette: number;
  creance: number;
  verseF: number;
  verseC: number;
  prochainRecouvrement?: string | null;
  /** qui l'a amené ; absent s'il est venu de lui-même */
  apporteur?: Apporteur | null;
  siteId: string;
  userId: string;
}

interface Site {
  id: string;
  nom: string;
}

export default function FichePartenairePage() {
  const { user, activite, profile } = useAuth();
  /* La compensation engage la maison des deux côtés : elle revient à qui
     répond des comptes. */
  const [roleSite, setRoleSite] = useState<RoleSite | null>(null);
  const [apercuComp, setApercuComp] = useState<ApercuCompensation | null>(null);
  const [compEnCours, setCompEnCours] = useState(false);
  const [compMsg, setCompMsg] = useState('');
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  const partenaireId = params.partenaireId as string;
  const vueRetour = searchParams.get('vue') ?? 'clients';
  /* on peut arriver ici depuis Partenaires ou depuis Achats : le retour
     doit ramener à l'écran qu'on a quitté, pas à un onglet par défaut */
  const retourHref = searchParams.get('retour') === 'achats'
    ? `/site/${siteId}?onglet=achats&axe=fournisseur&carte=${searchParams.get('carte') ?? 'recu'}`
    /* Ouvert depuis la vue d'ensemble, on y retourne : elle n'est pas sous
       le site, et y renvoyer ferait changer d'écran. */
    : searchParams.get('de') === 'ensemble'
      ? `/ensemble?onglet=partenaires&vue=${vueRetour}`
      : `/site/${siteId}?onglet=partenaires&vue=${vueRetour}`;

  const [partenaire, setPartenaire] = useState<Partenaire | null>(null);
  /* Total et versé se déduisent des dossiers : `verseF` et `verseC` n'ont
     jamais été écrits, et les cartes affichaient donc zéro. */
  /* Qui a amené le partenaire : modifiable, car l'information vient
     souvent après la création de la fiche. */
  const [employes, setEmployes] = useState<EmployeChoix[]>([]);
  const [apporteurEmploye, setApporteurEmploye] = useState('');
  /* Le cas choisi. `apporteurEmploye` porte l'identifiant ou 'externe' ;
     lui seul ne dirait pas si un champ vide est un choix ou un oubli. */
  const [modeApporteur, setModeApporteur] = useState<'aucun' | 'employe' | 'externe'>('aucun');
  const [apporteurNom, setApporteurNom] = useState('');
  const [apporteurFonction, setApporteurFonction] = useState('');

  const [soldes, setSoldes] = useState<{
    fournisseur: SoldeTiers; client: SoldeTiers;
  } | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [categories, setCategories] = useState<Categorie[]>([]);
  const [loading, setLoading] = useState(true);

  /* Edition */
  const [editing, setEditing] = useState(false);
  const [nom, setNom] = useState('');
  const [contact, setContact] = useState('');
  const [rolesFournisseur, setRolesFournisseur] = useState(false);
  const [rolesClient, setRolesClient] = useState(false);
  const [catsFournisseurSel, setCatsFournisseurSel] = useState<string[]>([]);
  const [catsClientSel, setCatsClientSel] = useState<string[]>([]);
  const [prochainRecouvrement, setProchainRecouvrement] = useState('');
  const [saving, setSaving] = useState(false);
  const [erreur, setErreur] = useState('');

  /* Suppression */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(setRoleSite)
      .catch(() => setRoleSite(null));
  }, [user, siteId, activite?.adminUid]);

  /* Ce qu'une compensation ferait, avant de la faire : on ne demande pas
     de confirmer une écriture qu'on ne voit pas. */
  useEffect(() => {
    if (!partenaire?.rolesFournisseur || !partenaire?.rolesClient) return;
    simulerCompensation({ siteId, partenaireId })
      .then(setApercuComp)
      .catch(() => setApercuComp(null));
  }, [siteId, partenaireId, partenaire?.rolesFournisseur,
      partenaire?.rolesClient, partenaire?.dette, partenaire?.creance]);

  async function lancerCompensation() {
    if (!user || compEnCours) return;
    setCompEnCours(true); setCompMsg('');
    try {
      const a = await auteurCourant(siteId, user.uid, profile?.nom ?? user.email);
      const r = await compenser({
        siteId, partenaireId,
        partenaireNom: partenaire?.nom ?? null,
        userId: user.uid,
        date: new Date().toISOString().slice(0, 10),
        utilisateurNom: a.utilisateurNom,
        utilisateurFonction: a.utilisateurFonction,
        roleSite: roleSite,
      });
      setCompMsg(`${formatMontant(r.compense)} compensés de chaque côté.`);
      /* On relit les deux soldes : ils se déduisent des factures moins
         les versements, et deux versements viennent d'être écrits. */
      const [f, c] = await Promise.all([
        soldeTiers(siteId, partenaireId, 'fournisseur'),
        soldeTiers(siteId, partenaireId, 'client'),
      ]);
      setSoldes({ fournisseur: f, client: c });
      setPartenaire(prev => prev
        ? { ...prev, dette: f.reste, creance: c.reste } : prev);
      setApercuComp(await simulerCompensation({ siteId, partenaireId }));
    } catch (e: any) {
      setCompMsg(e?.message ?? 'Compensation impossible.');
    }
    setCompEnCours(false);
  }

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getDoc(doc(db, 'partenaires', partenaireId)),
      getDoc(doc(db, 'sites', siteId)),
      getDocs(query(collection(db, 'categories_partenaire'), where('siteId', '==', siteId))),
    ]).then(([partSnap, siteSnap, catSnap]) => {
      const cats = catSnap.docs.map(d => ({ id: d.id, ...d.data() } as Categorie));
      setCategories(cats);
      if (partSnap.exists()) {
        const p = { id: partSnap.id, ...partSnap.data() } as Partenaire;
        employesDuSite(siteId, p.userId ?? '').then(setEmployes).catch(() => setEmployes([]));
        setPartenaire(p);
        /* Dette et créance se déduisent des achats confirmés et des ventes
           livrées non soldés : stockées sur la fiche, elles survivaient à la
           suppression de leur document. */
        Promise.all([
          soldeTiers(siteId, partenaireId, 'fournisseur'),
          soldeTiers(siteId, partenaireId, 'client'),
        ]).then(([f, c]) => {
          setSoldes({ fournisseur: f, client: c });
          setPartenaire(prev => prev
            ? { ...prev, dette: f.reste, creance: c.reste } : prev);
        });
        setNom(p.nom);
        setApporteurEmploye(p.apporteur?.employeId ?? (p.apporteur ? 'externe' : ''));
        /* Le modal sert aussi à modifier : il doit rouvrir sur le cas déjà
           choisi, pas sur « sans apporteur ». */
        setModeApporteur(p.apporteur?.employeId ? 'employe' : p.apporteur ? 'externe' : 'aucun');
        setApporteurNom(p.apporteur?.employeId ? '' : (p.apporteur?.nom ?? ''));
        setApporteurFonction(p.apporteur?.employeId ? '' : (p.apporteur?.fonction ?? ''));
        setContact(p.contact ?? '');
        setRolesFournisseur(p.rolesFournisseur);
        setRolesClient(p.rolesClient);
        setCatsFournisseurSel(p.categoriesFournisseur ?? []);
        setCatsClientSel(p.categoriesClient ?? []);
        setProchainRecouvrement(p.prochainRecouvrement ?? '');
      }
      if (siteSnap.exists()) setSite({ id: siteSnap.id, nom: siteSnap.data().nom });
      setLoading(false);
    });
  }, [user, siteId, partenaireId]);

  function ouvrirEdition() {
    if (!partenaire) return;
    setNom(partenaire.nom);
    setContact(partenaire.contact ?? '');
    setRolesFournisseur(partenaire.rolesFournisseur);
    setRolesClient(partenaire.rolesClient);
    setCatsFournisseurSel(partenaire.categoriesFournisseur ?? []);
    setCatsClientSel(partenaire.categoriesClient ?? []);
    setProchainRecouvrement(partenaire.prochainRecouvrement ?? '');
    setErreur('');
    setEditing(true);
  }

  /** L'apporteur tel qu'il sera écrit : un employé, un externe, ou rien. */
  function construireApporteur(): Apporteur | null {
    if (!apporteurEmploye) return null;
    if (apporteurEmploye === 'externe') {
      if (!apporteurNom.trim()) return null;
      return {
        employeId: null,
        nom: apporteurNom.trim(),
        fonction: apporteurFonction.trim() || 'Externe',
      };
    }
    const e = employes.find(x => x.id === apporteurEmploye);
    return e ? { employeId: e.id, nom: e.nom, fonction: e.fonction } : null;
  }

  async function sauvegarder() {
    if (!nom.trim()) { setErreur('Nom requis.'); return; }
    if (!rolesFournisseur && !rolesClient) { setErreur('Sélectionnez au moins un rôle.'); return; }
    /* Un bouton verrouillé n'est pas une permission : le rôle se
       contrôle aussi à l'écriture. Retirer « fournisseur » à un tiers
       dont les achats existent rendrait ces documents orphelins — ils
       désigneraient un fournisseur que la fiche ne reconnaît plus. */
    if (!rolesFournisseur && (soldes?.fournisseur.total ?? 0) > 0) {
      setErreur('Ce partenaire a des achats : son rôle de fournisseur ne '
        + 'peut plus être retiré.');
      return;
    }
    if (!rolesClient && (soldes?.client.total ?? 0) > 0) {
      setErreur('Ce partenaire a des ventes : son rôle de client ne peut '
        + 'plus être retiré.');
      return;
    }
    setSaving(true); setErreur('');
    try {
      const updates = {
        nom: nom.trim(),
        contact: contact.trim(),
        apporteur: construireApporteur(),
        rolesFournisseur,
        rolesClient,
        categoriesFournisseur: rolesFournisseur ? catsFournisseurSel : [],
        categoriesClient: rolesClient ? catsClientSel : [],
        prochainRecouvrement: prochainRecouvrement || null,
      };
      await updateDoc(doc(db, 'partenaires', partenaireId), updates);
      setPartenaire(prev => prev ? { ...prev, ...updates } : prev);
      setEditing(false);
    } catch (e: any) {
      setErreur(e?.message ?? 'Erreur.');
    } finally {
      setSaving(false);
    }
  }

  async function supprimer() {
    setDeleting(true);
    await deleteDoc(doc(db, 'partenaires', partenaireId));
    router.push(`/site/${siteId}`);
  }

  function toggleCat(role: 'f' | 'c', id: string) {
    if (role === 'f') setCatsFournisseurSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    else setCatsClientSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function nomCat(id: string) {
    return categories.find(c => c.id === id)?.nom ?? id;
  }

  const catsFournisseur = categories.filter(c => c.role === 'fournisseur');
  const catsClient = categories.filter(c => c.role === 'client');

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!partenaire) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-400">
      Partenaire introuvable.
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="p-4 sm:p-6">

        {/* Retour */}
        <button onClick={() => router.push(retourHref)}
          className="flex items-center gap-2 mb-5 group">
          <ArrowLeft size={15} className="text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200 transition-colors" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
            {site?.nom ?? 'Site'}
          </span>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <span className="text-sm text-gray-400">{partenaire.nom}</span>
        </button>

        {/* Header fiche */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-900/40 rounded-xl flex items-center justify-center shrink-0">
                <Building2 size={18} className="text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">{partenaire.nom}</h1>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {partenaire.rolesFournisseur && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Fournisseur</span>
                  )}
                  {partenaire.rolesClient && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">Client</span>
                  )}
                  {partenaire.categoriesFournisseur?.filter(id => categories.some(c => c.id === id)).map(id => (
                    <span key={id} className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                      {nomCat(id)}
                    </span>
                  ))}
                  {partenaire.categoriesClient?.filter(id => categories.some(c => c.id === id)).map(id => (
                    <span key={id} className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                      {nomCat(id)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={ouvrirEdition}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-600 dark:text-gray-300 hover:border-indigo-400 hover:text-indigo-600 transition-colors">
                <Pencil size={13} /> Modifier
              </button>
              <button onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 dark:border-red-900/50 text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                <Trash2 size={13} /> Supprimer
              </button>
            </div>
          </div>

          {(partenaire.contact || partenaire.prochainRecouvrement) && (
            <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
              {partenaire.contact && (
                <div className="flex items-center gap-2">
                  <Phone size={13} className="text-gray-400" />
                  <span className="text-sm text-gray-600 dark:text-gray-300">{partenaire.contact}</span>
                </div>
              )}
              {partenaire.prochainRecouvrement && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase text-gray-400">Recouvrement</span>
                  <span className="text-sm text-gray-600 dark:text-gray-300">
                    {new Date(partenaire.prochainRecouvrement).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Finances */}
        <div className={`grid gap-3 mb-4 ${partenaire.rolesFournisseur && partenaire.rolesClient ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
          {partenaire.rolesClient && (() => {
            const verse = soldes?.client.verse ?? 0;
            const total = soldes?.client.total ?? 0;
            /* Le retour ne s'affiche que s'il existe : une ligne à zéro
               ferait chercher une marchandise rendue qui n'existe pas. */
            const retour = soldes?.client.retour ?? 0;
            const pct = total > 0 ? Math.min((verse / total) * 100, 100) : 0;
            return (
              <div onClick={() => router.push(`/site/${siteId}/partenaires/${partenaireId}/transactions?role=client`)}
                className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4 cursor-pointer hover:border-orange-200 dark:hover:border-orange-900 transition-colors">
                <p className="text-xs font-bold uppercase text-gray-400 mb-1">Créance restante</p>
                <p className={`${hankenGrotesk.className} text-2xl font-bold tracking-tight text-orange-500`}>{formatMontant(partenaire.creance)}</p>
                <span className={`mt-2 inline-block px-2 py-0.5 rounded-full text-xs font-bold ${partenaire.creance <= 0 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                  {partenaire.creance <= 0 ? 'Soldé' : 'Partiel'}
                </span>
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                  <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden mb-1.5">
                    <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs text-gray-400">
                    Total {formatMontant(total)} · Versé {formatMontant(verse)}
                    {retour > 0 && <> · Retour {formatMontant(retour)}</>}
                  </p>
                </div>
              </div>
            );
          })()}
          {partenaire.rolesFournisseur && (() => {
            const verse = soldes?.fournisseur.verse ?? 0;
            const total = soldes?.fournisseur.total ?? 0;
            /* Le retour ne s'affiche que s'il existe : une ligne à zéro
               ferait chercher une marchandise rendue qui n'existe pas. */
            const retour = soldes?.fournisseur.retour ?? 0;
            const pct = total > 0 ? Math.min((verse / total) * 100, 100) : 0;
            return (
              <div onClick={() => router.push(`/site/${siteId}/partenaires/${partenaireId}/transactions?role=fournisseur`)}
                className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4 cursor-pointer hover:border-red-200 dark:hover:border-red-900 transition-colors">
                <p className="text-xs font-bold uppercase text-gray-400 mb-1">Dette restante</p>
                <p className={`${hankenGrotesk.className} text-2xl font-bold tracking-tight text-red-600`}>{formatMontant(partenaire.dette)}</p>
                <span className={`mt-2 inline-block px-2 py-0.5 rounded-full text-xs font-bold ${partenaire.dette <= 0 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                  {partenaire.dette <= 0 ? 'Soldé' : 'Partiel'}
                </span>
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                  <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden mb-1.5">
                    <div className="h-full bg-red-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs text-gray-400">
                    Total {formatMontant(total)} · Versé {formatMontant(verse)}
                    {retour > 0 && <> · Retour {formatMontant(retour)}</>}
                  </p>
                </div>
              </div>
            );
          })()}
        </div>

        {/* La compensation : deux dettes réciproques s'annulent.
            Elle ne paraît que lorsqu'il y en a une de chaque côté —
            proposer d'annuler un solde contre rien n'aurait pas de sens. */}
        {apercuComp && apercuComp.compensable > 0 && peutCompenser(roleSite) && (
          <div className="mb-4 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900/40 dark:bg-indigo-900/10">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
                  Compensation possible
                </p>
                <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-300">
                  Il doit {formatMontant(apercuComp.creance)}, on lui doit{' '}
                  {formatMontant(apercuComp.dette)}.{' '}
                  <span className="font-bold text-gray-900 dark:text-gray-100">
                    {formatMontant(apercuComp.compensable)}
                  </span>{' '}
                  s’annulent de chaque côté.
                  {apercuComp.reste > 0 && (
                    <> Restera {formatMontant(apercuComp.reste)}{' '}
                      {apercuComp.resteCote === 'client'
                        ? 'à recouvrer' : 'à payer'}.</>
                  )}
                </p>
                <p className="mt-0.5 text-[11px] text-gray-400">
                  Aucun argent ne circule : la caisse ne voit rien passer.
                </p>
              </div>
              <button type="button" onClick={lancerCompensation}
                disabled={compEnCours}
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                {compEnCours && <Loader2 size={13} className="animate-spin" />}
                Compenser
              </button>
            </div>
          </div>
        )}

        {compMsg && (
          <p className="mb-4 rounded-xl bg-gray-50 p-2.5 text-[12px] text-gray-600 dark:bg-gray-800/50 dark:text-gray-300">
            {compMsg}
          </p>
        )}

        {/* Recouvrement */}
        <SectionRecouvrement
          partenaireId={partenaireId}
          siteId={siteId}
          userId={user!.uid}
          rolesFournisseur={partenaire.rolesFournisseur}
          rolesClient={partenaire.rolesClient}
          dette={partenaire.dette}
          creance={partenaire.creance}
          /* Un versement réduit ce que le partenaire doit : les cartes au-
             dessus doivent suivre sans recharger la page. */
          onSolde={(role) => {
            /* On relit plutôt que de soustraire : le calcul fait foi, et le
               corriger à la main le ferait diverger. Les cartes suivent —
               le versé bouge autant que le reste. */
            soldeTiers(siteId, partenaireId, role).then(s => {
              setSoldes(prev => prev ? { ...prev, [role]: s } : prev);
              setPartenaire(prev => prev
                ? { ...prev, ...(role === 'fournisseur'
                    ? { dette: s.reste } : { creance: s.reste }) }
                : prev);
            });
          }}
        />

      </div>

      {/* Modal édition */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md shadow-xl p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Modifier le partenaire</h2>
              <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
            </div>

            {/* Nom */}
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Nom</p>
            <input type="text" value={nom} onChange={e => setNom(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            {/* Apporté par : un employé, dont la fonction suit, ou quelqu'un
                du dehors. Vide, le partenaire est venu de lui-même. */}
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Apporté par</p>
            {/* Trois cas, trois boutons : personne, un employé, ou quelqu'un
                du dehors. Dans une liste déroulante, les employés et les deux
                autres choix se mélangeaient. */}
            <div className="mb-2 grid grid-cols-3 gap-2">
              {([
                { cle: 'aucun' as const,   label: 'Sans apporteur' },
                { cle: 'employe' as const, label: 'Employé' },
                { cle: 'externe' as const, label: 'Externe' },
              ]).map(o => {
                const actif = modeApporteur === o.cle;
                return (
                  <button key={o.cle} type="button"
                    onClick={() => {
                      setModeApporteur(o.cle);
                      /* Changer de cas efface ce qu'on avait saisi dans
                         l'autre : sinon un nom externe survivrait au choix
                         d'un employé. */
                      setApporteurEmploye(o.cle === 'externe' ? 'externe' : '');
                      setApporteurNom(''); setApporteurFonction('');
                    }}
                    className={`rounded-xl border py-2.5 text-sm font-medium transition-all ${
                      actif
                        ? 'border-indigo-400 bg-indigo-50 text-gray-900 dark:bg-indigo-900/30 dark:text-gray-100'
                        : 'border-gray-200 text-gray-900 dark:border-gray-700 dark:text-gray-100'}`}>
                    {o.label}
                  </button>
                );
              })}
            </div>

            {modeApporteur === 'employe' && (
              <div className="mb-2">
                {/* Une liste d'employés peut être longue : on la cherche. */}
                <SelectCherchable valeur={apporteurEmploye} onChange={setApporteurEmploye}
                  options={employes.map(e => ({ valeur: e.id, label: e.nom, detail: e.fonction }))}
                  placeholder="Choisir un employé…" vide="Aucun employé" />
              </div>
            )}

            {modeApporteur === 'externe' && (
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input type="text" placeholder="Nom" value={apporteurNom}
                  onChange={e => setApporteurNom(e.target.value)}
                  className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <input type="text" placeholder="Fonction" value={apporteurFonction}
                  onChange={e => setApporteurFonction(e.target.value)}
                  className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            )}
            <div className="mb-2" />

            {/* Rôle */}
            <p className="text-xs font-bold text-gray-400 uppercase mb-2">Rôle</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {(() => {
                /* Un rôle se verrouille dès qu'un document existe, pas
                   seulement tant qu'il reste dû.
                   Le verrou se fondait sur la dette restante : une fois
                   soldée — par un versement, un retour ou une
                   compensation —, le rôle redevenait retirable, et l'on
                   pouvait ôter « fournisseur » à un tiers dont les achats
                   sont au registre. `verseF` et `verseC`, eux, n'ont
                   jamais été écrits : ils valaient toujours zéro et
                   n'ajoutaient rien. C'est le total des documents qui
                   dit si le rôle a servi. */
                const verrouF = (soldes?.fournisseur.total ?? 0) > 0;
                const verrouC = (soldes?.client.total ?? 0) > 0;
                return (
                  <>
                    <button
                      onClick={() => !verrouF && setRolesFournisseur(v => !v)}
                      title={verrouF ? 'Ce rôle est verrouillé car des transactions existent' : undefined}
                      className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-all
                        ${rolesFournisseur ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-gray-900 dark:text-gray-100' : 'border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100'}
                        ${verrouF ? 'opacity-60 cursor-not-allowed' : ''}`}>
                      {rolesFournisseur && <span className="text-indigo-600">✓</span>}
                      Fournisseur
                      {verrouF && <span className="text-gray-400 text-xs">🔒</span>}
                    </button>
                    <button
                      onClick={() => !verrouC && setRolesClient(v => !v)}
                      title={verrouC ? 'Ce rôle est verrouillé car des transactions existent' : undefined}
                      className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-all
                        ${rolesClient ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 text-gray-900 dark:text-gray-100' : 'border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100'}
                        ${verrouC ? 'opacity-60 cursor-not-allowed' : ''}`}>
                      {rolesClient && <span className="text-indigo-600">✓</span>}
                      Client
                      {verrouC && <span className="text-gray-400 text-xs">🔒</span>}
                    </button>
                  </>
                );
              })()}
            </div>

            {/* Catégories fournisseur */}
            {rolesFournisseur && (
              <div className="mb-4">
                <p className="text-xs font-bold text-gray-400 uppercase mb-2">Catégories fournisseur</p>
                <div className="space-y-1 max-h-32 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-xl p-2">
                  {catsFournisseur.length === 0
                    ? <p className="text-xs text-gray-400 px-1 py-1">Aucune catégorie disponible</p>
                    : catsFournisseur.map(c => (
                      <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
                        <input type="checkbox" checked={catsFournisseurSel.includes(c.id)} onChange={() => toggleCat('f', c.id)} className="accent-indigo-600" />
                        <span className="text-sm text-gray-700 dark:text-gray-300">{c.nom}</span>
                      </label>
                    ))
                  }
                </div>
              </div>
            )}

            {/* Catégories client */}
            {rolesClient && (
              <div className="mb-4">
                <p className="text-xs font-bold text-gray-400 uppercase mb-2">Catégories client</p>
                <div className="space-y-1 max-h-32 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-xl p-2">
                  {catsClient.length === 0
                    ? <p className="text-xs text-gray-400 px-1 py-1">Aucune catégorie disponible</p>
                    : catsClient.map(c => (
                      <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
                        <input type="checkbox" checked={catsClientSel.includes(c.id)} onChange={() => toggleCat('c', c.id)} className="accent-indigo-600" />
                        <span className="text-sm text-gray-700 dark:text-gray-300">{c.nom}</span>
                      </label>
                    ))
                  }
                </div>
              </div>
            )}

            {/* Contact */}
            <p className="text-xs font-bold text-gray-400 uppercase mb-1">Contact</p>
            <input type="tel" value={contact} onChange={e => setContact(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            {erreur && <p className="text-red-500 text-xs mb-3">{erreur}</p>}

            <div className="flex gap-3">
              <button onClick={() => setEditing(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={sauvegarder} disabled={saving}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal confirmation suppression */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-sm shadow-xl p-5">
            <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center mb-4">
              <Trash2 size={18} className="text-red-500" />
            </div>
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1">Supprimer ce partenaire ?</h2>
            <p className="text-sm text-gray-400 mb-5">
              <span className="font-medium text-gray-700 dark:text-gray-300">{partenaire.nom}</span> sera définitivement supprimé. Cette action est irréversible.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">
                Annuler
              </button>
              <button onClick={supprimer} disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                {deleting ? <Loader2 size={15} className="animate-spin" /> : null} Supprimer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
