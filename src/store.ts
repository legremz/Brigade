import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENTS_DIR, db } from "./db.js";

export class NotFoundError extends Error {}
export class InvalidError extends Error {}

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// ---------- Types ----------

export type ProjectMode = "main" | "team";
export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  created_at: string;
  /** main = le chat courant fait le travail ; team = des sous-agents définis dans le projet. */
  mode: ProjectMode;
  default_model: string;
  review_required: boolean;
}
export interface ProjectSummary extends Project {
  open_grills: number;
  pending_questions: number;
}
export interface Attachment {
  id: string;
  question_id: string;
  mime: string;
  filename: string;
  size: number;
  created_at: string;
}
export interface Question {
  id: string;
  grill_id: string;
  position: number;
  text: string;
  hint: string;
  choices: string[] | null;
  answer_text: string;
  skipped: boolean;
  answered: boolean;
  answered_at: string | null;
  attachments: Attachment[];
}
export interface GrillSummary {
  id: string;
  project_id: string;
  title: string;
  context: string;
  status: "open" | "submitted";
  created_at: string;
  submitted_at: string | null;
  total: number;
  answered: number;
}
export interface Grill extends GrillSummary {
  project: Pick<Project, "id" | "slug" | "name">;
  questions: Question[];
}

type Row = Record<string, unknown>;

const toProject = <T extends object>(row: T): T & Pick<Project, "review_required"> => ({
  ...row,
  review_required: Boolean((row as Row).review_required),
});

// ---------- Projets ----------

const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "projet";

export function createProject(name: string, description = ""): Project {
  if (!name.trim()) throw new InvalidError("Le nom du projet est vide.");
  const base = slugify(name);
  let slug = base;
  for (let i = 2; db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug); i++) slug = `${base}-${i}`;
  const project: Project = {
    id: newId("p"),
    slug,
    name: name.trim(),
    description,
    created_at: now(),
    mode: "main",
    default_model: "",
    review_required: false,
  };
  db.prepare("INSERT INTO projects (id, slug, name, description, created_at) VALUES (?,?,?,?,?)").run(
    project.id,
    project.slug,
    project.name,
    project.description,
    project.created_at,
  );
  return project;
}

export function getProject(ref: string): Project {
  const row = db.prepare("SELECT * FROM projects WHERE id = ? OR slug = ?").get(ref, ref) as Project | undefined;
  if (!row) throw new NotFoundError(`Projet introuvable : « ${ref} ». Utilise list_projects.`);
  return toProject(row);
}

export function listProjects(): ProjectSummary[] {
  const rows = db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM grills g WHERE g.project_id = p.id AND g.status = 'open') AS open_grills,
        (SELECT COUNT(*) FROM questions q JOIN grills g ON g.id = q.grill_id
           WHERE g.project_id = p.id AND g.status = 'open' AND q.answered_at IS NULL) AS pending_questions
       FROM projects p ORDER BY p.created_at DESC`,
    )
    .all() as unknown as ProjectSummary[];
  return rows.map(toProject);
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  mode?: ProjectMode;
  default_model?: string;
  review_required?: boolean;
}

export function updateProject(ref: string, fields: ProjectPatch): Project {
  const p = getProject(ref);
  const next: Project = {
    ...p,
    name: fields.name?.trim() || p.name,
    description: fields.description ?? p.description,
    mode: fields.mode ?? p.mode,
    default_model: fields.default_model ?? p.default_model,
    review_required: fields.review_required ?? p.review_required,
  };
  db.prepare(
    "UPDATE projects SET name = ?, description = ?, mode = ?, default_model = ?, review_required = ? WHERE id = ?",
  ).run(next.name, next.description, next.mode, next.default_model, next.review_required ? 1 : 0, p.id);
  return next;
}

export function deleteProject(ref: string): void {
  const p = getProject(ref);
  const atts = db
    .prepare(
      `SELECT a.id FROM attachments a JOIN questions q ON q.id = a.question_id
       JOIN grills g ON g.id = q.grill_id WHERE g.project_id = ?`,
    )
    .all(p.id) as Row[];
  db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
  for (const a of atts) rmSync(join(ATTACHMENTS_DIR, String(a.id)), { force: true });
}

// ---------- Grills ----------

export interface NewQuestion {
  text: string;
  hint?: string;
  choices?: string[];
}

export function createGrill(projectRef: string, title: string, context: string, questions: NewQuestion[]): Grill {
  const project = getProject(projectRef);
  if (!title.trim()) throw new InvalidError("Le titre du grill est vide.");
  if (questions.length === 0) throw new InvalidError("Un grill doit contenir au moins une question.");
  const id = newId("g");
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO grills (id, project_id, title, context, created_at) VALUES (?,?,?,?,?)").run(
      id,
      project.id,
      title.trim(),
      context,
      now(),
    );
    const ins = db.prepare(
      "INSERT INTO questions (id, grill_id, position, text, hint, choices) VALUES (?,?,?,?,?,?)",
    );
    questions.forEach((q, i) => {
      if (!q.text.trim()) throw new InvalidError(`La question ${i + 1} est vide.`);
      ins.run(newId("q"), id, i + 1, q.text, q.hint ?? "", q.choices?.length ? JSON.stringify(q.choices) : null);
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getGrill(id);
}

const grillSummarySql = `
  SELECT g.*,
    (SELECT COUNT(*) FROM questions q WHERE q.grill_id = g.id) AS total,
    (SELECT COUNT(*) FROM questions q WHERE q.grill_id = g.id AND q.answered_at IS NOT NULL) AS answered
  FROM grills g`;

export function listGrills(projectRef: string, status?: "open" | "submitted"): GrillSummary[] {
  const p = getProject(projectRef);
  const sql = `${grillSummarySql} WHERE g.project_id = ? ${status ? "AND g.status = ?" : ""} ORDER BY g.created_at DESC`;
  const args = status ? [p.id, status] : [p.id];
  return db.prepare(sql).all(...args) as unknown as GrillSummary[];
}

function toQuestion(row: Row, attachments: Attachment[]): Question {
  return {
    id: String(row.id),
    grill_id: String(row.grill_id),
    position: Number(row.position),
    text: String(row.text),
    hint: String(row.hint),
    choices: row.choices ? (JSON.parse(String(row.choices)) as string[]) : null,
    answer_text: String(row.answer_text),
    skipped: Boolean(row.skipped),
    answered: row.answered_at != null,
    answered_at: row.answered_at ? String(row.answered_at) : null,
    attachments,
  };
}

function attachmentsByQuestion(grillId: string): Map<string, Attachment[]> {
  const rows = db
    .prepare(
      `SELECT a.* FROM attachments a JOIN questions q ON q.id = a.question_id
       WHERE q.grill_id = ? ORDER BY a.created_at`,
    )
    .all(grillId) as unknown as Attachment[];
  const map = new Map<string, Attachment[]>();
  for (const a of rows) map.set(a.question_id, [...(map.get(a.question_id) ?? []), a]);
  return map;
}

export function getGrill(id: string): Grill {
  const row = db.prepare(`${grillSummarySql} WHERE g.id = ?`).get(id) as GrillSummary | undefined;
  if (!row) throw new NotFoundError(`Grill introuvable : « ${id} ». Utilise list_grills.`);
  const project = db.prepare("SELECT id, slug, name FROM projects WHERE id = ?").get(row.project_id) as Grill["project"];
  const atts = attachmentsByQuestion(id);
  const questions = (db.prepare("SELECT * FROM questions WHERE grill_id = ? ORDER BY position").all(id) as Row[]).map(
    (q) => toQuestion(q, atts.get(String(q.id)) ?? []),
  );
  return { ...row, project, questions };
}

export function setGrillStatus(id: string, status: "open" | "submitted"): Grill {
  getGrill(id);
  db.prepare("UPDATE grills SET status = ?, submitted_at = ? WHERE id = ?").run(
    status,
    status === "submitted" ? now() : null,
    id,
  );
  return getGrill(id);
}

export function deleteGrill(id: string): void {
  const g = getGrill(id);
  const ids = g.questions.flatMap((q) => q.attachments.map((a) => a.id));
  db.prepare("DELETE FROM grills WHERE id = ?").run(id);
  for (const a of ids) rmSync(join(ATTACHMENTS_DIR, a), { force: true });
}

// ---------- Questions et réponses ----------

export function getQuestion(id: string): Question & { grill: Pick<GrillSummary, "id" | "title" | "status"> } {
  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new NotFoundError(`Question introuvable : « ${id} ».`);
  const attachments = db
    .prepare("SELECT * FROM attachments WHERE question_id = ? ORDER BY created_at")
    .all(id) as unknown as Attachment[];
  const grill = db.prepare("SELECT id, title, status FROM grills WHERE id = ?").get(String(row.grill_id)) as Pick<
    GrillSummary,
    "id" | "title" | "status"
  >;
  return { ...toQuestion(row, attachments), grill };
}

/** Une question est « répondue » si elle a du texte, une image, ou si elle est explicitement passée. */
export function setAnswer(questionId: string, fields: { text?: string; skipped?: boolean }): Question {
  const q = getQuestion(questionId);
  const text = fields.text ?? q.answer_text;
  const skipped = fields.skipped ?? q.skipped;
  const answered = text.trim() !== "" || q.attachments.length > 0 || skipped;
  db.prepare("UPDATE questions SET answer_text = ?, skipped = ?, answered_at = ? WHERE id = ?").run(
    text,
    skipped ? 1 : 0,
    answered ? (q.answered_at ?? now()) : null,
    questionId,
  );
  return getQuestion(questionId);
}

// ---------- Pièces jointes ----------

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function addAttachment(questionId: string, mime: string, filename: string, data: Buffer): Attachment {
  getQuestion(questionId);
  if (!ALLOWED_MIME.has(mime)) throw new InvalidError(`Type d'image non géré : ${mime}.`);
  if (data.length === 0) throw new InvalidError("Image vide.");
  if (data.length > MAX_ATTACHMENT_BYTES) throw new InvalidError("Image trop lourde (10 Mo max).");
  const att: Attachment = {
    id: newId("a"),
    question_id: questionId,
    mime,
    filename: filename.slice(0, 120) || "image",
    size: data.length,
    created_at: now(),
  };
  writeFileSync(join(ATTACHMENTS_DIR, att.id), data);
  db.prepare("INSERT INTO attachments (id, question_id, mime, filename, size, created_at) VALUES (?,?,?,?,?,?)").run(
    att.id,
    att.question_id,
    att.mime,
    att.filename,
    att.size,
    att.created_at,
  );
  setAnswer(questionId, {}); // recalcule « répondue »
  return att;
}

export function getAttachment(id: string): { meta: Attachment; data: Buffer } {
  const meta = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Attachment | undefined;
  if (!meta) throw new NotFoundError(`Pièce jointe introuvable : « ${id} ».`);
  return { meta, data: readFileSync(join(ATTACHMENTS_DIR, id)) };
}

export function deleteAttachment(id: string): void {
  const meta = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Attachment | undefined;
  if (!meta) throw new NotFoundError(`Pièce jointe introuvable : « ${id} ».`);
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  rmSync(join(ATTACHMENTS_DIR, id), { force: true });
  setAnswer(meta.question_id, {}); // recalcule « répondue »
}

export interface ProjectQuestion {
  id: string;
  grill_id: string;
  grill_title: string;
  position: number;
  text: string;
  answered: boolean;
}

/** Toutes les questions d'un projet (pour relier des tâches à des questions du grill). */
export function listProjectQuestions(projectRef: string): ProjectQuestion[] {
  const p = getProject(projectRef);
  const rows = db
    .prepare(
      `SELECT q.id, q.grill_id, g.title AS grill_title, q.position, q.text, q.answered_at
       FROM questions q JOIN grills g ON g.id = q.grill_id
       WHERE g.project_id = ? ORDER BY g.created_at, q.position`,
    )
    .all(p.id) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    grill_id: String(r.grill_id),
    grill_title: String(r.grill_title),
    position: Number(r.position),
    text: String(r.text),
    answered: r.answered_at != null,
  }));
}
