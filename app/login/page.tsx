'use client';
import { useState } from 'react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
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
        /* La racine décide : elle enverra vers l'activité si elle manque,
           vers les sites sinon. */
        router.push('/');
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, password);

        /* Un gérant a pu inviter cette adresse avant que le compte existe.
           Dans ce cas le compte rejoint un site : il ne fonde pas d'activité,
           et on ne lui en demande pas le nom. */
        let invite = 0;
        try { invite = await rattacherCompte(cred.user.uid, email); }
        catch { invite = 0; }

        await setDoc(doc(db, 'users', cred.user.uid), {
          uid: cred.user.uid,
          email,
          nom: email,
          role: invite > 0 ? 'membre' : 'admin',
          ...(invite > 0 ? {} : { adminUid: cred.user.uid }),
          createdAt: serverTimestamp(),
        });
        router.push(invite > 0 ? '/site' : '/activite');
      }
    } catch (err: any) {
      setError(err.message);
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
