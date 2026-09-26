/**
 * Vider la base, sans toucher à la maison.
 *
 * Ce que le script garde : les sites, les membres, les utilisateurs et les
 * activités. Tout le reste part — l'exploitation, le catalogue, les
 * partenaires, les employés, les configurations, et la caisse.
 *
 * Pourquoi un script plutôt que le bouton : l'écran passe par les règles
 * Firestore, qui refusent de supprimer un mouvement de caisse. Ici on parle
 * au serveur avec une clé de service, hors des règles — c'est le seul moyen
 * de vider vraiment. C'est aussi ce qui le rend dangereux : rien ne
 * protège plus, alors le script demande une confirmation écrite et refuse
 * de tourner sur un autre projet que celui qu'on lui nomme.
 *
 * Usage :
 *   node scripts/vider-base.mjs --cle <chemin.json> --essai
 *   node scripts/vider-base.mjs --cle <chemin.json> --confirmer VIDER
 *
 * `--essai` compte sans rien effacer. C'est le seul moyen de voir ce qu'on
 * perdrait, puisqu'on ne pourra pas revenir dessus.
 */

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/** Le projet attendu : une clé d'un autre projet viderait la mauvaise base. */
const PROJET = 'ib-gestion';

/** Ce qui reste debout. Tout ce qui n'est pas ici sera effacé. */
const GARDEES = new Set([
  'sites',
  'membres',
  'users',
  'activites',
]);

function argument(nom, defaut = null) {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : defaut;
}

const cheminCle = argument('cle');
const essai = process.argv.includes('--essai');
const confirmation = argument('confirmer');

if (!cheminCle) {
  console.error('Il manque --cle <chemin vers la clé de service .json>.');
  console.error('Console Firebase → Paramètres → Comptes de service → Générer une clé.');
  process.exit(1);
}

if (!essai && confirmation !== 'VIDER') {
  console.error('Rien n\'a été touché.');
  console.error('Pour compter sans effacer  : --essai');
  console.error('Pour effacer pour de bon   : --confirmer VIDER');
  process.exit(1);
}

const cle = JSON.parse(readFileSync(cheminCle, 'utf8'));

/* Une clé du mauvais projet effacerait une base qu'on ne regardait pas.
   On le vérifie avant d'ouvrir quoi que ce soit. */
if (cle.project_id !== PROJET) {
  console.error(`Cette clé est pour « ${cle.project_id} », pas « ${PROJET} ».`);
  console.error('Refus : ce n\'est pas la base de cette application.');
  process.exit(1);
}

initializeApp({ credential: cert(cle) });
const db = getFirestore();

/* Firestore refuse un lot de plus de 500 écritures. */
const LOT = 450;

async function viderCollection(nom) {
  let efface = 0;
  /* On relit à chaque tour plutôt que de tout charger : une collection de
     plusieurs dizaines de milliers de documents ne tient pas en mémoire. */
  for (;;) {
    const snap = await db.collection(nom).limit(LOT).get();
    if (snap.empty) break;
    if (essai) return snap.size === LOT ? `${LOT}+` : snap.size;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    efface += snap.size;
    process.stdout.write(`\r  ${nom} · ${efface}`);
  }
  if (!essai && efface > 0) process.stdout.write('\n');
  return efface;
}

const collections = (await db.listCollections())
  .map(c => c.id)
  .filter(id => !GARDEES.has(id))
  .sort();

console.log(`Projet   : ${PROJET}`);
console.log(`Mode     : ${essai ? 'ESSAI — rien ne sera effacé' : 'SUPPRESSION DÉFINITIVE'}`);
console.log(`Gardées  : ${[...GARDEES].join(', ')}`);
console.log(`À vider  : ${collections.length} collection(s)\n`);

let total = 0;
for (const nom of collections) {
  const n = await viderCollection(nom);
  if (n === 0) continue;
  if (essai) console.log(`  ${nom} · ${n}`);
  if (typeof n === 'number') total += n;
}

console.log(`\n${essai ? 'À effacer' : 'Effacé'} : ${total} document(s).`);
if (essai) console.log('Rien n\'a été touché. Relance avec --confirmer VIDER pour effacer.');
