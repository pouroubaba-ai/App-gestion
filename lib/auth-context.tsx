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
        /* La condition ne regarde plus le rôle, seulement l'activité.
         *
           Elle exigeait `role === 'admin'`. Un compte déjà passé à
           `membre` mais resté sans activité — ce que produisait une
           inscription dont le rattachement avait échoué à mi-chemin —
           n'était jamais repris : il gardait un profil muet, et chaque
           lecture de son site lui était refusée. Ce qu'on répare ici est
           l'activité manquante ; le rôle n'y change rien. */
        if (!p.activiteId) {
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
          /* Absent plutôt que `null` quand on ne la connaît pas encore.
           *
             Un champ présent valant `null` n'est pas un champ vide :
             `get('activiteId', '')` rend alors `null`, pas `''`, et la
             règle qui n'autorise à poser l'activité que sur un champ
             vide refusait l'écriture. Le compte invité après son
             inscription restait donc sans activité pour toujours — les
             règles lui demandaient sa maison, il n'en nommait aucune, et
             son propre site répondait « Site introuvable ». */
          ...(sonActivite ? { activiteId: sonActivite } : {}),
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
      /* Le profil ne porte plus `adminUid`.
       *
         Il servait de raccourci aux regles, qui ne le lisent plus : un
         compte ecrit son propre profil, et poser `adminUid: moi` avec
         l'activite d'un autre suffisait a s'y declarer proprietaire.
         C'est l'activite qui repond maintenant, et elle seule.
       *
         Le champ est donc interdit a la creation d'un profil. Mais
         l'app continuait de l'ecrire a l'inscription : la regle
         refusait, et tout compte cree sans invitation prealable butait
         sur « Missing or insufficient permissions » — il ne pouvait
         jamais entrer. */

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
