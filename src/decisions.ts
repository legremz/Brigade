import { db } from "./db.js";
import { getProject, getQuestion, InvalidError, newId, NotFoundError, now, type Question } from "./store.js";
import { resolveTaskRef } from "./tasks.js";

export interface DecisionQuestion {
  id: string;
  grill_id: string;
  position: number;
  text: string;
}
export interface DecisionTask {
  id: string;
  seq: number;
  title: string;
}
/** linked = question encore présente ; deleted = grill source supprimé depuis ; none = jamais de question source. */
export type DecisionSource = "linked" | "deleted" | "none";
export interface Decision {
  id: string;
  project_id: string;
  decision: string;
  reason: string;
  created_at: string;
  source: DecisionSource;
  /** Null si la source a disparu ou n'a jamais existé : voir `source`. */
  question: DecisionQuestion | null;
  /** Texte de la question au moment de la décision, null s'il n'y a jamais eu de source. */
  question_text: string | null;
  tasks: DecisionTask[];
}
export interface NewDecision {
  decision: string;
  reason: string;
  question_id?: string;
  task_ids?: string[];
}
export interface AwaitingDecision {
  id: string;
  grill_id: string;
  grill_title: string;
  position: number;
  text: string;
}

interface DecisionRow {
  id: string;
  project_id: string;
  decision: string;
  reason: string;
  question_id: string | null;
  question_text: string | null;
  created_at: string;
}

const RECENT_FIRST = "ORDER BY d.created_at DESC, d.rowid DESC";

function sourceOf(row: DecisionRow): DecisionSource {
  if (row.question_id) return "linked";
  return row.question_text === null ? "none" : "deleted";
}

function hydrate(row: DecisionRow): Decision {
  const question = row.question_id
    ? (db.prepare("SELECT id, grill_id, position, text FROM questions WHERE id = ?").get(row.question_id) as unknown as DecisionQuestion | undefined)
    : undefined;
  const tasks = db
    .prepare(
      `SELECT t.id, t.seq, t.title FROM tasks t JOIN decision_tasks dt ON dt.task_id = t.id
       WHERE dt.decision_id = ? ORDER BY t.seq`,
    )
    .all(row.id) as unknown as DecisionTask[];
  return {
    id: row.id,
    project_id: row.project_id,
    decision: row.decision,
    reason: row.reason,
    created_at: row.created_at,
    source: sourceOf(row),
    question: question ?? null,
    question_text: row.question_text,
    tasks,
  };
}

function questionInProject(questionId: string, projectId: string): Question {
  const found = db
    .prepare("SELECT 1 FROM questions q JOIN grills g ON g.id = q.grill_id WHERE q.id = ? AND g.project_id = ?")
    .get(questionId, projectId);
  if (!found) throw new NotFoundError(`Question introuvable dans ce projet : « ${questionId} ».`);
  return getQuestion(questionId);
}

/** Sur une question critique, l'agent ne tranche pas à la place de l'utilisateur : il faut un avis de sa part. */
function assertCriticalAnswered(q: Question): void {
  // Sous « plus tard » ou « pas pertinent », un texte ou une image restent une note, pas une réponse.
  const setAside = q.outcome === "later" || q.outcome === "not_relevant";
  const hasAnswer = !setAside && (q.answer_text.trim() !== "" || q.attachments.length > 0);
  const hasUserInput = hasAnswer || q.outcome === "accept_default";
  if (q.critical && !hasUserInput)
    throw new InvalidError("Décision refusée : cette question critique n'a pas de réponse de l'utilisateur. Attends sa réponse.");
}

/** Enregistre une décision : c'est aussi ce qui clôt le « Décide pour moi » de sa question source. */
export function recordDecision(projectRef: string, input: NewDecision): Decision {
  const project = getProject(projectRef);
  const decision = input.decision.trim();
  const reason = input.reason.trim();
  if (!decision) throw new InvalidError("La décision est vide.");
  if (!reason) throw new InvalidError("La raison est vide : une décision sans raison ne peut pas être rejouée.");
  const question = input.question_id ? questionInProject(input.question_id, project.id) : null;
  if (question) assertCriticalAnswered(question);
  const taskIds = new Set((input.task_ids ?? []).map((ref) => resolveTaskRef(project.id, ref)));

  const id = newId("d");
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO decisions (id, project_id, decision, reason, question_id, question_text, created_at) VALUES (?,?,?,?,?,?,?)").run(
      id,
      project.id,
      decision,
      reason,
      question?.id ?? null,
      question?.text ?? null,
      now(),
    );
    const link = db.prepare("INSERT INTO decision_tasks (decision_id, task_id) VALUES (?,?)");
    for (const taskId of taskIds) link.run(id, taskId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getDecision(id);
}

export function getDecision(id: string): Decision {
  const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as DecisionRow | undefined;
  if (!row) throw new NotFoundError(`Décision introuvable : « ${id} ». Utilise list_decisions.`);
  return hydrate(row);
}

export function listDecisions(projectRef: string): Decision[] {
  const project = getProject(projectRef);
  const rows = db.prepare(`SELECT d.* FROM decisions d WHERE d.project_id = ? ${RECENT_FIRST}`).all(project.id) as unknown as DecisionRow[];
  return rows.map(hydrate);
}

export function decisionsForQuestion(questionId: string): Decision[] {
  const rows = db.prepare(`SELECT d.* FROM decisions d WHERE d.question_id = ? ${RECENT_FIRST}`).all(questionId) as unknown as DecisionRow[];
  return rows.map(hydrate);
}

/** Décisions à transmettre à l'agent d'une tâche : celles de la tâche et celles des questions qui lui sont liées. */
export function decisionsForTask(taskId: string): Decision[] {
  const rows = db
    .prepare(
      `SELECT d.* FROM decisions d
       WHERE d.id IN (SELECT decision_id FROM decision_tasks WHERE task_id = ?)
          OR d.question_id IN (SELECT question_id FROM task_questions WHERE task_id = ?)
       ${RECENT_FIRST}`,
    )
    .all(taskId, taskId) as unknown as DecisionRow[];
  return rows.map(hydrate);
}

export function listAwaitingDecisions(projectRef: string): AwaitingDecision[] {
  const project = getProject(projectRef);
  return db
    .prepare(
      `SELECT q.id, q.grill_id, g.title AS grill_title, q.position, q.text
       FROM questions q JOIN grills g ON g.id = q.grill_id
       WHERE g.project_id = ? AND q.outcome = 'decide_for_me'
         AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.question_id = q.id)
       ORDER BY g.created_at, q.position`,
    )
    .all(project.id) as unknown as AwaitingDecision[];
}
