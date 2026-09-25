'use client';

/**
 * Qui je suis, et sous quel titre je travaille.
 *
 * Un membre ne pilote pas d'activité : la page Paramètre, qui la renomme et
 * purge ses données, ne le concerne pas. Il a pourtant besoin de vérifier
 * son propre poste — sous quelle adresse il est connecté, sur quel site il
 * agit, et quel rôle lui a été donné. Sans cet écran, il faut le demander à
 * son gérant.
 *
 * On montre ce qui est vrai et rien d'autre : ces informations se
 * consultent, elles ne se modifient pas ici. Le rôle est donné par celui
 * qui répond du site ; se l'attribuer soi-même n'aurait aucun sens.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { doc, getDoc } from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import { signOut } from 'firebase/auth';
import { useAuth } from '@/lib/auth-context';
import AppLayout from '@/components/AppLayout';
import { navDuSite } from '@/lib/onglets-site';
import {
  postesDuCompte, LIBELLES_ROLE, DESCRIPTIONS_ROLE, type Membre,
} from '@/lib/roles';
import { Loader2, LogOut, Mail, User, MapPin, ShieldCheck } from 'lucide-react';

export default function MonComptePage() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();
  const [postes, setPostes] = useState<(Membre & { siteNom: string })[]>([]);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push('/login'); return; }

    (async () => {
      const liste = await postesDuCompte(user.uid).catch(() => [] as Membre[]);
      /* Le membre porte l'identifiant du site, pas son nom : sans cette
         lecture, l'écran afficherait une suite de caractères. */
      const avecNom = await Promise.all(liste.map(async m => {
        const s = await getDoc(doc(db, 'sites', m.siteId)).catch(() => null);
        return { ...m, siteNom: (s?.data()?.nom as string) ?? '—' };
      }));
      setPostes(avecNom);
      setChargement(false);
    })();
  }, [user, loading, router]);

  /* Le nom le plus fiable, dans l'ordre : celui que le gérant a saisi en
     invitant, puis celui du profil, puis rien. Une adresse n'est pas un
     nom — l'afficher deux fois de suite n'apprend rien. */
  const courriel = profile?.email || user?.email || '';
  const nomPoste = postes.find(p => p.nom?.trim())?.nom?.trim();
  const nomProfil = profile?.nom?.trim();
  const nom = nomPoste
    || (nomProfil && nomProfil !== courriel ? nomProfil : '')
    || user?.displayName?.trim()
    || '—';

  /* Les onglets du site où il travaille. Plusieurs postes : on prend le
     premier, faute de savoir lequel il regardait — il y revient d'un clic. */
  const premier = postes[0];
  const nav = premier ? navDuSite(premier.siteId, premier.role) : undefined;

  if (loading || chargement) return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    /* La navigation suit le membre : cette page est atteinte depuis sa
       barre du bas, qui disparaîtrait ici faute d'onglets — le menu burger
       reprendrait la main sous ses pieds. On lui rend donc les onglets de
       son site.
       Un compte sans poste — le propriétaire — n'a pas de barre : il
       navigue par son menu, qui ne bouge pas. */
    <AppLayout navItems={nav} navTitre={postes[0]?.siteNom} portee={postes[0]?.siteId}>
      <div className="w-full p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Mon compte</h1>
        <p className="mt-0.5 text-sm text-gray-400">Ce qui vous identifie dans l&apos;application</p>

        {/* ————— L'identité du compte ————— */}
        <div className="mt-5 max-w-lg rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex flex-col gap-3">
            {/* Le nom du profil vaut souvent l'adresse : à l'inscription,
                rien d'autre n'est connu. Celui de l'invitation, lui, a été
                saisi par le gérant — c'est le vrai nom de la personne. */}
            <Ligne icone={<User size={15} />} label="Nom" valeur={nom} />
            <Ligne icone={<Mail size={15} />} label="Adresse de connexion"
              valeur={courriel || '—'} />
          </div>
        </div>

        {/* ————— Les postes ————— */}
        <p className="mt-6 text-xs font-bold uppercase tracking-wide text-gray-400">
          {postes.length > 1 ? 'Mes postes' : 'Mon poste'}
        </p>

        {postes.length === 0 ? (
          /* Un propriétaire n'est désigné par aucun membre : il entre
             partout de droit, et n'a donc pas de poste à afficher. */
          <p className="mt-2 max-w-lg rounded-2xl border border-gray-100 bg-white p-5 text-sm text-gray-400 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            Aucun poste : ce compte n&apos;est rattaché à aucun site par un rôle.
          </p>
        ) : (
          <div className="mt-2 flex max-w-lg flex-col gap-2">
            {postes.map(p => (
              <div key={p.id}
                className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
                <div className="flex flex-col gap-3">
                  <Ligne icone={<MapPin size={15} />} label="Site" valeur={p.siteNom} />
                  <Ligne icone={<ShieldCheck size={15} />} label="Rôle"
                    valeur={LIBELLES_ROLE[p.role]} />
                </div>
                {/* Ce que le rôle ouvre : le nom seul ne le dit pas. */}
                <p className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-400 dark:border-gray-800">
                  {DESCRIPTIONS_ROLE[p.role]}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* La déconnexion vivait dans le tiroir du menu : sans lui sur
            téléphone, elle n'était plus atteignable nulle part. */}
        <button
          onClick={async () => { await signOut(auth); router.push('/login'); }}
          className="mt-6 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20">
          <LogOut size={15} /> Se déconnecter
        </button>
      </div>
    </AppLayout>
  );
}

/** Une information : son icône, ce qu'elle nomme, et sa valeur. */
function Ligne({ icone, label, valeur }: {
  icone: React.ReactNode; label: string; valeur: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex shrink-0 items-center gap-2 text-xs text-gray-400">
        <span className="text-gray-300 dark:text-gray-600">{icone}</span>
        {label}
      </span>
      {/* Une adresse se lit en entier ou ne sert à rien : elle passe à la
          ligne plutôt que de se couper. */}
      <span className="break-all text-right text-sm font-medium text-gray-900 dark:text-gray-100">
        {valeur}
      </span>
    </div>
  );
}
