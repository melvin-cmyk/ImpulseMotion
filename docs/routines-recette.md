# Routines — guide de recette

Ce guide sert à vérifier l'espace « Routines » en production, en écriture réelle, **sur un compte de test**, avant de l'ouvrir aux consultants.

Tant que la recette n'est pas passée, l'espace est fermé : seuls les administrateurs le voient. Aucun consultant ne peut créer ni activer une routine.

Comptez une à deux heures, plus une attente jusqu'au lendemain pour la vérification 16.

---

## 1. Ce qu'il faut préparer

### Sur Vercel

| Variable | Valeur pour la recette |
|---|---|
| `ROUTINES_ACCESS` | absente (ou `admin`) : espace réservé aux administrateurs |
| `N8N_AUTO_ALERT_WEBHOOK_URL` et `N8N_ALERT_WEBHOOK_SECRET` | déjà en place pour les alertes ; sans le secret, toute routine avec un message Slack est refusée |
| `CRON_SECRET` | déjà en place |
| `ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN` | au choix ; `1` réserve aux administrateurs l'activation des routines qui créent des publicités |

Une variable modifiée sur Vercel ne prend effet qu'après un nouveau déploiement.

### Un compte Meta de test

- Un compte publicitaire qui n'est **pas** celui d'un client, rattaché à un client de test dans l'application.
- Une campagne **en pause**.
- Dans cette campagne, un ensemble de publicités **en pause**.
- Une Page Facebook que ce compte peut promouvoir.
- Notez les identifiants de la campagne, de l'ensemble et de la Page (des chiffres).

Avec la campagne et l'ensemble en pause, rien ne peut être diffusé, même si une publicité était activée par erreur.

### Un Google Sheet de test

- Partagé **en éditeur** avec `data@impulse-analytics.com`.
- Un onglet nommé `Créas`.
- En ligne 1, ces onze colonnes, avec ces noms exacts (minuscules, sans accent, tiret bas) :

| id | nom_pub | texte_principal | titre | description | lien | type_media | url_media | statut | id_pub | erreur |
|---|---|---|---|---|---|---|---|---|---|---|

- En ligne 2, une ligne d'exemple :

| id | nom_pub | texte_principal | titre | description | lien | type_media | url_media | statut | id_pub | erreur |
|---|---|---|---|---|---|---|---|---|---|---|
| crea-001 | Recette - visuel 1 | Découvrez notre nouvelle gamme. | Nouvelle gamme | | https://www.exemple.fr/produit-1 | image | https://www.exemple.fr/images/visuel-1.jpg | | | |

À quoi sert chaque colonne :

| Colonne | Remplie par | Rôle |
|---|---|---|
| `id` | vous | Identifiant unique de la ligne, jamais réutilisé ni modifié. C'est lui qui empêche de créer deux fois la même publicité. |
| `nom_pub` | vous | Nom de la publicité dans Meta. Un nom différent par ligne. |
| `texte_principal` | vous | Texte de la publicité. |
| `titre` | vous | Titre (facultatif). |
| `description` | vous | Description (facultatif). |
| `lien` | vous | Adresse de destination, en `https://`. |
| `type_media` | vous | Toujours `image`. La vidéo n'est pas prise en charge. |
| `url_media` | vous | Adresse publique de l'image, en `https://`. Pas de lien Google Drive privé. |
| `statut` | la routine | Laissez vide. |
| `id_pub` | la routine | Laissez vide. Identifiant de la publicité créée. |
| `erreur` | la routine | Laissez vide. |

Statuts que la routine écrit, et aucun autre : `créée (en pause)`, `déjà présente (en pause)`, `créée`, `échec`, `abandonnée après 3 tentatives`, `refusée`, `à vérifier` (parfois suivi de « : » et de ce qui est à vérifier).

Remplacez les adresses d'exemple par un vrai lien et une vraie image publique.

### Un canal Slack de test

- Un canal où personne d'autre que vous ne sera dérangé, par exemple `#test-routines`.
- Le bot de l'agence doit y être invité.

### Deux comptes dans l'application

- Le vôtre, administrateur.
- Celui d'un consultant (ou un compte de test au rôle consultant), pour la vérification 1.

---

## 2. Les 16 vérifications

Elles vont du moins risqué au plus risqué. **Arrêtez-vous à la première qui échoue** : les suivantes supposent que les précédentes ont réussi.

### A. Sans aucune écriture

#### 1. L'espace est fermé aux consultants

- **À faire** : connectez-vous avec le compte consultant. Regardez le menu, puis tapez l'adresse `/routines` à la main.
- **On doit voir** : pas d'entrée « Routines » dans le menu ; l'adresse renvoie à la page d'accueil. Avec votre compte administrateur, l'entrée est là et la page s'ouvre.
- **Sinon** : vérifiez que `ROUTINES_ACCESS` est absente ou vaut `admin` sur Vercel, puis redéployez. N'allez pas plus loin tant que le consultant entre.

#### 2. La création propose les Pages du compte

- **À faire** : « Nouvelle routine », choisissez le client de test, laissez Meta coché.
- **On doit voir** : une liste déroulante « Page Facebook » avec la Page de test. Choisissez-la, donnez un nom, créez.
- **Sinon** : si la liste est vide ou en erreur, la Page n'est pas rattachée au compte publicitaire dans Meta. Corrigez dans Meta, pas dans l'application.

#### 3. L'IA propose une routine correcte

- **À faire** : demandez à l'IA : « Chaque jour à 9 h, crée une publicité Meta en pause par nouvelle ligne de mon Sheet, reporte le résultat dans le Sheet et préviens le canal #test-routines. » Donnez le lien du Sheet, la campagne et l'ensemble quand elle les demande.
- **On doit voir** : une carte de proposition. Elle ne redemande pas la Page. Le nom de la publicité vient de `nom_pub`, sans date. Le filtre porte sur `id_pub` vide, pas sur `statut`.
- **Sinon** : dites à l'IA ce qui ne va pas. N'appliquez pas une proposition qui filtre sur le statut ou met une date dans le nom.

#### 4. L'application contrôle avant d'enregistrer

- **À faire** : cliquez « Appliquer la proposition ».
- **On doit voir** : « Définition enregistrée ». S'il y a des avertissements, lisez-les.
- **Sinon** : un refus dit pourquoi (Sheet non partagé, colonne absente, ensemble hors du compte, Page que le compte ne peut pas promouvoir). Corrigez la cause et réessayez.

#### 5. L'essai à blanc n'écrit rien

- **À faire** : onglet « Essai à blanc », lancez l'essai.
- **On doit voir** : « 1 publicité à créer, 1 ligne de Sheet à écrire, 1 message à envoyer ». Dans Meta, aucune publicité nouvelle. Dans le Sheet, rien n'a changé. Dans Slack, rien.
- **Sinon** : si quoi que ce soit a été écrit, **arrêtez la recette** et signalez-le. C'est le défaut le plus grave possible.

#### 6. L'essai à blanc sur un Sheet vide prévient

- **À faire** : videz la ligne 2 du Sheet (gardez la ligne 1), relancez l'essai.
- **On doit voir** : l'essai réussit avec un encadré : « L'essai n'a rien trouvé à créer : vous activez sans avoir vu d'exemple. »
- **Sinon** : signalez-le. Remettez la ligne d'exemple et relancez l'essai avant de continuer.

#### 6 bis. L'activation exige un essai à blanc à jour

- **À faire** : sur une routine dont l'essai à blanc a réussi, demandez à l'IA un petit changement (l'heure, par exemple), appliquez, puis regardez le bouton « Activer ».
- **On doit voir** : « Activer » est grisé, avec la raison : l'essai à blanc ne correspond plus à la définition. Il redevient cliquable après un nouvel essai réussi.
- **Sinon** : si l'activation est possible sans refaire l'essai, arrêtez la recette et signalez-le.

### B. Écritures sans conséquence (Slack, Sheet)

#### 6 ter. Une formule dans une cellule écrite est neutralisée

- **À faire** : créez une routine qui ajoute une ligne dans un onglet `Suivi` du Sheet de test, avec une valeur qui commence par `=` (par exemple un nom de campagne saisi `=1+1`). Essai à blanc, activez, « Exécuter maintenant ».
- **On doit voir** : la cellule affiche le texte `=1+1` (éventuellement précédé d'une apostrophe), pas le résultat `2`.
- **Sinon** : si la cellule affiche `2`, signalez-le.

#### 7. Un message Slack simple part, une seule fois

- **À faire** : créez une seconde routine sur le client de test : « Poste "Test de recette" dans #test-routines, déclenchement manuel. » Appliquez, essai à blanc, activez, puis « Exécuter maintenant ».
- **On doit voir** : un message, un seul, dans `#test-routines`. L'historique dit « 1 message envoyé ».
- **Sinon** : « canal introuvable » : invitez le bot dans le canal. « secret non configuré » : voir les préalables.

#### 8. Un lien déguisé venu du Sheet est désamorcé

- **À faire** : dans une routine qui lit le Sheet et poste une cellule dans Slack, mettez dans `nom_pub` : `<https://exemple.fr|Cliquez ici> <!channel>`. Exécutez.
- **On doit voir** : dans Slack, « Cliquez ici (https://exemple.fr) » en texte ; personne n'est notifié par `@channel`.
- **Sinon** : signalez-le, et retirez ce texte du Sheet.

### C. Création de publicités en pause

Pour toute cette partie : la campagne et l'ensemble de test restent **en pause**.

#### 9. Première publicité créée, en pause

- **À faire** : revenez à la première routine, une seule ligne dans le Sheet. Activez, puis « Exécuter maintenant ».
- **On doit voir** :
  - dans le Gestionnaire de publicités, **une** publicité au nom de `nom_pub`, **en pause**, dans l'ensemble de test ;
  - dans le Sheet : `statut` = `créée (en pause)`, `id_pub` rempli, `erreur` vide ;
  - dans Slack : un message avec le tableau ;
  - dans l'historique : « 1 publicité créée, 1 ligne écrite dans un Sheet, 1 message envoyé ».
- **Sinon** : si la publicité n'est **pas en pause**, mettez-la en pause à la main, mettez la routine en pause, arrêtez la recette.

#### 10. Une seconde exécution ne recrée rien

- **À faire** : « Exécuter maintenant » une seconde fois, sans toucher au Sheet. Puis videz `statut` et `id_pub` à la main et exécutez encore.
- **On doit voir** : toujours une seule publicité dans Meta. Après le vidage, le Sheet est remis à jour (`créée`, identifiant remis). Pas de nouveau message Slack.
- **Sinon** : deux publicités pour la même ligne : mettez la routine en pause, arrêtez la recette.

#### 11. Le plafond par exécution est respecté

- **À faire** : demandez à l'IA un plafond de 2 publicités par exécution, appliquez, refaites l'essai, activez. Ajoutez trois lignes (`crea-002` à `crea-004`). Exécutez.
- **On doit voir** : 2 publicités créées, « 1 reportée ». La troisième ligne reste vide dans le Sheet. Une nouvelle exécution la crée.
- **Sinon** : plus de 2 créations d'un coup : routine en pause, signalez-le.

#### 12. Une publicité du même nom, active, n'est ni touchée ni doublée

- **À faire** : dans Meta, créez à la main dans l'ensemble de test une publicité nommée `Recette - doublon` et laissez-la **active** (l'ensemble étant en pause, elle ne diffuse pas). Ajoutez une ligne `crea-005` avec `nom_pub` = `Recette - doublon`. Exécutez.
- **On doit voir** : aucune nouvelle publicité. Sheet : `à vérifier : une publicité du même nom existe au statut ACTIVE`. La publicité manuelle n'a pas changé de statut. Exécution « Partielle », pas de message Slack.
- **Sinon** : si le Sheet dit « en pause », ou si la publicité manuelle a été modifiée : routine en pause, signalez-le.

#### 13. Une ligne refusée par Meta est retentée trois fois, puis abandonnée

- **À faire** : ajoutez une ligne `crea-006` dont `url_media` pointe vers une page web (pas une image). Exécutez trois fois.
- **On doit voir** : `échec` avec l'erreur de Meta aux deux premières, puis `abandonnée après 3 tentatives`. Les autres lignes sont traitées normalement. La routine reste active. Une quatrième exécution n'envoie plus rien pour cette ligne.
- **Sinon** : si la routine s'arrête à cause de cette seule ligne, ou si la ligne est dite « déjà traitée », signalez-le.

#### 14. « J'ai vérifié » lève une ligne en doute

- **À faire** : sur la page de la routine, la liste « Lignes à vérifier » montre `crea-005` (après trois exécutions) et `crea-006`.
  - Pour `crea-005` : mettez la publicité `Recette - doublon` en pause dans Meta, copiez son identifiant, collez-le, cliquez « J'ai vérifié : la publicité existe ».
  - Pour `crea-006` : corrigez `url_media` dans le Sheet, cliquez « J'ai vérifié : rien n'a été créé, réessayer », puis exécutez.
- **On doit voir** : `crea-005` disparaît de la liste, la ligne est close. `crea-006` est créée à l'exécution suivante. Aucune publicité en double.
- **Sinon** : un refus explique pourquoi (publicité d'un autre ensemble, introuvable). Si l'identifiant d'une publicité d'un autre ensemble est accepté, signalez-le.

#### 15. Changer d'ensemble de publicités prévient avant de recréer

- **À faire** : créez un second ensemble en pause dans la même campagne. Demandez à l'IA de changer d'ensemble.
- **On doit voir** : sur la carte, puis à l'essai à blanc : « L'ensemble de publicités a changé : les N lignes déjà traitées dans l'ancien ensemble seront créées à nouveau dans le nouveau. »
- **Sinon** : sans cet avertissement, n'activez pas. **Refusez la proposition** si vous ne voulez pas de ces nouvelles publicités.

### D. Exécution automatique

#### 16. Le planning déclenche une exécution, et une seule

- **À faire** : réglez la routine sur une heure proche (par pas de 15 minutes), ajoutez une ligne, activez. Attendez l'heure, puis le quart d'heure suivant. Laissez tourner jusqu'au lendemain.
- **On doit voir** : une exécution « Planifiée » dans l'historique à l'heure dite, une publicité en pause, un message Slack. Rien de plus au quart d'heure suivant. « Prochaine exécution » indique le lendemain. Le lendemain, sans nouvelle ligne : une exécution, aucune création, aucun message.
- **Sinon** : deux exécutions ou deux messages pour le même créneau : routine en pause, signalez-le. Aucune exécution : vérifiez `CRON_SECRET` et les tâches planifiées sur Vercel.

### Ce que la recette à la main ne peut pas provoquer

Ces cas sont couverts par les tests automatiques, mais pas vérifiables à la main sans casser quelque chose exprès :

- la fonction arrêtée par l'hébergeur en cours d'exécution ;
- la base injoignable au milieu d'une exécution ;
- une réponse de Meta qui arrive après la fin de l'exécution ;
- le message « routine dégradée » après trois exécutions sans succès complet.

Si l'un d'eux se produit pendant la recette, l'historique le dit (« Exécution interrompue », « Exécution non démarrée ») : notez l'heure et signalez-le.

---

## 3. Ouvrir l'espace à tout le personnel

Seulement quand les 16 vérifications sont passées.

1. Sur Vercel, ajoutez `ROUTINES_ACCESS` avec la valeur `staff` (en minuscules, sans espace), pour l'environnement de production.
2. Redéployez.
3. Avec le compte consultant : l'entrée « Routines » apparaît dans le menu, la page s'ouvre. Un consultant déjà connecté la voit après avoir rechargé la page.

Toute autre valeur que `staff` garde l'espace fermé.

Si `ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN` vaut `1`, les consultants peuvent créer une routine et faire l'essai à blanc, mais seul un administrateur peut activer, reprendre ou exécuter une routine qui crée des publicités.

---

## 4. Tout arrêter en cas de problème

Dans cet ordre.

0. **Arrêt général des exécutions planifiées** : sur Vercel, ajoutez `ROUTINES_CRON` avec la valeur `off`, puis redéployez. Plus aucune routine ne part au planning. « Exécuter maintenant » reste possible pour qui a l'accès. Retirez la variable pour reprendre ; une routine en retard de plus de 12 heures est alors notée « manquée », pas rejouée.
1. **Mettez en pause chaque routine active** : page de la routine, bouton « Mettre en pause ». Une routine en pause ne s'exécute plus, ni au planning ni à la main.
2. **Refermez l'espace** : sur Vercel, retirez `ROUTINES_ACCESS` (ou mettez `admin`), puis redéployez. Les consultants ne peuvent plus rien créer ni activer.
3. **Dans Meta**, vérifiez que les publicités créées sont en pause. La routine ne sait ni activer ni supprimer une publicité : ce qui est en pause le reste.

**Attention** : refermer l'espace (étape 2) n'arrête **pas** les routines déjà actives. Elles continuent de s'exécuter à leur heure. Seuls l'arrêt général (étape 0) et la mise en pause (étape 1) les arrêtent.

Pour arrêter définitivement une routine : « Archiver ». Son historique reste consultable.
