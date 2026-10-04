# Audit financier — ce qui a été trouvé

Rien n'est retiré de ce fichier tant que ce n'est pas corrigé **et** vérifié
dans la base. Un bug signalé puis oublié parce qu'on parlait d'autre chose
est une négligence, pas un oubli.

Chaque entrée dit : ce qui se passe, ce que ça coûte en argent, et comment
on sait que c'est réglé.

---

## Ouverts

### On ne peut pas créer un fournisseur depuis l'achat

**Où** `app/site/[id]/achats/nouveau` — champ Fournisseur

**Ce qui se passe** La recherche dit « Aucun fournisseur » et s'arrête là.
Il faut quitter la commande en cours, aller dans Partenaires, créer le
fournisseur, revenir et tout ressaisir.

**Ce que ça coûte** Le même va-et-vient que celui qu'on a supprimé au
comptoir en permettant d'ajouter un client depuis la recherche. Une
commande préparée puis abandonnée pour aller créer un partenaire, c'est du
travail perdu — et le brouillon ne garde que la marchandise, pas le reste.

**Comment on saura** Un nom cherché sans résultat propose de créer le
partenaire, comme au comptoir.



## Corrigés

### Le versement éteignait la dette avant que l'argent soit entré

**Où** `lib/versements.ts`, `lib/versements-collection.ts`,
`lib/attente-caisse.ts`

**Ce qui se passait** Quand le site a un caissier, le mouvement part en
file d'attente — c'est voulu, c'est lui qui ouvre le tiroir. Mais le
versement, lui, s'écrivait aussitôt : les échéances se soldaient, le
document passait à « payé », la dette du partenaire tombait. Et à
l'autorisation, `autoriser()` écrivait la ligne de caisse sans jamais
revenir sur ces versements — rien ne les raccrochait au mouvement.

**Ce que ça coûtait** Le registre disait qu'on avait payé avec un argent
qui n'était pas entré. Un fournisseur apparaissait réglé alors que les
billets étaient encore chez celui qui les portait ; un client apparaissait
soldé avant que la caisse ait rien reçu. Entre la déclaration et
l'autorisation, les comptes du partenaire étaient faux — et si
l'autorisation n'arrivait jamais, ils le restaient.

**Corrigé le** 04/10/2026 — les lignes de versement voyagent désormais en
réserve sur le mouvement d'attente (`versementsEnAttente`) et ne
s'écrivent qu'à l'autorisation, avec le mouvement de caisse en référence.
Sans caissier, rien ne change : l'argent entre, le versement s'écrit.

**Reste à vérifier** Sur la boutique (qui a une caissière), un règlement
fournisseur ne doit rien écrire chez le partenaire tant que la caissière
n'a pas autorisé ; après autorisation, le versement doit apparaître avec
son mouvement de caisse.

---

### Catégories et unités apparaissent en double dans les listes

**Où** formulaire Nouveau produit, listes « Catégorie » et « Unité »

**Ce qui se passe** Après avoir créé un produit avec la catégorie
« Construction » et l'unité « Sac », le formulaire suivant propose
« Construction » deux fois et « Sac » deux fois. Une seule de chaque a été
saisie.

**Ce que ça coûte** Pas d'argent directement, mais deux entrées pour la
même catégorie veulent dire que des produits identiques se rangeront sous
deux clés différentes — les regroupements et les totaux par catégorie s'en
trouvent faussés.

**Corrigé le** 04/10/2026 — `OngletInventaire.tsx`. Le test anti-doublon
portait sur la liste capturée au rendu, alors que `charger()` venait de la
reconstruire : la catégorie y était déjà, le test ne la voyait pas, et elle
s'ajoutait une seconde fois. Le test se fait maintenant dans le setter, où
`prev` est la liste à jour.

**Vérifié en base** Une seule catégorie, une seule unité, un seul produit :
le doublon n'était qu'à l'écran, rien de faux n'a été écrit.


### Le champ Adresse est obligatoire sans que rien ne le dise

**Où** création d'un site, `app/site/page.tsx`

**Ce qui se passe** « Créer » ne fait rien tant que l'adresse est vide. Le
message « Adresse requise. » n'apparaît qu'après le clic, et le champ ne
porte aucune marque avant — ni astérisque, ni « requis ». Nom et téléphone
ont la même apparence, alors que seul l'un des trois bloque.

**Ce que ça coûte** Pas d'argent : un bouton qui semble mort, et on
recommence. Relevé pendant le test parce qu'il a failli passer inaperçu —
la première création a échoué en silence.

**Comment on saura** Le champ obligatoire se distingue des autres avant
qu'on clique.

---

### Le versement au partenaire s'exécute pendant que son apport attend

**Où** `app/site/[id]/components/ModalVersementTiers.tsx:119-137`

**Ce qui se passe** Quand on verse à un partenaire plus que la caisse ne
contient, l'app écrit un apport de complément. S'il y a un caissier sur le
site, cet apport part en file d'attente — `ecrireEnCaisse` fait son travail.
Mais `verserAuTiers`, juste après, s'exécute sans attendre.

**Ce que ça coûte** La dette du partenaire est éteinte alors que l'argent
censé la couvrir n'est pas entré en caisse. Entre les deux, le registre dit
qu'on a payé avec un argent qu'on n'a pas. Le commentaire du code (ligne 116)
dit vouloir éviter exactement ça — la garantie saute dès qu'un caissier
existe.

**Corrigé le** 04/10/2026 — quand la caisse a un responsable et que ce
n'est pas lui qui agit, le complément ne peut plus accompagner le
versement. L'écran dit pourquoi et où aller le déclarer. La garde tient
aussi à l'enregistrement : masquer la case ne ferme pas l'écriture.

**Reste à vérifier** Sur un site avec caissier, un versement dépassant la
caisse ne doit rien écrire chez le partenaire.

---

### Le solde d'ensemble montrait celui d'un seul site

**Où** `lib/caisse.ts` — `soldeCaisse`

**Ce qui se passait** La fonction prenait le dernier mouvement de la liste
et lisait son `soldeApres`. Juste sur un site — c'est le solde figé du
registre. Faux en vue d'ensemble : la liste mêle plusieurs caisses, et le
dernier mouvement est celui du site qui a bougé en dernier.

**Ce que ça coûtait** Cinq caisses portant 2 639 461 FCFA affichaient
2 500 FCFA, parce que le dernier encaissement venait de la plus petite.
Les montants en base étaient justes : c'était un défaut d'affichage, pas
d'écriture.

**Corrigé le** 04/10/2026 — on prend le dernier mouvement de chaque site et
on additionne ces soldes.

**Reste à vérifier** L'écran d'ensemble doit afficher 2 639 461 FCFA.
