import { Hono } from "hono";
import { z } from "zod";
import { humanQueue } from "./queue.js";
import { projectState } from "./state.js";
import * as store from "./store.js";
import * as tasks from "./tasks.js";
import * as skills from "./skills.js";
import * as decisions from "./decisions.js";

export const api = new Hono();

api.onError((err, c) => {
  if (err instanceof tasks.ForceRequiredError) return c.json({ error: err.message, code: "force_required" }, 409);
  if (err instanceof store.NotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof store.InvalidError || err instanceof z.ZodError) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: "Erreur interne" }, 500);
});

const projectBody = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  mode: z.enum(["main", "team"]).optional(),
  default_model: z.string().optional(),
  review_required: z.boolean().optional(),
});
const taskBody = z.object({
  title: z.string(),
  description: z.string().optional(),
  priority: z.enum(tasks.PRIORITIES).optional(),
  difficulty: z.enum(tasks.DIFFICULTIES).optional(),
  assignee: z.string().optional(),
  reviewer: z.string().optional(),
  review: z.boolean().optional(),
  for_human: z.boolean().optional(),
  depends_on: z.array(z.string()).optional(),
  question_ids: z.array(z.string()).optional(),
});
const taskPatch = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.enum(tasks.PRIORITIES).optional(),
  difficulty: z.enum(tasks.DIFFICULTIES).optional(),
  assignee: z.string().nullable().optional(),
  reviewer: z.string().nullable().optional(),
  review: z.boolean().nullable().optional(),
  for_human: z.boolean().optional(),
  add_depends_on: z.array(z.string()).optional(),
  remove_depends_on: z.array(z.string()).optional(),
  link_questions: z.array(z.string()).optional(),
  unlink_questions: z.array(z.string()).optional(),
});
const taskAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), agent: z.string().optional() }),
  z.object({ action: z.literal("complete"), result: z.string().default(""), verification: z.string().default("") }),
  z.object({ action: z.literal("approve"), notes: z.string().default("") }),
  z.object({ action: z.literal("changes"), notes: z.string() }),
  z.object({ action: z.literal("release") }),
  z.object({ action: z.literal("move"), status: z.enum(tasks.STATUSES), force: z.boolean().optional() }),
]);
const agentBody = z.object({
  name: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
});
const skillBody = z.object({
  name: z.string(),
  description: z.string().optional(),
  content: z.string().optional(),
  always: z.boolean().optional(),
});
const answerBody = z.object({
  text: z.string().optional(),
  skipped: z.boolean().optional(),
  outcome: z.enum(store.OUTCOMES).nullable().optional(),
});
const statusBody = z.object({ status: z.enum(["open", "submitted"]) });

// Projets
api.get("/projects", (c) => c.json(store.listProjects()));
api.post("/projects", async (c) => {
  const b = projectBody.parse(await c.req.json());
  return c.json(store.createProject(b.name ?? "", b.description ?? ""), 201);
});
api.get("/projects/:ref", (c) => c.json(store.getProject(c.req.param("ref"))));
api.patch("/projects/:ref", async (c) => c.json(store.updateProject(c.req.param("ref"), projectBody.parse(await c.req.json()))));
api.delete("/projects/:ref", (c) => {
  store.deleteProject(c.req.param("ref"));
  return c.body(null, 204);
});
api.get("/projects/:ref/grills", (c) => c.json(store.listGrills(c.req.param("ref"))));

// Grills
api.get("/grills/:id", (c) => c.json(store.getGrill(c.req.param("id"))));
api.post("/grills/:id/status", async (c) =>
  c.json(store.setGrillStatus(c.req.param("id"), statusBody.parse(await c.req.json()).status)),
);
api.delete("/grills/:id", (c) => {
  store.deleteGrill(c.req.param("id"));
  return c.body(null, 204);
});

// Réponses
api.put("/questions/:id/answer", async (c) =>
  c.json(store.setAnswer(c.req.param("id"), answerBody.parse(await c.req.json()))),
);

// Pièces jointes : corps brut de l'image, nom en query (?filename=)
api.post("/questions/:id/attachments", async (c) => {
  const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
  const data = Buffer.from(await c.req.arrayBuffer());
  const att = store.addAttachment(c.req.param("id"), mime, c.req.query("filename") ?? "image", data);
  return c.json(att, 201);
});
api.get("/attachments/:id", (c) => {
  const { meta, data } = store.getAttachment(c.req.param("id"));
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": meta.mime, "Cache-Control": "private, max-age=31536000, immutable" },
  });
});
api.delete("/attachments/:id", (c) => {
  store.deleteAttachment(c.req.param("id"));
  return c.body(null, 204);
});

// Questions du projet (pour relier des tâches aux questions du grill)
api.get("/projects/:ref/questions", (c) => c.json(store.listProjectQuestions(c.req.param("ref"))));

// Tâches
api.get("/projects/:ref/tasks", (c) => c.json(tasks.listTasks(c.req.param("ref"))));
api.post("/projects/:ref/tasks", async (c) => {
  const [t] = tasks.createTasks(c.req.param("ref"), [taskBody.parse(await c.req.json())]);
  return c.json(t, 201);
});
api.get("/tasks/:id", (c) => c.json(tasks.getTask(c.req.param("id"))));
api.patch("/tasks/:id", async (c) => c.json(tasks.updateTask(c.req.param("id"), taskPatch.parse(await c.req.json()))));
api.delete("/tasks/:id", (c) => {
  tasks.deleteTask(c.req.param("id"));
  return c.body(null, 204);
});
// Actions du cycle de vie. « move » = déplacement manuel ; imposer une fin malgré les règles exige `force`.
api.post("/tasks/:id/action", async (c) => {
  const id = c.req.param("id");
  const a = taskAction.parse(await c.req.json());
  switch (a.action) {
    case "start": return c.json(tasks.startTask(id, a.agent));
    case "complete": return c.json(tasks.completeTask(id, a.result, a.verification));
    case "approve": return c.json(tasks.reviewTask(id, "approve", a.notes));
    case "changes": return c.json(tasks.reviewTask(id, "changes", a.notes));
    case "release": return c.json(tasks.releaseTask(id));
    case "move": return c.json(tasks.forceStatus(id, a.status, { force: a.force }));
  }
});

// Agents du projet
api.get("/projects/:ref/agents", (c) => c.json(tasks.listAgents(c.req.param("ref"))));
api.post("/projects/:ref/agents", async (c) => c.json(tasks.createAgent(c.req.param("ref"), agentBody.parse(await c.req.json())), 201));
api.patch("/agents/:id", async (c) => c.json(tasks.updateAgent(c.req.param("id"), agentBody.partial().parse(await c.req.json()))));
api.delete("/agents/:id", (c) => {
  tasks.deleteAgent(c.req.param("id"));
  return c.body(null, 204);
});

// Skills / instructions du projet
api.get("/projects/:ref/skills", (c) => c.json(skills.listSkills(c.req.param("ref"))));
api.post("/projects/:ref/skills", async (c) => c.json(skills.saveSkill(c.req.param("ref"), skillBody.parse(await c.req.json())).skill, 201));
// Import d'un SKILL.md brut (corps = texte du fichier) ; ?name= si pas de frontmatter
api.post("/projects/:ref/skills/import", async (c) => {
  const input = skills.parseSkillMd(await c.req.text(), c.req.query("name") || undefined);
  return c.json(skills.saveSkill(c.req.param("ref"), input).skill, 201);
});
api.get("/skills/:id", (c) => c.json(skills.getSkillById(c.req.param("id"))));
api.get("/skills/:id/skill.md", (c) =>
  c.body(skills.toSkillMd(skills.getSkillById(c.req.param("id"))), 200, { "Content-Type": "text/markdown; charset=utf-8" }),
);
api.patch("/skills/:id", async (c) => c.json(skills.updateSkillById(c.req.param("id"), skillBody.partial().parse(await c.req.json()))));
api.delete("/skills/:id", (c) => {
  skills.deleteSkill(c.req.param("id"));
  return c.body(null, 204);
});

// Registre des décisions : lecture seule ici, l'écriture passe par le MCP
api.get("/projects/:ref/decisions", (c) => c.json(decisions.listDecisions(c.req.param("ref"))));
api.get("/decisions/:id", (c) => c.json(decisions.getDecision(c.req.param("id"))));

// File « Pour toi » : ce qui attend l'humain, tous projets confondus
api.get("/queue", (c) => c.json(humanQueue()));

// État consolidé d'un projet (reprise)
api.get("/projects/:ref/state", (c) => c.json(projectState(c.req.param("ref"))));
