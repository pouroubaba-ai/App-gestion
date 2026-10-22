# À faire — IBD Kunda

> Les tâches à traiter, et celles déjà réglées. On coche au fur et à mesure.
> `[ ]` = à faire · `[~]` = en cours · `[x]` = résolu

---

## En cours

- [ ] **Fermeture de fiche = rechargement de la liste.**
  Quand on ferme une fiche (vente, achat, transfert, importation), la liste
  se recharge entièrement (spinner + relecture Firestore → coûte des lectures).
  Objectif : ne relire que ce qui a changé depuis (lecture incrémentale).
  - Point de lecture unique : `lireParSite` dans [lib/portee.ts](lib/portee.ts)
    via `chargerVentesDuSite` ([lib/flux-marchandise.ts](lib/flux-marchandise.ts)).
  - 8 écrans ouvrent/ferment des fiches (les 4 fiches + 4 formulaires de création).
  - Pré-requis : un champ `updatedAt` sur chaque écriture (n'existe pas encore).

## À faire

<!-- Ajoute ici les prochaines idées / corrections à traiter. -->

---

## Résolu

- [x] PDF : bouton de téléchargement (achats, ventes, transferts, importations),
      titre « Facture » pour une vente livrée, emballage dans la colonne quantité.
- [x] Configuration du site : infos modifiables (logo, nom, adresse, tél.), page réorganisée.
- [x] Préparation/réception : saisie silencieuse (plus de gel), correction possible même en « prêt ».
- [x] Le ⓘ reste pour plier le journal même à zéro préparé.
- [x] Filtre Cycle de vente : un seul modal à deux niveaux (types → choix),
      filtres retirables depuis la page, filtre par origine (venant d'un ordre / non),
      filtre par date, filtre par statut (payé / acompte / impayé).
- [x] Colonne « Statut » (paiement : payé / acompte / impayé).
- [x] Colonne « Livraison dans » retirée.
