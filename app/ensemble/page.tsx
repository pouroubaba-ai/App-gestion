'use client';
/**
 * Les onglets du propriétaire : les mêmes qu'un site, sur l'ensemble.
 *
 * Aucun composant n'est dupliqué ici. Les onglets d'un site acceptent une
 * portée — un identifiant ou plusieurs — et la liste des sites qu'elle
 * couvre. Avec plusieurs, ils montrent la colonne Site et son filtre ; avec
 * un seul, ils sont exactement ce qu'ils étaient.
 */
import { Suspense, useEffect, useState } from 'react';
import { collection, query, where, getDocs, getDoc, doc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { sitesDuCompte } from '@/lib/roles';
import { useRouter, useSearchParams } from 'next/navigation';
import AppLayout from '@/components/AppLayout';
import { Loader2 } from 'lucide-react';
import type { SiteConnu } from '@/app/site/[id]/components/ContexteSites';

import OngletDashboard from '@/app/site/[id]/components/OngletDashboard';
import OngletFonds from '@/app/site/[id]/components/OngletFonds';
import OngletPartenaires from '@/app/site/[id]/components/OngletPartenaires';
import OngletRecouvrements from '@/app/site/[id]/components/OngletRecouvrements';
import OngletRemises from '@/app/site/[id]/components/OngletRemises';
import OngletRetours from '@/app/site/[id]/components/OngletRetours';
import OngletEmployes from '@/app/site/[id]/components/OngletEmployes';
import OngletCycleVente from '@/app/site/[id]/components/OngletCycleVente';
import OngletAchats from '@/app/site/[id]/components/OngletAchats';
import OngletTransferts from '@/app/site/[id]/components/OngletTransferts';
import OngletInventaire from '@/app/site/[id]/components/OngletInventaire';
import OngletHistorique from '@/app/site/[id]/components/OngletHistorique';

export type OngletEnsemble =
  | 'dashboard' | 'fonds' | 'partenaires' | 'recouvrements' | 'employes'
  | 'cycle-vente' | 'achats' | 'transferts' | 'inventaire' | 'historique'
  | 'remises' | 'retours';

/* Le titre de la page. Il vit ici, sur le header, et non dans chaque
   onglet : celui-ci sert aussi la fiche d'un site, où le nom du site tient
   déjà la place. */
const TITRES: Record<OngletEnsemble, string> = {
  dashboard: 'Tableau de bord',
  fonds: 'Fonds disponible',
  partenaires: 'Partenaires',
  recouvrements: 'Recouvrements',
  /* Le propriétaire vend lui aussi : ces ventes attendent la caisse comme
     celles de ses gérants, et il n'avait nulle part où les suivre. */
  remises: 'Mes remises',
  /* Le propriétaire décide des retours de toutes ses boutiques. */
  retours: 'Retours',
  employes: 'Employés',
  'cycle-vente': 'Cycle de vente',
  achats: 'Achats',
  transferts: 'Transferts',
  inventaire: 'Inventaire',
  historique: 'Historique',
};

/**
 * L'onglet courant vit dans la query. Sur un segment statique comme
 * celui-ci, Next prérend la page au build — or la query n'existe qu'au
 * moment de la requête. La frontière Suspense lui dit d'attendre le
 * navigateur plutôt que d'échouer.
 */
export default function EnsemblePage() {
  return (
    <Suspense fallback={
      <AppLayout>
        <div className="flex min-h-64 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-indigo-500" />
        </div>
      </AppLayout>
    }>
      <Ensemble />
    </Suspense>
  );
}

function Ensemble() {
  const { user, activite, profile, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  /* L'onglet se garde en état et se resynchronise à chaque changement
     d'adresse. Le lire directement de `searchParams` le laissait en retard
     d'un cran : les onglets écrivent aussi dans la query avec
     `history.replaceState`, que Next ne voit pas passer — au lien suivant,
     le contenu affiché et l'adresse ne désignaient plus le même onglet. */
  const [onglet, setOnglet] = useState<OngletEnsemble>(
    (searchParams.get('onglet') as OngletEnsemble) ?? 'dashboard');

  useEffect(() => {
    const voulu = (searchParams.get('onglet') as OngletEnsemble) ?? 'dashboard';
    setOnglet(prev => (prev === voulu ? prev : voulu));
  }, [searchParams]);

  const [sites, setSites] = useState<SiteConnu[] | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  /* La vue d'ensemble appartient à qui possède plusieurs sites : un membre
     travaille dans le sien, il n'a rien à embrasser. */
  useEffect(() => {
    if (!authLoading && profile?.role === 'membre') router.replace('/site');
  }, [authLoading, profile?.role, router]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      if (activite) {
        const snap = await getDocs(query(
          collection(db, 'sites'), where('activiteId', '==', activite.id)));
        setSites(snap.docs.map(d => ({ id: d.id, nom: (d.data() as any).nom })));
        return;
      }
      const ids = await sitesDuCompte(user.uid);
      const docs = await Promise.all(ids.map(id => getDoc(doc(db, 'sites', id))));
      setSites(docs.filter(d => d.exists())
        .map(d => ({ id: d.id, nom: (d.data() as any).nom })));
    })().catch(() => setSites([]));
  }, [user, activite]);

  if (authLoading || sites === null) return (
    <AppLayout>
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-indigo-500" />
      </div>
    </AppLayout>
  );

  if (!user) return null;

  /* Un membre n'a rien à embrasser : la redirection est lancée, mais elle
     prend un battement. Sans ce garde, l'écran se dessine entre-temps avec
     un rôle que cette page ne lit pas — et montre à un recouvreur la vue
     du gérant, chiffres du site entier compris. */
  if (profile?.role === 'membre') return null;

  const ids = sites.map(s => s.id);
  /* Le titre descend dans l'onglet : c'est lui qui tient la barre du haut,
     avec ses filtres à l'autre bout. Le poser au-dessus les aurait laissés
     sur une seconde ligne, détachés de leur titre. */
  const commun = { siteId: ids, sites, userId: user.uid, titre: TITRES[onglet] };

  return (
    /* Le compte des dossiers en attente porte sur toute l'activité : c'est
       ce que cette page embrasse. */
    <AppLayout portee={ids}>
      {/* Hors d'un site, la page occupe l'écran : l'enfermer dans une carte
          n'encadrerait que du vide sur les bords. */}
      <div className="w-full mx-auto">
        {sites.length === 0 ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-gray-400">
            Aucun site à embrasser.
          </div>
        ) : (
          <>
            {onglet === 'dashboard' && (
              <OngletDashboard {...commun}
                onNaviguer={o => router.push(`/ensemble?onglet=${o}`)} />
            )}
            {onglet === 'fonds' && <OngletFonds {...commun} />}
            {onglet === 'partenaires' && (
              <OngletPartenaires {...commun}
                defaultVue={(searchParams.get('vue') as 'clients' | 'fournisseurs') ?? 'clients'} />
            )}
            {onglet === 'recouvrements' && <OngletRecouvrements {...commun} />}
            {onglet === 'remises' && <OngletRemises {...commun} />}
            {onglet === 'retours' && <OngletRetours {...commun} role={null} />}
            {onglet === 'employes' && <OngletEmployes {...commun} />}
            {onglet === 'cycle-vente' && <OngletCycleVente {...commun} />}
            {onglet === 'achats' && <OngletAchats {...commun} />}
            {onglet === 'transferts' && <OngletTransferts {...commun} />}
            {onglet === 'inventaire' && <OngletInventaire {...commun} />}
            {onglet === 'historique' && <OngletHistorique {...commun} />}
          </>
        )}
      </div>
    </AppLayout>
  );
}
