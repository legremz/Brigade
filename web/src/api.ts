export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  created_at: string;
  open_grills?: number;
  pending_questions?: number;
  mode: "main" | "team";
  default_model: string;
  review_required: boolean;
}
export type Status = "todo" | "in_progress" | "review" | "done";
export type Priority = "low" | "medium" | "high" | "urgent";
export type Difficulty = "easy" | "medium" | "hard";
export interface TaskRef { id: string; seq: number; title: string; status: Status }
export interface Task {
  id: string;
  project_id: string;
  seq: number;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  difficulty: Difficulty;
  assignee: { id: string; name: string } | null;
  reviewer: { id: string; name: string } | null;
  review_required: boolean | null;
  review_effective: boolean;
  result: string;
  verification: string;
  review_notes: string;
  forced_note: string;
  depends_on: TaskRef[];
  blocked_by: TaskRef[];
  ready: boolean;
  question_ids: string[];
  for_human: boolean;
  stale: boolean;
  stale_for: string | null;
}
export interface TaskPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  assignee?: string | null;
  review?: boolean | null;
  for_human?: boolean;
  add_depends_on?: string[];
  remove_depends_on?: string[];
  link_questions?: string[];
  unlink_questions?: string[];
}
export interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  prompt: string;
  busy_with: { id: string; seq: number; title: string }[];
  available: boolean;
}
export interface ProjectQuestion {
  id: string;
  grill_id: string;
  grill_title: string;
  position: number;
  text: string;
  answered: boolean;
}
export interface QueueProject { id: string; slug: string; name: string }
export interface QueueTask { id: string; seq: number; title: string; priority: Priority }
export type GrillQueueItem =
  | { type: "grill_unanswered"; project: QueueProject; grill: { id: string; title: string }; unanswered: number; total: number }
  | { type: "grill_complete"; project: QueueProject; grill: { id: string; title: string }; total: number };
export type TaskQueueItem =
  | { type: "task_review"; project: QueueProject; task: QueueTask }
  | { type: "task_stale"; project: QueueProject; task: QueueTask; stale_for: string }
  | { type: "task_human_ready"; project: QueueProject; task: QueueTask };
export type QueueItem = GrillQueueItem | TaskQueueItem;
export interface HumanQueue {
  grills: GrillQueueItem[];
  human_tasks: TaskQueueItem[];
  agent_tasks: TaskQueueItem[];
  total: number;
  up_to_date: boolean;
}
export interface Attachment {
  id: string;
  question_id: string;
  mime: string;
  filename: string;
  size: number;
}
export type Outcome = "accept_default" | "decide_for_me" | "not_relevant" | "later";
export interface Question {
  id: string;
  grill_id: string;
  position: number;
  text: string;
  hint: string;
  choices: string[] | null;
  critical: boolean;
  default_answer: string;
  answer_text: string;
  skipped: boolean;
  outcome: Outcome | null;
  available_outcomes: Outcome[];
  answered: boolean;
  modified_since_read: boolean;
  awaiting_decision: boolean;
  attachments: Attachment[];
}
export interface Decision {
  id: string;
  decision: string;
  reason: string;
  created_at: string;
  source: "linked" | "deleted" | "none";
  question: { id: string; grill_id: string; position: number; text: string } | null;
  question_text: string | null;
  tasks: { id: string; seq: number; title: string }[];
}
export interface GrillSummary {
  id: string;
  title: string;
  context: string;
  status: "open" | "submitted";
  created_at: string;
  last_read_at: string | null;
  total: number;
  answered: number;
}
export interface Grill extends GrillSummary {
  project: { id: string; slug: string; name: string };
  questions: Question[];
}

/** Erreur renvoyée par l'API, avec le code métier éventuel (ex. `force_required`). */
export class ApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: BodyInit, headers?: Record<string, string>, keepalive = false): Promise<T> {
  const res = await fetch(`/api${path}`, { method, body, headers, keepalive });
  if (!res.ok) {
    const payload = await res.json().then((j: { error?: string; code?: string }) => j).catch(() => undefined);
    throw new ApiError(payload?.error ?? `Erreur ${res.status}`, payload?.code);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
/** Le navigateur refuse un corps keepalive de plus de 64 Kio ; un caractère UTF-16 fait au plus 3 octets en UTF-8. */
const KEEPALIVE_MAX_CHARS = 20000;
const json = (v: unknown) => ({ body: JSON.stringify(v), headers: { "content-type": "application/json" } });

export interface Skill {
  id: string;
  project_id: string;
  name: string;
  description: string;
  content: string;
  always: boolean;
  created_at: string;
  updated_at: string;
}

export const api = {
  projects: () => request<Project[]>("GET", "/projects"),
  queue: () => request<HumanQueue>("GET", "/queue"),
  project: (ref: string) => request<Project>("GET", `/projects/${ref}`),
  createProject: (name: string, description: string) => {
    const j = json({ name, description });
    return request<Project>("POST", "/projects", j.body, j.headers);
  },
  deleteProject: (ref: string) => request<void>("DELETE", `/projects/${ref}`),
  grills: (ref: string) => request<GrillSummary[]>("GET", `/projects/${ref}/grills`),
  grill: (id: string) => request<Grill>("GET", `/grills/${id}`),
  setStatus: (id: string, status: "open" | "submitted") => {
    const j = json({ status });
    return request<Grill>("POST", `/grills/${id}/status`, j.body, j.headers);
  },
  deleteGrill: (id: string) => request<void>("DELETE", `/grills/${id}`),
  answer: (qid: string, fields: { text?: string; skipped?: boolean; outcome?: Outcome | null }) => {
    const j = json(fields);
    // keepalive : un enregistrement lancé en quittant la page doit aller au bout (mais le navigateur plafonne ces corps).
    return request<Question>("PUT", `/questions/${qid}/answer`, j.body, j.headers, j.body.length < KEEPALIVE_MAX_CHARS);
  },
  upload: (qid: string, blob: Blob, filename: string) =>
    request<Attachment>("POST", `/questions/${qid}/attachments?filename=${encodeURIComponent(filename)}`, blob, {
      "content-type": blob.type,
    }),
  deleteAttachment: (id: string) => request<void>("DELETE", `/attachments/${id}`),
  updateProject: (ref: string, patch: Partial<Pick<Project, "name" | "description" | "mode" | "default_model" | "review_required">>) => {
    const j = json(patch);
    return request<Project>("PATCH", `/projects/${ref}`, j.body, j.headers);
  },
  decisions: (ref: string) => request<Decision[]>("GET", `/projects/${ref}/decisions`),
  projectQuestions: (ref: string) => request<ProjectQuestion[]>("GET", `/projects/${ref}/questions`),
  tasks: (ref: string) => request<Task[]>("GET", `/projects/${ref}/tasks`),
  createTask: (ref: string, title: string) => {
    const j = json({ title });
    return request<Task>("POST", `/projects/${ref}/tasks`, j.body, j.headers);
  },
  updateTask: (id: string, patch: TaskPatch) => {
    const j = json(patch);
    return request<Task>("PATCH", `/tasks/${id}`, j.body, j.headers);
  },
  deleteTask: (id: string) => request<void>("DELETE", `/tasks/${id}`),
  taskAction: (id: string, body: Record<string, unknown>) => {
    const j = json(body);
    return request<Task>("POST", `/tasks/${id}/action`, j.body, j.headers);
  },
  agents: (ref: string) => request<Agent[]>("GET", `/projects/${ref}/agents`),
  createAgent: (ref: string, a: Partial<Agent> & { name: string }) => {
    const j = json(a);
    return request<Agent>("POST", `/projects/${ref}/agents`, j.body, j.headers);
  },
  updateAgent: (id: string, a: Partial<Agent>) => {
    const j = json(a);
    return request<Agent>("PATCH", `/agents/${id}`, j.body, j.headers);
  },
  deleteAgent: (id: string) => request<void>("DELETE", `/agents/${id}`),
  skills: (ref: string) => request<Skill[]>("GET", `/projects/${ref}/skills`),
  skill: (id: string) => request<Skill>("GET", `/skills/${id}`),
  createSkill: (ref: string, v: Partial<Skill> & { name: string }) => {
    const j = json(v);
    return request<Skill>("POST", `/projects/${ref}/skills`, j.body, j.headers);
  },
  updateSkill: (id: string, v: Partial<Skill>) => {
    const j = json(v);
    return request<Skill>("PATCH", `/skills/${id}`, j.body, j.headers);
  },
  importSkill: (ref: string, md: string, name?: string) =>
    request<Skill>("POST", `/projects/${ref}/skills/import${name ? `?name=${encodeURIComponent(name)}` : ""}`, md, { "content-type": "text/markdown" }),
  deleteSkill: (id: string) => request<void>("DELETE", `/skills/${id}`),
  skillMdUrl: (id: string) => `/api/skills/${id}/skill.md`,
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
};
