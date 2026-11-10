import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as store from "./store.js";
import { humanDuration } from "./stale.js";
import { projectState } from "./state.js";
import * as skills from "./skills.js";
import * as tasks from "./tasks.js";
import * as decisions from "./decisions.js";

const startedAt = new Date();
const PUBLIC_URL = (process.env.BRIGADE_PUBLIC_URL ?? "http://localhost:3100").replace(/\/$/, "");
/** Au-delà, l'image n'est pas embarquée dans la réponse MCP (limite de taille côté client). */
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

const grillUrl = (g: { id: string; project: { slug: string } }) => `${PUBLIC_URL}/#/p/${g.project.slug}/g/${g.id}`;

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
});

/** Enveloppe un handler : les erreurs métier deviennent des réponses d'erreur lisibles par l'agent. */
function safe<A>(fn: (args: A) => CallToolResult | Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof store.NotFoundError || e instanceof store.InvalidError) return fail(e);
      throw e;
    }
  };
}

/** Sens exact de chaque sortie pour l'agent qui lit les réponses. */
const OUTCOME_GUIDANCE: Record<store.Outcome, (q: store.Question) => string> = {
  accept_default: (q) => `**Sortie : proposition validée.** Consigne : la proposition fait foi : « ${q.default_answer} ».`,
  decide_for_me: () => "**Sortie : décide pour moi.** Consigne : tranche toi-même et écris ta décision.",
  not_relevant: () => "**Sortie : pas pertinent.** Consigne : écarte cette question.",
  later: () => "**Sortie : plus tard.** Consigne : laisse la question ouverte, ne présume rien.",
};

function outcomeLine(q: store.Question, outcome: store.Outcome): string {
  if (outcome === "decide_for_me" && !q.awaiting_decision) return "**Sortie : décide pour moi.** Décision enregistrée.";
  return OUTCOME_GUIDANCE[outcome](q);
}

function answerLines(q: store.Question): string[] {
  const written = q.answer_text.trim();
  if (q.outcome) return [outcomeLine(q, q.outcome), ...(written ? [`Note de l'utilisateur :\n${written}`] : [])];
  if (q.skipped) return ["**Réponse : question passée (ancienne valeur, intention d'origine inconnue).**"];
  if (written) return [`**Réponse :**\n${written}`];
  return q.attachments.length === 0 ? ["**Réponse : (pas encore répondu)**"] : [];
}

/** Rend une question (et sa réponse) en markdown + blocs image. */
function renderQuestion(q: store.Question, content: CallToolResult["content"]): void {
  const lines = [`### ${q.position}. ${q.text}  \`${q.id}\``];
  if (q.critical) lines.push("**Question critique.**");
  if (q.hint) lines.push(`_Indication : ${q.hint}_`);
  if (q.choices) lines.push(`Suggestions : ${q.choices.join(" · ")}`);
  if (q.default_answer) lines.push(`Proposition de l'agent : ${q.default_answer}`);
  if (q.modified_since_read) lines.push("⚠ **Modifiée depuis ta dernière lecture.**");
  lines.push(...answerLines(q));
  if (q.awaiting_decision) lines.push(`⚠ **Attend une décision : tranche, puis record_decision (question_id : ${q.id}).**`);
  const recorded = decisions.decisionsForQuestion(q.id);
  if (recorded.length) lines.push("Décision(s) enregistrée(s) :", ...recorded.map(decisionLine));
  content.push({ type: "text", text: lines.join("\n") });
  for (const a of q.attachments) {
    if (a.size > MAX_INLINE_IMAGE_BYTES) {
      content.push({
        type: "text",
        text: `[Image « ${a.filename} » (${a.id}) trop lourde pour être incluse : ${PUBLIC_URL}/api/attachments/${a.id}]`,
      });
      continue;
    }
    const { data } = store.getAttachment(a.id);
    content.push({ type: "text", text: `Image jointe à la question ${q.position} : « ${a.filename} » (${a.id})` });
    content.push({ type: "image", data: data.toString("base64"), mimeType: a.mime });
  }
}

const EXCERPT_CHARS = 120;
const excerpt = (t: string | null) => (t ?? "").trim().split("\n")[0]!.slice(0, EXCERPT_CHARS);

function decisionSource(d: decisions.Decision): string {
  switch (d.source) {
    case "linked":
      return `question \`${d.question?.id}\` (« ${excerpt(d.question_text)} »)`;
    case "deleted":
      return `source supprimée (« ${excerpt(d.question_text)} »)`;
    case "none":
      return "jamais de source";
    default: {
      const unknown: never = d.source;
      throw new Error(`Source de décision inconnue : ${String(unknown)}`);
    }
  }
}

const decisionLine = (d: decisions.Decision): string => {
  const source = ` — ${decisionSource(d)}`;
  const linked = d.tasks.length ? ` — tâches ${d.tasks.map((t) => `#${t.seq}`).join(", ")}` : "";
  return `- \`${d.id}\` (${d.created_at}) : ${d.decision} — raison : ${d.reason}${source}${linked}`;
};

const taskLine = (t: tasks.Task) => {
  const state = t.status === "todo" ? (t.ready ? "todo · PRÊTE" : `todo · BLOQUÉE par ${t.blocked_by.map((d) => "#" + d.seq).join(",")}`) : t.status;
  return (
    `- #${t.seq} [${state}]${t.for_human ? " [POUR L'HUMAIN]" : ""} (${t.priority}, ${t.difficulty}) ${t.title}` +
    (t.assignee ? ` — agent : ${t.assignee.name}` : "") +
    (t.depends_on.length ? ` — dépend de ${t.depends_on.map((d) => "#" + d.seq).join(",")}` : "") +
    (t.question_ids.length ? ` — questions : ${t.question_ids.join(",")}` : "") +
    ` — id ${t.id}`
  );
};

/** Résultat encore valable seulement en relecture ou terminé ; sinon il décrit une tentative renvoyée ou abandonnée. */
const isCurrentAttempt = (t: tasks.Task) => t.status === "review" || t.status === "done";

function resultLines(t: tasks.Task): string[] {
  const current = isCurrentAttempt(t);
  const lines: string[] = [];
  if (t.result) lines.push("", current ? "## Résultat déclaré" : "## Résultat de la tentative précédente", t.result);
  if (t.verification) lines.push("", current ? "## Vérification réalisée" : "## Vérification de la tentative précédente", t.verification);
  return lines;
}

function dependencyLine(ref: tasks.TaskRef): string {
  const dep = tasks.getTask(ref.id);
  const head = `- #${ref.seq} « ${ref.title} » (${ref.status})`;
  if (!dep.result) return head;
  const proof = dep.verification ? ` (vérifié : ${dep.verification})` : "";
  const attempt = isCurrentAttempt(dep) ? "" : "tentative précédente : ";
  return `${head} : ${attempt}${dep.result}${proof}`;
}

/** Fiche complète d'une tâche : tout ce qu'il faut à un agent (ou sous-agent) pour travailler seul. */
function renderTaskBrief(t: tasks.Task): CallToolResult {
  const project = store.getProject(t.project_id);
  const content: CallToolResult["content"] = [];
  const head = [
    `# Tâche #${t.seq} « ${t.title} » (${t.id}) — projet ${project.name}`,
    `Statut : ${t.status}${t.ready ? " (prête à démarrer)" : ""} · Priorité : ${t.priority} · Difficulté : ${t.difficulty}`,
    `Assignée à : ${t.assignee?.name ?? "personne (l'agent maître choisit)"} · Relecture : ${t.review_effective ? "requise" : "non requise"}${t.reviewer ? ` (par ${t.reviewer.name})` : ""}`,
  ];
  if (t.for_human) head.push("👤 Réservée à l'humain : ne la fais pas à sa place, sauf demande explicite de sa part.");
  if (t.blocked_by.length)
    head.push(`⛔ BLOQUÉE par : ${t.blocked_by.map((d) => `#${d.seq} « ${d.title} » (${d.status})`).join(", ")}`);
  head.push("", "## Description", t.description.trim() || "(aucune)");
  if (t.review_notes) head.push("", "## Notes de la relecture précédente (à prendre en compte)", t.review_notes);
  head.push(...resultLines(t));
  if (t.forced_note) head.push("", "## Fin hors des règles", t.forced_note);
  if (t.depends_on.length) {
    head.push("", "## Dépendances et leur résultat");
    head.push(...t.depends_on.map(dependencyLine));
  }
  if (t.assignee) {
    const a = tasks.getAgent(t.assignee.id);
    head.push(
      "",
      `## Agent assigné : ${a.name}${a.model ? ` (modèle : ${a.model})` : ""}`,
      a.description || "",
      a.prompt ? `Instructions de l'agent :\n${a.prompt}` : "",
    );
  }
  const sk = skills.listSkills(t.project_id);
  if (sk.length)
    head.push(
      "",
      "## Skills du projet (instructions à respecter ; lis-les avec get_skill)",
      ...sk.map((x) => `- ${x.always ? "[toujours] " : ""}${x.name}${x.description ? ` — ${x.description}` : ""}`),
    );
  const linked = decisions.decisionsForTask(t.id);
  if (linked.length) head.push("", "## Décisions liées (à respecter)", ...linked.map(decisionLine));
  content.push({ type: "text", text: head.filter((l) => l !== undefined).join("\n") });
  if (t.question_ids.length) {
    content.push({ type: "text", text: "## Questions du grill liées à cette tâche (réponses de l'utilisateur)" });
    for (const qid of t.question_ids) renderQuestion(store.getQuestion(qid), content);
  }
  return { content };
}

const recentDecisionLines = (recent: decisions.Decision[]): string[] =>
  recent.length ? ["", `## Décisions récentes (${recent.length})`, ...recent.map(decisionLine)] : [];

/** Construit une instance MCP (une par requête, mode stateless). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "brigade", version: "0.4.0" },
    {
      instructions:
        "Brigade est le gestionnaire de projet local d'Alexandre. Si l'utilisateur dit « on continue » ou reprend un projet : commence par get_project_state. Flux du grill : (1) list_projects / create_project, " +
        "(2) ask_questions pour déposer TOUTES les questions d'un coup, autant que nécessaire pour extraire le maximum de détails, " +
        "puis continuer sans attendre — ne bloque jamais ; default_answer seulement avec une hypothèse solide, critical quand une erreur coûterait cher, " +
        "(3) dis à l'utilisateur d'ouvrir l'URL renvoyée, (4) quand il annonce avoir répondu, appelle get_answers et suis la consigne de chaque sortie. " +
        "« Décide pour moi » : tranche, puis record_decision (raison obligatoire, question_id) ; toute décision durable s'y enregistre aussi. " +
        "Kanban : découpe le travail avec create_tasks (dépendances, liens vers les questions), puis pour chaque tâche " +
        "prête (list_tasks ready_only) : start_task, get_task, travail (toi ou un sous-agent à qui tu transmets la fiche), " +
        "complete_task (result et verification obligatoires : la commande ou le contrôle réalisé), puis review_task si la relecture est exigée. Brigade ne lance aucun agent : c'est toi qui le fais. " +
        "Skills du projet (conventions, stack, règles) : list_skills puis get_skill ; lis d'emblée ceux marqués « toujours » " +
        "(get_project_state les signale) et les autres quand ils concernent la tâche.",
    },
  );

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Vérifie que Brigade répond. Renvoie l'heure serveur, l'uptime et l'écho du message.",
      inputSchema: { message: z.string().optional().describe("Texte à renvoyer en écho") },
    },
    async ({ message }) => {
      const t = new Date();
      return text(
        JSON.stringify({
          ok: true,
          service: "brigade",
          serverTime: t.toISOString(),
          uptimeSeconds: Math.round((t.getTime() - startedAt.getTime()) / 1000),
          echo: message ?? null,
        }),
      );
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "Lister les projets",
      description: "Liste les projets Brigade avec le nombre de grills ouverts et de questions en attente de réponse.",
      inputSchema: {},
    },
    safe(() => {
      const projects = store.listProjects();
      if (projects.length === 0) return text("Aucun projet. Crée-en un avec create_project.");
      return text(
        projects
          .map(
            (p) =>
              `- ${p.name} (slug: ${p.slug}) — ${p.open_grills} grill(s) ouvert(s), ${p.pending_questions} question(s) en attente` +
              (p.description ? `\n  ${p.description}` : ""),
          )
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "create_project",
    {
      title: "Créer un projet",
      description: "Crée un projet Brigade. Renvoie son slug, à utiliser ensuite comme référence de projet.",
      inputSchema: {
        name: z.string().describe("Nom du projet"),
        description: z.string().optional().describe("Objectif du projet en une ou deux phrases"),
      },
    },
    safe(({ name, description }) => {
      const p = store.createProject(name, description ?? "");
      return text(`Projet créé : ${p.name} (slug: ${p.slug}). Interface : ${PUBLIC_URL}/#/p/${p.slug}`);
    }),
  );

  server.registerTool(
    "ask_questions",
    {
      title: "Déposer des questions (grill)",
      description:
        "Dépose un lot de questions dans le grill d'un projet. NE BLOQUE PAS : l'utilisateur répondra plus tard dans " +
        "l'interface web (texte, code, images collées). Pose toutes tes questions d'un coup, regroupées par thème, " +
        "puis poursuis ton travail ou indique à l'utilisateur d'ouvrir l'URL. Le texte des questions et le contexte " +
        "sont en markdown (blocs de code acceptés).",
      inputSchema: {
        project: z.string().describe("Slug ou id du projet"),
        title: z.string().describe("Titre du lot, ex. « Cadrage — périmètre et contraintes »"),
        context: z.string().optional().describe("Pourquoi ces questions, ce que tu as compris (markdown)"),
        questions: z
          .array(
            z.object({
              text: z.string().describe("La question (markdown)"),
              hint: z.string().optional().describe("Précision sur le type de réponse attendue"),
              choices: z.array(z.string()).optional().describe("Réponses suggérées (l'utilisateur peut aussi écrire librement)"),
              critical: z.boolean().optional().describe("Question critique : « décide pour moi » y sera refusé"),
              default_answer: z.string().optional().describe("Réponse que tu retiendrais sans avis de l'utilisateur ; seulement si tu as une hypothèse solide"),
            }),
          )
          .min(1),
      },
    },
    safe(({ project, title, context, questions }) => {
      const g = store.createGrill(project, title, context ?? "", questions);
      return text(
        `Grill créé : « ${g.title} » (id: ${g.id}) — ${g.total} question(s).\n` +
          `Question ids : ${g.questions.map((q) => `${q.position}=${q.id}`).join(", ")}\n` +
          `À ouvrir par l'utilisateur : ${grillUrl(g)}\n` +
          `Ne bloque pas : continue, et appelle get_answers quand l'utilisateur dit avoir répondu.`,
      );
    }),
  );

  server.registerTool(
    "list_grills",
    {
      title: "Lister les grills",
      description: "Liste les grills d'un projet avec leur avancement (répondues / total) et leur statut.",
      inputSchema: {
        project: z.string().describe("Slug ou id du projet"),
        status: z.enum(["open", "submitted"]).optional().describe("open = en cours, submitted = l'utilisateur a marqué terminé"),
      },
    },
    safe(({ project, status }) => {
      const grills = store.listGrills(project, status);
      if (grills.length === 0) return text("Aucun grill.");
      const p = store.getProject(project);
      return text(
        grills
          .map(
            (g) =>
              `- ${g.id} « ${g.title} » — ${g.answered}/${g.total} répondues, statut ${g.status} — ${PUBLIC_URL}/#/p/${p.slug}/g/${g.id}`,
          )
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "get_answers",
    {
      title: "Lire un grill et ses réponses",
      description:
        "Renvoie toutes les questions d'un grill avec les réponses de l'utilisateur, y compris les images jointes " +
        "(en blocs image). À appeler quand l'utilisateur dit avoir répondu. Signale les questions restées sans réponse " +
        "et celles modifiées depuis ta dernière lecture ; cet appel enregistre la lecture. Chaque sortie explicite " +
        "(proposition validée, décide pour moi, pas pertinent, plus tard) arrive avec sa consigne, à suivre ; « plus tard » est listé à part.",
      inputSchema: { grill_id: z.string().describe("Id du grill (g_xxxxxxxx)") },
    },
    safe(({ grill_id }) => {
      const g = store.getGrill(grill_id);
      const content: CallToolResult["content"] = [
        {
          type: "text",
          text:
            `# Grill « ${g.title} » (${g.id}) — projet ${g.project.name}\n` +
            `Statut : ${g.status === "submitted" ? "marqué terminé par l'utilisateur" : "ouvert"} — ${g.answered}/${g.total} répondues.` +
            (g.last_read_at ? `\nDernière lecture : ${g.last_read_at}.` : "") +
            (g.context ? `\n\nContexte posé :\n${g.context}` : ""),
        },
      ];
      // « Plus tard » compte comme traité dans la progression, mais ne doit pas se lire comme une réponse.
      const later = g.questions.filter((q) => q.outcome === "later");
      for (const q of g.questions) if (q.outcome !== "later") renderQuestion(q, content);
      if (later.length) {
        content.push({ type: "text", text: `## Plus tard : ${later.length} question(s) à laisser ouvertes, ne présume rien` });
        for (const q of later) renderQuestion(q, content);
      }
      const pending = g.questions.filter((q) => !q.answered).map((q) => q.position);
      if (pending.length) content.push({ type: "text", text: `⚠ Sans réponse : question(s) ${pending.join(", ")}.` });
      const undecided = g.questions.filter((q) => q.awaiting_decision).map((q) => q.position);
      if (undecided.length) content.push({ type: "text", text: `⚠ En attente d'une décision : question(s) ${undecided.join(", ")}.` });
      const modified = g.questions.filter((q) => q.modified_since_read).map((q) => q.position);
      if (modified.length) content.push({ type: "text", text: `⚠ Modifiées depuis ta dernière lecture : question(s) ${modified.join(", ")}.` });
      // Après le rendu : la réponse ci-dessus doit encore porter le marquage qu'elle lève.
      store.markGrillRead(g.id);
      return { content };
    }),
  );

  server.registerTool(
    "get_question",
    {
      title: "Lire une question et sa réponse",
      description:
        "Renvoie une seule question avec sa réponse et ses images. Utile pour un sous-agent orienté vers une question précise.",
      inputSchema: { question_id: z.string().describe("Id de la question (q_xxxxxxxx)") },
    },
    safe(({ question_id }) => {
      const q = store.getQuestion(question_id);
      const content: CallToolResult["content"] = [
        { type: "text", text: `Grill « ${q.grill.title} » (${q.grill.id})` },
      ];
      renderQuestion(q, content);
      return { content };
    }),
  );

  server.registerTool(
    "get_project_state",
    {
      title: "État du projet (reprise)",
      description:
        "À appeler en PREMIER quand l'utilisateur dit « on continue » / « reprends le projet X » : renvoie en une fois les " +
        "réglages, les grills et leur avancement, le kanban (relecture, en cours, prêtes, bloquées), les agents et leur " +
        "disponibilité, et les prochaines actions suggérées. Décide ensuite quoi lancer (toi ou des sous-agents).",
      inputSchema: { project: z.string().describe("Slug ou id du projet") },
    },
    safe(({ project }) => {
      const st = projectState(project);
      const p = st.project;
      const line = (t: tasks.Task, extra = "") => taskLine(t) + extra;
      const out: string[] = [
        `# État de « ${p.name} » (${p.slug})`,
        `Mode : ${p.mode === "team" ? "équipe de sous-agents" : "chat courant seul"}${p.default_model ? ` · modèle par défaut : ${p.default_model}` : ""} · relecture ${p.review_required ? "exigée" : "optionnelle"}`,
      ];
      if (p.description) out.push(`Objectif : ${p.description}`);

      out.push("", "## Grills");
      if (st.grills.length === 0) out.push("Aucun grill.");
      for (const g of st.grills.slice(0, 10))
        out.push(
          `- ${g.id} « ${g.title} » — ${g.answered}/${g.total} répondues${g.status === "submitted" ? ", marqué terminé par l'utilisateur" : ""} — ${PUBLIC_URL}/#/p/${p.slug}/g/${g.id}`,
        );

      const k = st.tasks;
      out.push(
        "",
        `## Kanban — ${k.total} tâche(s) : ${k.ready.length} prête(s), ${k.blocked.length} bloquée(s), ${k.in_progress.length} en cours, ${k.review.length} en relecture, ${k.done} terminée(s)`,
      );
      if (k.review.length) out.push("### En relecture", ...k.review.map((t) => line(t)));
      if (k.in_progress.length)
        out.push("### En cours", ...k.in_progress.map((t) => line(t, ` — depuis ${humanDuration(Math.round((Date.now() - new Date(t.started_at ?? Date.now()).getTime()) / 60000))}`)));
      const humanReady = k.ready.filter((t) => t.for_human);
      const agentReady = k.ready.filter((t) => !t.for_human);
      if (agentReady.length) out.push("### Prêtes à démarrer", ...agentReady.map((t) => line(t)));
      if (humanReady.length) out.push("### Prêtes, réservées à l'humain", ...humanReady.map((t) => line(t)));
      if (k.blocked.length) out.push("### Bloquées", ...k.blocked.map((t) => line(t)));

      out.push(...recentDecisionLines(st.decisions.recent));

      out.push("", "## Agents");
      if (st.agents.length === 0) out.push("Aucun agent défini.");
      for (const a of st.agents)
        out.push(`- ${a.name}${a.model ? ` (${a.model})` : ""} — ${a.available ? "disponible" : `OCCUPÉ par ${a.busy_with.map((b) => "#" + b.seq).join(",")}`}${a.description ? ` — ${a.description}` : ""}`);

      out.push("", "## Skills du projet");
      if (st.skills.length === 0) out.push("Aucun skill.");
      for (const x of st.skills) out.push(`- ${x.name}${x.always ? " [TOUJOURS]" : ""}${x.description ? ` — ${x.description}` : ""}`);

      out.push("", "## Prochaines actions suggérées");
      out.push(...(st.next_actions.length ? st.next_actions.map((a, i) => `${i + 1}. ${a}`) : ["Rien d'urgent : demande à l'utilisateur ce qu'il veut faire."]));
      return text(out.join("\n"));
    }),
  );

  // ================= Décisions =================

  server.registerTool(
    "record_decision",
    {
      title: "Enregistrer une décision",
      description:
        "Écrit une décision dans le registre du projet, avec sa raison. Obligatoire pour clore un « Décide pour moi » : " +
        "donne alors question_id. Permis aussi pour toute autre décision, liée ou non à une question ou à des tâches, " +
        "sauf sur une question critique à laquelle l'utilisateur n'a pas répondu (refusé). " +
        "Une décision est immuable ; pour en changer, enregistre-en une nouvelle.",
      inputSchema: {
        project: z.string().describe("Slug ou id du projet"),
        decision: z.string().describe("Ce qui est décidé"),
        reason: z.string().describe("Pourquoi"),
        question_id: z.string().optional().describe("Question source (q_xxxxxxxx) ; clôt son « Décide pour moi »"),
        task_ids: z.array(z.string()).optional().describe("Tâches concernées (id ou « #n »)"),
      },
    },
    safe(({ project, ...input }) => {
      const d = decisions.recordDecision(project, input);
      return text(`Décision enregistrée :\n${decisionLine(d)}`);
    }),
  );

  server.registerTool(
    "list_decisions",
    {
      title: "Lister les décisions",
      description: "Registre des décisions du projet, les plus récentes d'abord, et les « Décide pour moi » encore sans décision.",
      inputSchema: { project: z.string().describe("Slug ou id du projet") },
    },
    safe(({ project }) => {
      const all = decisions.listDecisions(project);
      const awaiting = decisions.listAwaitingDecisions(project);
      const out = all.length ? all.map(decisionLine) : ["Aucune décision."];
      if (awaiting.length) out.push("", `« Décide pour moi » sans décision : ${awaiting.map((q) => q.id).join(", ")}`);
      return text(out.join("\n"));
    }),
  );

  // ================= Kanban =================

  const prio = z.enum(tasks.PRIORITIES);
  const diff = z.enum(tasks.DIFFICULTIES);

  server.registerTool(
    "create_tasks",
    {
      title: "Créer des tâches (découper un travail)",
      description:
        "Crée un lot de tâches dans le kanban d'un projet. Pour les dépendances entre tâches du même lot, donne à chacune " +
        "une `ref` locale et référence-la dans `depends_on` (tu peux aussi citer un id existant ou « #n »). Une tâche " +
        "dépendante ne pourra être démarrée que quand ses dépendances sont terminées (et relues si la relecture est exigée). " +
        "Relie les tâches aux questions du grill concernées via `question_ids` : l'agent qui exécutera la tâche y trouvera " +
        "les réponses de l'utilisateur. Découpe en petites tâches vérifiables ; écris dans la description le critère " +
        "d'acceptation (comment savoir que c'est fini).",
      inputSchema: {
        project: z.string().describe("Slug ou id du projet"),
        tasks: z
          .array(
            z.object({
              ref: z.string().optional().describe("Clé locale pour depends_on au sein de ce lot"),
              title: z.string(),
              description: z.string().optional().describe("Markdown : objectif, étapes, critère d'acceptation"),
              priority: prio.optional(),
              difficulty: diff.optional(),
              assignee: z.string().optional().describe("Nom ou id d'un agent du projet (optionnel)"),
              reviewer: z.string().optional().describe("Nom ou id de l'agent relecteur (optionnel)"),
              review: z.boolean().optional().describe("Force la relecture pour cette tâche (sinon : réglage du projet)"),
              for_human: z.boolean().optional().describe("Tâche à faire par l'humain (validation, décision) : aucun agent ne doit la prendre"),
              depends_on: z.array(z.string()).optional(),
              question_ids: z.array(z.string()).optional().describe("Ids de questions du grill à lier"),
            }),
          )
          .min(1),
      },
    },
    safe(({ project, tasks: inputs }) => {
      const created = tasks.createTasks(project, inputs);
      return text(`${created.length} tâche(s) créée(s) :\n${created.map(taskLine).join("\n")}`);
    }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "Lister les tâches",
      description:
        "Vue du kanban d'un projet, triée par priorité. Indique pour chaque tâche si elle est PRÊTE (démarrable) ou BLOQUÉE " +
        "par ses dépendances. Utilise ready_only pour ne voir que ce qui peut être lancé maintenant.",
      inputSchema: {
        project: z.string(),
        status: z.enum(tasks.STATUSES).optional(),
        ready_only: z.boolean().optional().describe("Seulement les tâches « à faire » dont les dépendances sont satisfaites"),
      },
    },
    safe(({ project, status, ready_only }) => {
      const list = tasks.listTasks(project, { status, readyOnly: ready_only });
      if (list.length === 0) return text("Aucune tâche.");
      return text(list.map(taskLine).join("\n"));
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Lire une tâche (fiche complète)",
      description:
        "Fiche complète d'une tâche : description, dépendances et leurs résultats, notes de relecture, instructions de " +
        "l'agent assigné, et questions du grill liées avec les réponses (images comprises). C'est le brief à donner à " +
        "un sous-agent : tu peux aussi lui dire de l'appeler lui-même avec l'id de la tâche.",
      inputSchema: { task_id: z.string().describe("Id (t_xxxxxxxx)") },
    },
    safe(({ task_id }) => renderTaskBrief(tasks.getTask(task_id))),
  );

  server.registerTool(
    "update_task",
    {
      title: "Modifier une tâche",
      description:
        "Modifie les champs d'une tâche (titre, description, priorité, difficulté, agent assigné, relecture) et ses " +
        "liens (dépendances, questions). Assigne un agent ici quand tu choisis qui fera la tâche. Ne change pas le statut : " +
        "utilise start_task, complete_task, review_task ou release_task.",
      inputSchema: {
        task_id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: prio.optional(),
        difficulty: diff.optional(),
        assignee: z.string().nullable().optional().describe("Nom/id d'agent, ou null pour retirer"),
        reviewer: z.string().nullable().optional(),
        review: z.boolean().nullable().optional().describe("true/false = surcharge ; null = hérite du projet"),
        for_human: z.boolean().optional().describe("true = tâche à faire par l'humain ; false = tâche d'agent"),
        add_depends_on: z.array(z.string()).optional(),
        remove_depends_on: z.array(z.string()).optional(),
        link_questions: z.array(z.string()).optional(),
        unlink_questions: z.array(z.string()).optional(),
      },
    },
    safe(({ task_id, ...patch }) => text(`Tâche mise à jour :\n${taskLine(tasks.updateTask(task_id, patch))}`)),
  );

  server.registerTool(
    "start_task",
    {
      title: "Démarrer une tâche",
      description:
        "Passe une tâche « à faire » en « en cours ». REFUSÉ par le serveur si une dépendance n'est pas terminée (et relue " +
        "si exigé) ou si la tâche n'est pas « à faire » (elle a peut-être déjà été prise par un autre agent). " +
        "Appelle-le avant de lancer le travail ; en cas de refus, ne contourne pas : traite d'abord les dépendances.",
      inputSchema: {
        task_id: z.string(),
        agent: z.string().optional().describe("Agent qui prend la tâche (nom ou id) ; sinon l'assignation existante est conservée"),
      },
    },
    safe(({ task_id, agent }) => {
      const t = tasks.startTask(task_id, agent);
      return text(`Tâche démarrée :\n${taskLine(t)}\nUtilise get_task pour sa fiche complète.`);
    }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Terminer une tâche",
      description:
        "Déclare le travail fait : `result` (ce qui a été fait, fichiers touchés) et `verification` (commande ou contrôle " +
        "réalisé), tous deux obligatoires et non vides. Si la relecture est exigée, la tâche passe « en relecture » ; sinon " +
        "« terminée ». Résultat et vérification sont transmis aux tâches qui en dépendent.",
      inputSchema: {
        task_id: z.string(),
        result: z.string().describe("Compte rendu concis : ce qui a été fait"),
        verification: z.string().describe("Commande ou contrôle réalisé, et son résultat"),
      },
    },
    safe(({ task_id, result, verification }) => {
      const t = tasks.completeTask(task_id, result, verification);
      return text(
        `${t.status === "review" ? "En attente de relecture" : "Terminée"} :\n${taskLine(t)}`,
      );
    }),
  );

  server.registerTool(
    "review_task",
    {
      title: "Relire une tâche",
      description:
        "Relecture d'une tâche « en relecture » : `approve` la termine (ce qui débloque les tâches dépendantes) ; `changes` " +
        "la renvoie « à faire » avec des notes précises sur ce qu'il faut corriger.",
      inputSchema: {
        task_id: z.string(),
        verdict: z.enum(["approve", "changes"]),
        notes: z.string().optional().describe("Obligatoire pour `changes`"),
      },
    },
    safe(({ task_id, verdict, notes }) => text(`Relecture enregistrée :\n${taskLine(tasks.reviewTask(task_id, verdict, notes ?? ""))}`)),
  );

  server.registerTool(
    "release_task",
    {
      title: "Libérer une tâche",
      description: "Remet une tâche « en cours » ou « en relecture » à « à faire » (agent interrompu, changement de plan).",
      inputSchema: { task_id: z.string() },
    },
    safe(({ task_id }) => text(`Tâche libérée :\n${taskLine(tasks.releaseTask(task_id))}`)),
  );

  // ================= Agents et réglages du projet =================

  server.registerTool(
    "list_agents",
    {
      title: "Lister les agents du projet",
      description:
        "Agents définis dans le projet, avec leur disponibilité (occupé s'ils ont une tâche en cours ou en relecture). " +
        "Sert à choisir à quel agent assigner une tâche. Rappelle-toi : c'est TOI (Claude Code) qui lances les sous-agents " +
        "avec ces définitions, Brigade ne lance rien.",
      inputSchema: { project: z.string() },
    },
    safe(({ project }) => {
      const p = store.getProject(project);
      const agents = tasks.listAgents(project);
      const head = `Mode du projet : ${p.mode === "team" ? "équipe de sous-agents" : "chat courant seul"}` +
        `${p.default_model ? ` · modèle par défaut : ${p.default_model}` : ""} · relecture ${p.review_required ? "exigée" : "optionnelle"}`;
      if (agents.length === 0) return text(`${head}\nAucun agent défini.`);
      return text(
        `${head}\n` +
          agents
            .map(
              (a) =>
                `- ${a.name} (id ${a.id})${a.model ? ` — modèle ${a.model}` : ""} — ${a.available ? "disponible" : `OCCUPÉ par ${a.busy_with.map((b) => "#" + b.seq).join(",")}`}` +
                (a.description ? `\n  ${a.description}` : ""),
            )
            .join("\n"),
      );
    }),
  );

  server.registerTool(
    "save_agent",
    {
      title: "Créer ou modifier un agent du projet",
      description:
        "Crée (ou met à jour, si le nom existe déjà) la définition d'un sous-agent du projet : rôle, modèle, instructions. " +
        "Le prompt est ce que tu transmettras au sous-agent quand tu le lanceras sur une tâche.",
      inputSchema: {
        project: z.string(),
        name: z.string().describe("Nom court et unique dans le projet, ex. « frontend »"),
        description: z.string().optional().describe("Rôle en une phrase"),
        model: z.string().optional().describe("Modèle à utiliser (vide = modèle par défaut du projet)"),
        prompt: z.string().optional().describe("Instructions de l'agent (markdown)"),
      },
    },
    safe(({ project, ...input }) => {
      const existing = tasks.listAgents(project).find((a) => a.name === input.name.trim());
      const agent = existing ? tasks.updateAgent(existing.id, input) : tasks.createAgent(project, input);
      return text(`Agent ${existing ? "mis à jour" : "créé"} : ${agent.name} (id ${agent.id}).`);
    }),
  );

  server.registerTool(
    "list_skills",
    {
      title: "Lister les skills du projet",
      description:
        "Skills (instructions réutilisables) du projet : nom, description, et si le skill est à lire « toujours » au démarrage. " +
        "Lis le contenu avec get_skill.",
      inputSchema: { project: z.string().describe("Id ou slug du projet") },
    },
    safe(({ project }) => {
      const list = skills.listSkills(project);
      if (!list.length) return text("Aucun skill dans ce projet. Crée-en avec save_skill (conventions, stack, règles de test...).");
      return text(list.map((x) => `- ${x.name}${x.always ? " [TOUJOURS]" : ""} — ${x.description || "(sans description)"}`).join("\n"));
    }),
  );

  server.registerTool(
    "get_skill",
    {
      title: "Lire un skill du projet",
      description: "Contenu complet d'un skill du projet (markdown), à appliquer pour le travail en cours.",
      inputSchema: { project: z.string(), skill: z.string().describe("Nom ou id du skill") },
    },
    safe(({ project, skill }) => {
      const s = skills.getSkill(project, skill);
      return text(`# Skill « ${s.name} »${s.always ? " (toujours)" : ""}\n${s.description ? `_${s.description}_\n` : ""}\n${s.content.trim() || "(vide)"}`);
    }),
  );

  server.registerTool(
    "save_skill",
    {
      title: "Créer ou modifier un skill du projet",
      description:
        "Crée (ou met à jour, si le nom existe) un skill : des instructions durables du projet (conventions de code, stack, " +
        "commandes de test, règles de style). N'y mets pas de secret. Propose-les à l'utilisateur plutôt que d'en imposer.",
      inputSchema: {
        project: z.string(),
        name: z.string().describe("minuscules, chiffres, tirets ; ex. conventions-api"),
        description: z.string().optional().describe("Quand l'utiliser, en une phrase"),
        content: z.string().optional().describe("Instructions (markdown)"),
        always: z.boolean().optional().describe("true = à lire au démarrage de toute session sur ce projet"),
      },
    },
    safe(({ project, ...input }) => {
      const { skill, created } = skills.saveSkill(project, input);
      return text(`Skill ${created ? "créé" : "mis à jour"} : ${skill.name} (id ${skill.id}).`);
    }),
  );

  server.registerTool(
    "set_project_settings",
    {
      title: "Régler le projet",
      description:
        "Règle le mode d'exécution du projet (`main` = le chat courant fait le travail ; `team` = sous-agents définis), " +
        "le modèle par défaut et l'exigence de relecture avant « terminée ». Sans argument, affiche les réglages.",
      inputSchema: {
        project: z.string(),
        mode: z.enum(["main", "team"]).optional(),
        default_model: z.string().optional(),
        review_required: z.boolean().optional(),
      },
    },
    safe(({ project, ...patch }) => {
      const p = Object.keys(patch).length ? store.updateProject(project, patch) : store.getProject(project);
      return text(
        `Projet ${p.name} : mode ${p.mode}, modèle par défaut « ${p.default_model || "(aucun)"} », relecture ${p.review_required ? "exigée" : "optionnelle"}.`,
      );
    }),
  );

  return server;
}
