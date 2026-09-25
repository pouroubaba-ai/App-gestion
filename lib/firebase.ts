import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

/* Projet Firebase propre à cette application, distinct de l'ancienne. */
const firebaseConfig = {
  apiKey: "AIzaSyCem5MF1eIHLClTOsx__b2NKCbFPAc2AxA",
  authDomain: "ib-gestion.firebaseapp.com",
  projectId: "ib-gestion",
  storageBucket: "ib-gestion.firebasestorage.app",
  messagingSenderId: "715059046983",
  appId: "1:715059046983:web:12c3ccc6cd45d9eeed1f62",
};

/**
 * Le nom de la session, lu dans l'adresse.
 *
 * Deux onglets du même navigateur partagent le même stockage : se
 * connecter dans l'un déconnecte l'autre. Pour travailler à plusieurs
 * rôles — voir ce que le caissier voit pendant que le gérant décide — il
 * faut des sessions qui ne se marchent pas dessus.
 *
 * `?session=caissier` dans l'adresse donne à cet onglet sa propre instance
 * Firebase, donc son propre stockage d'authentification. Sans paramètre,
 * rien ne change : c'est la session ordinaire.
 *
 * Cela sert à vérifier la coordination entre les rôles. En usage réel,
 * personne n'a de raison de mettre ce paramètre.
 */
function nomSession(): string {
  if (typeof window === 'undefined') return '';
  const n = new URLSearchParams(window.location.search).get('session');
  /* On accepte des noms simples : un nom libre deviendrait une clé de
     stockage arbitraire. */
  const propre = n && /^[a-z0-9-]{1,20}$/i.test(n) ? n : '';

  /* Le nom se retient dans l'onglet. Sans cela, la première redirection
     — vers la connexion, vers un site — le perdait de l'adresse, et
     l'onglet retombait dans la session commune : se connecter ici
     déconnectait là. `sessionStorage` est propre à l'onglet, c'est
     exactement la portée qu'il faut. */
  try {
    if (propre) {
      window.sessionStorage.setItem('ibd:session', propre);
      return propre;
    }
    return window.sessionStorage.getItem('ibd:session') ?? '';
  } catch {
    /* Navigation privée, stockage refusé : on se contente de l'adresse. */
    return propre;
  }
}

const SESSION = nomSession();

/* Chaque session a son application Firebase, donc son propre coffre
   d'authentification. La session par défaut garde l'application anonyme,
   pour ne rien changer à ce qui existe. */
const nomApp = SESSION ? `session-${SESSION}` : '[DEFAULT]';
const app = getApps().find(a => a.name === nomApp)
  ?? (SESSION ? initializeApp(firebaseConfig, nomApp) : initializeApp(firebaseConfig));
export const auth = getAuth(app);
/**
 * Cache disque plutôt que mémoire.
 *
 * Sans lui, chaque ouverture d'un onglet relisait des collections entières
 * sur le serveur — le tableau de bord en lit sept — et un simple aller-retour
 * entre deux onglets coûtait des centaines de lectures. Le quota gratuit
 * (50 000 lectures par jour) s'épuisait en une matinée de travail.
 *
 * Avec le cache persistant, Firestore sert d'abord depuis le disque du
 * navigateur : ces lectures-là ne sont pas facturées et survivent au
 * rechargement de la page. Il ne va sur le réseau que pour ce qu'il n'a pas.
 *
 * `persistentMultipleTabManager` autorise plusieurs onglets ouverts sur
 * l'app à partager ce cache ; sans lui, le second onglet le perdrait.
 */
/* Le cache disque appartient à l'application : une session nommée a donc
   le sien, et deux rôles ouverts côte à côte ne se relisent pas l'un
   l'autre. */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const storage = getStorage(app);

// Instance secondaire pour créer des sous-comptes sans déconnecter l'admin
const secondaryApp = getApps().find(a => a.name === 'secondary') ?? initializeApp(firebaseConfig, 'secondary');
export const authSecondary = getAuth(secondaryApp);
