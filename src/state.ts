import { getProject, listGrills, type GrillSummary, type Project } from "./store.js";
import { listSkills } from "./skills.js";
import { listAgents, listTasks, type AgentStatus, type Task } from "./tasks.js";

export interface ProjectState {
  project: Project;
  grills: GrillSummary[];
  /** Grills ouverts ayant encore des questions sans réponse. */
  awaiting_answers: GrillSummary[];
  tasks: {
    todo: number;
    ready: Task[];
    blocked: Task[];
    in_progress: Task[];
    review: Task[];
    done: number;
    total: number;
  };
  agents: AgentStatus[];
  skills: ReturnType<typeof listSkills>;
  next_actions: string[];
}

const minutesSince = (iso: string | null) => (iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60000) : 0);
export const humanDuration = (min: number) =>
  min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} j`;

/** Un travail « en cours » depuis longtemps a peut-être été abandonné (agent planté). */
const STALE_MINUTES = 120;

export function projectState(ref: string): ProjectState {
  const project = getProject(ref);
  const grills = listGrills(ref);
  const all = listTasks(ref);
  const agents = listAgents(ref);
  const skills = listSkills(ref);

  const ready = all.filter((t) => t.ready);
  const blocked = all.filter((t) => t.status === "todo" && !t.ready);
  const in_progress = all.filter((t) => t.status === "in_progress");
  const review = all.filter((t) => t.status === "review");
  const done = all.filter((t) => t.status === "done").length;
  const awaiting = grills.filter((g) => g.status === "open" && g.answered < g.total);

  const next: string[] = [];
  const always = skills.filter((x) => x.always);
  if (always.length)
    next.push(`Skills à lire d'abord (get_skill) : ${always.map((x) => x.name).join(", ")}.${skills.length > always.length ? ` Autres skills disponibles : ${skills.filter((x) => !x.always).map((x) => x.name).join(", ")}.` : ""}`);
  else if (skills.length) next.push(`Skills du projet disponibles (get_skill) : ${skills.map((x) => x.name).join(", ")}.`);
  if (grills.length === 0 && all.length === 0)
    next.push("Projet vide : lance un grill de cadrage (ask_questions) pour comprendre l'objectif, le périmètre et les contraintes.");
  if (awaiting.length)
    next.push(
      `Des questions attendent l'utilisateur (${awaiting.map((g) => `« ${g.title} » ${g.answered}/${g.total}`).join(", ")}) : ` +
        "ne les relance pas, demande-lui s'il a répondu, puis lis get_answers.",
    );
  const answeredGrills = grills.filter((g) => g.answered > 0 && !awaiting.includes(g));
  if (answeredGrills.length && all.length === 0)
    next.push(`Des grills sont répondus (${answeredGrills.map((g) => g.id).join(", ")}) mais aucune tâche n'existe : lis get_answers puis découpe le travail avec create_tasks.`);
  for (const t of review)
    next.push(`Relire #${t.seq} « ${t.title} »${t.reviewer ? ` (relecteur prévu : ${t.reviewer.name})` : ""} avec review_task.`);
  for (const t of in_progress) {
    const min = minutesSince(t.started_at);
    if (min >= STALE_MINUTES)
      next.push(`#${t.seq} « ${t.title} » est en cours depuis ${humanDuration(min)} : vérifie qu'un agent y travaille encore, sinon release_task.`);
  }
  if (ready.length) {
    const free = agents.filter((a) => a.available).map((a) => a.name);
    next.push(
      `Démarrables maintenant : ${ready.map((t) => `#${t.seq}`).join(", ")} (par priorité). ` +
        (project.mode === "team"
          ? `Agents disponibles : ${free.length ? free.join(", ") : "aucun"} ; assigne les tâches non assignées avec update_task.`
          : "Mode « chat courant » : fais-les toi-même, ou délègue à un sous-agent générique."),
    );
  }
  if (blocked.length && !ready.length && !in_progress.length && !review.length)
    next.push("Tout est bloqué : une dépendance est probablement mal posée. Inspecte avec get_task.");
  if (all.length > 0 && done === all.length) next.push("Toutes les tâches sont terminées : propose un bilan à l'utilisateur ou un nouveau grill.");

  return {
    project,
    grills,
    awaiting_answers: awaiting,
    tasks: { todo: ready.length + blocked.length, ready, blocked, in_progress, review, done, total: all.length },
    agents,
    skills,
    next_actions: next,
  };
}
