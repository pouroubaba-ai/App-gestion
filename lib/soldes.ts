import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { valeurVente } from './flux-marchandise';
import { lireParSite, type Portee } from '@/lib/portee';
import { totalImportation } from './importations';
import { estOuverture, valeurDossier } from './ouverture';

/**
 * Ce que chaque tiers doit, déduit et non stocké.
 *
 * La dette d'un fournisseur était écrite sur sa fiche à la confirmation d'un
 * achat. Ce nombre vivait ensuite seul : supprimer l'achat le laissait
 * intact, et rien ne signalait qu'il ne correspondait plus à rien. Le même
 * piège guettait la créance, le versé et le reste.
 *
 * Une dette est la somme des restes des documents non soldés. Cette somme
 * existe déjà dans les documents ; l'en recopier ailleurs crée une seconde
 * vérité qui finit par diverger de la première. On la calcule.
 *
 * Toutes les vues — cartes comme tableaux — passent par ici : deux calculs
 * parallèles finiraient par afficher deux chiffres différents.
 */

export type RoleTiers = 'client' | 'fournisseur';

export interface SoldeTiers {
  partenaireId: string;
  /** valeur de ce qui a été reçu ou livré */
  total: number;
  /**
   * Ce qui a été versé là-dessus : de l'argent, et rien d'autre.
   *
   * Un retour de marchandise éteint une dette sans qu'un franc ne
   * circule. Le compter ici ferait croire que le tiers a payé, et l'on
   * réclamerait moins qu'on n'a encaissé.
   */
  verse: number;
  /** ce que la marchandise rendue a éteint, sans argent */
  retour: number;
  /** ce qui reste dû ; jamais négatif */
  reste: number;
  /** la date du dernier document, pour dire si le compte est encore vivant */
  derniereOperation: string | null;
  /* Ce que pesait ce jour-là : une date seule ne dit pas si l'opération
     comptait. Plusieurs dossiers du même jour se cumulent — sans heure sur
     les dossiers, le jour est la plus petite unité qu'on puisse départager. */
  derniereValeur: number;
  /** nombre de documents non soldés */
  ouverts: number;
}

export interface SoldesParRole {
  fournisseur: Map<string, SoldeTiers>;
  client: Map<string, SoldeTiers>;
}

function vide(partenaireId: string): SoldeTiers {
  return {
    partenaireId, total: 0, verse: 0, retour: 0, reste: 0,
    derniereOperation: null, derniereValeur: 0, ouverts: 0,
  };
}

/**
 * Un achat ne pèse sur la dette qu'une fois confirmé : tant que la
 * marchandise n'est pas reçue, on ne doit rien. Une vente pareillement, à la
 * livraison.
 */
export function conclu(doc: any, role: RoleTiers): boolean {
  /* Le bon de commande d'un ordre n'est pas une vente.
   *
   * Un ordre tient deux dossiers de vente : celui du site qui expédie,
   * et celui du site qui facture. Seul le second porte un client et une
   * créance — le premier est un ordre de travail, il dit au magasinier
   * quoi rassembler et à qui remettre.
   *
   * Les deux portant le même montant, les compter tous les deux doublait
   * tout : la vente, le reste à encaisser, le chiffre d'affaires. Une
   * seule marchandise facturée une fois apparaissait deux fois.
   *
   * Il se reconnaît à `ordre` — seul le dossier de la source le porte —
   * et il n'a d'ailleurs pas de `clientId`, puisque le client est à
   * l'autre bout. */
  if (doc?.ordre === true) return false;
  return role === 'fournisseur'
    ? doc.etat === 'confirme'
    : doc.etat === 'livre';
}

function cumuler(
  cible: Map<string, SoldeTiers>,
  partenaireId: string,
  total: number,
  verse: number,
  date: string | null,
  retour = 0,
) {
  const e = cible.get(partenaireId) ?? vide(partenaireId);
  /* Les deux éteignent la dette, mais on ne les confond pas : l'un est
     de l'argent reçu, l'autre de la marchandise revenue. */
  const reste = Math.max(0, total - verse - retour);
  /* Le payé est borné à ce qui couvre encore cette facture.
   *
   * Versé 15 000 puis rendu pour 10 000 sur une facture de 20 000 : les
   * deux additionnés font 25 000, et la carte annonçait plus que le
   * total. Les 5 000 de trop ont été remboursés ou reportés sur
   * d'anciennes dettes — ils ne sont plus sur cette facture, mais cette
   * carte-ci ne peut pas savoir où ils sont allés.
   *
   * On borne donc le payé, pas le retour : la marchandise rendue est un
   * fait entier, tandis que l'argent, lui, a pu repartir. Rien n'est
   * caché pour autant — le remboursement laisse un mouvement de caisse,
   * la répartition laisse des versements sur les factures qu'elle a
   * éteintes. Ils se lisent là où ils sont, pas ici. */
  const verseVu = Math.min(verse, Math.max(0, total - retour));
  cible.set(partenaireId, {
    partenaireId,
    total: e.total + total,
    verse: e.verse + verseVu,
    retour: e.retour + retour,
    reste: e.reste + reste,
    derniereOperation: !date ? e.derniereOperation
      : !e.derniereOperation || date > e.derniereOperation ? date : e.derniereOperation,
    derniereValeur: !date ? e.derniereValeur
      : !e.derniereOperation || date > e.derniereOperation ? total
      : date === e.derniereOperation ? e.derniereValeur + total
      : e.derniereValeur,
    ouverts: e.ouverts + (reste > 0 ? 1 : 0),
  });
}

/** Les soldes de tous les tiers d'un site, des deux côtés. */
export async function soldesDuSite(siteId: Portee): Promise<SoldesParRole> {
  return (await soldesEtVentilation(siteId)).ensemble;
}

/**
 * Les mêmes soldes, plus leur ventilation site par site.
 *
 * Le tableau de bord veut les deux : le total de la portée, et la
 * créance de chaque site pour sa colonne. Il les obtenait en appelant
 * `soldesDuSite` une fois sur l'ensemble, puis une fois par site — soit
 * sept collections relues autant de fois qu'il y a de sites, alors que
 * les mêmes documents venaient d'arriver. Sur trois sites, cela faisait
 * vingt-huit lectures là où sept suffisent, et l'onglet mettait
 * plusieurs secondes à s'ouvrir.
 *
 * On ne pouvait pas ventiler après coup : `soldesDuSite` agrège par
 * partenaire et perd le site en chemin, et le reste dû se borne dossier
 * par dossier — `max(0, total − versé − retour)` ne se redéduit pas
 * d'une somme. La ventilation doit donc se faire au moment du cumul,
 * sur les mêmes documents. C'est ce que fait cette fonction : une
 * lecture, deux cumuls.
 */
export async function soldesEtVentilation(siteId: Portee): Promise<{
  ensemble: SoldesParRole;
  parSite: Map<string, SoldesParRole>;
}> {
  /* Une importation est un achat : elle fait entrer la même marchandise
     et crée la même dette chez le même fournisseur. Elle vit seulement
     dans une autre collection, parce que son voyage a ses étapes. Ne pas
     la lire ici laissait un conteneur confirmé peser zéro. */
  const [achDocs, impDocs, venDocs, parRetour] = await Promise.all([
    lireParSite('achats', siteId),
    lireParSite('importations', siteId).catch(() => []),
    lireParSite('ventes', siteId),
    retoursParDossier(siteId),
  ]);

  const fournisseur = new Map<string, SoldeTiers>();
  const client = new Map<string, SoldeTiers>();

  /* Le même cumul, répété sur le seau du site d'où vient le dossier. Un
     document sans `siteId` ne tombe dans aucun seau : il compte dans
     l'ensemble, et aucune colonne ne se l'attribue à tort. */
  const parSite = new Map<string, SoldesParRole>();
  const seau = (id: unknown): SoldesParRole | null => {
    if (typeof id !== 'string' || !id) return null;
    let s = parSite.get(id);
    if (!s) { s = { fournisseur: new Map(), client: new Map() }; parSite.set(id, s); }
    return s;
  };

  for (const d of achDocs) {
    const a = d.data() as any;
    if (!a.fournisseurId || !conclu(a, 'fournisseur')) continue;
    /* `avanceVersee` ne porte que de l'argent : un retour n'y entre
       plus. Le retirer une seconde fois le comptait deux fois. */
    const parRet = parRetour.get(d.id) ?? 0;
    /* Frais compris : le transport est dû au même fournisseur, et
       l'omettre soldait un dossier qu'il restait à payer. */
    const dateA = a.dateConfirmation ?? a.dateReception ?? a.dateCommande ?? null;
    const valA = valeurDossier(a, 'fournisseur');
    cumuler(fournisseur, a.fournisseurId, valA, a.avanceVersee ?? 0, dateA, parRet);
    const sA = seau(a.siteId);
    if (sA) cumuler(sA.fournisseur, a.fournisseurId, valA, a.avanceVersee ?? 0, dateA, parRet);
  }

  for (const d of impDocs) {
    const i = d.data() as any;
    if (!i.fournisseurId || i.etat !== 'confirme') continue;
    const parRet = parRetour.get(d.id) ?? 0;
    const dateI = i.dates?.confirme ?? i.dates?.recu ?? i.dates?.en_attente ?? null;
    const valI = totalImportation(i);
    cumuler(fournisseur, i.fournisseurId, valI, i.avanceVersee ?? 0, dateI, parRet);
    const sI = seau(i.siteId);
    if (sI) cumuler(sI.fournisseur, i.fournisseurId, valI, i.avanceVersee ?? 0, dateI, parRet);
  }

  for (const d of venDocs) {
    const v = d.data() as any;
    if (!v.clientId || !conclu(v, 'client')) continue;
    const parRet = parRetour.get(d.id) ?? 0;
    const dateV = v.dateLivraison ?? v.dateCommande ?? null;
    const valV = valeurDossier(v, 'client');
    cumuler(client, v.clientId, valV, v.avanceVersee ?? 0, dateV, parRet);
    const sV = seau(v.siteId);
    if (sV) cumuler(sV.client, v.clientId, valV, v.avanceVersee ?? 0, dateV, parRet);
  }

  return { ensemble: { fournisseur, client }, parSite };
}

/**
 * Ce qu'un retour a imputé sur chaque dossier.
 *
 * La marchandise rendue éteint une dette sans qu'un franc ne circule.
 * Il faut donc la distinguer d'un paiement : confondues, l'une se lit
 * comme l'autre et l'écran annonce un encaissement qui n'a pas eu lieu.
 *
 * Elle se lisait dans les `versements`, sur le motif
 * `retour_marchandise`. Mais le retour s'écrit dans `retours_dossiers`,
 * et il n'y a pas toujours de versement en face — un retour réglé en
 * déduction n'en produit aucun, puisque rien n'est payé. Le dossier
 * restait donc dû en entier : on réclamait son argent à un client qui
 * avait rendu sa marchandise, et le « à encaisser » comptait une somme
 * que plus personne ne devait.
 *
 * On lit donc le retour là où il vit, et le versement reste consulté
 * pour ce qui n'aurait été inscrit que là.
 */
async function retoursParDossier(siteId: Portee): Promise<Map<string, number>> {
  const parDossier = new Map<string, number>();
  const ajouter = (cle: string | null | undefined, montant: number) => {
    if (!cle || !(montant > 0)) return;
    parDossier.set(cle, (parDossier.get(cle) ?? 0) + montant);
  };

  try {
    const docs = await lireParSite('retours_dossiers', siteId);
    for (const d of docs) {
      const r = d.data() as any;
      /* Un retour annoncé n'a rien éteint : tant qu'il n'est pas reçu,
         la marchandise peut ne jamais revenir, et la dette tient. */
      if (r.etat !== 'recu' && r.etat !== 'livre' && r.etat !== 'traite') continue;
      /* `deduit` est ce que la marchandise a effacé de la dette ; ce qui
         a été remboursé en argent n'entre pas ici — ce versement-là est
         un vrai paiement, et il est déjà compté comme tel. */
      ajouter(r.venteId ?? r.achatId, r.deduit ?? 0);
    }
  } catch {
    /* Sans les retours on ne sait pas séparer : mieux vaut une dette
       trop large qu'un écran vide — on ne réclame jamais moins qu'on ne
       doit, on réclame seulement trop longtemps. */
  }

  /* Les retours inscrits en versement et nulle part ailleurs : une
     imputation posée à la main, ou un dossier d'avant cette écriture.
     Le dédoublonnage se fait par dossier — on garde le plus grand des
     deux plutôt que de les additionner, deux lectures du même retour
     éteindraient la dette deux fois. */
  try {
    const docs = await lireParSite('versements', siteId);
    const parVersement = new Map<string, number>();
    for (const d of docs) {
      const v = d.data() as any;
      if (v.motif !== 'retour_marchandise') continue;
      const cle = v.achatId ?? v.venteId;
      if (!cle) continue;
      parVersement.set(cle, (parVersement.get(cle) ?? 0) + (v.montant ?? 0));
    }
    for (const [cle, montant] of parVersement) {
      if (montant > (parDossier.get(cle) ?? 0)) parDossier.set(cle, montant);
    }
  } catch {
    /* rien de plus à ajouter : le dossier de retour fait déjà foi */
  }

  return parDossier;
}

/**
 * Ce qui reste dû, vente par vente, avec la date de chacune.
 *
 * Le total des créances dit ce que les tiers doivent en tout. Sur un
 * tableau de bord filtré, la question est autre : des ventes de cette
 * période, combien reste-t-il à encaisser ? Les deux chiffres diffèrent,
 * et les confondre faisait afficher « Ventes 0 · À encaisser 16 000 »
 * pour une journée sans la moindre vente.
 *
 * Un retour de marchandise éteint la dette sans qu'un franc ne rentre :
 * il est retiré du versé ailleurs, mais ici il réduit bien le reste — ce
 * qui n'est plus dû n'est plus à encaisser.
 */
export async function restesDesVentes(
  siteId: Portee,
): Promise<{ date: string | null; reste: number; siteId: string | null }[]> {
  /* Ce que les retours ont deja eteint, par dossier.
   *
     Le commentaire au-dessus promettait que le retour reduit le reste —
     et rien ne le faisait. Un client qui rendait toute sa marchandise
     restait debiteur de son montant entier : la carte « A encaisser »
     annoncait 55 000 pour une vente integralement rendue, et le
     proprietaire reclamait de l'argent a quelqu'un qui ne devait plus
     rien. `soldesDuSite` lisait deja ces retours ; cette fonction-ci,
     non. Deux ecrans comptaient la meme dette differemment. */
  const [docs, parRetour] = await Promise.all([
    lireParSite('ventes', siteId),
    retoursParDossier(siteId),
  ]);
  return docs
    .map(d => {
      const v = d.data() as any;
      if (!conclu(v, 'client')) return null;
      /* Une ouverture reporte un compte né ailleurs : ce n'est pas une
         vente de la periode, et son reste n'est pas a encaisser au titre
         des ventes. La compter ici gonflerait « a encaisser » d'un montant
         qu'aucune vente n'a produit. */
      if (estOuverture(v)) return null;
      const total = valeurVente(v.lignes ?? []);
      return {
        date: v.dateLivraison ?? v.dateCommande ?? null,
        reste: Math.max(0,
          total - (v.avanceVersee ?? 0) - (parRetour.get(d.id) ?? 0)),
        siteId: v.siteId ?? null,
      };
    })
    .filter((x): x is { date: string | null; reste: number; siteId: string | null } =>
      x !== null && x.reste > 0);
}

/** Le solde d'un seul tiers, quand la page n'en affiche qu'un. */
export async function soldeTiers(
  siteId: string, partenaireId: string, role: RoleTiers,
): Promise<SoldeTiers> {
  const champ = role === 'fournisseur' ? 'fournisseurId' : 'clientId';
  /* Une importation est un achat : même marchandise, même dette, même
     fournisseur — seulement rangée ailleurs parce que son voyage a ses
     étapes. La liste des soldes la lit déjà ; l'omettre ici faisait dire
     à la fiche d'un tiers tout autre chose qu'à la liste qui y mène. */
  const [snap, impSnap, parRetour] = await Promise.all([
    getDocs(query(
      collection(db, role === 'fournisseur' ? 'achats' : 'ventes'),
      where('siteId', '==', siteId),
      where(champ, '==', partenaireId))),
    role === 'fournisseur'
      ? getDocs(query(
          collection(db, 'importations'),
          where('siteId', '==', siteId),
          where('fournisseurId', '==', partenaireId))).catch(() => null)
      : Promise.resolve(null),
    retoursParDossier(siteId),
  ]);

  const cible = new Map<string, SoldeTiers>();
  for (const d of snap.docs) {
    const x = d.data() as any;
    if (!conclu(x, role)) continue;
    /* Même partage que sur la liste : l'argent d'un côté, la
       marchandise rendue de l'autre. */
    const parRet = parRetour.get(d.id) ?? 0;
    cumuler(cible, partenaireId,
      /* Les frais entrent dans la dette ici aussi : la fiche du tiers
         et la liste des soldes comptaient le même achat différemment. */
      valeurDossier(x, role),
      x.avanceVersee ?? 0,
      role === 'fournisseur'
        ? (x.dateConfirmation ?? x.dateReception ?? x.dateCommande ?? null)
        : (x.dateLivraison ?? x.dateCommande ?? null),
      parRet);
  }

  /* Même règle que sur la liste : seule une importation confirmée pèse
     sur la dette — avant, la marchandise n'est pas encore due. */
  for (const d of impSnap?.docs ?? []) {
    const i = d.data() as any;
    if (i.etat !== 'confirme') continue;
    cumuler(cible, partenaireId,
      totalImportation(i),
      i.avanceVersee ?? 0,
      i.dates?.confirme ?? i.dates?.recu ?? i.dates?.en_attente ?? null,
      parRetour.get(d.id) ?? 0);
  }

  return cible.get(partenaireId) ?? vide(partenaireId);
}

/** Ce que porte un tiers dans un rôle, sans avoir à tester la présence. */
export function soldeDe(
  soldes: SoldesParRole, partenaireId: string, role: RoleTiers,
): SoldeTiers {
  return (role === 'fournisseur' ? soldes.fournisseur : soldes.client)
    .get(partenaireId) ?? vide(partenaireId);
}

/** Le total d'un côté, pour les cartes de tête. */
export function totalRole(soldes: SoldesParRole, role: RoleTiers) {
  const m = role === 'fournisseur' ? soldes.fournisseur : soldes.client;
  const liste = [...m.values()];
  return {
    total: liste.reduce((n, s) => n + s.total, 0),
    verse: liste.reduce((n, s) => n + s.verse, 0),
    retour: liste.reduce((n, s) => n + s.retour, 0),
    reste: liste.reduce((n, s) => n + s.reste, 0),
    ouverts: liste.filter(s => s.reste > 0).length,
    tiers: liste.length,
  };
}
