import { getProject, listGrills, type GrillSummary, type Project } from "./store.js";
import { listSkills } from "./skills.js";
import { listDecisions, listAwaitingDecisions, type AwaitingDecision, type Decision } from "./decisions.js";
import { listAgents, listTasks, type AgentStatus, type Task } from "./tasks.js";

export interface DecisionsOverview {
  total: number;
  awaiting: AwaitingDecision[];
  /** Les plus récentes d'abord. */
  recent: Decision[];
}

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
  decisions: DecisionsOverview;
  agents: AgentStatus[];
  skills: ReturnType<typeof listSkills>;
  next_actions: string[];
}

const RECENT_DECISIONS = 5;

function decisionsOverview(ref: string): DecisionsOverview {
  const all = listDecisions(ref);
  return { total: all.length, awaiting: listAwaitingDecisions(ref), recent: all.slice(0, RECENT_DECISIONS) };
}

function decisionActions({ total, awaiting }: DecisionsOverview): string[] {
  const actions: string[] = [];
  if (awaiting.length)
    actions.push(
      `${awaiting.length} « Décide pour moi » encore sans décision (${awaiting.map((q) => `« ${q.grill_title} » question ${q.position} : ${q.id}`).join(", ")}) : ` +
        "tranche puis enregistre avec record_decision (question_id).",
    );
  if (total) actions.push(`${total} décision(s) enregistrée(s) : list_decisions pour les relire ; get_task transmet celles de chaque tâche.`);
  return actions;
}

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
  const decisions = decisionsOverview(ref);

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
  next.push(...decisionActions(decisions));
  // Tâches humaines : visibles dans le kanban, jamais proposées aux agents.
  const forAgents = (t: Task) => !t.for_human;
  for (const t of review.filter(forAgents))
    next.push(`Relire #${t.seq} « ${t.title} »${t.reviewer ? ` (relecteur prévu : ${t.reviewer.name})` : ""} avec review_task.`);
  for (const t of in_progress.filter((x) => x.stale && forAgents(x)))
    next.push(`#${t.seq} « ${t.title} » est sans activité depuis ${t.stale_for} : vérifie qu'un agent y travaille encore, sinon release_task.`);
  const humanReady = ready.filter((t) => t.for_human);
  if (humanReady.length) next.push(`Réservées à l'humain, ne les fais pas à sa place : ${humanReady.map((t) => `#${t.seq}`).join(", ")}.`);
  const agentReady = ready.filter(forAgents);
  if (agentReady.length) {
    const free = agents.filter((a) => a.available).map((a) => a.name);
    next.push(
      `Démarrables maintenant : ${agentReady.map((t) => `#${t.seq}`).join(", ")} (par priorité). ` +
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
    decisions,
    agents,
    skills,
    next_actions: next,
  };
}
