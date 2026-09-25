'use client';
import { useState } from 'react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { rattacherCompte } from '@/lib/roles';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (tab === 'login') {
        const cred = await signInWithEmailAndPassword(auth, email, password);

        /**
         * Rattraper une inscription restée à mi-chemin.
         *
         * Créer un compte se fait en deux écritures : celle de Firebase
         * Auth, puis le profil. Entre les deux, une panne ou un refus
         * laisse un compte qui existe sans rien être — et le réessayer
         * bute sur « cette adresse est déjà prise ». La personne est
         * coincée : ni dedans, ni dehors.
         *
         * La connexion finit donc le travail quand le profil manque. On
         * cherche l'invitation, et c'est elle qui dit ce que ce compte
         * est — membre d'un site, ou propriétaire de sa maison.
         */
        const ref = doc(db, 'users', cred.user.uid);
        const dejaLa = await getDoc(ref);
        if (!dejaLa.exists()) {
          const r = await rattacherCompte(cred.user.uid, email);
          await setDoc(ref, {
            uid: cred.user.uid,
            email,
            nom: email,
            role: r.nb > 0 ? 'membre' : 'admin',
            /* L'activité vient de l'invitation : sans elle, les règles ne
               savent pas de quelle maison est ce compte et lui refusent
               toute lecture. */
            ...(r.activiteId ? { activiteId: r.activiteId } : {}),
            ...(r.nb > 0 ? {} : { adminUid: cred.user.uid }),
            createdAt: serverTimestamp(),
          });
        } else {
          /* Le profil existe : on rattache quand même, car une invitation
             peut être arrivée depuis — un second site, un rôle ajouté. */
          let miens = 0;
          let sonActivite: string | null = null;
          try {
            const r = await rattacherCompte(cred.user.uid, email);
            miens = r.nb; sonActivite = r.activiteId;
          } catch { miens = 0; }

          /**
           * Réparer un « admin » qui n'en est pas un.
           *
           * Un profil `admin` sans activité, alors que ce compte est
           * membre quelque part, ne peut venir que d'un rattachement
           * raté : à l'inscription, l'échec de la recherche passait pour
           * « personne ne l'a invité ». La personne se retrouvait
           * propriétaire d'une activité qui n'existe pas, devant un écran
           * vide.
           *
           * On ne dégrade jamais un vrai propriétaire : celui-là a une
           * activité, et la condition l'écarte.
           */
          const p = dejaLa.data();
          if (miens > 0 && p?.role === 'admin' && !p?.activiteId) {
            try {
              await setDoc(ref, {
                role: 'membre',
                ...(sonActivite ? { activiteId: sonActivite } : {}),
              }, { merge: true });
            } catch { /* il faudra le corriger à la main */ }
          } else if (miens > 0 && sonActivite && !p?.activiteId) {
            /* Membre sans activité : même cause, l'écran reste vide tant
               qu'elle manque. */
            try {
              await setDoc(ref, { activiteId: sonActivite }, { merge: true });
            } catch { /* la prochaine fois */ }
          }
        }

        /* La racine décide : elle enverra vers l'activité si elle manque,
           vers les sites sinon. */
        router.push('/');
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, password);

        /**
         * Inviter d'abord, décider ensuite.
         *
         * Un gérant a pu inviter cette adresse avant que le compte
         * existe ; dans ce cas la personne rejoint un site et ne fonde
         * pas d'activité. Il faut donc chercher l'invitation avant
         * d'écrire le profil, puisque c'est elle qui dit le rôle.
         *
         * Et si cette recherche échoue, on ne décide rien. Elle échouait
         * en silence et l'échec valait « personne ne l'a invité » : un
         * employé devenait propriétaire de sa propre activité. Une panne
         * de réseau ne doit pas distribuer les droits.
         */
        let invite = 0;
        let sonActivite: string | null = null;
        try {
          const r = await rattacherCompte(cred.user.uid, email);
          invite = r.nb;
          sonActivite = r.activiteId;
        } catch (e) {
          /* Le compte d'authentification existe déjà : le laisser sans
             profil vaut mieux qu'un profil faux. Il se reconnectera, et
             le rattachement se refera — cette fois depuis un compte
             connecté, ce que les règles acceptent. */
          setError(
            'Compte créé, mais votre invitation n’a pas pu être vérifiée. '
            + 'Connectez-vous : elle sera retrouvée.');
          setLoading(false);
          return;
        }

        await setDoc(doc(db, 'users', cred.user.uid), {
          uid: cred.user.uid,
          email,
          nom: email,
          role: invite > 0 ? 'membre' : 'admin',
          ...(sonActivite ? { activiteId: sonActivite } : {}),
          ...(invite > 0 ? {} : { adminUid: cred.user.uid }),
          createdAt: serverTimestamp(),
        });
        /**
         * Un vrai chargement, pas une navigation.
         *
         * Le profil vient d'être écrit, mais le contexte d'authentification
         * l'avait déjà cherché — et ne l'avait pas trouvé, puisqu'il
         * n'existait pas encore. `router.push` ne relance pas cette
         * lecture : le nouveau membre arrivait devant « Mon activité » et
         * « 0 / 0 site », alors que tout était correct en base.
         *
         * Un rechargement complet repart du profil réel. C'est un peu plus
         * lent, une fois dans la vie d'un compte.
         */
        window.location.href = invite > 0 ? '/site' : '/activite';
      }
    } catch (err: any) {
      /* Les messages de Firebase sont écrits pour un développeur. Ceux
         qu'on rencontre vraiment méritent d'être dits en clair — surtout
         « adresse déjà prise », qui arrive à qui a déjà un compte sans le
         savoir et qu'il faut envoyer vers la connexion, pas laisser
         devant un mur. */
      const code = err?.code ?? '';
      setError(
        code === 'auth/email-already-in-use'
          ? 'Cette adresse a déjà un compte. Passez par « Se connecter ».'
        : code === 'auth/invalid-credential' || code === 'auth/wrong-password'
          ? 'Adresse ou mot de passe incorrect.'
        : code === 'auth/user-not-found'
          ? 'Aucun compte à cette adresse. Créez-en un.'
        : code === 'auth/weak-password'
          ? 'Mot de passe trop court : six caractères au minimum.'
        : code === 'auth/invalid-email'
          ? 'Cette adresse n’est pas valide.'
        : code === 'auth/network-request-failed'
          ? 'Pas de réseau. Réessayez.'
        : err?.message ?? 'La connexion a échoué.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 mb-4 text-center">
          <h1 className="text-3xl font-bold text-gray-900">IB APP</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          <div className="flex border-b border-gray-200 mb-6">
            <button onClick={() => setTab('register')}
              className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors ${tab === 'register' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400'}`}>
              Créer un compte
            </button>
            <button onClick={() => setTab('login')}
              className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors ${tab === 'login' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-400'}`}>
              Se connecter
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="exemple@email.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mot de passe</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="••••••••" />
            </div>
            {error && <p className="text-red-500 text-xs">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full bg-indigo-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {loading ? 'Chargement...' : tab === 'login' ? 'Se connecter' : 'Créer un compte'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
