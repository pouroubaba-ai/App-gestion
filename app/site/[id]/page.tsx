'use client';
import { useEffect, useState } from 'react';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import AppLayout from '@/components/AppLayout';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, ShoppingCart } from 'lucide-react';
import {
  ONGLETS_SITE as onglets, ongletsVisibles as calculerOnglets, navDuSite,
  type Onglet,
} from '@/lib/onglets-site';
import { chargerMissions } from '@/lib/missions';
import OngletPartenaires from './components/OngletPartenaires';
import OngletRecouvrements from './components/OngletRecouvrements';
import OngletRemises from './components/OngletRemises';
import OngletEmployes from './components/OngletEmployes';
import OngletInventaire from './components/OngletInventaire';
import OngletDashboard from './components/OngletDashboard';
import OngletConfiguration from './components/OngletConfiguration';
import OngletFonds from './components/OngletFonds';
import OngletMouvements from './components/OngletMouvements';
import OngletAutorisations from './components/OngletAutorisations';
import OngletTransferts from './components/OngletTransferts';
import OngletAchats from './components/OngletAchats';
import OngletHistorique from './components/OngletHistorique';
import OngletCycleVente from './components/OngletCycleVente';

type TypeSite = 'boutique' | 'depot';
type EtatSite = 'actif' | 'inactif';

interface Site {
  id: string;
  /* Le gérant n'a pas d'activité à lui : c'est le site qui porte la sienne. */
  activiteId?: string;
  nom: string;
  type: TypeSite;
  etat: EtatSite;
  adresse: string;
  numero?: string;
  imageUrl?: string;
  nbEmployes: number;
  remunerationMensuelle: number;
}

/* L'ordre suit la journée, pas l'alphabet : on constate d'abord, on agit
   ensuite dans l'ordre du cycle, on règle avec ceux à qui l'on doit, on
   consulte enfin. C'est le même ordre que le menu du propriétaire — un
   gérant qui passe de son site à la vue d'ensemble ne doit pas avoir à
   rechercher ses onglets. */
/* Les onglets construits ; les autres affichent « à venir ». */
const ONGLETS_PRETS: Onglet[] = [
  'dashboard', 'fonds', 'mouvements', 'autorisations',
  'partenaires', 'recouvrements',
  'employes', 'cycle-vente', 'achats', 'transferts', 'inventaire', 'historique',
  'remises',
  'configuration',
];

export default function SiteFichePage() {
  const { user, activite, profile, loading: authLoading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;

  const [site, setSite] = useState<Site | null>(null);
  const [loading, setLoading] = useState(true);
  const [onglet, setOngletBrut] = useState<Onglet>((searchParams.get('onglet') as Onglet) ?? 'dashboard');

  /* L'URL suit l'onglet : sans ça, actualiser ou partager le lien ramenait
     sur le tableau de bord, quel que soit l'endroit où l'on était.
     `replace` plutôt que `push` — parcourir des onglets n'a pas à remplir
     l'historique du navigateur. */
  function setOnglet(o: Onglet) {
    setOngletBrut(o);
    const params = new URLSearchParams(searchParams.toString());
    params.set('onglet', o);
    /* La vue ne vaut que pour les partenaires : la traîner ailleurs
       encombrerait l'adresse sans rien désigner. */
    if (o !== 'partenaires') params.delete('vue');
    router.replace(`?${params.toString()}`, { scroll: false });
  }
  /* L'état ne se lit qu'au montage : un lien du sidebar change l'adresse sans
     remonter la page, et le contenu restait sur l'onglet précédent. */
  useEffect(() => {
    const voulu = (searchParams.get('onglet') as Onglet) ?? 'dashboard';
    setOngletBrut(prev => (prev === voulu ? prev : voulu));
  }, [searchParams]);

  const [countRecouvrements, setCountRecouvrements] = useState(0);
  /* `null` veut dire aucune restriction : l'admin de l'activité, ou un compte
     qu'aucun membre ne désigne. On ne ferme jamais une porte par accident. */
  const [role, setRole] = useState<RoleSite | null>(null);
  const [roleLu, setRoleLu] = useState(false);

  /* Sans utilisateur, il n'y a rien à montrer : ni au premier chargement, ni
     après une déconnexion. La page de connexion prend le relais. */
  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!user || !siteId) return;
    getDoc(doc(db, 'sites', siteId)).then(snap => {
      if (snap.exists()) setSite({ id: snap.id, ...snap.data() } as Site);
      setLoading(false);
    });
  }, [user, siteId]);

  /* Le rôle décide des onglets : on le lit avant de dessiner la barre, sinon
     on montre un onglet interdit le temps d'un battement. */
  useEffect(() => {
    if (!user || !siteId) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(setRole)
      .catch(() => setRole(null))
      .finally(() => setRoleLu(true));
  }, [user, siteId, activite?.adminUid]);

  /* Le compte des recouvrements du jour se lit ici : quand il ne venait que
     de l'onglet, il restait a zero tant qu'on ne l'avait pas ouvert — donc
     personne ne savait qu'il y avait quelque chose a traiter.

     Le porteur compte ses missions, non les echeances du site : la
     pastille lui promettait un travail qui n'etait pas le sien, et le
     chiffre du bas contredisait celui de l'onglet fournisseurs. */
  useEffect(() => {
    if (!user || !siteId || !roleLu) return;

    if (role === 'recouvrement') {
      chargerMissions(siteId)
        .then(ms => setCountRecouvrements(ms.filter(m =>
          m.mode === 'porte'
          && m.etat !== 'soldee' && m.etat !== 'annulee'
          && (!m.porteurUid || m.porteurUid === user.uid)).length))
        .catch(() => setCountRecouvrements(0));
      return;
    }

    const aujourdhui = new Date().toISOString().split('T')[0];
    getDocs(query(
      collection(db, 'recouvrement_journal'),
      where('siteId', '==', siteId),
      where('date', '==', aujourdhui),
    ))
      .then(snap => setCountRecouvrements(snap.size))
      .catch(() => setCountRecouvrements(0));
  }, [user, siteId, role, roleLu]);


  /* La barre ne montre que ce que le rôle ouvre. Un onglet caché reste
     inaccessible par l'adresse : sinon la restriction ne tiendrait qu'à
     l'absence d'un bouton. */
  /* La liste de la barre fait aussi le garde : deux sources différaient,
     et l'une d'elles laissait passer ce que l'autre cachait. */
  const ongletsVisibles = calculerOnglets(role);
  const clesVisibles = ongletsVisibles.map(o => o.key);
  const ongletCourant = clesVisibles.includes(onglet)
    ? onglet : (clesVisibles[0] as Onglet | undefined) ?? onglet;

  /* Un membre n'a pas de liste de sites : ses onglets vivent dans le sidebar,
     accessibles au burger sur mobile. Le propriétaire garde la barre du haut,
     puisqu'il navigue d'abord entre ses sites. */
  const membre = profile?.role === 'membre';
  const navSite = membre
    ? [
        ...navDuSite(siteId, role),
        /* Le comptoir est une page, pas un onglet : sa vente naît livrée et
           ne traverse aucun des états que les cartes du cycle représentent.
           Il encaisse, donc il appartient à qui répond du site — pas à qui
           saisit les commandes. */
        ...(role === 'gerant'
          ? [{
              type: 'link' as const,
              label: 'Comptoir',
              href: `/site/${siteId}/comptoir`,
              icon: ShoppingCart,
            }]
          : []),
      ]
    : undefined;

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

  /* La déconnexion vide l'utilisateur avant que la navigation aboutisse : la
     page se redessine une dernière fois, et tout ce qui lit son identifiant
     tombe sur du vide. On s'arrête dès qu'il n'y en a plus. */
  if (!user) return null;

  /* Le rôle compte autant que le site : `null` veut dire « aucune
     restriction », si bien que dessiner avant sa réponse montre à chacun
     les onglets de tous — le caissier voyait passer « Mouvements » avant
     qu'il ne lui soit retiré. `roleLu` dit que la question a été posée,
     pas que la réponse est non vide.
     Il se lit après l'utilisateur : sans lui l'effet ne s'exécute pas, et
     la page attendrait une réponse que personne ne va donner. */
  if (!roleLu) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!site) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 text-gray-400">
      Site introuvable.
    </div>
  );

  const corps = (
    <div className={`bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100 ${
      membre ? 'min-h-full' : 'min-h-screen'}`}>
      {/* Les marges détachent la page des bords quand elle occupe l'écran
          seule. Dans le cadre de l'app, elles l'enfermeraient dans un encart. */}
      <div className={`w-full mx-auto ${membre ? 'px-4 py-4 sm:px-6' : 'p-4 sm:p-6 lg:p-8'}`}>

        {/* Retour avec nom + badge. Un membre n'a nulle part où revenir : son
            site est sa porte d'entrée, le nom reste mais ne se clique pas. */}
        {/* Le nom surmonte déjà le menu d'un membre : le répéter ici prendrait
            une ligne pour redire la même chose. */}
        <div className={`mb-5 items-center gap-2 ${membre ? 'hidden' : 'flex'}`}>
          {profile?.role !== 'membre' && (
            <button onClick={() => router.push(
              /* On revient là d'où l'on vient : arriver par une carte de la
                 vue par site et repartir sur la liste ferait perdre sa
                 place à chaque aller-retour. */
              searchParams.get('de') === 'ensemble'
                ? '/ensemble?onglet=dashboard&vueSites=sites'
                : '/site')} className="group flex items-center">
              <ArrowLeft size={15} className="text-gray-400 transition-colors group-hover:text-gray-600 dark:group-hover:text-gray-200" />
            </button>
          )}
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {site.nom}
          </span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold
            ${site.type === 'boutique'
              ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'}`}>
            {site.type === 'boutique' ? 'Boutique' : 'Dépôt'}
          </span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold
            ${site.etat === 'actif'
              ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
              : 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'}`}>
            {site.etat === 'actif' ? 'Actif' : 'Inactif'}
          </span>
        </div>

        {/* Onglets. Un membre les a dans son sidebar : les répéter en haut
            occuperait la largeur sans rien ajouter. */}
        <div className={`items-center gap-1 overflow-x-auto pb-1 mb-5 border-b border-gray-100 dark:border-gray-800 ${
          membre ? 'hidden' : 'flex'}`}>
          {ongletsVisibles.map(o => {
            const Icon = o.icon;
            const actif = ongletCourant === o.key;
            return (
              <button key={o.key} onClick={() => setOnglet(o.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all shrink-0
                  ${actif
                    ? 'bg-indigo-600 text-white'
                    : 'border border-indigo-200 dark:border-indigo-800 text-gray-500 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300'}`}>
                <Icon size={14} />
                {o.key === 'recouvrements' ? `${o.label} (${countRecouvrements})` : o.label}
              </button>
            );
          })}
        </div>

        {/* Contenu */}
        {/* La carte détache le contenu de la barre d'onglets posée au-dessus.
            Un membre a ses onglets dans le menu : elle n'aurait plus rien à
            séparer et ne ferait qu'encadrer la page. */}
        <div className={membre ? '' : 'bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4 sm:p-6'}>
          {ongletCourant === 'partenaires' && <OngletPartenaires siteId={siteId} userId={user!.uid} roleSite={role} defaultVue={(searchParams.get('vue') as 'clients' | 'fournisseurs') ?? 'clients'} />}
          {ongletCourant === 'recouvrements' && <OngletRecouvrements siteId={siteId} userId={user!.uid} roleSite={role} onCount={setCountRecouvrements} />}
          {ongletCourant === 'remises' && <OngletRemises siteId={siteId} userId={user!.uid} />}
          {ongletCourant === 'employes' && <OngletEmployes siteId={siteId} userId={user!.uid} />}
          {ongletCourant === 'dashboard' && <OngletDashboard siteId={siteId} userId={user!.uid} onNaviguer={o => setOnglet(o as Onglet)} />}
          {ongletCourant === 'fonds' && <OngletFonds siteId={siteId} userId={user!.uid} />}
          {ongletCourant === 'mouvements' && (
            <OngletMouvements siteId={siteId} userId={user!.uid} />
          )}
          {/* La pastille de cet onglet vit dans la barre du bas, qui compte
              elle-même ce qui attend : l'onglet n'a rien à lui remonter. */}
          {ongletCourant === 'autorisations' && (
            <OngletAutorisations siteId={siteId} userId={user!.uid} />
          )}
          {ongletCourant === 'inventaire' && <OngletInventaire siteId={siteId} userId={user!.uid} />}
          {ongletCourant === 'transferts' && <OngletTransferts siteId={siteId} userId={user!.uid} role={role} />}
          {ongletCourant === 'achats' && (
            <OngletAchats siteId={siteId} userId={user!.uid} role={role} />
          )}
          {ongletCourant === 'historique' && <OngletHistorique siteId={siteId} userId={user!.uid} />}
          {ongletCourant === 'cycle-vente' && (
            <OngletCycleVente siteId={siteId} userId={user!.uid} role={role} />
          )}
          {ongletCourant === 'configuration' && (
            <OngletConfiguration siteId={siteId} activiteId={activite?.id ?? site.activiteId} role={role} />
          )}
          {!ONGLETS_PRETS.includes(ongletCourant) && (
            <div className="min-h-64 flex items-center justify-center">
              <p className="text-gray-300 dark:text-gray-600 text-sm">
                {onglets.find(o => o.key === ongletCourant)?.label} — à venir
              </p>
            </div>
          )}
        </div>

      </div>
    </div>
  );

  /* Le membre travaille dans le cadre de l'app : sidebar à gauche, burger sur
     mobile. Le propriétaire garde sa page pleine, il vient de sa liste. */
  return membre
    ? <AppLayout navItems={navSite} navTitre={site.nom} portee={siteId}>{corps}</AppLayout>
    : corps;
}
