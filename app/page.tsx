'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { sitesDuCompte } from '@/lib/roles';

/**
 * L'app s'ouvre sur le tableau de bord de l'activité.
 *
 * Une activité se pilote site par site, mais celui qui en répond veut
 * d'abord savoir où il en est — pas choisir par quel site commencer. La
 * liste reste accessible, elle sert à administrer, pas à entrer.
 *
 * Un membre, lui, n'a qu'un site : c'est le sien qui l'accueille.
 */
export default function Home() {
  const { user, activite, profile, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/login'); return; }

    /* Sans activité, il n'y a nulle part où ranger un site : on la demande
       avant tout le reste. Sauf à un membre invité : il travaille sur le
       site d'un autre, il n'a pas d'activité à fonder. */
    if (profile?.role !== 'membre') {
      router.replace(activite ? '/ensemble?onglet=dashboard' : '/activite');
      return;
    }

    /* Un membre n'a qu'un site : passer par la liste le ferait traverser un
       écran qui se redirige aussitôt, et chaque saut redessine la page. On
       résout sa destination ici, une fois. */
    let vivant = true;
    sitesDuCompte(user.uid)
      .then(ids => {
        if (!vivant) return;
        router.replace(ids.length === 1 ? `/site/${ids[0]}` : '/site');
      })
      .catch(() => { if (vivant) router.replace('/site'); });
    return () => { vivant = false; };
  }, [user, activite, profile?.role, loading, router]);

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
