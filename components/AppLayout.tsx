'use client';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu, WifiOff, Sun, Moon } from 'lucide-react';
import Sidebar from './Sidebar';
import { useReseau } from '@/lib/reseau';
import { useTheme } from '@/lib/theme-context';

export default function AppLayout({
  children, navItems, navTitre, portee,
}: {
  children: React.ReactNode;
  /** Les onglets de la page, quand elle en a : ils vont dans le sidebar. */
  navItems?: React.ComponentProps<typeof Sidebar>['items'];
  /** Ce que le menu surmonte, quand ce n'est pas l'activité. */
  navTitre?: string;
  /** Sur quoi porte le compte des dossiers en attente, dans le menu. */
  portee?: React.ComponentProps<typeof Sidebar>['portee'];
}) {
  const { user, loading } = useAuth();
  /* Le réseau tombe sans prévenir : l'app continue de fonctionner sur son
     cache, mais il faut le dire — sinon on croit à une panne. */
  const enLigne = useReseau();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  /* Avant les retours anticipés : un hook ne s'appelle pas conditionnellement. */
  const { theme, toggle } = useTheme();

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  if (loading) return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!user) return null;

  /* Peu d'onglets : ils se posent en barre basse sur téléphone, et le menu
     n'a plus lieu d'être — il cacherait les pastilles qu'on veut voir.
     Le sidebar ajoute « Paramètre » aux onglets de la page : la barre en
     compte donc un de plus, et les deux doivent s'accorder, sinon l'un
     dessine la barre pendant que l'autre garde le menu. */
  const barreBasse = !!navItems && navItems.length > 0 && navItems.length + 1 <= 5;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50 dark:bg-gray-950">
      {/* Hors ligne, on travaille quand même : ce qui est saisi s'inscrit
          localement et partira au retour. Le dire évite qu'on recommence
          une vente déjà enregistrée. */}
      {!enLigne && (
        <div className="flex shrink-0 items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-xs font-bold text-white">
          <WifiOff size={13} className="shrink-0" />
          Hors ligne — le travail continue et partira au retour du réseau.
        </div>
      )}
      {/* Topbar mobile. Avec la barre basse, plus de bouton de menu : les
          onglets sont déjà tous à l'écran, et ouvrir un tiroir pour y
          retrouver la même chose n'apporte rien. */}
      <header className="md:hidden flex items-center gap-3 px-4 h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shrink-0">
        {!barreBasse && (
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400">
            <Menu size={22} />
          </button>
        )}
        <span className="text-lg font-bold text-indigo-600 dark:text-indigo-400">IB APP</span>
        {/* Le thème vivait dans le tiroir : sans lui, il deviendrait
            introuvable sur téléphone. Il passe ici, où le menu était.
            La déconnexion, elle, se trouve dans Paramètre, qui est dans
            la barre. */}
        {barreBasse && (
          <button onClick={toggle} aria-label={theme === 'dark' ? 'Mode clair' : 'Mode sombre'}
            className="ml-auto rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
            {theme === 'dark' ? <Sun size={20} className="text-yellow-400" /> : <Moon size={20} />}
          </button>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar mobileOpen={mobileMenuOpen} onMobileClose={() => setMobileMenuOpen(false)}
          items={navItems} titre={navTitre} portee={portee} />
        {/* Une page qui apporte sa propre mise en page ne doit pas hériter des
            marges du cadre : elles se cumuleraient en un encadrement étroit. */}
        {/* La barre basse est fixée au-dessus de la page : sans cette
            réserve, elle couvrirait la dernière ligne, qui est justement
            celle qu'on vient de saisir. */}
        <main className={`flex-1 overflow-y-auto text-gray-900 dark:text-gray-100 ${
          navItems ? '' : 'p-3 sm:p-6'} ${barreBasse ? 'pb-20 md:pb-0' : ''}`}>
          {children}
        </main>
      </div>
    </div>
  );
}
