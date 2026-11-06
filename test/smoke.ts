// Test de fumée : vrai client MCP + API HTTP contre un Brigade déjà démarré.
// Usage : BRIGADE_URL=http://127.0.0.1:3100 npm run smoke
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BRIGADE_URL ?? "http://127.0.0.1:3100";
const TOKEN = process.env.BRIGADE_TOKEN;

// PNG 1x1 rouge
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
  }),
);

type Block = { type: string; text?: string; data?: string; mimeType?: string };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), content: r.content as Block[] };
};
const textOf = (r: { content: Block[] }) => r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const api = async (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) => {
  const res = await fetch(`${BASE}/api${path}`, { method, body, headers });
  return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? await res.json() : null };
};

const tools = (await client.listTools()).tools.map((t) => t.name);
for (const t of ["ping", "list_projects", "create_project", "ask_questions", "list_grills", "get_answers", "get_question"])
  assert.ok(tools.includes(t), `outil manquant : ${t}`);

const name = `Smoke ${Date.now()}`;
const created = textOf(await call("create_project", { name, description: "test automatique" }));
const slug = /slug: ([\w-]+)/.exec(created)![1]!;

const asked = textOf(
  await call("ask_questions", {
    project: slug,
    title: "Cadrage",
    context: "Contexte avec `code`",
    questions: [
      { text: "Quel périmètre ?\n\n```ts\nconst a = 1\n```", hint: "court", choices: ["MVP", "Complet"] },
      { text: "Une capture du design actuel ?" },
      { text: "Question à passer" },
    ],
  }),
);
const grillId = /id: (g_[0-9a-f]+)/.exec(asked)![1]!;
const qIds = [...asked.matchAll(/\d=(q_[0-9a-f]+)/g)].map((m) => m[1]!);
assert.equal(qIds.length, 3);

// Erreurs métier lisibles
const bad = await call("ask_questions", { project: "inexistant", title: "x", questions: [{ text: "y" }] });
assert.equal(bad.isError, true);
assert.match(textOf(bad), /introuvable/);

// Avant réponse
assert.match(textOf(await call("get_answers", { grill_id: grillId })), /0\/3 répondues/);

// Réponses via l'API (comme le ferait l'interface)
assert.equal((await api("PUT", `/questions/${qIds[0]}/answer`, JSON.stringify({ text: "MVP d'abord" }), { "content-type": "application/json" })).status, 200);
const att = await api("POST", `/questions/${qIds[1]}/attachments?filename=design.png`, PNG, { "content-type": "image/png" });
assert.equal(att.status, 201);
assert.equal((await api("PUT", `/questions/${qIds[2]}/answer`, JSON.stringify({ skipped: true }), { "content-type": "application/json" })).status, 200);
assert.equal((await api("POST", `/questions/${qIds[1]}/attachments`, "pas une image", { "content-type": "text/plain" })).status, 400);

const answers = await call("get_answers", { grill_id: grillId });
assert.match(textOf(answers), /3\/3 répondues/);
assert.match(textOf(answers), /MVP d'abord/);
assert.match(textOf(answers), /question passée/);
const img = answers.content.find((b) => b.type === "image");
assert.ok(img, "image absente de get_answers");
assert.equal(img!.mimeType, "image/png");
assert.equal(Buffer.from(img!.data!, "base64").compare(PNG), 0, "image corrompue");

// Sous-agent : une seule question
const one = await call("get_question", { question_id: qIds[1] });
assert.ok(one.content.some((b) => b.type === "image"));

// Passage en « terminé » puis suppression de la pièce jointe → question redevient sans réponse
assert.equal((await api("POST", `/grills/${grillId}/status`, JSON.stringify({ status: "submitted" }), { "content-type": "application/json" })).json.status, "submitted");
assert.match(textOf(await call("list_grills", { project: slug, status: "submitted" })), /3\/3/);
assert.equal((await api("DELETE", `/attachments/${att.json.id}`)).status, 204);
assert.match(textOf(await call("get_answers", { grill_id: grillId })), /2\/3 répondues/);


// ================= Kanban =================
const idOf = (out: string, title: string) => new RegExp(`${title}[^\\n]*id (t_[0-9a-f]+)`).exec(out)![1]!;

// Agents + réglages
assert.match(textOf(await call("save_agent", { project: slug, name: "backend", description: "API", model: "sonnet", prompt: "Tu écris l'API." })), /créé/);
assert.match(textOf(await call("save_agent", { project: slug, name: "backend", description: "API et BDD" })), /mis à jour/);
assert.match(textOf(await call("set_project_settings", { project: slug, mode: "team", review_required: true })), /mode team.*relecture exigée/);

// Lot avec dépendances entre tâches du même lot, lien vers une question du grill (avec image)
const made = textOf(
  await call("create_tasks", {
    project: slug,
    tasks: [
      { ref: "a", title: "Schema", description: "Créer le schéma", priority: "high", assignee: "backend" },
      { ref: "b", title: "Endpoints", depends_on: ["a"], question_ids: [qIds[1]], difficulty: "hard" },
      { ref: "c", title: "Docs", depends_on: ["a", "b"], priority: "low" },
    ],
  }),
);
const A = idOf(made, "Schema"), B = idOf(made, "Endpoints"), C = idOf(made, "Docs");
assert.match(made, /#2 \[todo · BLOQUÉE par #1\]/);

// Cycle refusé, même indirect
const cyc = await call("update_task", { task_id: A, add_depends_on: [C] });
assert.equal(cyc.isError, true);
assert.match(textOf(cyc), /circulaire/);
assert.equal((await call("create_tasks", { project: slug, tasks: [{ title: "x", depends_on: ["inexistante"] }] })).isError, true);
assert.doesNotMatch(textOf(await call("list_tasks", { project: slug })), /\bx\b.*id t_/, "le lot en erreur doit être annulé");

// Seule A est prête ; B ne peut pas démarrer
assert.match(textOf(await call("list_tasks", { project: slug, ready_only: true })), /#1.*PRÊTE/);
const blocked = await call("start_task", { task_id: B });
assert.equal(blocked.isError, true);
assert.match(textOf(blocked), /bloquée par.*#1/);

// Démarrage atomique : le second démarrage de A est refusé
const [s1, s2] = await Promise.all([call("start_task", { task_id: A }), call("start_task", { task_id: A })]);
assert.equal([s1, s2].filter((r) => r.isError).length, 1, "un seul démarrage doit réussir");
assert.match(textOf(await call("list_agents", { project: slug })), /backend.*OCCUPÉ par #1/);

// Relecture exigée : A en relecture ne débloque pas B ; « changes » renvoie à faire avec notes
assert.match(textOf(await call("complete_task", { task_id: A, result: "Schéma v1 créé" })), /relecture/);
assert.equal((await call("start_task", { task_id: B })).isError, true, "B doit rester bloquée tant que A n'est pas relue");
assert.equal((await call("review_task", { task_id: A, verdict: "changes" })).isError, true, "notes obligatoires");
await call("review_task", { task_id: A, verdict: "changes", notes: "Il manque l'index sur user_id" });
assert.match(textOf(await call("get_task", { task_id: A })), /Il manque l'index/);
await call("start_task", { task_id: A });
await call("complete_task", { task_id: A, result: "Schéma v2 avec index" });
await call("review_task", { task_id: A, verdict: "approve", notes: "OK" });
assert.match(textOf(await call("list_tasks", { project: slug, ready_only: true })), /#2.*PRÊTE/);

// Fiche de B : résultat de la dépendance, question liée avec son image, agent
await call("update_task", { task_id: B, assignee: "backend" });
const brief = await call("get_task", { task_id: B });
assert.match(textOf(brief), /Schéma v2 avec index/);
assert.match(textOf(brief), /Instructions de l'agent[\s\S]*Tu écris l'API/);
assert.ok(brief.content.some((b) => b.type === "image") || textOf(brief).includes("Image jointe") || textOf(brief).includes("Une capture du design"), "question liée absente");

// Sans relecture exigée : terminée directement
await call("set_project_settings", { project: slug, review_required: false });
await call("start_task", { task_id: B });
assert.match(textOf(await call("complete_task", { task_id: B, result: "API faite" })), /Terminée/);
assert.match(textOf(await call("list_tasks", { project: slug, ready_only: true })), /#3.*PRÊTE/);

// État de reprise : prochaines actions cohérentes avec le kanban
const state = textOf(await call("get_project_state", { project: slug }));
assert.match(state, /# État de « Smoke/);
assert.match(state, /Mode : équipe de sous-agents/);
assert.match(state, /3 tâche\(s\) : 1 prête\(s\), 0 bloquée\(s\), 0 en cours, 0 en relecture, 2 terminée\(s\)/);
assert.match(state, /Démarrables maintenant : #3.*Agents disponibles : backend/s);
assert.equal((await api("GET", `/projects/${slug}/state`)).json.tasks.ready.length, 1);
const emptyProj = textOf(await call("create_project", { name: `Vide ${Date.now()}` }));
const emptySlug = /slug: ([\w-]+)/.exec(emptyProj)![1]!;
assert.match(textOf(await call("get_project_state", { project: emptySlug })), /Projet vide : lance un grill/);
await api("DELETE", `/projects/${emptySlug}`);

// Skills du projet
assert.match(textOf(await call("list_skills", { project: slug })), /Aucun skill/);
assert.match(textOf(await call("save_skill", { project: slug, name: "Conventions API", content: "x" }) ), /invalide/);
assert.match(textOf(await call("save_skill", { project: slug, name: "conventions-api", description: "REST", content: "Toujours du JSON.", always: true })), /créé/);
assert.match(textOf(await call("save_skill", { project: slug, name: "conventions-api", content: "Toujours du JSON, snake_case." })), /mis à jour/);
assert.match(textOf(await call("get_skill", { project: slug, skill: "conventions-api" })), /snake_case/);
assert.match(textOf(await call("list_skills", { project: slug })), /conventions-api \[TOUJOURS\] — REST/);
assert.match(textOf(await call("get_project_state", { project: slug })), /Skills à lire d'abord \(get_skill\) : conventions-api/);
assert.match(textOf(await call("get_task", { task_id: C })), /\[toujours\] conventions-api/);
const skList = (await api("GET", `/projects/${slug}/skills`)).json;
assert.equal(skList.length, 1);
const md = await (await fetch(`${BASE}/api/skills/${skList[0].id}/skill.md`)).text();
assert.match(md, /^---\nname: conventions-api\ndescription: "REST"\n---/);
const imp = await api("POST", `/projects/${slug}/skills/import`, "---\nname: tests-vitest\ndescription: Lancer les tests\n---\n\nUtilise `npm test`.\n", { "content-type": "text/markdown" });
assert.equal(imp.json.name, "tests-vitest");
assert.equal(imp.json.content, "Utilise `npm test`.");
assert.equal((await api("DELETE", `/skills/${skList[0].id}`)).status, 204);

// Interface : déplacement manuel, suppression
const moved = await api("POST", `/tasks/${C}/action`, JSON.stringify({ action: "move", status: "done" }), { "content-type": "application/json" });
assert.equal(moved.json.status, "done");
assert.equal((await api("DELETE", `/tasks/${C}`)).status, 204);
assert.equal((await api("GET", `/tasks/${C}`)).status, 404);

// Nettoyage
assert.equal((await api("DELETE", `/projects/${slug}`)).status, 204);
assert.equal((await api("GET", `/projects/${slug}`)).status, 404);
console.log("SMOKE OK");
await client.close();
