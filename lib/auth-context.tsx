'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import {
  doc, getDoc, setDoc, addDoc, collection, query, where, getDocs,
  serverTimestamp,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { rattacherCompte, sitesDuCompte } from './roles';

/**
 * Ce qu'un compte est au niveau de l'app.
 *
 * `admin` tient une activité et ses sites. `membre` a été invité sur un site
 * par son gérant : il n'a pas d'activité à lui, et n'en créera pas.
 */
export type UserRole = 'admin' | 'membre';

export interface UserProfile {
  uid: string;
  email: string;
  nom: string;
  role: UserRole;
  /** l'activité que ce compte pilote ; absente tant qu'elle n'est pas créée */
  activiteId?: string | null;
}

/**
 * L'activité commerciale : ce qui réunit les sites d'une même maison.
 *
 * Un site n'existe pas seul — une boutique et son dépôt appartiennent à la
 * même activité, partagent ses partenaires et ses produits. Sans ce niveau,
 * chaque site serait une île et l'app ne servirait qu'à en tenir un.
 */
export interface Activite {
  id: string;
  nom: string;
  /** le compte qui l'a créée ; propriétaire de tout ce qui en dépend */
  adminUid: string;
  createdAt?: any;
}

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  activite: Activite | null;
  loading: boolean;
  /** crée l'activité du compte courant et la rend disponible aussitôt */
  creerActivite: (nom: string) => Promise<Activite>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null, profile: null, activite: null, loading: true,
  creerActivite: async () => { throw new Error('hors AuthProvider'); },
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [activite, setActivite] = useState<Activite | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (!u) {
        setProfile(null);
        setActivite(null);
        setLoading(false);
        return;
      }

      const ref = doc(db, 'users', u.uid);
      const snap = await getDoc(ref);
      let p: UserProfile;
      if (snap.exists()) {
        p = snap.data() as UserProfile;

        /* Un compte créé avant son invitation porte encore `admin` : le rôle
           fut écrit à l'inscription, quand rien ne le désignait. On le
           rattache ici, sinon il resterait bloqué à créer une activité qu'il
           n'aura jamais. */
        if (p.role === 'admin' && !p.activiteId) {
          try {
            const r = await rattacherCompte(u.uid, u.email ?? '');
            const sites = await sitesDuCompte(u.uid);
            if (r.nb > 0 || sites.length > 0) {
              /* L'activité avec le rôle : sans elle, les règles ne savent
                 pas de quelle maison il est et lui refusent tout. */
              p = { ...p, role: 'membre',
                ...(r.activiteId ? { activiteId: r.activiteId } : {}) };
              await setDoc(ref, {
                role: 'membre',
                ...(r.activiteId ? { activiteId: r.activiteId } : {}),
              }, { merge: true });
            }
          } catch { /* hors ligne : on garde le profil tel quel */ }
        }
      } else {
        /* Premier login. Un gérant a pu inviter cette adresse avant que le
           compte existe : on pose l'identifiant sur ces invitations, et le
           compte devient membre au lieu de fonder une activité à lui. */
        let invite = 0;
        let sonActivite: string | null = null;
        try {
          const r = await rattacherCompte(u.uid, u.email ?? '');
          invite = r.nb; sonActivite = r.activiteId;
        } catch { invite = 0; }

        p = {
          uid: u.uid,
          email: u.email ?? '',
          nom: u.email ?? '',
          role: invite > 0 ? 'membre' : 'admin',
          /* L'invitation porte l'activité : un membre en hérite, et sans
             elle les règles lui refusent toute lecture. */
          activiteId: sonActivite,
        };
        await setDoc(ref, { ...p, createdAt: serverTimestamp() });
      }
      setProfile(p);

      /* On retrouve l'activité par son id quand le profil le porte ; sinon
         on la cherche par son propriétaire, pour rattraper un profil créé
         avant qu'elle n'existe. */
      let a: Activite | null = null;
      if (p.activiteId) {
        const s = await getDoc(doc(db, 'activites', p.activiteId));
        if (s.exists()) a = { id: s.id, ...s.data() } as Activite;
      }
      if (!a && p.role !== 'membre') {
        const q = await getDocs(query(
          collection(db, 'activites'), where('adminUid', '==', u.uid)));
        if (!q.empty) {
          a = { id: q.docs[0].id, ...q.docs[0].data() } as Activite;
          await setDoc(ref, { activiteId: a.id }, { merge: true });
          setProfile({ ...p, activiteId: a.id });
        }
      }
      /**
       * Le profil apprend qu'il est propriétaire.
       *
       * Les règles Firestore le demandent souvent — à chaque écriture, à
       * chaque lecture d'un site. Sans ce champ, chacune doit aller lire
       * l'activité : une requête de plus, un aller-retour de plus, et
       * l'app rame dès qu'elle est loin du serveur.
       *
       * On le pose ici parce que c'est le seul endroit où la réponse est
       * déjà connue sans rien relire : l'activité vient d'être chargée.
       * Les comptes créés depuis l'écran d'inscription l'ont déjà ; ceux
       * d'avant le reçoivent à leur prochaine ouverture.
       */
      if (a && a.adminUid === u.uid && !(p as { adminUid?: string }).adminUid) {
        try {
          await setDoc(ref, { adminUid: u.uid }, { merge: true });
        } catch {
          /* Sans lui, tout marche encore — seulement un peu plus
             lentement. On réessaiera à la prochaine ouverture. */
        }
      }

      setActivite(a);
      setLoading(false);
    });
  }, []);

  async function creerActivite(nom: string): Promise<Activite> {
    if (!user) throw new Error('Aucun compte connecté.');
    const ref = await addDoc(collection(db, 'activites'), {
      nom: nom.trim(),
      adminUid: user.uid,
      createdAt: serverTimestamp(),
    });
    const a: Activite = { id: ref.id, nom: nom.trim(), adminUid: user.uid };
    /* Le profil porte l'id : au prochain démarrage, une lecture suffit. */
    await setDoc(doc(db, 'users', user.uid), { activiteId: ref.id }, { merge: true });
    setActivite(a);
    setProfile(prev => prev ? { ...prev, activiteId: ref.id } : prev);
    return a;
  }

  return (
    <AuthContext.Provider value={{ user, profile, activite, loading, creerActivite }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
