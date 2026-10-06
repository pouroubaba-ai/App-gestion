# IBD Kunda — guide de test

Ce document décrit l'application telle qu'elle est écrite, pour qu'une
personne qui ne l'a pas développée puisse la tester sans deviner. Il dit
ce que chaque module fait, qui a le droit d'en faire quoi, et quels
parcours doivent être vérifiés avant une mise en ligne.

Les règles ci-dessous sont celles du code, pas des intentions : chaque
affirmation vient de `lib/roles.ts`, `lib/onglets-site.ts` ou
`lib/flux-marchandise.ts`.

---

## 1. Ce qu'est l'application

Un outil de gestion commerciale multi-sites. Une **activité** (une
maison de commerce) possède plusieurs **sites** — un dépôt, des
boutiques. Chaque site tient son stock, sa caisse, ses clients et ses
fournisseurs. Les sites s'échangent de la marchandise par des
**transferts**.

Deux façons de regarder : **par site**, ou en **vue d'ensemble**
(`/ensemble`), qui agrège tous les sites de l'activité. Le sélecteur
« Ensemble / Par site » et le filtre « Site » commandent cette portée.

Technique : Next.js 16, Firebase/Firestore. Les droits sont appliqués
deux fois — à l'écran, et dans `firestore.rules`. **Tester les deux** :
qu'un bouton soit caché ne prouve pas que l'écriture est refusée.

---

## 2. Les rôles

Un compte est rattaché à un site par un document `membres`, qui porte
son rôle. Le **propriétaire** (l'admin de l'activité) n'a pas de rôle :
dans le code son rôle vaut `null`, ce qui signifie « aucune
restriction ».

| Rôle | Métier |
|---|---|
| *(propriétaire)* | Tout, sur tous les sites de son activité |
| `gerant` | Répond du site : décide, engage, mais n'ouvre pas le tiroir |
| `commandes` | Reçoit et remet la marchandise ; ne voit pas les prix |
| `caissier` | Tient la caisse ; autorise ce qui y entre et en sort |
| `recouvrement` | Porte l'argent des clients ; ne décide de rien |

### Onglets visibles par rôle

Défini dans `ONGLETS_PAR_ROLE` (`lib/roles.ts`).

| Rôle | Onglets |
|---|---|
| propriétaire | tous |
| `gerant` | Dashboard, Fonds, Partenaires, Recouvrements, Employés, Cycle de vente, Achats, Transferts, Retours, Inventaire, Mouvements de stock, Historique, Mes remises, Audit |
| `commandes` | Cycle de vente *(intitulé « Bons de commande »)*, Achats, Transferts, Retours, Mouvements de stock |
| `caissier` | Fonds disponible, Mouvements, Autorisations |
| `recouvrement` | Partenaires, Recouvrements, Mes remises |

Deux subtilités à vérifier :

- **« Cycle de vente » s'appelle « Bons de commande » pour `commandes`.**
  Il n'entre qu'après le devis : l'intention ne le concerne pas.
- **« Mouvements » et « Autorisations » n'existent comme onglets que
  pour le caissier.** Les autres rôles y accèdent sous « Fonds
  disponible ».

### Droits par geste

| Geste | Qui |
|---|---|
| Gérer les membres | propriétaire, `gerant` |
| Gérer les partenaires | propriétaire, `gerant` |
| Planifier un recouvrement | propriétaire, `gerant` |
| Planifier un règlement fournisseur | propriétaire, `gerant` |
| Régler un fournisseur | tous **sauf** `recouvrement` |
| Disposer du capital (apport, retrait) | **propriétaire seul** |
| Déclarer un mouvement de caisse | tous **sauf** `caissier` |
| Autoriser un mouvement de caisse | **`caissier` seul** |
| Initier un transfert | **propriétaire seul** |
| Arbitrer un écart de transfert | **propriétaire seul** |
| Expédier / recevoir un transfert | propriétaire, `gerant`, `commandes` |
| Annuler un dossier | propriétaire, `gerant` |
| Confirmer un achat | **`commandes`** (ou propriétaire) |

> **Le piège du `null`.** `role === null` veut dire à la fois « aucune
> restriction » et « pas encore lu ». Les écrans attendent donc un
> drapeau `roleLu` avant de dessiner. **À tester :** recharger une page
> avec un compte restreint et vérifier qu'aucun onglet interdit
> n'apparaît, même un instant.

---

## 3. Les modules

### Cycle de vente

`devis → commande → préparation → prêt → livré` (ou `annulé`).

- Le **devis** ne progresse pas : il se *transforme* en commande, qui
  naît à côté de lui.
- La **préparation** se déclare ligne par ligne (collection
  `preparations`), jamais en bloc. « Marquer prêt » fige ce qui a été
  prélevé.
- La **livraison** est le seul moment où le stock sort et où la créance
  naît. Changer l'état sans passer par `livrerVente` laisserait la
  marchandise en rayon tout en la facturant.

### Achats

`en attente → reçu → en traitement → confirmé`.

La **confirmation** fait entrer le stock et fige le coût moyen. Elle
revient au responsable des commandes. Les frais (transport, douane) se
répartissent sur les lignes et entrent dans le coût.

### Transferts

`en cours → préparation → expédié → reçu → en traitement → à confirmer →
confirmé`.

Seul le propriétaire initie et arbitre les écarts. La source expédie, la
destination compte ce qu'elle reçoit. **La confirmation est le seul
geste qui écrit les mouvements de stock des deux sites.**

### Ordres de transfert *(le cas particulier à tester en priorité)*

Quand l'admin désigne un **partenaire du site destinataire** au moment
d'un transfert, **quatre** documents naissent ensemble :

| Document | Site | Rôle |
|---|---|---|
| Bon de commande | source | fait travailler ; ne porte **aucune** créance |
| Transfert | les deux | déplace la marchandise et la valeur |
| Commande client | destinataire | porte la facture et la dette |
| Achat inter-sites | destinataire | porte la dette envers le site source |

Règles à vérifier :

- **Un seul chemin pour la marchandise** : sortie A (transfert) →
  entrée B (transfert) → sortie B (vente au client). Le bon source
  n'écrit aucun mouvement (`ordreSansMouvement: true`).
- **L'achat inter-sites n'écrit pas de stock** non plus, et sa
  confirmation manuelle est refusée : il suit le transfert.
- **L'annulation est groupée, par deux portes seulement** : le
  *transfert* côté source, le *bon client* côté destinataire. Le bon
  source n'a pas de bouton annuler.
- **Le prix de vente est exigé** à la création : sans lui les dossiers
  naîtraient à zéro et s'afficheraient « soldés ».
- Dans la **vue d'ensemble**, un ordre ne compte qu'une ligne, portée
  par le site destinataire, avec une pastille rouge.

### Caisse

Deux faits distincts : **déclarer** un mouvement et **l'autoriser**.

`ecrireEnCaisse` (`lib/ecrire-caisse.ts`) tranche seul :

- site **sans** caissier → l'argent entre directement ;
- site **avec** caissier, saisie par quelqu'un d'autre → le mouvement
  part en **attente** (`mouvements_attente`) : c'est la *remise* ;
- le caissier saisit lui-même → direct, il est devant le tiroir ;
- **apport et retrait** (le capital) n'attendent personne — propriétaire
  seul.

### Recouvrements

Échéances planifiées par client ou fournisseur
(`recouvrement_journal`). Le volet **Versement** est ouvert à tous les
rôles : la remise remplace l'interdiction — celui qui encaisse ne
s'atteste plus lui-même, c'est le caissier qui l'atteste.

**Un versement éteint la dette immédiatement**, sans attendre le
caissier : il impute `avanceVersee` sur les dossiers ouverts du tiers,
du plus ancien au plus récent. Ce que le caissier confirme, c'est que
l'argent est arrivé au tiroir — pas que le client s'est acquitté.

Une échéance soldée **reste affichée le jour même** (attendu / versé) et
ne s'efface qu'au lendemain ; les compteurs, eux, ne comptent que ce qui
reste à faire.

### Retours

Un retour défait une vente ou un achat. Il peut être réglé **en
déduction** — auquel cas il n'y a pas de versement : la dette s'éteint
sans qu'un franc circule. Les soldes lisent `retours_dossiers`, pas les
versements.

### Inventaire, employés, partenaires

Stock par site (`produits_site` porte stock, coût moyen, prix — le
produit appartient à l'activité). Rémunérations et avances par employé.
Partenaires client et/ou fournisseur, par site.

---

## 4. Parcours à tester

### P1 — Vente ordinaire
1. Créer un client, puis un devis.
2. Le transformer en commande → préparer ligne par ligne → marquer prêt
   → livrer.
3. **Vérifier :** le stock a baissé du montant livré ; la créance du
   client est apparue ; la marge est calculée.
4. Encaisser partiellement, puis totalement. **Vérifier** que le reste
   suit.

### P2 — Achat
1. Créer un achat avec deux lignes et un frais de transport.
2. Déclarer les réceptions, confirmer.
3. **Vérifier :** le stock est entré ; le coût moyen a bougé ; le frais
   est entré dans le coût ; la dette fournisseur existe.
4. **Vérifier qu'un `gerant` ne peut pas confirmer** — c'est le rôle
   `commandes`.

### P3 — Transfert ordinaire
1. Depuis le propriétaire, transférer du dépôt vers une boutique.
2. Expédier, puis recevoir en déclarant une quantité **différente**.
3. **Vérifier :** l'écart est signalé ; seul le propriétaire l'arbitre ;
   après confirmation, les deux stocks sont cohérents.

### P4 — Ordre de transfert *(le plus sensible)*
1. Créer un transfert en désignant **un partenaire de la destination**.
2. **Vérifier d'abord que la création est refusée** si une ligne n'a pas
   de prix de vente.
3. Suivre le cycle depuis le bon source : préparation → prêt → livré.
4. **Vérifier à l'arrivée :**
   - le stock est sorti du site source **une seule fois** ;
   - il est entré puis ressorti chez le destinataire ;
   - la créance est sur le client, **au site destinataire** ;
   - le bon source ne porte **aucune** créance ;
   - les quatre documents sont dans un état cohérent.
5. **Tester l'annulation** depuis le transfert, puis sur un autre dossier
   depuis le bon client : les quatre doivent tomber ensemble.
6. **Vérifier que l'annulation est refusée** après livraison.

### P5 — Caisse et remises
1. Avec un `gerant`, déclarer une sortie de caisse sur un site **qui a
   un caissier**.
2. **Vérifier** qu'elle part en attente et n'entre pas au solde.
3. Avec le `caissier`, autoriser. **Vérifier** que le solde bouge alors.
4. **Vérifier qu'un `gerant` ne peut pas autoriser**, ni déclarer un
   apport.

### P6 — Recouvrement
1. Planifier une échéance client, puis verser un montant partiel.
2. **Vérifier immédiatement :** la créance du client a baissé ; le
   mouvement est en attente du caissier ; l'échéance reste visible avec
   « attendu » et « versé ».
3. Solder l'échéance. **Vérifier** qu'elle reste affichée le jour même
   mais ne compte plus dans « à traiter ».

### P7 — Rôles
Pour chacun des quatre rôles : se connecter, **vérifier la liste des
onglets** contre le tableau de la section 2, et tenter un geste interdit.
L'écran doit le cacher **et** l'écriture doit être refusée.

### P8 — Vue d'ensemble
1. Depuis `/ensemble`, vérifier que chaque chiffre agrège bien tous les
   sites.
2. Cliquer la carte **« À encaisser »** : la page des transactions doit
   s'ouvrir sur **tous** les sites, avec la période héritée.
3. Utiliser les filtres **période** et **site** ; recharger la page et
   vérifier qu'ils sont conservés (ils voyagent dans l'URL).

---

## 5. Points de vigilance connus

Ce sont des défauts déjà rencontrés. Ils sont corrigés, mais ce sont les
endroits où une régression coûterait le plus cher.

- **Cartons et pièces.** Une ligne porte une quantité *dans son
  emballage* et une quantité *en unités de base*. Une confusion entre
  les deux a déjà fait sortir 1 600 pièces pour 1 carton et facturé
  40 fois le prix. **Toujours tester avec un produit en carton.**
- **Écritures en chaîne.** Livrer un ordre enchaîne quatre écritures
  Firestore séparées, qu'on ne peut pas annuler ensemble. L'ordre va du
  plus coûteux à perdre vers le moins. Un échec doit laisser un dossier
  **relançable**, jamais un dossier livré sans stock sorti.
- **Deux comptabilités.** Un versement de recouvrement doit toucher
  `avanceVersee` du dossier, pas seulement son journal — sinon le client
  paie et reste débiteur.
- **Coût inconnu.** Une ligne peut n'avoir jamais su son coût
  (`coutInconnu`). La marge ne doit pas la compter comme un bénéfice
  entier. Vérifier la mention « sans coût connu » au tableau de bord.
- **Latence.** Chaque aller-retour Firestore coûte environ 230 ms depuis
  Brazzaville. Une action qui dépasse deux secondes enchaîne
  probablement des écritures qui pourraient voyager ensemble.

---

## 6. Environnement

- Développement : `npm run dev`, port **3010**.
- Projet Firebase : `ib-gestion`.
- **Plusieurs comptes en parallèle :** ajouter `?session=<nom>` à
  l'adresse (`localhost:3010/?session=commandes`). Chaque onglet obtient
  sa propre session Firebase et ne déconnecte pas les autres. Le nom est
  retenu dans l'onglet et survit aux redirections.
- Les règles d'accès se déploient à part :
  `npx firebase deploy --only firestore:rules`.
