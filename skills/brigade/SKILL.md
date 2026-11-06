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

1. `get_project_state` (projet par slug ou nom ; `list_projects` si incertain). **Toujours en premier.**
2. Résume en quelques lignes : où on en est, ce qui attend l'utilisateur, ce qui est démarrable.
3. Lis les skills marqués « toujours » (`get_skill`).
4. Suis les « prochaines actions » proposées, mais **propose** avant de lancer du travail lourd.
5. Des questions attendent l'utilisateur → ne les relance pas : demande-lui s'il a répondu.

## 2. Nouveau projet « avec Brigade »

Enchaîne ces phases, une à la fois, sans sauter la première.

### Phase A — Grill de cadrage
1. `list_projects` pour éviter un doublon, puis `create_project` (nom, objectif en une phrase).
2. Prépare **toutes** les questions d'un coup, puis `ask_questions` **une seule fois**. Ne bloque jamais, ne boucle pas.
   - 6 à 10 questions, ordonnées : objectif et public → périmètre (ce qui est dedans / dehors) → contraintes (stack, délai, existant) → critères de réussite et façon de vérifier → inspirations (demande des **captures d'écran** pour le design) → risques, points flous.
   - Une idée par question, `hint` pour préciser, `choices` quand les réponses typiques sont connues.
3. Donne l'URL du grill renvoyée par l'outil et dis à l'utilisateur de répondre à son rythme, puis de te dire « j'ai répondu ». **Arrête-toi là** : n'avance pas sur des hypothèses.

### Phase B — Analyse
1. Quand l'utilisateur annonce avoir répondu : `get_answers` (les images reviennent en blocs image, regarde-les).
2. Reformule ta compréhension en peu de lignes. Repère les trous et contradictions.
3. S'il reste des zones floues importantes : un **second grill court**, ciblé (retour phase A, étape 2). Sinon passe à la suite.

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

Pour chaque tâche prête (`list_tasks` avec `ready_only`, par priorité) :
1. `start_task` — le serveur **refuse** si une dépendance n'est pas terminée (et relue si exigé) ou si un autre agent l'a prise. En cas de refus, **ne contourne pas** : traite d'abord la dépendance.
2. `get_task` : fiche complète (dépendances et résultats, notes de relecture, instructions de l'agent assigné, questions liées avec réponses et images, liste des skills du projet).
3. Travail :
   - mode `main` : fais-le toi-même, ou délègue à un sous-agent générique ;
   - mode `team` : lance un sous-agent générique en lui transmettant le **prompt de l'agent assigné** (dans la fiche) et l'id de la tâche. Le sous-agent charge d'abord le schéma des outils `brigade` (ToolSearch), lit sa fiche avec `get_task` puis les skills utiles avec `get_skill`.
   - Tâches indépendantes et prêtes : plusieurs sous-agents en parallèle sont possibles.
4. `complete_task` avec un résultat concis et vérifiable (ce qui a été fait, fichiers, comment c'est vérifié). Le résultat est transmis aux tâches dépendantes.
5. Relecture si exigée : `review_task` (`approve` ou `changes` avec notes précises). Idéalement par un autre agent que l'auteur. Si `changes`, la tâche revient à reprendre en tenant compte des notes.
6. Reboucle avec `list_tasks` : de nouvelles tâches ont pu être débloquées.

Règles :
- Une tâche coincée ou abandonnée (« en cours » depuis longtemps) : `release_task` après vérification, jamais en silence.
- Tu ne supprimes pas de tâche ; l'humain le fait depuis l'interface. Pour ajuster : `update_task`, ou de nouvelles tâches via `create_tasks`.
- Un travail qui révèle une question de fond : dépose-la avec `ask_questions` (nouveau grill) au lieu de deviner, et continue sur ce qui n'est pas bloqué.
- Fin de session : résume l'état (fait / en cours / prochain pas) ; Brigade a déjà tout l'état, rien à sauvegarder à part.
