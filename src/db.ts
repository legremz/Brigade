import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "brigade.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

/** Migrations incrémentales, indexées par PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE grills (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted')),
    created_at TEXT NOT NULL,
    submitted_at TEXT
  );
  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    grill_id TEXT NOT NULL REFERENCES grills(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    choices TEXT,               -- JSON array de suggestions, ou NULL
    answer_text TEXT NOT NULL DEFAULT '',
    skipped INTEGER NOT NULL DEFAULT 0,
    answered_at TEXT
  );
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_grills_project ON grills(project_id);
  CREATE INDEX idx_questions_grill ON questions(grill_id, position);
  CREATE INDEX idx_attachments_question ON attachments(question_id);
  `,
  `
  ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'main' CHECK (mode IN ('main','team'));
  ALTER TABLE projects ADD COLUMN default_model TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (project_id, name)
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','review','done')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
    difficulty TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
    assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    reviewer_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    review_required INTEGER,           -- NULL = hérite du réglage du projet
    result TEXT NOT NULL DEFAULT '',
    review_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE (project_id, seq)
  );
  CREATE TABLE task_deps (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_id),
    CHECK (task_id <> depends_on_id)
  );
  CREATE TABLE task_questions (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, question_id)
  );
  CREATE INDEX idx_tasks_project ON tasks(project_id, status);
  CREATE INDEX idx_task_deps_dep ON task_deps(depends_on_id);
  `,
  // 3 : skills / instructions par projet (format compatible SKILL.md)
  `
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    always INTEGER NOT NULL DEFAULT 0,  -- 1 = à lire au démarrage de toute session sur le projet
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, name)
  );
  `,
  // 4 : trace d'un passage forcé en « terminée » malgré dépendances ou relecture
  `
  ALTER TABLE tasks ADD COLUMN forced_note TEXT NOT NULL DEFAULT '';
  `,
  // 5 : commande ou contrôle prouvant qu'une tâche est finie
  `
  ALTER TABLE tasks ADD COLUMN verification TEXT NOT NULL DEFAULT '';
  `,
  // 6 : suivi de la lecture d'un grill par get_answers (les grills déjà lus avant cette version repartent de zéro)
  `
  ALTER TABLE grills ADD COLUMN last_read_at TEXT;
  ALTER TABLE questions ADD COLUMN modified_since_read INTEGER NOT NULL DEFAULT 0;
  `,
  // 7 : criticité, réponse par défaut et sortie explicite. « skipped » reste tel quel : son intention d'origine est inconnue.
  `
  ALTER TABLE questions ADD COLUMN critical INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE questions ADD COLUMN default_answer TEXT NOT NULL DEFAULT '';
  ALTER TABLE questions ADD COLUMN outcome TEXT CHECK (outcome IN ('accept_default','decide_for_me','not_relevant','later'));
  `,
  // 8 : registre des décisions. Une décision survit à sa question et à ses tâches ; seule la suppression du projet l'emporte.
  `
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
    question_text TEXT,  -- copie à l'enregistrement : garde le sens si le grill source disparaît ; NULL = jamais de source
    created_at TEXT NOT NULL
  );
  CREATE TABLE decision_tasks (
    decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (decision_id, task_id)
  );
  CREATE INDEX idx_decisions_project ON decisions(project_id, created_at);
  CREATE INDEX idx_decisions_question ON decisions(question_id);
  CREATE INDEX idx_decision_tasks_task ON decision_tasks(task_id);
  `,
  // 9 : tâche réservée à l'humain. Toujours explicite : aucune tâche existante n'est marquée, surtout pas d'après son titre.
  `
  ALTER TABLE tasks ADD COLUMN for_human INTEGER NOT NULL DEFAULT 0 CHECK (for_human IN (0,1));
  `,
];

const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
for (let v = current; v < MIGRATIONS.length; v++) {
  db.exec("BEGIN");
  try {
    db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
