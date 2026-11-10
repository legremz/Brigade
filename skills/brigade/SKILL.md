---
name: brigade
description: Travailler avec Brigade, le gestionnaire de projet local pour IA (MCP « brigade » : grill de questions asynchrone, kanban avec dépendances, agents et skills par projet). À utiliser quand l'utilisateur dit « un projet avec Brigade », « nouveau projet Brigade », « on continue » sur un projet Brigade, « j'ai répondu / j'ai rempli » (grill), ou parle du grill, du kanban ou des cartes Brigade.
---

# Brigade

Brigade garde l'état d'un projet **entre les sessions** : questions (grill), tâches (kanban), agents et skills du projet. Tout passe par les outils MCP `brigade` (préfixe `mcp__brigade__`). L'interface web (par défaut http://localhost:3100) sert à l'utilisateur pour lire et répondre.

**Brigade ne lance aucun agent.** C'est toi qui lis les tâches et qui délègues à des sous-agents.

## 0. Avant tout

- Si les outils `brigade` sont absents (charge-les avec ToolSearch `brigade`), dis-le : le serveur est peut-être arrêté (`npm start` dans `~/Work/perso/brigade`) ou le MCP non enregistré (`claude mcp add --transport http brigade http://127.0.0.1:3100/mcp`). Ne contourne pas en inventant l'état du projet.
- Ne mets jamais de secret (mot de passe, jeton, clé) dans Brigade.
- L'utilisateur peut avoir du mal à démarrer et à finir : questions courtes, tâches petites, propositions plutôt qu'injonctions.

## 1. « On continue » (projet existant)

1. `get_project_state` (projet par slug ou id ; `list_projects` si incertain). **Toujours en premier.**
2. Résume en quelques lignes : où on en est, ce qui attend l'utilisateur, ce qui est démarrable.
3. Lis les skills marqués « toujours » (`get_skill`).
4. Suis les « prochaines actions » proposées, mais **propose** avant de lancer du travail lourd.
5. Des questions attendent l'utilisateur → ne les relance pas : demande-lui s'il a répondu.

## 2. Nouveau projet « avec Brigade »

Enchaîne ces phases, une à la fois, sans sauter la première.

### Phase A — Grill de cadrage
1. `list_projects` pour éviter un doublon, puis `create_project` (nom, objectif en une phrase).
2. Prépare **toutes** les questions d'un coup, puis `ask_questions` **une seule fois**. Ne bloque jamais, ne boucle pas.
   - **Autant de questions que nécessaire** : le grill sert à extraire le maximum de détails du créateur du projet, il n'y a aucun nombre limite. Ordonne-les : objectif et public → périmètre (ce qui est dedans / dehors) → contraintes (stack, délai, existant) → critères de réussite et façon de vérifier → inspirations (demande des **captures d'écran** pour le design) → risques, points flous.
   - Une idée par question, `hint` pour préciser, `choices` quand les réponses typiques sont connues.
   - `default_answer` : seulement quand tu as une hypothèse solide (« sans avis de ta part, je pars sur X »). Pas de proposition de remplissage : sans hypothèse, n'en mets pas.
   - `critical: true` : quand une erreur coûterait cher ou serait difficile à défaire (architecture, données, sécurité, argent, irréversible). L'utilisateur ne peut alors pas répondre « Décide pour moi ».
3. Donne l'URL du grill renvoyée par l'outil et dis à l'utilisateur de répondre à son rythme, puis de te dire « j'ai répondu ». **Arrête-toi là** : n'avance pas sur des hypothèses.

### Phase B — Analyse
1. Quand l'utilisateur annonce avoir répondu : `get_answers` (les images reviennent en blocs image, regarde-les).
2. Applique chaque sortie selon §4 et enregistre les décisions qui en découlent.
3. Reformule ta compréhension en peu de lignes. Repère les trous et contradictions.
4. S'il reste des zones floues importantes : un **second grill ciblé** (retour phase A, étape 2). Sinon passe à la suite.

### Phase C — Plan
1. Propose le cadre à l'utilisateur et applique-le après accord :
   - `set_project_settings` : mode (`main` = toi seul, `team` = agents du projet), modèle par défaut, relecture exigée ou non ;
   - `save_agent` si mode `team` (un rôle = un agent, avec son prompt) ;
   - `save_skill` pour les conventions durables révélées par le grill (stack, style, commandes de test) ; `always: true` seulement pour l'essentiel.
2. Découpe le travail avec `create_tasks` (un seul lot) :
   - **petites tâches** (idéalement 30 à 90 min de travail), titre à l'impératif ;
   - description = quoi faire **et comment vérifier** (critère observable : test, commande, rendu) ;
   - `depends_on` pour l'ordre réel, `priority` et `difficulty` renseignés ;
   - `question_ids` vers les questions du grill qui éclairent la tâche (surtout celles avec images) ;
   - n'assigne un agent que si le mode est `team`.
3. Présente le plan en bref (ordre, première tâche) et demande l'accord avant d'exécuter.

### Phase D — Exécution
Voir §3.

## 3. Exécuter les tâches

Les tâches marquées `[POUR L'HUMAIN]` reviennent à l'utilisateur : ne les démarre pas toi-même, signale-les-lui.

Pour chaque autre tâche prête (`list_tasks` avec `ready_only`, par priorité) :
1. `start_task` — le serveur **refuse** si une dépendance n'est pas terminée (et relue si exigé) ou si un autre agent l'a prise. En cas de refus, **ne contourne pas** : traite d'abord la dépendance.
2. `get_task` : fiche complète (dépendances et résultats, notes de relecture, instructions de l'agent assigné, questions liées avec réponses et images, liste des skills du projet).
3. Travail :
   - mode `main` : fais-le toi-même, ou délègue à un sous-agent générique ;
   - mode `team` : lance un sous-agent générique en lui transmettant le **prompt de l'agent assigné** (dans la fiche) et l'id de la tâche. Le sous-agent charge d'abord le schéma des outils `brigade` (ToolSearch), lit sa fiche avec `get_task` puis les skills utiles avec `get_skill`.
   - Tâches indépendantes et prêtes : plusieurs sous-agents en parallèle sont possibles.
4. `complete_task` avec `result` (ce qui a été fait, fichiers) et `verification` : la **preuve de fin**, c'est-à-dire la commande ou le contrôle réellement exécuté et son résultat. Les deux sont obligatoires et non vides, le serveur refuse sinon et la tâche reste en cours. Ils sont transmis aux tâches dépendantes. N'écris dans `verification` que ce que tu as vraiment constaté ; ce qui n'a pas pu être vérifié se dit dans `result`.
5. Relecture si exigée : `review_task` (`approve` ou `changes` avec notes précises). Idéalement par un autre agent que l'auteur. Si `changes`, la tâche revient à reprendre en tenant compte des notes.
6. Reboucle avec `list_tasks` : de nouvelles tâches ont pu être débloquées.

Règles :
- Une tâche coincée ou abandonnée (« en cours » depuis longtemps) : `release_task` après vérification, jamais en silence.
- Tu ne supprimes pas de tâche ; l'humain le fait depuis l'interface. Pour ajuster : `update_task`, ou de nouvelles tâches via `create_tasks`.
- Un travail qui révèle une question de fond : dépose-la avec `ask_questions` (nouveau grill) au lieu de deviner, et continue sur ce qui n'est pas bloqué.
- Fin de session : résume l'état (fait / en cours / prochain pas) ; Brigade a déjà tout l'état, rien à sauvegarder à part.

## 4. Lire les réponses : sorties et décisions

`get_answers` restitue pour chaque question sa réponse, ou sa sortie avec la consigne associée :

| Sortie choisie | Ce que tu fais |
|---|---|
| **Réponse écrite ou image** | Elle fait foi. |
| **Proposition validée** | Ta réponse par défaut fait foi. |
| **Décide pour moi** | Tu tranches et tu écris ta décision avec `record_decision` (`question_id`). La question reste signalée « attend une décision » tant que ce n'est pas fait. |
| **Pas pertinent** | Tu écartes la question, sans en tirer de conclusion. |
| **Plus tard** (listée à part) | Tu laisses la question ouverte et tu ne présumes rien. Elle compte comme traitée dans la progression, ce n'est pas une réponse. |
| **Question passée** (ancienne valeur) | Son intention d'origine est inconnue : ne présume rien, redemande si elle bloque. |

Le texte joint à une sortie est une note de l'utilisateur, à lire. `get_answers` signale aussi les réponses **modifiées depuis ta dernière lecture** : tiens-en compte, y compris sur un grill marqué terminé. Il enregistre la lecture et lève ce marquage ; `get_question` ne le fait pas.

### Enregistrer une décision

`record_decision` : `decision` et `reason` sont obligatoires ; `question_id` et `task_ids` (id ou « #n ») sont optionnels.

- **Quand** : toujours pour clore un « Décide pour moi » ; aussi pour tout choix durable pris pendant le travail qui engage les tâches suivantes (architecture, compromis, écart au plan). Lie les tâches concernées : `get_task` leur transmet la décision, et `get_project_state` rappelle les plus récentes.
- **Refusé par le serveur** : décision ou raison vide ; question ou tâche d'un autre projet ; décision sur une **question critique sans réponse de l'utilisateur** (ni texte, ni image, ni proposition validée), ou mise en « Plus tard » ou « Pas pertinent », même avec une note. Sur un refus, ne contourne pas : pose la question à l'utilisateur.
- **Immuable** : une décision ne se modifie ni ne se supprime. Pour en changer, enregistre-en une nouvelle qui dit ce qu'elle remplace.
- `list_decisions` relit le registre et les « Décide pour moi » encore sans décision.
