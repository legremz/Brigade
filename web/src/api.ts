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
  review_notes: string;
  depends_on: TaskRef[];
  blocked_by: TaskRef[];
  ready: boolean;
  question_ids: string[];
}
export interface TaskPatch {
  title?: string;
  description?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  assignee?: string | null;
  review?: boolean | null;
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
export interface Attachment {
  id: string;
  question_id: string;
  mime: string;
  filename: string;
  size: number;
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
  attachments: Attachment[];
}
export interface GrillSummary {
  id: string;
  title: string;
  context: string;
  status: "open" | "submitted";
  created_at: string;
  total: number;
  answered: number;
}
export interface Grill extends GrillSummary {
  project: { id: string; slug: string; name: string };
  questions: Question[];
}

async function request<T>(method: string, path: string, body?: BodyInit, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`/api${path}`, { method, body, headers });
  if (!res.ok) {
    const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => undefined);
    throw new Error(msg ?? `Erreur ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
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
  answer: (qid: string, fields: { text?: string; skipped?: boolean }) => {
    const j = json(fields);
    return request<Question>("PUT", `/questions/${qid}/answer`, j.body, j.headers);
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
