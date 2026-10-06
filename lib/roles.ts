import {
  collection, query, where, getDocs, addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { oublierAuteur } from './auteur';

/**
 * Qui travaille sur un site, et à quel titre.
 *
 * Le compte qui a créé l'activité en est l'admin : il entre partout. Les
 * autres reçoivent un rôle sur un site précis, et ne voient que ce que ce
 * rôle demande — non par méfiance, mais parce qu'un écran qui montre tout
 * noie le travail de chacun.
 *
 * Le rôle vit sur le membre, jamais sur le compte : la même personne peut
 * être gérante ici et responsable des commandes ailleurs.
 */

/**
 * Un role sur un site.
 *
 * `aucun` n'est pas un poste : c'est la reponse donnee a qui n'en a pas.
 *
 * Elle existe parce que `null` en disait deux choses a la fois — « aucune
 * restriction », qui est le proprietaire, et « pas de membre trouve », qui
 * est l'inverse. Un compte etranger au site, ou une lecture qui echoue,
 * obtenait donc les pleins pouvoirs : toutes les fonctions `peut*`
 * commencent par `role === null`, et lui repondaient oui.
 *
 * `aucun` ne figure dans aucune table de permission, donc il ne peut rien
 * par construction. C'est la bonne reponse a « je ne sais pas », et elle
 * ne se confond avec rien.
 */
export type RoleSite =
  'gerant' | 'recouvrement' | 'commandes' | 'caissier' | 'aucun';

export interface Membre {
  id: string;
  siteId: string;
  /** l'activité dont dépend le site ; évite de la relire pour filtrer */
  activiteId: string;
  /** le compte Firebase, posé quand la personne s'est inscrite */
  compteUid?: string | null;
  /** l'adresse par laquelle on l'invite, avant qu'elle ait un compte */
  email: string;
  nom: string;
  role: RoleSite;
  /** l'employé correspondant, quand il en existe un */
  employeId?: string | null;
  actif: boolean;
  createdAt?: any;
}

export const LIBELLES_ROLE: Record<RoleSite, string> = {
  gerant: 'Gérant',
  recouvrement: 'Recouvrements',
  commandes: 'Commandes',
  caissier: 'Caisse',
  /* Pas un poste : la reponse donnee a qui n'en a pas. Elle ne s'affiche
     dans aucune liste de choix, mais le type exige qu'elle ait un nom. */
  aucun: 'Aucun acces',
};

export const DESCRIPTIONS_ROLE: Record<RoleSite, string> = {
  gerant: 'Responsable du site : tout ce que voit le propriétaire.',
  recouvrement: 'Partenaires et recouvrements.',
  commandes: 'Achats et ventes, entrées et sorties.',
  caissier: 'Entrées et sorties de fonds.',
  aucun: "Ce compte n'a pas de poste sur ce site.",
};

/**
 * Les onglets qu'un rôle ouvre.
 *
 * L'admin n'y figure pas : il entre partout. Le gérant voit tout son site,
 * sauf la configuration — elle touche à l'existence du site, pas à son
 * exploitation.
 */
const ONGLETS_PAR_ROLE: Record<RoleSite, string[] | null> = {
  /* Le gérant décide des mouvements mais n'ouvre pas le tiroir : « Mes
     remises » lui dit où en sont ses déclarations, sans lui donner le droit
     de les autoriser lui-même. */
  gerant: [
    'dashboard', 'fonds', 'partenaires', 'recouvrements', 'employes',
    'cycle-vente', 'achats', 'transferts', 'retours', 'inventaire',
    'mouvements-stock', 'historique', 'remises', 'audit',
  ],
  /* Il ne voit pas le fond de caisse — ce tiroir n'est pas le sien — mais
     il doit savoir ce qu'il porte : « Mes remises » dit ce qu'il a encaissé
     et que la caisse n'a pas encore confirmé. */
  recouvrement: ['partenaires', 'recouvrements', 'remises'],
  /* Il reçoit et déclare la marchandise : les transferts le concernent
     autant que les achats. Il charge ce qui part, il compte ce qui arrive —
     il n'initie rien et n'arbitre aucun écart. */
  /* Les retours défont ce qu'il a reçu ou expédié : c'est la même
     marchandise, le même geste à l'envers. Il les traite sans les ouvrir
     — décider qu'une marchandise repart éteint une dette ou fait sortir
     de l'argent, et cela revient à qui répond du site. */
  /* Le mouvement de stock suit la même règle que le retour : le gérant
     déclare ce qui manque, le responsable va compter au rayon et
     confirme. Sans cet onglet il ne verrait jamais ce qu'on lui demande
     de constater. */
  commandes: [
    'cycle-vente', 'achats', 'transferts', 'retours', 'mouvements-stock',
  ],
  /* Trois écrans pour un seul métier : ce qu'il y a dans le tiroir, ce qui
     y est passé, ce qui attend d'y entrer. Le caissier travaille au
     téléphone et ne fait que cela : empilés sur une page, le registre
     commençait hors champ et la file se perdait dessous.
     Les autres rôles gardent tout sous « Fonds de caisse » — pour eux la
     caisse est une partie du travail, pas le travail. */
  caissier: ['fonds', 'mouvements', 'autorisations'],
  /* Aucun onglet, et c'est volontaire : un compte sans poste ici ne doit
     rien ouvrir. La liste vide est ce qui rend ce role inoffensif. */
  aucun: [],
};

/**
 * Qui peut distribuer les rôles d'un site.
 *
 * Le gérant est responsable de son site : c'est lui qui sait de qui il a
 * besoin, pas l'admin depuis l'extérieur. L'admin garde le droit, étant
 * partout chez lui.
 */
export function peutGererMembres(role: RoleSite | null): boolean {
  return role === null || role === 'gerant';
}

/**
 * Ouvrir un compte partenaire, ou ranger les partenaires par catégorie.
 *
 * Inscrire un client ou un fournisseur engage le site sur une relation
 * commerciale : à qui vend-on à crédit, chez qui s'approvisionne-t-on.
 * C'est une décision, pas une écriture.
 *
 * Le responsable des recouvrements travaille sur des dettes déjà nées : il
 * relance, il encaisse, il constate. Il n'a pas à choisir avec qui la
 * maison commerce — et les catégories, qui ordonnent ce fichier, relèvent
 * du même choix.
 */
export function peutGererPartenaires(role: RoleSite | null): boolean {
  return role === null || role === 'gerant';
}

/**
 * Fixer un calendrier de recouvrement.
 *
 * Décider qu'un client remboursera en trois fois sur deux mois engage le
 * site : c'est accorder un crédit, et sur quelles modalités. Le modèle par
 * défaut, qui vaut pour tous les partenaires, engage plus encore.
 *
 * Le chargé de recouvrement applique ce calendrier — il relance, il
 * encaisse, il constate. Le fixer lui-même reviendrait à se donner les
 * délais qu'il aura ensuite à faire respecter.
 */
export function peutPlanifierRecouvrement(role: RoleSite | null): boolean {
  return role === null || role === 'gerant';
}

/**
 * Qui règle un fournisseur.
 *
 * Recouvrer et payer sont deux métiers opposés. Le chargé de recouvrement
 * applique un calendrier déjà fixé : la dette existe, la date est écrite,
 * il va chercher l'argent. Régler un fournisseur, c'est arbitrer une
 * trésorerie — payer celui-ci maintenant ou attendre la rentrée de jeudi.
 * C'est une décision, et elle revient à qui répond du site.
 *
 * Il y a une raison plus dure que le partage des tâches : celui qui
 * encaisse ne décaisse pas. Pouvant les deux, il prendrait 50 000 chez un
 * client et déclarerait un règlement fournisseur de 50 000 qui n'a pas
 * lieu — les deux écritures s'annulent, le solde reste juste, et rien ne
 * se voit.
 */
export function peutReglerFournisseur(role: RoleSite | null): boolean {
  /* Defini par exclusion : il faut donc nommer `aucun`, qui n'est pas un
     poste mais la reponse donnee a qui n'en a pas. Sans cela un compte
     sans acces passerait, puisqu'il n'est pas du recouvrement. */
  return role !== 'recouvrement' && role !== 'aucun';
}

/**
 * Qui décide de la façon dont une dette sera réglée.
 *
 * Poser une échéance, c'est engager l'argent du site à une date : une
 * décision de trésorerie, pas un geste de manutention.
 *
 * Le responsable des commandes fait avancer la marchandise — il reçoit,
 * il compte, il expédie. L'écran le lui demandait pourtant dès qu'il
 * ouvrait un achat confirmé, et il se trouvait devant un dossier de
 * dette qu'il n'a ni à voir ni à trancher. Le recouvrement, lui,
 * encaisse ce qui est dû ; il ne fixe pas non plus les termes.
 */
export function peutPlanifierReglement(role: RoleSite | null): boolean {
  return role === null || role === 'gerant';
}

/**
 * Qui dispose du capital de l'activité.
 *
 * Un apport et un retrait ne sont pas des mouvements d'exploitation : le
 * propriétaire met de l'argent dans son activité, ou il en sort. C'est une
 * décision sur son capital.
 *
 * Le caissier tient le tiroir — il ne peut pas déclarer à la place du
 * propriétaire que celui-ci a fait un apport. Il recevra l'argent et le
 * confirmera, comme tout ce qu'on lui remet ; c'est le gérant ou le
 * propriétaire qui l'annonce.
 *
 * Restent au caissier les mouvements qui naissent au tiroir même : les
 * frais payés en espèces, et les écarts qu'il constate en comptant.
 */
export function peutDisposerDuCapital(role: RoleSite | null): boolean {
  /* Le propriétaire seul, pas le gérant.
   *
   * Un apport et un retrait ne sont pas des gestes d'exploitation : ils
   * font entrer ou sortir le capital de l'activité. Celui qui dirige un
   * site en répond devant celui à qui cet argent appartient — lui laisser
   * sortir des fonds, c'est lui laisser décider de ce qui n'est pas à
   * lui.
   *
   * La trace suit le droit : un retrait porte le nom du propriétaire
   * parce que lui seul a pu le faire. */
  return role === null;
}

/**
 * Qui déclare un mouvement de caisse.
 *
 * Un mouvement est un acte voulu : quelqu'un a décidé de payer le
 * transporteur, de sortir de la marchandise, de faire un apport. Il a un
 * auteur, une intention, et il pouvait ne pas avoir lieu.
 *
 * Le caissier n'est pas cet auteur. Il tient le tiroir : il reçoit ce
 * qu'on lui remet, il délivre ce qu'on lui demande. S'il pouvait déclarer
 * lui-même une dépense puis l'autoriser, il sortirait de l'argent sans que
 * personne ne l'ait voulu — et la file d'attente ne prouverait plus rien,
 * puisqu'il y déposerait ses propres lignes pour les signer.
 *
 * La ligne n'est pas le grade, c'est la place : déclare celui qui n'est pas
 * au tiroir. Ce que le caissier garde, c'est le constat — l'écart qu'il
 * trouve en comptant, que personne d'autre ne peut voir à sa place.
 */
export function peutDeclarerMouvement(role: RoleSite | null): boolean {
  /* Meme raison qu'au reglement fournisseur : une regle par exclusion
     laisse passer tout ce qu'elle n'a pas nomme. */
  return role !== 'caissier' && role !== 'aucun';
}

/**
 * Qui annule un mouvement de caisse.
 *
 * Annuler n'efface rien : cela écrit le mouvement inverse, et les deux
 * lignes restent. C'est donc déclarer un mouvement de plus — une sortie
 * pour neutraliser une entrée, une entrée pour neutraliser une sortie.
 *
 * Le caissier ne le fait pas, pour la même raison qu'il ne déclare pas :
 * il pourrait sortir de l'argent en contre-passant une entrée qu'il vient
 * lui-même d'autoriser. Il constate une erreur, il ne la corrige pas seul.
 */
export function peutAnnulerMouvement(role: RoleSite | null): boolean {
  return peutDeclarerMouvement(role);
}

/**
 * Qui fait bouger l'argent du tiroir.
 *
 * Décider d'un mouvement et le faire sont deux gestes. Le gérant vend, le
 * chargé de recouvrement encaisse, quelqu'un décide de payer un
 * fournisseur — mais c'est le responsable de la caisse qui ouvre le tiroir,
 * et lui seul en répond.
 *
 * Il n'y a pas d'exception : une caisse dont le décideur autorise ses
 * propres écritures ne prouve plus rien, et c'est justement ce que la file
 * d'attente établit.
 */
export function peutAutoriserCaisse(role: RoleSite | null): boolean {
  return role === 'caissier';
}

/** Le site a-t-il quelqu'un pour tenir sa caisse ? */
export async function aUnCaissier(siteId: string): Promise<boolean> {
  const connu = caissiersConnus.get(siteId);
  if (connu) return connu;

  const p = getDocs(query(
    collection(db, 'membres'),
    where('siteId', '==', siteId),
    where('role', '==', 'caissier')))
    .then(snap => snap.docs.some(d => (d.data() as Membre).actif !== false))
    .catch(e => { caissiersConnus.delete(siteId); throw e; });

  caissiersConnus.set(siteId, p);
  return p;
}

/**
 * Personne d'autre ne peut fermer ce dossier.
 *
 * Le cycle d'un mouvement de stock demande deux mains : l'une déclare,
 * l'autre compte et confirme — et la seconde est le responsable des
 * commandes. C'est ce qui empêche qu'un seul homme fasse disparaître ce
 * qu'il veut, et cela n'a de sens que si cette seconde main existe.
 *
 * Deux cas où elle n'existe pas, et c'est le même mur :
 *
 *   - le commerce n'a qu'un compte ;
 *   - il en a plusieurs, mais aucun ne porte le rôle « commandes ».
 *
 * Dans les deux, le dossier reste ouvert pour toujours. Il faudrait
 * inventer un compte, ou se donner un rôle qu'on n'exerce pas, pour
 * fermer ce qu'on a soi-même ouvert — et le registre dirait alors deux
 * personnes là où il n'y en a qu'une. Mieux vaut qu'il dise la vérité :
 * c'est le propriétaire, seul, et son nom s'inscrit.
 *
 * Dès qu'un responsable des commandes est nommé, la règle revient
 * d'elle-même, sans rien changer nulle part.
 *
 * La réponse se garde le temps de la session : la question se pose
 * devant chaque bouton d'un dossier, et elle ne change pas entre deux
 * clics.
 */
const seulsConnus = new Map<string, Promise<boolean>>();

export async function estSeulAuCommerce(
  siteId: string, userId: string,
): Promise<boolean> {
  const cle = `${siteId}:${userId}`;
  const connu = seulsConnus.get(cle);
  if (connu) return connu;

  const p = getDocs(query(
    collection(db, 'membres'), where('siteId', '==', siteId)))
    .then(snap => !snap.docs.some(d => {
      const m = d.data() as Membre;
      /* Celui qui pourrait confirmer à ma place : un autre compte,
         actif, et qui tient les commandes. Un membre invité mais pas
         encore inscrit n'a pas de compte — il ne confirme rien, il ne
         compte donc pas encore. */
      return m.actif !== false
        && !!m.compteUid && m.compteUid !== userId
        && m.role === 'commandes';
    }))
    /* Sans réponse — hors ligne, lecture refusée — on ne desserre
       rien : mieux vaut un bouton qui refuse qu'une confirmation
       qu'on n'aurait pas dû pouvoir donner. */
    .catch(() => { seulsConnus.delete(cle); return false; });

  seulsConnus.set(cle, p);
  return p;
}

/** Oublier la réponse : un membre vient d'arriver ou de partir. */
export function oublierSeulAuCommerce(): void {
  seulsConnus.clear();
}

/** Les onglets visibles. `null` en rôle veut dire admin : tout est ouvert. */
export function ongletsDuRole(role: RoleSite | null, tous: string[]): string[] {
  if (!role) return tous;
  const permis = ONGLETS_PAR_ROLE[role];
  if (!permis) return tous;
  /* L'ordre reste celui de la barre : un rôle ne réorganise pas l'app. */
  return tous.filter(o => permis.includes(o));
}

/** Un onglet est-il ouvert à ce rôle ? */
export function ongletAutorise(role: RoleSite | null, onglet: string): boolean {
  if (!role) return true;
  const permis = ONGLETS_PAR_ROLE[role];
  return !permis || permis.includes(onglet);
}

/** Les membres d'un site. */
export async function membresDuSite(siteId: string): Promise<Membre[]> {
  const snap = await getDocs(query(
    collection(db, 'membres'), where('siteId', '==', siteId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Membre))
    .sort((a, b) => a.nom.localeCompare(b.nom));
}

/**
 * Le rôle d'un compte sur un site.
 *
 * `null` veut dire « aucune restriction », et une seule chose peut le
 * valoir : etre l'admin de l'activite — ce que dit `adminUid`, verifie
 * contre le document de l'activite.
 *
 * Un compte qu'aucun membre ne designe recoit `aucun`, pas `null`. Les
 * deux se confondaient, et toutes les fonctions `peut*` commencent par
 * `role === null` : un etranger au site, ou une lecture qui echoue,
 * obtenait les pleins pouvoirs. On ne ferme jamais une porte par
 * accident, mais on n'en ouvre pas une par ignorance.
 */
/**
 * Ce qu'on a déjà demandé aux `membres`, le temps de la session.
 *
 * Le rôle de qui agit et la présence d'un caissier se lisent avant chaque
 * écriture en caisse — donc à chaque versement, à chaque vente. Ni l'un
 * ni l'autre ne change entre deux gestes : les redemander posait deux
 * attentes devant chaque bouton, pour la même réponse.
 *
 * On retient la promesse, pas seulement la réponse : deux appels lancés
 * en même temps — ce qui arrive, `ecrireEnCaisse` les met en parallèle —
 * partagent alors la même requête au lieu d'en faire deux.
 *
 * `oublierRoles` vide tout dès qu'une équipe change.
 */
const rolesConnus = new Map<string, Promise<RoleSite | null>>();
const caissiersConnus = new Map<string, Promise<boolean>>();

/** Oublie ce qui a été retenu : l'équipe d'un site a changé. */
export function oublierRoles(): void {
  rolesConnus.clear();
  caissiersConnus.clear();
}

export async function roleSurSite(
  uid: string, siteId: string, adminUid?: string | null,
): Promise<RoleSite | null> {
  if (adminUid && uid === adminUid) return null;

  const cle = `${siteId}:${uid}`;
  const connu = rolesConnus.get(cle);
  if (connu) return connu;

  const p = getDocs(query(
    collection(db, 'membres'),
    where('siteId', '==', siteId),
    where('compteUid', '==', uid)))
    .then(snap => snap.docs
      .map(d => d.data() as Membre)
      /* Aucun membre actif : ce compte n'a pas de poste ici. Rendre
         `null` le ferait passer pour le proprietaire — c'est ce que
         `null` veut dire partout ailleurs. */
      .find(m => m.actif !== false)?.role ?? 'aucun')
    .catch(e => {
      /* Un échec ne se retient pas : le garder condamnerait l'écran
         jusqu'au rechargement de la page. */
      rolesConnus.delete(cle);
      throw e;
    });

  rolesConnus.set(cle, p);
  return p;
}

/**
 * Les sites où un compte travaille.
 *
 * Sert à l'écran des sites : un gérant ne doit voir que le sien, pas toute
 * l'activité.
 */
export async function sitesDuCompte(uid: string): Promise<string[]> {
  const snap = await getDocs(query(
    collection(db, 'membres'), where('compteUid', '==', uid)));
  return snap.docs
    .map(d => d.data() as Membre)
    .filter(m => m.actif !== false)
    .map(m => m.siteId);
}

/**
 * Les postes d'un compte : où il travaille, et à quel titre.
 *
 * `sitesDuCompte` ne rend que des identifiants — assez pour ouvrir un
 * écran, pas pour se dire à quelqu'un. Ici on garde la fiche entière :
 * une personne doit pouvoir vérifier sous quel rôle elle agit, et sur
 * quel site, sans avoir à le demander à son gérant.
 */
export async function postesDuCompte(uid: string): Promise<Membre[]> {
  const snap = await getDocs(query(
    collection(db, 'membres'), where('compteUid', '==', uid)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Membre))
    .filter(m => m.actif !== false);
}

export async function inviterMembre(saisie: {
  siteId: string; activiteId: string;
  email: string; nom: string; role: RoleSite;
  employeId?: string | null;
}): Promise<string> {
  const email = saisie.email.trim().toLowerCase();
  if (!email) throw new Error('Une adresse est nécessaire.');

  /* Deux membres sur le même site avec la même adresse se contrediraient :
     lequel des deux rôles s'appliquerait ? */
  const existant = await getDocs(query(
    collection(db, 'membres'),
    where('siteId', '==', saisie.siteId),
    where('email', '==', email)));
  if (!existant.empty) throw new Error('Cette adresse a déjà un rôle sur ce site.');

  const ref = await addDoc(collection(db, 'membres'), {
    siteId: saisie.siteId,
    activiteId: saisie.activiteId,
    email,
    nom: saisie.nom.trim(),
    role: saisie.role,
    employeId: saisie.employeId ?? null,
    /* Le compte n'existe pas encore : il se rattache à la première connexion. */
    compteUid: null,
    actif: true,
    createdAt: serverTimestamp(),
  });
  /* Inviter quelqu'un change l'équipe : un caissier a pu apparaître, et
     c'est lui qui décide si l'argent passe par une file d'attente. */
  oublierRoles();
  return ref.id;
}

/* La signature retenue en mémoire porte le rôle : la changer sans
   l'oublier ferait signer les gestes suivants de l'ancienne fonction. */
export async function changerRole(membreId: string, role: RoleSite): Promise<void> {
  await updateDoc(doc(db, 'membres', membreId), { role });
  oublierAuteur();
  oublierRoles();
}

export async function basculerMembre(membreId: string, actif: boolean): Promise<void> {
  await updateDoc(doc(db, 'membres', membreId), { actif });
  oublierAuteur();
  oublierRoles();
}

export async function retirerMembre(membreId: string): Promise<void> {
  await deleteDoc(doc(db, 'membres', membreId));
  oublierAuteur();
  oublierRoles();
}

/**
 * Rattache un compte fraîchement connecté aux invitations à son adresse.
 *
 * L'invitation se pose avant que la personne existe. À sa première connexion,
 * on pose son identifiant sur les membres qui portent son adresse — c'est lui
 * qui servira ensuite, l'adresse pouvant changer.
 */
export async function rattacherCompte(
  uid: string, email: string,
): Promise<{ nb: number; activiteId: string | null }> {
  const snap = await getDocs(query(
    collection(db, 'membres'),
    where('email', '==', email.trim().toLowerCase())));

  const aPoser = snap.docs.filter(d => !(d.data() as Membre).compteUid);

  /**
   * L'invitation devient un membre nommé.
   *
   * On invite une adresse avant que la personne ait un compte : à cet
   * instant l'identifiant définitif — {siteId}_{uid} — ne peut pas
   * exister. Il se pose ici, à la première connexion, quand les deux
   * moitiés sont enfin connues.
   *
   * Ce nom n'est pas une coquetterie : c'est ce qui permet au serveur de
   * vérifier où travaille un caissier. Une règle Firestore ne requête
   * pas, elle lit un document dont elle connaît le chemin — et ce chemin
   * se déduit du site et du compte. Sans cela, le site reste invisible au
   * serveur, qui ne peut alors empêcher personne d'écrire à côté.
   */
  await Promise.all(aPoser.map(async d => {
    const m = d.data() as Membre;
    const cle = `${m.siteId}_${uid}`;
    if (d.id === cle) {
      await updateDoc(doc(db, 'membres', d.id), { compteUid: uid });
      return;
    }
    /* Recopié sous son vrai nom, puis l'invitation disparaît. Si la copie
       échoue, l'invitation reste : on réessaiera à la prochaine
       connexion, ce qui vaut mieux qu'un membre perdu entre les deux. */
    await setDoc(doc(db, 'membres', cle), { ...m, compteUid: uid });
    await deleteDoc(doc(db, 'membres', d.id));
  }));

  /* Le rattachement pose le `compteUid` — celui-là même que `roleSurSite`
     interroge. Sans oubli, la session garderait le « aucun rôle » lu
     avant que l'invitation ne devienne un membre. */
  if (aPoser.length > 0) oublierRoles();

  /**
   * Ce que ce compte a, une fois le rattachement fait.
   *
   * On ne compte pas ce qu'on vient de poser, mais ce qui existe : un
   * rattachement réussi puis une inscription interrompue laissait un
   * membre bien accroché et un profil manquant. La connexion suivante
   * rappelait cette fonction, ne trouvait plus d'invitation à poser —
   * elles l'étaient déjà — et concluait « personne ne l'a invité ».
   * L'employé devenait propriétaire, pour avoir réussi du premier coup.
   */
  const miens = await getDocs(query(
    collection(db, 'membres'), where('compteUid', '==', uid)));
  const actifs = miens.docs
    .map(d => d.data() as Membre)
    .filter(m => m.actif !== false);

  /**
   * Le membre hérite de l'activité où il travaille.
   *
   * Presque toutes les règles demandent « de quelle maison es-tu ? », et
   * la réponse se lit sur le profil. Un membre qui n'en portait pas se
   * voyait refuser chaque lecture : il était bien inscrit sur un site,
   * mais le serveur ne pouvait pas le rattacher à une activité, donc ne
   * lui ouvrait rien. Il arrivait devant un écran vide.
   *
   * L'invitation porte l'activité — c'est le gérant qui l'a posée. On la
   * recopie sur le compte, là où les règles savent la lire.
   */
  /* On la rend plutôt que de l'écrire : à l'inscription, le profil
     n'existe pas encore, et l'écrire ici créerait un document que le
     profil complet écraserait aussitôt. C'est à celui qui écrit le
     profil de la porter. */
  return {
    nb: actifs.length,
    activiteId: actifs.find(m => m.activiteId)?.activiteId ?? null,
  };
}
