import { listGrills, listProjects, type GrillSummary, type ProjectSummary } from "./store.js";
import { PRIORITIES, listTasks, type Task } from "./tasks.js";

type ProjectRef = Pick<ProjectSummary, "id" | "slug" | "name">;
type GrillRef = Pick<GrillSummary, "id" | "title">;
type TaskRef = Pick<Task, "id" | "seq" | "title" | "priority">;

export type GrillItem =
  | { type: "grill_unanswered"; project: ProjectRef; grill: GrillRef; unanswered: number; total: number }
  | { type: "grill_complete"; project: ProjectRef; grill: GrillRef; total: number };
export type TaskItem =
  | { type: "task_review"; project: ProjectRef; task: TaskRef }
  | { type: "task_stale"; project: ProjectRef; task: TaskRef; stale_for: string }
  | { type: "task_human_ready"; project: ProjectRef; task: TaskRef };

export interface HumanQueue {
  /** Grills qui attendent une réponse ou d'être marqués terminés. */
  grills: GrillItem[];
  /** Validations humaines : tout élément porté par une tâche marquée « pour l'humain ». */
  human_tasks: TaskItem[];
  /** Tâches d'agents qui attendent une intervention. */
  agent_tasks: TaskItem[];
  total: number;
  /** Vrai seulement si la file est vide ; seul fondement du « À jour » affiché. */
  up_to_date: boolean;
}

function grillItem(project: ProjectRef, grill: GrillSummary): GrillItem {
  const ref = { id: grill.id, title: grill.title };
  // « Plus tard » renseigne answered_at : une question reportée compte déjà comme traitée.
  const unanswered = grill.total - grill.answered;
  if (unanswered > 0) return { type: "grill_unanswered", project, grill: ref, unanswered, total: grill.total };
  return { type: "grill_complete", project, grill: ref, total: grill.total };
}

/** Une tâche donne au plus un élément : ses statuts d'attente s'excluent. */
function taskItem(project: ProjectRef, t: Task): TaskItem | null {
  const task = { id: t.id, seq: t.seq, title: t.title, priority: t.priority };
  if (t.status === "review") return { type: "task_review", project, task };
  if (t.stale_for !== null) return { type: "task_stale", project, task, stale_for: t.stale_for };
  if (t.for_human && t.ready) return { type: "task_human_ready", project, task };
  return null;
}

/** Urgentes d'abord ; le tri est stable : à priorité égale, l'ordre des projets et des tâches est conservé. */
const byPriority = (a: TaskItem, b: TaskItem) => PRIORITIES.indexOf(b.task.priority) - PRIORITIES.indexOf(a.task.priority);

export function humanQueue(): HumanQueue {
  const grills: GrillItem[] = [];
  const human: TaskItem[] = [];
  const agents: TaskItem[] = [];
  for (const p of listProjects()) {
    const project = { id: p.id, slug: p.slug, name: p.name };
    grills.push(...listGrills(p.id, "open").map((g) => grillItem(project, g)));
    for (const t of listTasks(p.id)) {
      const item = taskItem(project, t);
      if (item) (t.for_human ? human : agents).push(item);
    }
  }
  const human_tasks = human.sort(byPriority);
  const agent_tasks = agents.sort(byPriority);
  const total = grills.length + human_tasks.length + agent_tasks.length;
  return { grills, human_tasks, agent_tasks, total, up_to_date: total === 0 };
}
