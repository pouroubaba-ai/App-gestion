'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Loader2, Store } from 'lucide-react';

/**
 * Le nom de l'activité, demandé une seule fois.
 *
 * Tout ce que l'app enregistre — sites, produits, partenaires — appartient à
 * une activité. Tant qu'elle n'existe pas, il n'y a nulle part où ranger un
 * site : c'est pourquoi cet écran précède tous les autres, et pourquoi on ne
 * peut pas le passer.
 */
export default function ActivitePage() {
  const { user, activite, profile, loading, creerActivite } = useAuth();
  const router = useRouter();
  const [nom, setNom] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push('/login'); return; }
    /* Elle existe déjà : rien à demander. */
    if (activite) { router.push('/site'); return; }
    /* Un membre travaille sur l'activité d'un autre : il n'en fonde aucune,
       et cet écran le retiendrait sur un nom qu'il n'a pas à donner. */
    if (profile?.role === 'membre') router.push('/site');
  }, [user, activite, profile?.role, loading, router]);

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    if (!nom.trim()) { setErreur('Donnez un nom à votre activité.'); return; }
    setEnCours(true);
    setErreur('');
    try {
      await creerActivite(nom);
      router.push('/site');
    } catch (err: any) {
      setErreur(err?.message ?? 'Création impossible.');
      setEnCours(false);
    }
  }

  if (loading || !user || activite || profile?.role === 'membre') return (
    <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow-sm">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 dark:bg-indigo-900/30">
          <Store size={20} className="text-indigo-600 dark:text-indigo-400" />
        </span>

        <h1 className="mt-4 text-lg font-bold text-gray-900 dark:text-gray-100">
          Votre activité
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Vos boutiques et dépôts en dépendront tous. Ce nom se change plus tard
          dans les paramètres.
        </p>

        <form onSubmit={enregistrer} className="mt-5">
          <label className="mb-1.5 block text-xs font-bold uppercase text-gray-400">
            Nom de l&apos;activité
          </label>
          <input
            type="text"
            value={nom}
            onChange={e => setNom(e.target.value)}
            placeholder="Ex. Établissements Kunda"
            autoFocus
            className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />

          {erreur && <p className="mt-2 text-xs text-red-500">{erreur}</p>}

          <button
            type="submit"
            disabled={enCours || !nom.trim()}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40"
          >
            {enCours && <Loader2 size={14} className="animate-spin" />}
            Continuer
          </button>
        </form>
      </div>
    </div>
  );
}
