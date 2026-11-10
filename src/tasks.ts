import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { humanDuration, lastActivity, minutesSince, parseStaleMinutes } from "./stale.js";
import { InvalidError, NotFoundError, getProject, type Project } from "./store.js";

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;
type Row = Record<string, unknown>;

export const STATUSES = ["todo", "in_progress", "review", "done"] as const;
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Lu au chargement du module : une valeur invalide empêche le serveur de démarrer. */
const STALE_MINUTES = parseStaleMinutes(process.env.BRIGADE_STALE_MINUTES);

/** Déplacement refusé, mais qu'un humain peut imposer après confirmation explicite. */
export class ForceRequiredError extends InvalidError {}

// ================= Agents =================

export interface Agent {
  id: string;
  project_id: string;
  name: string;
  description: string;
  model: string;
  prompt: string;
  created_at: string;
}
export interface AgentStatus extends Agent {
  /** Tâches en cours (ou en relecture) assignées à cet agent. */
  busy_with: { id: string; seq: number; title: string }[];
  available: boolean;
}

export interface AgentInput {
  name: string;
  description?: string;
  model?: string;
  prompt?: string;
}

export function createAgent(projectRef: string, input: AgentInput): Agent {
  const project = getProject(projectRef);
  const name = input.name.trim();
  if (!name) throw new InvalidError("Le nom de l'agent est vide.");
  if (db.prepare("SELECT 1 FROM agents WHERE project_id = ? AND name = ?").get(project.id, name))
    throw new InvalidError(`Un agent « ${name} » existe déjà dans ce projet. Utilise save_agent pour le modifier.`);
  const agent: Agent = {
    id: newId("ag"),
    project_id: project.id,
    name,
    description: input.description ?? "",
    model: input.model ?? "",
    prompt: input.prompt ?? "",
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO agents (id, project_id, name, description, model, prompt, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(agent.id, agent.project_id, agent.name, agent.description, agent.model, agent.prompt, agent.created_at);
  return agent;
}

/** Résout un agent par id ou nom (dans un projet donné). */
export function resolveAgent(projectId: string, ref: string): Agent {
  const a = db.prepare("SELECT * FROM agents WHERE project_id = ? AND (id = ? OR name = ?)").get(projectId, ref, ref) as
    | Agent
    | undefined;
  if (!a) throw new NotFoundError(`Agent introuvable dans ce projet : « ${ref} ». Utilise list_agents.`);
  return a;
}

export function getAgent(id: string): Agent {
  const a = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
  if (!a) throw new NotFoundError(`Agent introuvable : « ${id} ».`);
  return a;
}

export function updateAgent(id: string, patch: Partial<AgentInput>): Agent {
  const a = getAgent(id);
  const next = {
    ...a,
    name: patch.name?.trim() || a.name,
    description: patch.description ?? a.description,
    model: patch.model ?? a.model,
    prompt: patch.prompt ?? a.prompt,
  };
  if (next.name !== a.name && db.prepare("SELECT 1 FROM agents WHERE project_id = ? AND name = ?").get(a.project_id, next.name))
    throw new InvalidError(`Un agent « ${next.name} » existe déjà.`);
  db.prepare("UPDATE agents SET name = ?, description = ?, model = ?, prompt = ? WHERE id = ?").run(
    next.name,
    next.description,
    next.model,
    next.prompt,
    id,
  );
  return next;
}

export function deleteAgent(id: string): void {
  getAgent(id);
  db.prepare("DELETE FROM agents WHERE id = ?").run(id); // assignations remises à NULL (ON DELETE SET NULL)
}

export function listAgents(projectRef: string): AgentStatus[] {
  const project = getProject(projectRef);
  const agents = db.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY name").all(project.id) as unknown as Agent[];
  return agents.map((a) => {
    const busy = db
      .prepare(
        "SELECT id, seq, title FROM tasks WHERE assignee_id = ? AND status IN ('in_progress','review') ORDER BY seq",
      )
      .all(a.id) as unknown as AgentStatus["busy_with"];
    return { ...a, busy_with: busy, available: busy.length === 0 };
  });
}

// ================= Tâches =================

export interface TaskRef {
  id: string;
  seq: number;
  title: string;
  status: Status;
}
export interface Task {
  id: string;
  project_id: string;
  seq: number;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  difficulty: Difficulty;
  assignee: Pick<Agent, "id" | "name"> | null;
  reviewer: Pick<Agent, "id" | "name"> | null;
  /** null = hérite du projet ; `review_effective` donne la valeur appliquée. */
  review_required: boolean | null;
  review_effective: boolean;
  result: string;
  /** Commande ou contrôle réalisé pour prouver le résultat. */
  verification: string;
  review_notes: string;
  /** Renseigné si un humain a imposé le passage en « terminée » malgré dépendances ou relecture. */
  forced_note: string;
  depends_on: TaskRef[];
  /** Dépendances pas encore terminées (et relues si la relecture est exigée). */
  blocked_by: TaskRef[];
  /** À faire et toutes les dépendances sont satisfaites : peut être démarrée. */
  ready: boolean;
  question_ids: string[];
  /** Tâche à faire par l'humain : exclue des actions suggérées aux agents. Toujours posé explicitement. */
  for_human: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  /** Le plus récent de `updated_at` et `started_at`. */
  last_activity_at: string;
  /** En cours sans activité depuis le seuil : à signaler, jamais libérée automatiquement. */
  stale: boolean;
  /** Durée lisible depuis la dernière activité (« 3 h »), renseignée seulement si `stale`. */
  stale_for: string | null;
}

const REF_SQL = "SELECT t.id, t.seq, t.title, t.status FROM tasks t JOIN task_deps d ON d.depends_on_id = t.id WHERE d.task_id = ? ORDER BY t.seq";

function activityOf(status: Status, updatedAt: string, startedAt: string | null): Pick<Task, "last_activity_at" | "stale" | "stale_for"> {
  const last_activity_at = lastActivity(updatedAt, startedAt);
  const idle = minutesSince(last_activity_at);
  const stale = status === "in_progress" && idle >= STALE_MINUTES;
  return { last_activity_at, stale, stale_for: stale ? humanDuration(idle) : null };
}

function toTask(row: Row, project: Project): Task {
  const id = String(row.id);
  const depends_on = db.prepare(REF_SQL).all(id) as unknown as TaskRef[];
  const blocked_by = depends_on.filter((d) => d.status !== "done");
  const agentOf = (aid: unknown) =>
    aid ? (db.prepare("SELECT id, name FROM agents WHERE id = ?").get(String(aid)) as Task["assignee"]) ?? null : null;
  const override = row.review_required == null ? null : Boolean(row.review_required);
  const status = String(row.status) as Status;
  const startedAt = row.started_at ? String(row.started_at) : null;
  return {
    id,
    project_id: String(row.project_id),
    seq: Number(row.seq),
    title: String(row.title),
    description: String(row.description),
    status,
    priority: String(row.priority) as Priority,
    difficulty: String(row.difficulty) as Difficulty,
    assignee: agentOf(row.assignee_id),
    reviewer: agentOf(row.reviewer_id),
    review_required: override,
    review_effective: override ?? project.review_required,
    result: String(row.result),
    verification: String(row.verification),
    review_notes: String(row.review_notes),
    forced_note: String(row.forced_note),
    depends_on,
    blocked_by,
    ready: status === "todo" && blocked_by.length === 0,
    question_ids: (db.prepare("SELECT question_id FROM task_questions WHERE task_id = ?").all(id) as Row[]).map((r) =>
      String(r.question_id),
    ),
    for_human: Boolean(row.for_human),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    started_at: startedAt,
    completed_at: row.completed_at ? String(row.completed_at) : null,
    ...activityOf(status, String(row.updated_at), startedAt),
  };
}

function rowOf(id: string): Row {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new NotFoundError(`Tâche introuvable : « ${id} ». Utilise list_tasks.`);
  return row;
}

const projectOfId = (projectId: string) => getProject(projectId);

export function getTask(id: string): Task {
  const row = rowOf(id);
  return toTask(row, projectOfId(String(row.project_id)));
}

const PRIORITY_ORDER = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

export function listTasks(projectRef: string, opts: { status?: Status; readyOnly?: boolean } = {}): Task[] {
  const project = getProject(projectRef);
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE project_id = ? ${opts.status ? "AND status = ?" : ""} ORDER BY ${PRIORITY_ORDER}, seq`)
    .all(...(opts.status ? [project.id, opts.status] : [project.id])) as Row[];
  const tasks = rows.map((r) => toTask(r, project));
  return opts.readyOnly ? tasks.filter((t) => t.ready) : tasks;
}

// ---- Dépendances ----

/** Vrai si `target` est atteignable depuis `from` en suivant « dépend de ». */
function reaches(from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of db.prepare("SELECT depends_on_id FROM task_deps WHERE task_id = ?").all(cur) as Row[])
      stack.push(String(r.depends_on_id));
  }
  return false;
}

function addDependency(taskId: string, dependsOnId: string): void {
  const a = rowOf(taskId);
  const b = rowOf(dependsOnId);
  if (a.project_id !== b.project_id) throw new InvalidError("Une dépendance doit rester dans le même projet.");
  if (taskId === dependsOnId) throw new InvalidError("Une tâche ne peut pas dépendre d'elle-même.");
  if (reaches(dependsOnId, taskId))
    throw new InvalidError(`Dépendance circulaire : #${b.seq} dépend déjà (directement ou non) de #${a.seq}.`);
  db.prepare("INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?,?)").run(taskId, dependsOnId);
}

/** Résout une référence de tâche : id existant, ou « #n » (numéro dans le projet). */
export function resolveTaskRef(projectId: string, ref: string): string {
  const seq = /^#?(\d+)$/.exec(ref.trim());
  const row = (
    seq
      ? db.prepare("SELECT id FROM tasks WHERE project_id = ? AND seq = ?").get(projectId, Number(seq[1]))
      : db.prepare("SELECT id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, ref)
  ) as Row | undefined;
  if (!row) throw new NotFoundError(`Tâche introuvable dans ce projet : « ${ref} ».`);
  return String(row.id);
}

function linkQuestion(taskId: string, projectId: string, questionId: string): void {
  const q = db
    .prepare(
      "SELECT q.id FROM questions q JOIN grills g ON g.id = q.grill_id WHERE q.id = ? AND g.project_id = ?",
    )
    .get(questionId, projectId);
  if (!q) throw new NotFoundError(`Question introuvable dans ce projet : « ${questionId} ».`);
  db.prepare("INSERT OR IGNORE INTO task_questions (task_id, question_id) VALUES (?,?)").run(taskId, questionId);
}

// ---- Création ----

export interface NewTask {
  /** Clé locale pour que d'autres tâches du même lot s'y réfèrent dans depends_on. */
  ref?: string;
  title: string;
  description?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  /** Nom ou id d'agent. */
  assignee?: string;
  reviewer?: string;
  /** null/absent = hérite du projet. */
  review?: boolean;
  /** `ref` d'une tâche du même lot, id de tâche existante, ou « #n ». */
  depends_on?: string[];
  question_ids?: string[];
  for_human?: boolean;
}

export function createTasks(projectRef: string, inputs: NewTask[]): Task[] {
  const project = getProject(projectRef);
  if (inputs.length === 0) throw new InvalidError("Aucune tâche à créer.");
  const created: string[] = [];
  const byRef = new Map<string, string>();
  db.exec("BEGIN");
  try {
    let seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM tasks WHERE project_id = ?").get(project.id) as Row).m as number;
    const ins = db.prepare(
      `INSERT INTO tasks (id, project_id, seq, title, description, priority, difficulty, assignee_id, reviewer_id,
         review_required, for_human, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const t of inputs) {
      if (!t.title.trim()) throw new InvalidError("Une tâche a un titre vide.");
      if (t.ref && byRef.has(t.ref)) throw new InvalidError(`Référence en double dans le lot : « ${t.ref} ».`);
      const id = newId("t");
      const ts = now();
      ins.run(
        id,
        project.id,
        ++seq,
        t.title.trim(),
        t.description ?? "",
        t.priority ?? "medium",
        t.difficulty ?? "medium",
        t.assignee ? resolveAgent(project.id, t.assignee).id : null,
        t.reviewer ? resolveAgent(project.id, t.reviewer).id : null,
        t.review == null ? null : t.review ? 1 : 0,
        t.for_human ? 1 : 0,
        ts,
        ts,
      );
      created.push(id);
      if (t.ref) byRef.set(t.ref, id);
    }
    // Dépendances et liens : après insertion, pour pouvoir viser n'importe quelle tâche du lot.
    inputs.forEach((t, i) => {
      const id = created[i]!;
      for (const dep of t.depends_on ?? [])
        addDependency(id, byRef.get(dep) ?? resolveTaskRef(project.id, dep));
      for (const qid of t.question_ids ?? []) linkQuestion(id, project.id, qid);
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return created.map(getTask);
}

// ---- Mise à jour (champs, pas le statut) ----

export interface TaskPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  /** Nom/id d'agent, ou null pour retirer l'assignation. */
  assignee?: string | null;
  reviewer?: string | null;
  /** true/false = surcharge ; null = hérite du projet. */
  review?: boolean | null;
  for_human?: boolean;
  add_depends_on?: string[];
  remove_depends_on?: string[];
  link_questions?: string[];
  unlink_questions?: string[];
}

type ColumnValue = string | number | null;

/** Colonnes à écrire pour un patch : seuls les champs présents, la résolution d'un agent inconnu annule la transaction. */
function patchColumns(patch: TaskPatch, projectId: string): [string, ColumnValue][] {
  const columns: [string, ColumnValue][] = [];
  const add = <T>(column: string, value: T | undefined, encode: (v: T) => ColumnValue) => {
    if (value !== undefined) columns.push([column, encode(value)]);
  };
  const asIs = (v: string) => v;
  const agentId = (ref: string | null) => (ref ? resolveAgent(projectId, ref).id : null);
  const title = (v: string) => {
    if (!v.trim()) throw new InvalidError("Le titre est vide.");
    return v.trim();
  };
  add("title", patch.title, title);
  add("description", patch.description, asIs);
  add("priority", patch.priority, asIs);
  add("difficulty", patch.difficulty, asIs);
  add("assignee_id", patch.assignee, agentId);
  add("reviewer_id", patch.reviewer, agentId);
  add("review_required", patch.review, (v: boolean | null) => (v === null ? null : Number(v)));
  add("for_human", patch.for_human, Number);
  return columns;
}

export function updateTask(id: string, patch: TaskPatch): Task {
  const row = rowOf(id);
  const projectId = String(row.project_id);
  db.exec("BEGIN");
  try {
    const columns = patchColumns(patch, projectId);
    columns.push(["updated_at", now()]);
    db.prepare(`UPDATE tasks SET ${columns.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`).run(...columns.map(([, value]) => value), id);

    for (const dep of patch.add_depends_on ?? []) addDependency(id, resolveTaskRef(projectId, dep));
    for (const dep of patch.remove_depends_on ?? [])
      db.prepare("DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?").run(id, resolveTaskRef(projectId, dep));
    for (const q of patch.link_questions ?? []) linkQuestion(id, projectId, q);
    for (const q of patch.unlink_questions ?? [])
      db.prepare("DELETE FROM task_questions WHERE task_id = ? AND question_id = ?").run(id, q);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getTask(id);
}

export function deleteTask(id: string): void {
  rowOf(id);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

// ---- Cycle de vie ----
// todo → in_progress → (review →) done. Les dépendances sont vérifiées au démarrage, côté serveur.

const touch = (id: string, sql: string, ...args: (string | null)[]) =>
  db.prepare(`UPDATE tasks SET ${sql}, updated_at = ? WHERE id = ?`).run(...args, now(), id);

function expectStatus(t: Task, ...allowed: Status[]): void {
  if (!allowed.includes(t.status))
    throw new InvalidError(
      `La tâche #${t.seq} est « ${t.status} » : action possible seulement depuis ${allowed.map((s) => `« ${s} »`).join(" ou ")}.`,
    );
}

const openDependencies = (t: Task): string =>
  `dépendance(s) non terminée(s) : ${t.blocked_by.map((d) => `#${d.seq}`).join(", ")}`;

/** Trace d'une fin atteinte alors qu'une dépendance est ouverte ; vide sinon. */
const openDependencyNote = (t: Task): string =>
  t.blocked_by.length ? `Fin déclarée le ${now()} malgré : ${openDependencies(t)}.` : "";

/** Une note de forçage ne disparaît qu'au retour à « à faire » : la relecture d'une fin imposée la conserve. */
const keptForcedNote = (t: Task, status: Status): string => (status === "todo" ? "" : t.forced_note);

/** Démarrage atomique : refuse si une dépendance n'est pas terminée (et relue si exigé). */
export function startTask(id: string, agentRef?: string): Task {
  db.exec("BEGIN IMMEDIATE");
  try {
    const t = getTask(id);
    expectStatus(t, "todo");
    if (t.blocked_by.length)
      throw new InvalidError(
        `La tâche #${t.seq} est bloquée par : ${t.blocked_by.map((d) => `#${d.seq} « ${d.title} » (${d.status})`).join(", ")}. ` +
          `Une dépendance doit être terminée${t.review_effective ? " et relue" : ""} avant.`,
      );
    if (agentRef) touch(id, "assignee_id = ?", resolveAgent(t.project_id, agentRef).id);
    touch(id, "status = 'in_progress', started_at = ?, completed_at = NULL", now());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getTask(id);
}

/** Fin du travail : passe en relecture si exigée, sinon terminée. */
export function completeTask(id: string, result: string, verification: string): Task {
  const t = getTask(id);
  expectStatus(t, "in_progress");
  if (!result.trim()) throw new InvalidError("Le résultat est vide : décris ce qui a été fait.");
  if (!verification.trim()) throw new InvalidError("La vérification est vide : indique la commande ou le contrôle réalisé.");
  const next: Status = t.review_effective ? "review" : "done";
  // Possible après un déplacement manuel en « En cours » : pas de refus, mais la fin ne doit pas passer inaperçue.
  const forcedNote = openDependencyNote(t);
  touch(
    id,
    "status = ?, result = ?, verification = ?, completed_at = ?, review_notes = '', forced_note = ?",
    next,
    result.trim(),
    verification.trim(),
    next === "done" ? now() : null,
    forcedNote,
  );
  return getTask(id);
}

export function reviewTask(id: string, verdict: "approve" | "changes", notes: string): Task {
  const t = getTask(id);
  expectStatus(t, "review");
  if (verdict === "approve")
    touch(id, "status = 'done', review_notes = ?, completed_at = ?, forced_note = ?", notes, now(), t.forced_note || openDependencyNote(t));
  else {
    if (!notes.trim()) throw new InvalidError("Précise ce qu'il faut corriger (notes) pour demander des changements.");
    touch(id, "status = 'todo', review_notes = ?, completed_at = NULL, forced_note = ''", notes);
  }
  return getTask(id);
}

/** Remet une tâche en cours ou en relecture à « à faire » (agent planté, changement de plan…). */
export function releaseTask(id: string): Task {
  const t = getTask(id);
  expectStatus(t, "in_progress", "review");
  touch(id, "status = 'todo', started_at = NULL, completed_at = NULL, forced_note = ''");
  return getTask(id);
}

function doneBlockers(t: Task): string[] {
  const blockers: string[] = [];
  if (t.blocked_by.length) blockers.push(openDependencies(t));
  if (t.review_effective) blockers.push("relecture non approuvée");
  return blockers;
}

/**
 * Déplacement manuel depuis l'interface. Le passage en « terminée » respecte dépendances et relecture :
 * l'humain garde le dernier mot, mais seulement par un `force` explicite, tracé sur la tâche.
 */
export function forceStatus(id: string, status: Status, opts: { force?: boolean } = {}): Task {
  const t = getTask(id);
  if (t.status === status) return t;
  const blockers = status === "done" ? doneBlockers(t) : [];
  if (blockers.length && !opts.force)
    throw new ForceRequiredError(`La tâche #${t.seq} ne peut pas passer en « Terminées » : ${blockers.join(" ; ")}.`);
  const ts = now();
  const forcedNote = blockers.length ? `Terminée manuellement le ${ts} malgré : ${blockers.join(" ; ")}.` : keptForcedNote(t, status);
  touch(
    id,
    "status = ?, started_at = CASE WHEN ? = 'todo' THEN NULL ELSE COALESCE(started_at, ?) END, completed_at = ?, forced_note = ?",
    status,
    status,
    ts,
    status === "done" ? ts : null,
    forcedNote,
  );
  return getTask(id);
}
