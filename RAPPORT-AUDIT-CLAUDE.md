# Audit IBD Kunda — 06/10/2026

Lecture du code complet, en lecture seule, pendant que Claude Code travaille.
Aucun fichier du projet n'a été modifié.

- TypeScript (`tsc --noEmit`) : **0 erreur**.
- ESLint : 647 remarques, presque toutes cosmétiques (`any`, variables
  inutilisées, apostrophes). Aucune ne casse l'app ; à traiter plus tard.
- Test dans le navigateur : bloqué à la page de connexion (pas de compte de
  test). Je n'ai rien écrit dans la base.

Les vrais problèmes sont dans la **logique** : argent, stock et règles
Firestore. Les 3 constats marqués ✅ ont été revérifiés à la main dans le code.

---

## À donner à Claude Code

> Lis RAPPORT-AUDIT-CLAUDE.md. Corrige les constats dans l'ordre (P0 puis P1).
> Pour chacun, vérifie d'abord dans le code que le constat est exact ; s'il
> ne l'est pas, dis-le et passe au suivant. Mets AUDIT.md à jour à chaque
> correction.

---

## P0 — Sécurité (à corriger avant toute mise en ligne)

### 1. ✅ N'importe quel inscrit peut devenir propriétaire de n'importe quelle activité
`firestore.rules` — `suisProprietaire()` (~l.95), `match /users/{uid}` (~l.341-386)

`suisProprietaire()` fait confiance à `users/{moi}.adminUid == moi`, un champ
que l'utilisateur écrit lui-même. `users` create n'a aucune contrainte, et
le premier `allow update` accepte tout changement tant que `role` ne bouge
pas (donc `adminUid` et `activiteId` aussi). Un compte crée
`{role:'membre', activiteId:<victime>, adminUid:<moi>}` et devient propriétaire.

**Correctif** : ne jamais lire `adminUid` depuis `users` ; dans
`suisProprietaire()`, vérifier `get(activites/{activiteId}).data.adminUid == monUid()`.
Interdire `adminUid` à la création et limiter les champs modifiables
(`affectedKeys().hasOnly([...])`). Vérifier aussi `membres` create (branche
sans invitation) et la modification d'invitations non rattachées (~l.491).

### 2. ✅ Les règles de caisse ne protègent rien
`firestore.rules` ~l.515-534 et ~l.603

- `caisse_compteurs` : `allow read, write: if aUneActivite()` — n'importe
  quel compte peut réécrire le solde d'un autre commerçant.
- `mouvements_attente` : `allow update: if travailleSur(...)` — un gérant
  peut passer sa propre demande à `autorise`.
- `mouvements_caisse` : création ouverte à tout membre — on contourne
  l'attente et le « propriétaire seul » pour apport/retrait.

**Correctif** : compteurs limités au site ; mise à jour d'attente réservée
au caissier, seulement depuis `en_attente`, avec `affectedKeys().hasOnly([...])`.

### 3. Les règles ne vérifient ni rôle ni état sur achats, ventes, transferts, stock
`firestore.rules` ~l.734-802

Tout membre peut, en console : confirmer un achat (P2 dit `commandes` seul),
créer un transfert (propriétaire seul), passer une vente à `livre`/`annule`,
**supprimer une vente livrée** (la créance disparaît), supprimer des
`mouvements` (source du coût moyen). De même, la « séparation des deux
mains » sur retours/ajustements (~l.630, 672) ne lie pas `confirmeParUid` à
`monUid()`.

**Correctif** : `delete: if false` sur ventes, achats, transferts,
mouvements, produits_site, documents ; garde de rôle sur les transitions
d'état sensibles.

---

## P0 — Argent

### 4. ✅ Annuler un mouvement de caisse peut rentrer l'argent plusieurs fois
`lib/caisse.ts` ~l.278-306 + `firestore.rules` (`mouvements_caisse` update: false)

La contre-passation s'écrit, puis `updateDoc({annuleParId})` est **toujours
refusé** par les règles. L'écran affiche une erreur, le mouvement reste
annulable, l'utilisateur reclique : chaque clic ajoute une contre-passation.

**Correctif** : un verrou `caisse_annulations/{mouvementId}` créé dans une
transaction avec la contre-passation ; `annulableEnCaisse` le lit.

### 5. AUDIT.md dit « corrigé » mais ce n'est pas branché : le versement éteint la dette avant le caissier
`lib/versements.ts` ~l.230-265, `lib/attente-caisse.ts` ~l.337-349, `lib/versements-collection.ts` ~l.196

`versementsEnAttente` existe mais **aucun appelant ne le remplit**, et
`autoriser()` ne le lit pas. Conséquences :
- un paiement fournisseur **refusé** par la caissière reste « réglé » chez le fournisseur ;
- une autorisation **partielle** (4 000 sur 5 000) solde quand même 5 000 ;
- `autoriser()` rattache tous les versements du partenaire sans
  `mouvementCaisseId`, y compris ceux d'autres mouvements.

À noter : TESTING.md (« le versement éteint la dette immédiatement ») et
AUDIT.md se contredisent. **C'est à toi de trancher** le comportement voulu,
puis d'aligner le code et les deux documents.

### 6. Quatre chemins de versement, quatre comportements différents

| Point d'entrée | Ce qui s'écrit |
|---|---|
| ModalVersementTiers | dette éteinte + caisse |
| SectionRecouvrement, versement global | dette éteinte + caisse |
| OngletRecouvrements, volet Versement | journal + `avanceVersee` + caisse, **sans document `versements`** |
| SectionRecouvrement, bouton « Verser » d'une ligne (~l.319) | **journal seul** : échéance « soldée », créance et caisse inchangées |

Le dernier fait disparaître l'argent sans trace, et le bouton n'a aucun
contrôle de rôle. **Correctif** : tout faire passer par `verserAuTiers`.

### 7. Versement fournisseur depuis OngletRecouvrements : l'argent sort deux fois
`OngletRecouvrements.tsx` ~l.583-596 et ~l.974 ; `lib/missions.ts` ~l.407-445

L'argent a déjà été sorti à la remise au porteur (`delivrer()`), puis
`enregistrerVersement` écrit une seconde sortie. Et `declarerRemise` ne met
pas à jour `avanceVersee` : le fournisseur reste débiteur (« deux comptabilités »).

### 8. Une entrée refusée, une fois l'écart reconnu, retire un argent jamais entré
`lib/attente-caisse.ts` ~l.451-469 + `lib/ecarts-caisse.ts` ~l.207-220

**Correctif** : un écart né d'un refus d'entrée se reconnaît à 0.

### 9. Les paiements s'imputent sur des devis, des commandes non livrées ou des ventes annulées
`lib/versements.ts` ~l.65-90, `lib/imputation.ts` ~l.71-91, `lib/compensation.ts` ~l.72

Pas de filtre d'état ; les retours ne sont pas déduits. Un client avec une
vente annulée plus ancienne paie, et l'argent part dessus : on lui réclame
deux fois. **Correctif** : ne garder que `livre` (ventes) / `confirme` (achats).

---

## P1 — Stock (parcours P4, le plus sensible)

### 10. Une livraison d'ordre qui échoue à mi-chemin ne peut plus être relancée
`ventes/[venteId]/page.tsx` ~l.539-589, `lib/ordre-transfert.ts` ~l.468

Au second clic, `confirmerTransfert` lève « Seul un transfert reçu… » ; et
`if (v.etat === 'livre') return;` saute l'écriture de l'achat. Le stock est
entré chez le destinataire sans ressortir, client non facturé, dossier bloqué.
**Correctif** : rendre chaque étape idempotente (sauter ce qui est déjà fait).

### 11. Un ordre sort la quantité demandée, pas la quantité préparée
`ventes/[venteId]/page.tsx` ~l.548-553, `lib/ordre-transfert.ts` ~l.411, 474

5 cartons demandés, 3 préparés → 5 sortent et 5 sont facturés.
**Correctif** : utiliser `quantiteRecue ?? quantiteDemandee`.

### 12. Le « coût inconnu » se perd au transfert : marge = prix de vente
`lib/flux-marchandise.ts` ~l.889, 1112-1124

`appliquerLigne` en entrée pose `inconnuApres = false`. Le destinataire
hérite d'un coût « connu » de 0 et le tableau de bord compte tout le CA en
bénéfice. Même effet quand le coût réel arrive entre commande et livraison
(~l.1428 : la marge utilise le coût figé à la commande).

### 13. Prix au carton multiplié par des pièces (facteur ×24, ×25…)
- `lib/mouvements.ts` ~l.368 et ~l.507 : `valeurTotale = valeurUnitaire × qteUnites`
  alors que `valeurUnitaire` est par emballage → inventaire faux.
- `lib/mouvements.ts` ~l.483 : `enregistrerMouvement` traite comme « par
  carton » un coût que `ModalMouvement` saisit « par pièce » → coût moyen
  divisé par 25.
- `lib/retours.ts` ~l.156, 289 : retour client pondéré au prix du carton
  par pièce, et `valeurTotale` au **prix de vente**.
- `lib/ajustements.ts` ~l.450 et `lib/retours.ts` ~l.131 : la garde de stock
  compare des cartons à des pièces (1 carton ≤ 10 pièces → stock à −14).

C'est exactement le piège « cartons et pièces » de TESTING.md §5.

### 14. Variante absente de la détention : elle part du stock total
`lib/flux-marchandise.ts` ~l.877 (et `lib/mouvements.ts` ~l.312, 467)

**Correctif** : `stockAvant = varianteCle ? (variante?.stock ?? 0) : detention.stock`.

### 15. Aucune transaction sur livraison, confirmation d'achat et stock
`lib/flux-marchandise.ts` ~l.1012, 1026, 1078, 1248, 1397 ; `lib/reseau.ts` ~l.135

L'état est vérifié sur l'objet chargé à l'écran, et le stock est écrit en
valeur absolue. Deux postes (ou le comptoir qui « reprend » les ventes) →
stock sorti deux fois, achat confirmé deux fois, ou mise à jour perdue
(100 − 10 − 10 = 90). **Correctif** : `runTransaction` qui relit l'état,
ou au minimum `increment()` et un état intermédiaire « en_cours ».

### 16. Retour / ajustement « confirmé » sans que le stock ait bougé
`lib/retours-dossiers.ts` ~l.576-590, `lib/ajustements.ts` ~l.466-529

L'état final est posé avant l'écriture du stock ; si elle échoue, le dossier
est clos et non relançable. **Correctif** : marqueur `stockEcrit` + reprise.

### 17. Livrer un ordre échoue pour un gérant du site source
`lib/flux-marchandise.ts` ~l.1012, 1026 vs `firestore.rules` ~l.756-802

Les écritures sur la détention du destinataire n'ont pas les marqueurs
`transfertOuvrant` / `venteOuvrante` exigés par les règles → permission
refusée. En pratique, seul le propriétaire peut livrer un ordre.

### 18. `annulerOrdre` ne regarde ni le bon source ni l'achat
`lib/ordre-transfert.ts` ~l.584-596 — peut « annuler » des documents déjà livrés/confirmés.

---

## P1 — Rôles à l'écran (le piège du `null`)

### 19. Une erreur de lecture du rôle donne les droits du propriétaire
- `app/site/[id]/page.tsx` ~l.153 : `.catch(() => setRole(null))` ; et
  `lib/roles.ts` ~l.386 rend `null` si aucun membre → un compte d'un autre
  site obtient tous les onglets.
- `achats/[achatId]/page.tsx` ~l.127 : en cas d'erreur `roleLu` passe à vrai
  avec `role = null` → un gérant voit « Confirmer », `commandes` voit les prix.
- `ajustements/[ajustementId]/page.tsx` ~l.76 : pas de `roleLu`.
- `lib/ecrire-caisse.ts` ~l.72 : `.catch(() => null)` → apport/retrait autorisé.
- `SectionRecouvrement.tsx` ~l.77 : `peutRegler` vrai pendant le chargement.
- `transferts/[transfertId]/page.tsx` ~l.223-228 : « Confirmer » et
  « Arrêter les comptes » sans contrôle de rôle → on arbitre son propre écart.

**Correctif** : distinguer « propriétaire », « rôle X » et « refusé / erreur ».
Une erreur ne doit jamais valoir `null`.

---

## P2 — Mineur

- `lib/frais.ts` ~l.300 : arrondi frais par frais → 1 FCFA de trop bloque
  la confirmation ; la clé « quantité » compte 1 carton comme 1 pièce.
- `lib/flux-marchandise.ts` ~l.1525 : `beneficeAttendu` compte les lignes à
  coût inconnu comme marge pleine.
- `lib/roles.ts` ~l.255 : `aUnCaissier` est mis en cache sans fin ; un
  caissier nommé en cours de session n'est vu qu'après rechargement.
- AUDIT.md, ouvert : créer un fournisseur depuis un achat.
- ESLint : 35 `setState` dans des `useEffect`, 40 dépendances manquantes —
  source possible de doubles chargements, à voir plus tard.

## Ce qui a été vérifié sans défaut
Conversion carton ↔ pièce dans `appliquerLigne`, `SelecteurProduits` et le
comptoir ; refus de confirmer manuellement un achat inter-sites ; prix de
vente exigé à la création d'un ordre ; aucun secret dans le code
(`lib/firebase.ts` ne contient que la config web publique).
