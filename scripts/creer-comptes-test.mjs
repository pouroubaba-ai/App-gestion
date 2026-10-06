/**
 * Créer les comptes de test (Firebase Auth seulement).
 *
 * Le script crée cinq comptes de connexion. Il n'écrit RIEN dans Firestore :
 * profil, activité et rattachement aux sites se font par l'app elle-même,
 * à la première connexion et via les invitations — exactement comme pour
 * un vrai utilisateur. On teste donc aussi ce chemin-là.
 *
 * Usage (même clé de service que vider-base.mjs) :
 *   node scripts/creer-comptes-test.mjs --cle <chemin.json>
 *
 * Relancer est sans danger : un compte qui existe déjà est laissé tel quel.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const PROJET = 'ib-gestion';

const COMPTES = [
  { cle: 'proprio',      email: 'test.proprio@ibd-test.local' },
  { cle: 'gerant',       email: 'test.gerant@ibd-test.local' },
  { cle: 'caissier',     email: 'test.caissier@ibd-test.local' },
  { cle: 'commandes',    email: 'test.commandes@ibd-test.local' },
  { cle: 'recouvrement', email: 'test.recouvrement@ibd-test.local' },
];

function argument(nom) {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const chemin = argument('cle');
if (!chemin) {
  console.error('Usage : node scripts/creer-comptes-test.mjs --cle <chemin.json>');
  process.exit(1);
}
const cle = JSON.parse(readFileSync(chemin, 'utf8'));
if (cle.project_id !== PROJET) {
  console.error(`Clé du projet « ${cle.project_id} », attendu « ${PROJET} ». Arrêt.`);
  process.exit(1);
}

initializeApp({ credential: cert(cle) });
const auth = getAuth();

console.log('\nComptes de test :\n');
for (const c of COMPTES) {
  try {
    await auth.getUserByEmail(c.email);
    console.log(`  ${c.cle.padEnd(13)} ${c.email}  (existait déjà, mot de passe inchangé)`);
  } catch {
    const mdp = 'Test-' + randomBytes(5).toString('hex');
    await auth.createUser({ email: c.email, password: mdp, displayName: `TEST ${c.cle}` });
    console.log(`  ${c.cle.padEnd(13)} ${c.email}  mot de passe : ${mdp}`);
  }
}
console.log(`
Ensuite, dans l'ordre :
  1. Inviter (depuis le compte proprio, dans l'app) les 4 autres adresses
     avec leur rôle, AVANT leur première connexion.
  2. Se connecter une fois par onglet :
     localhost:3010/?session=proprio, ?session=gerant, ?session=caissier...
Garde ces mots de passe pour toi : ne les colle pas dans la conversation.
`);
