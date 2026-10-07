'use client';
import { useEffect, useState } from 'react';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import AppLayout from '@/components/AppLayout';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, ShoppingCart, ChevronDown } from 'lucide-react';
import {
  ONGLETS_SITE as onglets, ongletsVisibles as calculerOnglets, navDuSite,
  ongletsGroupes,
  type Onglet,
} from '@/lib/onglets-site';
import { chargerMissions } from '@/lib/missions';
import OngletPartenaires from './components/OngletPartenaires';
import OngletRecouvrements from './components/OngletRecouvrements';
import OngletRemises from './components/OngletRemises';
import OngletRetours from './components/OngletRetours';
import OngletEmployes from './components/OngletEmployes';
import OngletInventaire from './components/OngletInventaire';
import ListeMouvementsStock from './components/ListeMouvementsStock';
import OngletDashboard from './components/OngletDashboard';
import OngletConfiguration from './components/OngletConfiguration';
import OngletFonds from './components/OngletFonds';
import OngletMouvements from './components/OngletMouvements';
import OngletAutorisations from './components/OngletAutorisations';
import OngletTransferts from './components/OngletTransferts';
import OngletAchats from './components/OngletAchats';
import OngletImportations from './components/OngletImportations';
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
  'employes', 'cycle-vente', 'achats', 'importations', 'transferts', 'inventaire',
  'mouvements-stock', 'historique',
  'remises',
  'retours',
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
    /* Les sous-onglets ne traversent pas le changement d'onglet.
     *
     * Chaque onglet retient le sien dans l'adresse, et plusieurs se
     * nomment pareil faute d'un meilleur mot : `axe` sépare les
     * mouvements des auteurs dans la file, les dossiers des motifs dans
     * les mouvements de stock. Les garder en changeant d'onglet les
     * ferait lire par un écran à qui ils ne s'adressaient pas — on
     * ouvrirait « Recouvrements » rangé par échéance pour avoir regardé
     * la file par auteur. */
    for (const cle of ['rubrique', 'mode', 'axe', 'sens', 'etape', 'carte', 'groupe']) {
      params.delete(cle);
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  }
  /* L'état ne se lit qu'au montage : un lien du sidebar change l'adresse sans
     remonter la page, et le contenu restait sur l'onglet précédent. */
  useEffect(() => {
    const voulu = (searchParams.get('onglet') as Onglet) ?? 'dashboard';
    setOngletBrut(prev => (prev === voulu ? prev : voulu));
    /* Le panneau se referme sur le changement d'onglet, d'où qu'il
       vienne — le menu latéral mène aux mêmes écrans, et le laisser
       ouvert posait une liste par-dessus ce qu'on venait de demander. */
    setPlusOuvert(false);
  }, [searchParams]);

  const [countRecouvrements, setCountRecouvrements] = useState(0);
  /* Le panneau « Plus » de la barre du haut. Il ne se retient pas d'un
     écran à l'autre : on l'ouvre pour choisir, le choix le referme. */
  const [plusOuvert, setPlusOuvert] = useState(false);
  /* Où poser le panneau. Il se place en `fixed` pour échapper au
     débordement de la rangée, donc il ne peut plus se caler tout seul
     sous son bouton : c'est le clic qui relève la position. */
  const [posPlus, setPosPlus] = useState<{ x: number; y: number } | null>(null);
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
    /* Un refus doit s'arrêter quelque part.
       Sans `catch`, une lecture interdite laissait la promesse rejetée et
       `loading` à vrai : la page tournait indéfiniment sur son spinner, et
       rien ne disait pourquoi. Mieux vaut un écran qui dit « ce site ne
       vous est pas ouvert » qu'un écran qui ne dit rien. */
    getDoc(doc(db, 'sites', siteId))
      .then(snap => {
        if (snap.exists()) setSite({ id: snap.id, ...snap.data() } as Site);
      })
      .catch(() => setSite(null))
      .finally(() => setLoading(false));
  }, [user, siteId]);

  /* Le rôle décide des onglets : on le lit avant de dessiner la barre, sinon
     on montre un onglet interdit le temps d'un battement. */
  useEffect(() => {
    if (!user || !siteId) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(setRole)
      /* Une lecture qui echoue ne vaut pas « proprietaire ».
         `null` dit « aucune restriction » : le rendre ici donnait les
         pleins pouvoirs a qui perdait le reseau une seconde. */
      .catch(() => setRole('aucun'))
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

  /* Le même partage que dans le menu latéral : ce qui s'ouvre tous les
     jours, et ce qui se range. Les deux le demandent au même endroit —
     chacun le décidant de son côté, le même onglet aurait fini devant
     ici et caché là. Un rôle qui a peu d'onglets les garde tous devant,
     et « Plus » ne paraît pas. */
  const { devant: ongletsDevant, groupes: ongletsRanges } = ongletsGroupes(role);

  /* Un membre n'a pas de liste de sites : ses onglets vivent dans le sidebar,
     accessibles au burger sur mobile. Le propriétaire garde la barre du haut,
     puisqu'il navigue d'abord entre ses sites. */
  const membre = profile?.role === 'membre';
  const navSite = membre
    ? (() => {
        /* Rien tant que le rôle n'est pas lu.
         *
         * `role` vaut `null` au premier rendu comme il vaut `null` pour
         * qui n'a aucune restriction : le menu se construisait donc avec
         * tous les onglets le temps que la réponse arrive. On voyait le
         * responsable des commandes ouvrir la caisse et la configuration
         * pendant ce battement, et le menu se rétractait ensuite — ce
         * qui donnait l'écran de quelqu'un d'autre, puis le sien. */
        if (!roleLu) return [];
        const entrees = navDuSite(siteId, role);
        /* Le comptoir est une page, pas un onglet : sa vente naît livrée et
           ne traverse aucun des états que les cartes du cycle représentent.
           Il encaisse, donc il appartient à qui répond du site — pas à qui
           saisit les commandes. */
        if (role !== 'gerant') return entrees;
        const comptoir = {
          type: 'link' as const,
          label: 'Comptoir',
          href: `/site/${siteId}/comptoir`,
          icon: ShoppingCart,
        };
        /* Il se range avec ce qui s'ouvre tous les jours, non derrière les
           groupes repliés : le mettre en queue l'aurait posé sous trois
           menus fermés, alors que le gérant y vend toute la journée. */
        const premierGroupe = entrees.findIndex(e => e.type === 'accordion');
        if (premierGroupe < 0) return [...entrees, comptoir];
        return [
          ...entrees.slice(0, premierGroupe),
          comptoir,
          ...entrees.slice(premierGroupe),
        ];
      })()
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
            occuperait la largeur sans rien ajouter.
            Ce qui s'ouvre tous les jours reste en ligne ; le reste passe
            sous « Plus ». Les dix-sept tenaient sur la rangée en la
            faisant défiler — donc les derniers n'existaient que pour qui
            pensait à pousser la barre vers la droite. Un onglet qu'il
            faut chercher pour savoir qu'il est là ne se trouve pas. */}
        <div className={`items-center gap-1 overflow-x-auto pb-1 mb-5 border-b border-gray-100 dark:border-gray-800 ${
          membre ? 'hidden' : 'flex'}`}>
          {ongletsDevant.map(o => {
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

          {ongletsRanges.length > 0 && (
            <div className="relative shrink-0">
              {/* Le bouton se marque quand l'onglet ouvert est rangé
                  dessous : sans cela, on lirait une barre où rien n'est
                  actif en regardant pourtant un écran. */}
              <button type="button" onClick={e => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setPosPlus({ x: r.left, y: r.bottom + 4 });
                  setPlusOuvert(v => !v);
                }}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all
                  ${ongletsRanges.some(g => g.enfants.some(o => o.key === ongletCourant))
                    ? 'bg-indigo-600 text-white'
                    : 'border border-indigo-200 dark:border-indigo-800 text-gray-500 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300'}`}>
                Plus
                <ChevronDown size={14}
                  className={`transition-transform ${plusOuvert ? 'rotate-180' : ''}`} />
              </button>

              {plusOuvert && posPlus && (
                <>
                  {/* Un clic hors du panneau le referme : sans cette
                      surface, il restait ouvert sur l'écran qu'on venait
                      de demander. */}
                  {/* Fermer au défilement plutôt que suivre : posé en
                      `fixed`, le panneau resterait sur place pendant que
                      son bouton s'en va, et flotterait seul au milieu de
                      l'écran. */}
                  <div className="fixed inset-0 z-30"
                    onClick={() => setPlusOuvert(false)}
                    onWheel={() => setPlusOuvert(false)}
                    onTouchMove={() => setPlusOuvert(false)} />
                  {/* Posé en `fixed`, hors du flux : la rangée d'onglets
                      défile horizontalement, et tout ce qui s'y ancre est
                      coupé par ce débordement — le panneau s'ouvrait
                      vraiment, invisible sous le bord de la barre. */}
                  <div style={{ position: 'fixed', left: posPlus.x, top: posPlus.y }}
                    className="z-40 min-w-[200px] rounded-xl border border-gray-200 bg-white py-1.5 shadow-xl dark:border-gray-700 dark:bg-gray-800">
                    {ongletsRanges.map(g => (
                      <div key={g.label}>
                        <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                          {g.label}
                        </p>
                        {g.enfants.map(o => {
                          const Icon = o.icon;
                          const actif = ongletCourant === o.key;
                          return (
                            <button key={o.key} type="button"
                              onClick={() => { setOnglet(o.key); setPlusOuvert(false); }}
                              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-medium transition-colors
                                ${actif
                                  ? 'bg-indigo-600 text-white'
                                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'}`}>
                              <Icon size={15} className="shrink-0" />
                              {o.label}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Contenu */}
        {/* La carte détache le contenu de la barre d'onglets posée au-dessus.
            Un membre a ses onglets dans le menu : elle n'aurait plus rien à
            séparer et ne ferait qu'encadrer la page. */}
        <div className={membre ? '' : 'bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4 sm:p-6'}>
          {ongletCourant === 'partenaires' && <OngletPartenaires siteId={siteId} userId={user!.uid} roleSite={role} defaultVue={(searchParams.get('vue') as 'clients' | 'fournisseurs') ?? 'clients'} />}
          {ongletCourant === 'recouvrements' && <OngletRecouvrements siteId={siteId} userId={user!.uid} roleSite={role} onCount={setCountRecouvrements} />}
          {ongletCourant === 'remises' && <OngletRemises siteId={siteId} userId={user!.uid} />}
          {ongletCourant === 'retours' && <OngletRetours siteId={siteId} userId={user!.uid} role={role} />}
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
          {ongletCourant === 'mouvements-stock' && (
            <ListeMouvementsStock
              portee={siteId} siteEcriture={siteId} ensemble={false} />
          )}
          {ongletCourant === 'transferts' && <OngletTransferts siteId={siteId} userId={user!.uid} role={role} />}
          {ongletCourant === 'achats' && (
            <OngletAchats siteId={siteId} userId={user!.uid} role={role} />
          )}
          {ongletCourant === 'importations' && (
            <OngletImportations siteId={siteId} userId={user!.uid} role={role} />
          )}
          {ongletCourant === 'historique' && <OngletHistorique siteId={siteId} userId={user!.uid} />}
          {ongletCourant === 'cycle-vente' && (
            <OngletCycleVente siteId={siteId} userId={user!.uid} role={role} />
          )}
          {/* L'activité du site, pas celle du compte. Un propriétaire peut
              en avoir plusieurs — une créée, une autre héritée — et son
              profil n'en nomme qu'une. Prendre la sienne inscrivait les
              membres dans une maison où le site n'était pas : toutes leurs
              lectures étaient ensuite refusées, et leur écran restait
              blanc. C'est le site qu'on configure. */}
          {ongletCourant === 'configuration' && (
            <OngletConfiguration siteId={siteId} activiteId={site.activiteId ?? activite?.id}
              role={role} nomSite={site.nom} etatSite={site.etat}
              onEtatChange={e => setSite(s => (s ? { ...s, etat: e } : s))} />
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
