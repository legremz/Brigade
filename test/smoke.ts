// Test de fumée : vrai client MCP + API HTTP contre un Brigade déjà démarré.
// Usage : BRIGADE_URL=http://127.0.0.1:<port d'une instance jetable> npm run smoke
// BRIGADE_URL est obligatoire : le port 3100 héberge les vraies données, le test ne doit jamais le viser par défaut.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { localOnly } from "../src/guard.js";
import { parseStaleMinutes } from "../src/stale.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function requireBaseUrl(): string {
  const url = process.env.BRIGADE_URL;
  if (!url) throw new Error("BRIGADE_URL est obligatoire : indique l'URL d'une instance jetable.");
  return url;
}
const BASE = requireBaseUrl();
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
const callOn = (target: Client) => async (name: string, args: Record<string, unknown> = {}) => {
  const r = await target.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), content: r.content as Block[] };
};
const call = callOn(client);
const textOf = (r: { content: Block[] }) => r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const apiOn = (base: string) => async (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api${path}`, { method, body, headers });
  return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? await res.json() : null };
};
const api = apiOn(BASE);

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

// Fin de tâche : résultat et vérification obligatoires, la tâche reste en cours sinon
const emptyResult = await call("complete_task", { task_id: A, result: "  ", verification: "npm test" });
assert.equal(emptyResult.isError, true);
assert.match(textOf(emptyResult), /résultat est vide/);
const emptyProof = await call("complete_task", { task_id: A, result: "fait", verification: " " });
assert.equal(emptyProof.isError, true);
assert.match(textOf(emptyProof), /vérification est vide/);
assert.equal((await call("complete_task", { task_id: A, result: "fait" })).isError, true, "vérification absente");
assert.equal((await api("GET", `/tasks/${A}`)).json.status, "in_progress", "un refus laisse la tâche en cours");

// Relecture exigée : A en relecture ne débloque pas B ; « changes » renvoie à faire avec notes
assert.match(textOf(await call("complete_task", { task_id: A, result: "Schéma v1 créé", verification: "npm test : OK" })), /relecture/);
assert.equal((await call("start_task", { task_id: B })).isError, true, "B doit rester bloquée tant que A n'est pas relue");
assert.equal((await call("review_task", { task_id: A, verdict: "changes" })).isError, true, "notes obligatoires");
await call("review_task", { task_id: A, verdict: "changes", notes: "Il manque l'index sur user_id" });
const sentBack = textOf(await call("get_task", { task_id: A }));
assert.match(sentBack, /Il manque l'index/);
assert.match(sentBack, /Résultat de la tentative précédente\nSchéma v1 créé/);
assert.doesNotMatch(sentBack, /Résultat déclaré/);
await call("start_task", { task_id: A });
await call("complete_task", { task_id: A, result: "Schéma v2 avec index", verification: "npm test : OK" });
assert.match(textOf(await call("get_task", { task_id: A })), /Résultat déclaré\nSchéma v2 avec index/);
await call("review_task", { task_id: A, verdict: "approve", notes: "OK" });
assert.match(textOf(await call("list_tasks", { project: slug, ready_only: true })), /#2.*PRÊTE/);

// Fiche de B : résultat de la dépendance, question liée avec son image, agent
await call("update_task", { task_id: B, assignee: "backend" });
const brief = await call("get_task", { task_id: B });
assert.match(textOf(brief), /Schéma v2 avec index/);
assert.match(textOf(brief), /vérifié : npm test : OK/);
assert.match(textOf(brief), /Instructions de l'agent[\s\S]*Tu écris l'API/);
assert.ok(brief.content.some((b) => b.type === "image") || textOf(brief).includes("Image jointe") || textOf(brief).includes("Une capture du design"), "question liée absente");

// Sans relecture exigée : terminée directement
await call("set_project_settings", { project: slug, review_required: false });
await call("start_task", { task_id: B });
assert.match(textOf(await call("complete_task", { task_id: B, result: "API faite", verification: "npm test : OK" })), /Terminée/);
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

// Passage manuel en « Terminées » : respecte dépendances et relecture, sauf forçage explicite
const moveBody = (status: string, force?: boolean) => JSON.stringify({ action: "move", status, force });
const JSON_HEADERS = { "content-type": "application/json" };
const guarded = textOf(
  await call("create_tasks", {
    project: slug,
    tasks: [
      { ref: "open", title: "Ouverte" },
      { ref: "dep", title: "Dependante", depends_on: ["open"] },
      { title: "Relue", review: true },
    ],
  }),
);
const DEP = idOf(guarded, "Dependante"), REVIEWED = idOf(guarded, "Relue");
const depRefused = await api("POST", `/tasks/${DEP}/action`, moveBody("done"), JSON_HEADERS);
assert.equal(depRefused.status, 409);
assert.equal(depRefused.json.code, "force_required");
assert.match(depRefused.json.error, /dépendance.*#\d+/);
assert.equal((await api("GET", `/tasks/${DEP}`)).json.status, "todo", "le refus ne déplace pas la carte");
const reviewRefused = await api("POST", `/tasks/${REVIEWED}/action`, moveBody("done"), JSON_HEADERS);
assert.equal(reviewRefused.status, 409);
assert.match(reviewRefused.json.error, /relecture/);
const forced = await api("POST", `/tasks/${DEP}/action`, moveBody("done", true), JSON_HEADERS);
assert.equal(forced.json.status, "done");
assert.match(forced.json.forced_note, /malgré.*dépendance/);
assert.match(textOf(await call("get_task", { task_id: DEP })), /Fin hors des règles/);
const reopened = await api("POST", `/tasks/${DEP}/action`, moveBody("todo"), JSON_HEADERS);
assert.equal(reopened.json.status, "todo");
assert.equal(reopened.json.forced_note, "", "la réouverture efface la trace du forçage");

// Fin déclarée après un déplacement manuel en cours : acceptée, mais tracée
const manual = textOf(
  await call("create_tasks", { project: slug, tasks: [{ ref: "up", title: "Amont" }, { title: "Aval", depends_on: ["up"] }] }),
);
const DOWN = idOf(manual, "Aval");
await api("POST", `/tasks/${DOWN}/action`, moveBody("in_progress"), JSON_HEADERS);
await call("complete_task", { task_id: DOWN, result: "fait quand même", verification: "contrôle manuel" });
const finishedOpen = (await api("GET", `/tasks/${DOWN}`)).json;
assert.equal(finishedOpen.status, "done");
assert.match(finishedOpen.forced_note, /malgré.*dépendance.*#\d+/);

// Trace de fin avec relecture : effacée au renvoi à faire, calculée ou conservée à l'approbation
const reviewedFlow = textOf(
  await call("create_tasks", {
    project: slug,
    tasks: [
      { ref: "gate", title: "Barriere" },
      { title: "Renvoyee", depends_on: ["gate"], review: true },
      { title: "Liberee", depends_on: ["gate"], review: true },
      { title: "Approuvee", depends_on: ["gate"], review: true },
      { title: "Imposee", depends_on: ["gate"], review: true },
    ],
  }),
);
const finishOpen = async (taskId: string) => {
  await api("POST", `/tasks/${taskId}/action`, moveBody("in_progress"), JSON_HEADERS);
  await call("complete_task", { task_id: taskId, result: "fait", verification: "contrôle" });
  const task = (await api("GET", `/tasks/${taskId}`)).json;
  assert.equal(task.status, "review");
  assert.match(task.forced_note, /malgré.*dépendance/);
};
const SENT_BACK = idOf(reviewedFlow, "Renvoyee");
await finishOpen(SENT_BACK);
await call("review_task", { task_id: SENT_BACK, verdict: "changes", notes: "À reprendre" });
assert.equal((await api("GET", `/tasks/${SENT_BACK}`)).json.forced_note, "", "changes efface la trace");
const RELEASED = idOf(reviewedFlow, "Liberee");
await finishOpen(RELEASED);
await call("release_task", { task_id: RELEASED });
assert.equal((await api("GET", `/tasks/${RELEASED}`)).json.forced_note, "", "release efface la trace");

const APPROVED = idOf(reviewedFlow, "Approuvee");
await api("POST", `/tasks/${APPROVED}/action`, moveBody("review"), JSON_HEADERS);
assert.equal((await api("GET", `/tasks/${APPROVED}`)).json.forced_note, "");
await call("review_task", { task_id: APPROVED, verdict: "approve" });
assert.match((await api("GET", `/tasks/${APPROVED}`)).json.forced_note, /Fin déclarée.*malgré.*dépendance/, "approbation avec dépendance ouverte tracée");

const IMPOSED = idOf(reviewedFlow, "Imposee");
const imposedNote = (await api("POST", `/tasks/${IMPOSED}/action`, moveBody("done", true), JSON_HEADERS)).json.forced_note;
assert.match(imposedNote, /Terminée manuellement/);
assert.equal((await api("POST", `/tasks/${IMPOSED}/action`, moveBody("review"), JSON_HEADERS)).json.forced_note, imposedNote, "la remise en relecture conserve la note");
await call("review_task", { task_id: IMPOSED, verdict: "approve" });
assert.equal((await api("GET", `/tasks/${IMPOSED}`)).json.forced_note, imposedNote, "l'approbation conserve la note existante");

// Interface : déplacement manuel, suppression
const moved = await api("POST", `/tasks/${C}/action`, JSON.stringify({ action: "move", status: "done" }), { "content-type": "application/json" });
assert.equal(moved.json.status, "done");
assert.equal((await api("DELETE", `/tasks/${C}`)).status, 204);
assert.equal((await api("GET", `/tasks/${C}`)).status, 404);

// Requêtes d'une autre origine ou d'un autre hôte : rejetées sur l'API et le MCP
const MCP_INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const baseUrl = new URL(BASE);
assert.equal((await api("GET", "/projects", undefined, { origin: "https://example.com" })).status, 403);
assert.equal((await api("GET", "/projects", undefined, { origin: "null" })).status, 403);
assert.equal((await api("GET", "/projects", undefined, { origin: baseUrl.origin })).status, 200, "interface locale acceptée");
assert.equal((await api("GET", "/projects")).status, 200, "sans Origin : accepté");
assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", body: MCP_INIT, headers: { ...MCP_HEADERS, origin: "https://example.com" } })).status, 403);

/** fetch ne laisse pas toujours fixer Host : passage par node:http pour simuler un rebinding DNS. */
const statusWithHost = (path: string, host: string, method = "GET", body?: string) =>
  new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      { hostname: baseUrl.hostname, port: baseUrl.port, path, method, headers: { ...MCP_HEADERS, host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
assert.equal(await statusWithHost("/api/projects", "evil.example"), 403, "Host étranger refusé sur l'API");
assert.equal(await statusWithHost("/mcp", "evil.example:3100", "POST", MCP_INIT), 403, "Host étranger refusé sur le MCP");
assert.equal(await statusWithHost("/api/projects", "localhost:1234"), 200, "boucle locale, tout port");
assert.equal(await statusWithHost("/health", "evil.example"), 200, "healthcheck libre");

// Règles d'hôte dépendant de la configuration, testées sur une petite app sans redémarrer le serveur
const guardedApp = (publicUrl: string) => {
  const app = new Hono();
  app.use("*", localOnly(publicUrl));
  app.get("/x", (c) => c.text("ok"));
  return app;
};
const guardStatus = async (publicUrl: string, headers: Record<string, string>) =>
  (await guardedApp(publicUrl).request("/x", { headers })).status;
const PUBLIC_URL = "http://brigade.lan:8443";
assert.equal(await guardStatus(PUBLIC_URL, { host: "brigade.lan:8443" }), 200, "hôte public accepté");
assert.equal(await guardStatus("", { host: "brigade.lan:8443" }), 403, "hôte refusé sans BRIGADE_PUBLIC_URL");
assert.equal(await guardStatus(PUBLIC_URL, { host: "autre.lan:8443" }), 403, "autre hôte refusé");
assert.equal(await guardStatus(PUBLIC_URL, { host: "127.0.0.1:3100", origin: "http://brigade.lan:8443" }), 200, "origine publique derrière un proxy");
assert.equal(await guardStatus(PUBLIC_URL, { host: "127.0.0.1:3100", origin: "http://brigade.lan:9999" }), 403, "port d'origine différent refusé");
assert.equal(await guardStatus("", { host: "[::1]:3100" }), 200, "boucle locale IPv6");
assert.equal(await statusWithHost("/api/projects", `[::1]:${baseUrl.port}`), 200, "Host IPv6 sur le serveur réel");

// Réponses modifiables après « J'ai fini » ; marquage « modifiée depuis la lecture » levé par une nouvelle lecture
const MODIFIED_SINCE_READ = /Modifiée depuis ta dernière lecture/;
const readGrill = textOf(await call("ask_questions", { project: slug, title: "Lecture", questions: [{ text: "Base ?" }, { text: "Capture ?" }] }));
const READ_GRILL = /id: (g_[0-9a-f]+)/.exec(readGrill)![1]!;
const [READ_Q1, READ_Q2] = [...readGrill.matchAll(/\d=(q_[0-9a-f]+)/g)].map((m) => m[1]!) as [string, string];
const putAnswer = (qid: string, body: unknown) => api("PUT", `/questions/${qid}/answer`, JSON.stringify(body), JSON_HEADERS);
const questionState = async (qid: string, grill = READ_GRILL) =>
  (await api("GET", `/grills/${grill}`)).json.questions.find((q: { id: string }) => q.id === qid);
await putAnswer(READ_Q1, { text: "v1" });
assert.equal((await questionState(READ_Q1)).modified_since_read, false, "aucun marquage avant la première lecture");
assert.equal((await api("GET", `/grills/${READ_GRILL}`)).json.last_read_at, null);
assert.doesNotMatch(textOf(await call("get_answers", { grill_id: READ_GRILL })), MODIFIED_SINCE_READ);
assert.ok((await api("GET", `/grills/${READ_GRILL}`)).json.last_read_at, "lecture mémorisée");
assert.equal((await api("POST", `/grills/${READ_GRILL}/status`, JSON.stringify({ status: "submitted" }), JSON_HEADERS)).status, 200);
assert.equal((await putAnswer(READ_Q1, { text: "v1" })).status, 200);
assert.equal((await putAnswer(READ_Q1, {})).status, 200);
assert.equal((await questionState(READ_Q1)).modified_since_read, false, "une écriture sans changement ne marque rien");
assert.equal((await putAnswer(READ_Q1, { text: "v2 corrigée" })).status, 200, "grill terminé : réponse encore modifiable");
assert.equal((await questionState(READ_Q1)).modified_since_read, true);
assert.equal((await api("GET", `/grills/${READ_GRILL}`)).json.status, "submitted", "modifier ne rouvre pas le grill");
assert.match(textOf(await call("get_question", { question_id: READ_Q1 })), MODIFIED_SINCE_READ);
assert.equal((await questionState(READ_Q1)).modified_since_read, true, "get_question n'est pas une lecture du grill");
const reread = textOf(await call("get_answers", { grill_id: READ_GRILL }));
assert.match(reread, MODIFIED_SINCE_READ);
assert.match(reread, /v2 corrigée/);
assert.match(reread, /Modifiées depuis ta dernière lecture : question\(s\) 1\./);
assert.equal((await questionState(READ_Q1)).modified_since_read, false, "une nouvelle lecture retire le marquage");
assert.doesNotMatch(textOf(await call("get_answers", { grill_id: READ_GRILL })), MODIFIED_SINCE_READ);
const readAtt = await api("POST", `/questions/${READ_Q2}/attachments?filename=a.png`, PNG, { "content-type": "image/png" });
assert.equal((await questionState(READ_Q2)).modified_since_read, true, "image ajoutée après lecture");
await call("get_answers", { grill_id: READ_GRILL });
assert.equal((await api("DELETE", `/attachments/${readAtt.json.id}`)).status, 204);
assert.equal((await questionState(READ_Q2)).modified_since_read, true, "image retirée après lecture");

// Sorties explicites : règles côté serveur et consignes restituées à l'agent
const exitsGrill = textOf(
  await call("ask_questions", {
    project: slug,
    title: "Sorties",
    questions: [
      { text: "Proposition ?", default_answer: "  PostgreSQL  " },
      { text: "Décide ?", default_answer: "Option A" },
      { text: "Hors sujet ?" },
      { text: "Pour après ?" },
      { text: "Critique sans proposition ?", critical: true },
      { text: "Critique avec proposition ?", critical: true, default_answer: "Option B" },
    ],
  }),
);
const EXITS_GRILL = /id: (g_[0-9a-f]+)/.exec(exitsGrill)![1]!;
const [ACCEPTED, DECIDED, DISCARDED, LATER, CRITICAL, CRITICAL_DEFAULT] = [...exitsGrill.matchAll(/\d=(q_[0-9a-f]+)/g)].map((m) => m[1]!) as [string, string, string, string, string, string];
const exitState = (qid: string) => questionState(qid, EXITS_GRILL);

const fresh = await exitState(ACCEPTED);
assert.equal(fresh.outcome, null, "pas de sortie tant qu'il n'y en a pas d'explicite");
assert.equal(fresh.answered, false);
assert.equal(fresh.default_answer, "PostgreSQL", "proposition nettoyée");
assert.deepEqual(fresh.available_outcomes, ["accept_default", "decide_for_me", "not_relevant", "later"]);
assert.equal((await exitState(CRITICAL)).critical, true);
assert.deepEqual((await exitState(CRITICAL)).available_outcomes, ["not_relevant", "later"]);
assert.deepEqual((await exitState(DISCARDED)).available_outcomes, ["decide_for_me", "not_relevant", "later"]);
assert.deepEqual((await exitState(CRITICAL_DEFAULT)).available_outcomes, ["accept_default", "not_relevant", "later"]);

// Refus : la sortie n'est pas écrite et la question reste sans réponse
const refusedDecide = await putAnswer(CRITICAL, { outcome: "decide_for_me" });
assert.equal(refusedDecide.status, 400, "décide pour moi refusé sur une question critique");
assert.match(refusedDecide.json.error, /critique/);
assert.equal((await putAnswer(CRITICAL_DEFAULT, { outcome: "decide_for_me" })).status, 400, "même avec une proposition");
assert.equal((await exitState(CRITICAL)).outcome, null);
assert.equal((await exitState(CRITICAL)).answered, false);
const refusedAccept = await putAnswer(DISCARDED, { outcome: "accept_default" });
assert.equal(refusedAccept.status, 400, "valider refusé sans réponse par défaut");
assert.match(refusedAccept.json.error, /réponse par défaut/);
assert.equal((await putAnswer(DISCARDED, { outcome: "inconnue" })).status, 400, "valeur hors liste refusée");
assert.equal((await putAnswer(LATER, { outcome: "later", skipped: true })).status, 400, "passée et sortie s'excluent");

// Chaque sortie compte comme traitée, conserve le texte et porte sa consigne
assert.equal((await putAnswer(ACCEPTED, { outcome: "accept_default" })).json.outcome, "accept_default");
assert.equal((await putAnswer(DECIDED, { outcome: "decide_for_me" })).json.answered, true);
assert.equal((await putAnswer(DISCARDED, { text: "note gardée" })).status, 200);
const discardedSaved = await putAnswer(DISCARDED, { outcome: "not_relevant" });
assert.equal(discardedSaved.json.answer_text, "note gardée", "une sortie n'efface pas le texte");
assert.equal((await putAnswer(LATER, { outcome: "later" })).json.answered, true, "plus tard compte comme traité");
assert.equal((await api("GET", `/grills/${EXITS_GRILL}`)).json.answered, 4);
await putAnswer(CRITICAL_DEFAULT, { outcome: "accept_default" });

const exitsText = textOf(await call("get_answers", { grill_id: EXITS_GRILL }));
assert.match(exitsText, /5\/6 répondues/);
assert.match(exitsText, /Sortie : proposition validée\.\*\* Consigne : la proposition fait foi : « PostgreSQL »/);
assert.match(exitsText, /Sortie : décide pour moi\.\*\* Consigne : tranche toi-même et écris ta décision/);
assert.match(exitsText, /Sortie : pas pertinent\.\*\* Consigne : écarte cette question[\s\S]*note gardée/);
assert.match(exitsText, /Sortie : plus tard\.\*\* Consigne : laisse la question ouverte/);
assert.match(exitsText, /Question critique/);
assert.match(exitsText, /Proposition de l'agent : Option A/);
const laterSection = exitsText.indexOf("## Plus tard : 1 question(s)");
assert.ok(laterSection > 0, "plus tard listé à part");
assert.ok(exitsText.indexOf("Pour après ?") > laterSection, "la question reportée est dans la section à part");
assert.ok(exitsText.indexOf("Proposition ?") < laterSection, "les autres restent dans le flux");
assert.match(exitsText, /Sans réponse : question\(s\) 5\./, "plus tard ne figure pas parmi les questions sans réponse");
assert.match(textOf(await call("get_question", { question_id: DECIDED })), /Consigne : tranche toi-même/);

// Écrire sur une question « plus tard », c'est y répondre ; sur les autres sorties, le texte reste une note
assert.equal((await putAnswer(LATER, { text: "   " })).json.outcome, "later", "un texte vide ne retire pas plus tard");
assert.equal((await putAnswer(LATER, { text: "note", outcome: "later" })).json.outcome, "later", "texte envoyé avec la sortie : la sortie reste");
const writtenOverLater = await putAnswer(LATER, { text: "Finalement : oui" });
assert.equal(writtenOverLater.json.outcome, null, "un texte sur plus tard retire la sortie");
assert.equal(writtenOverLater.json.answered, true);
assert.equal(writtenOverLater.json.answer_text, "Finalement : oui");
assert.match(textOf(await call("get_question", { question_id: LATER })), /\*\*Réponse :\*\*\nFinalement : oui/);
assert.equal((await putAnswer(LATER, { text: "" })).status, 200);
assert.equal((await putAnswer(LATER, { outcome: "later" })).json.outcome, "later");
assert.equal((await putAnswer(DECIDED, { text: "note sur décide" })).json.outcome, "decide_for_me", "le texte reste une note sur décide pour moi");
assert.equal((await putAnswer(ACCEPTED, { text: "note sur validé" })).json.outcome, "accept_default", "le texte reste une note sur la proposition validée");
assert.equal((await putAnswer(DISCARDED, { text: "autre note" })).json.outcome, "not_relevant", "le texte reste une note sur pas pertinent");

// Retirer une sortie rend la question à nouveau sans réponse ; passer et sortie se remplacent
const laterCleared = await putAnswer(LATER, { outcome: null });
assert.equal(laterCleared.json.answered, false);
assert.equal(laterCleared.json.modified_since_read, true, "changer la sortie après lecture marque la réponse");
assert.equal((await putAnswer(LATER, { skipped: true })).json.skipped, true);
const skippedThenLater = await putAnswer(LATER, { outcome: "later" });
assert.equal(skippedThenLater.json.skipped, false, "la sortie remplace « passer »");
const laterThenSkipped = await putAnswer(LATER, { skipped: true });
assert.equal(laterThenSkipped.json.outcome, null, "« passer » remplace la sortie");
assert.match(textOf(await call("get_answers", { grill_id: EXITS_GRILL })), /question passée \(ancienne valeur, intention d'origine inconnue\)/);
assert.equal((await exitState(LATER)).outcome, null, "passée reste sans sortie");
assert.equal((await putAnswer(LATER, { skipped: false })).json.modified_since_read, true, "reprendre après lecture marque la réponse");

// Registre des décisions (le grill des sorties, avec son « Décide pour moi », fausserait les comptes)
assert.equal((await api("DELETE", `/grills/${EXITS_GRILL}`)).status, 204);
const toolNames = (await client.listTools()).tools.map((t) => t.name);
assert.ok(toolNames.includes("record_decision") && toolNames.includes("list_decisions"));
assert.ok(!toolNames.some((t) => /(update|delete|edit)_decision/.test(t)), "une décision est immuable");
const decisionGrill = textOf(
  await call("ask_questions", {
    project: slug,
    title: "Décisions",
    questions: [
      { text: "Quel format ?" },
      { text: "Hébergement ?", critical: true },
      { text: "Couleur ?" },
      { text: "Budget ?", critical: true, default_answer: "Faible" },
      { text: "Schéma ?", critical: true },
    ],
  }),
);
const DECISION_GRILL = /id: (g_[0-9a-f]+)/.exec(decisionGrill)![1]!;
const [TO_DECIDE, CRITICAL_SOURCE, OTHER_SOURCE, CRITICAL_ACCEPTED, CRITICAL_IMAGE] = [...decisionGrill.matchAll(/\d=(q_[0-9a-f]+)/g)].map((m) => m[1]!) as [string, string, string, string, string];
const decisionTasks = textOf(
  await call("create_tasks", {
    project: slug,
    tasks: [
      { title: "Tache directe" },
      { title: "Tache par question", question_ids: [CRITICAL_SOURCE] },
      { title: "Tache a part" },
    ],
  }),
);
const DIRECT_TASK = idOf(decisionTasks, "Tache directe"), VIA_QUESTION_TASK = idOf(decisionTasks, "Tache par question"), UNRELATED_TASK = idOf(decisionTasks, "Tache a part");
const decisionsApi = async () => (await api("GET", `/projects/${slug}/decisions`)).json as { id: string; decision: string; reason: string; created_at: string; source: string; question_text: string | null; question: { id: string; grill_id: string; position: number; text: string } | null; tasks: { id: string; seq: number; title: string }[] }[];
const decisionState = (qid: string) => questionState(qid, DECISION_GRILL);
const AWAITING = /Attend une décision/;
const decidedFirst = await decisionsApi();
assert.deepEqual(decidedFirst, []);
assert.match(textOf(await call("list_decisions", { project: slug })), /Aucune décision/);
assert.doesNotMatch(textOf(await call("get_project_state", { project: slug })), /décision\(s\) enregistrée\(s\)/);

// Validation : rien n'est écrit en cas de refus
const refuse = async (args: Record<string, unknown>, pattern: RegExp) => {
  const r = await call("record_decision", { project: slug, decision: "ok", reason: "ok", ...args });
  assert.equal(r.isError, true, `refus attendu : ${JSON.stringify(args)}`);
  assert.match(textOf(r), pattern);
};
await refuse({ decision: "  " }, /décision est vide/);
await refuse({ reason: " " }, /raison est vide/);
await refuse({ question_id: "q_inexistante" }, /introuvable/);
await refuse({ task_ids: ["t_inexistante"] }, /introuvable/i);
const otherProject = /slug: ([\w-]+)/.exec(textOf(await call("create_project", { name: `Autre ${Date.now()}` })))![1]!;
const otherAsked = textOf(await call("ask_questions", { project: otherProject, title: "x", questions: [{ text: "y" }] }));
const FOREIGN_QUESTION = /1=(q_[0-9a-f]+)/.exec(otherAsked)![1]!;
await refuse({ question_id: FOREIGN_QUESTION }, /introuvable/);
assert.equal((await decisionsApi()).length, 0, "aucune décision écrite après les refus");

// « Décide pour moi » : la question attend une décision, signalée à l'agent et dans la reprise
assert.equal((await putAnswer(TO_DECIDE, { outcome: "decide_for_me" })).status, 200);
assert.equal((await decisionState(TO_DECIDE)).awaiting_decision, true);
assert.equal((await decisionState(OTHER_SOURCE)).awaiting_decision, false, "seul décide pour moi attend une décision");
const awaitingAnswers = textOf(await call("get_answers", { grill_id: DECISION_GRILL }));
assert.match(awaitingAnswers, AWAITING);
assert.match(awaitingAnswers, /En attente d'une décision : question\(s\) 1\./);
const pendingState = textOf(await call("get_project_state", { project: slug }));
assert.match(pendingState, /1 « Décide pour moi » encore sans décision/);
assert.ok(pendingState.includes(TO_DECIDE), "la reprise cite la question");
assert.equal((await api("GET", `/projects/${slug}/state`)).json.decisions.awaiting.length, 1);
assert.match(textOf(await call("list_decisions", { project: slug })), new RegExp(`sans décision : ${TO_DECIDE}`));

// Une décision qui n'est pas liée à cette question ne la clôt pas
// Question critique : refusée tant que l'utilisateur n'a rien dit, y compris avec une sortie qui n'est pas une réponse
const countBefore = (await decisionsApi()).length;
await refuse({ question_id: CRITICAL_SOURCE }, /critique/);
assert.equal((await putAnswer(CRITICAL_SOURCE, { outcome: "later" })).status, 200);
await refuse({ question_id: CRITICAL_SOURCE }, /critique/);
assert.equal((await putAnswer(CRITICAL_SOURCE, { outcome: "not_relevant" })).status, 200);
await refuse({ question_id: CRITICAL_SOURCE }, /critique/);
assert.equal((await putAnswer(CRITICAL_SOURCE, { text: "une note", outcome: "later" })).json.outcome, "later");
await refuse({ question_id: CRITICAL_SOURCE }, /critique/);
assert.equal((await putAnswer(CRITICAL_SOURCE, { text: "une note", outcome: "not_relevant" })).json.outcome, "not_relevant");
await refuse({ question_id: CRITICAL_SOURCE }, /critique/);
assert.equal((await putAnswer(CRITICAL_SOURCE, { outcome: null })).status, 200);
assert.equal((await putAnswer(CRITICAL_SOURCE, { text: "   " })).status, 200);
await refuse({ question_id: CRITICAL_SOURCE }, /critique/);
await refuse({ question_id: CRITICAL_ACCEPTED }, /critique/);
assert.equal((await decisionsApi()).length, countBefore, "aucune décision écrite sur une question critique sans réponse");

// Question critique répondue : enregistrable (texte, proposition validée, image)
assert.equal((await putAnswer(CRITICAL_SOURCE, { text: "Chez nous" })).status, 200);
const onCritical = await call("record_decision", { project: slug, decision: "Auto-hébergé", reason: "Contrainte du projet", question_id: CRITICAL_SOURCE });
assert.equal(onCritical.isError, false, "décision permise sur une question critique répondue");
assert.equal((await putAnswer(CRITICAL_ACCEPTED, { outcome: "accept_default" })).status, 200);
assert.equal((await call("record_decision", { project: slug, decision: "Budget faible", reason: "Proposition validée", question_id: CRITICAL_ACCEPTED })).isError, false, "proposition validée : enregistrable");
assert.equal((await api("POST", `/questions/${CRITICAL_IMAGE}/attachments?filename=s.png`, PNG, { "content-type": "image/png" })).status, 201);
assert.equal((await putAnswer(CRITICAL_IMAGE, { outcome: "later" })).status, 200);
await refuse({ question_id: CRITICAL_IMAGE }, /critique/);
assert.equal((await putAnswer(CRITICAL_IMAGE, { outcome: null })).status, 200);
assert.equal((await call("record_decision", { project: slug, decision: "Schéma retenu", reason: "Capture fournie", question_id: CRITICAL_IMAGE })).isError, false, "réponse par image : enregistrable");
assert.equal((await call("record_decision", { project: slug, decision: "Bleu", reason: "Charte", question_id: OTHER_SOURCE })).isError, false, "décision permise sans la sortie");
const ordinary = await call("record_decision", { project: slug, decision: "Hors question", reason: "Choix général", task_ids: [UNRELATED_TASK] });
assert.equal(ordinary.isError, false, "décision permise sans question source");
assert.equal((await decisionState(TO_DECIDE)).awaiting_decision, true, "une décision sur une autre question ne clôt rien");

// La décision liée clôt l'attente et accepte des références de tâche par numéro
const directSeq = (await api("GET", `/tasks/${DIRECT_TASK}`)).json.seq as number;
const closing = await call("record_decision", { project: slug, decision: "JSON", reason: "Déjà en place", question_id: TO_DECIDE, task_ids: [`#${directSeq}`, DIRECT_TASK] });
assert.equal(closing.isError, false);
const closedId = /`(d_[0-9a-f]+)`/.exec(textOf(closing))![1]!;
assert.equal((await decisionState(TO_DECIDE)).awaiting_decision, false, "décision enregistrée : plus d'attente");
assert.equal((await decisionState(TO_DECIDE)).outcome, "decide_for_me", "la sortie reste");
const closedAnswers = textOf(await call("get_answers", { grill_id: DECISION_GRILL }));
assert.doesNotMatch(closedAnswers, AWAITING);
assert.doesNotMatch(closedAnswers, /En attente d'une décision/);
assert.match(closedAnswers, /Sortie : décide pour moi\.\*\* Décision enregistrée/);
assert.match(closedAnswers, /JSON — raison : Déjà en place/);
const closedState = textOf(await call("get_project_state", { project: slug }));
assert.doesNotMatch(closedState, /encore sans décision/);
assert.match(closedState, /6 décision\(s\) enregistrée\(s\)/);
const stateDecisions = (await api("GET", `/projects/${slug}/state`)).json.decisions as { total: number; recent: { id: string; decision: string }[] };
assert.equal(stateDecisions.total, 6);
assert.deepEqual(stateDecisions.recent.map((d) => d.decision), ["JSON", "Hors question", "Bleu", "Schéma retenu", "Budget faible"], "les 5 plus récentes, la plus récente d'abord");
assert.match(closedState, /## Décisions récentes \(5\)[\s\S]*JSON — raison : Déjà en place/);
assert.doesNotMatch(closedState, /Auto-hébergé/, "la 6e décision n'est pas reprise");

// Restitution : API, ordre, tâches sans doublon, question source
const registry = await decisionsApi();
assert.equal(registry.length, 6);
assert.equal(registry[0]!.id, closedId, "les plus récentes d'abord");
assert.equal(registry[0]!.reason, "Déjà en place");
assert.equal(registry[0]!.question?.id, TO_DECIDE);
assert.equal(registry[0]!.question?.grill_id, DECISION_GRILL);
assert.equal(registry[0]!.source, "linked");
assert.equal(registry[0]!.question_text, "Quel format ?", "texte de la question copié");
const neverSourced = registry.find((d) => d.decision === "Hors question")!;
assert.equal(neverSourced.source, "none");
assert.equal(neverSourced.question_text, null);
assert.match(textOf(await call("get_task", { task_id: UNRELATED_TASK })), /Hors question — raison : Choix général — jamais de source/);
assert.match(textOf(await call("list_decisions", { project: slug })), /Hors question — raison : Choix général — jamais de source/);
assert.deepEqual(registry[0]!.tasks.map((t) => t.id), [DIRECT_TASK], "référence et id de la même tâche : une seule liaison");
assert.equal((await api("GET", `/decisions/${closedId}`)).json.decision, "JSON");
assert.equal((await api("GET", "/decisions/d_inconnue")).status, 404);
assert.match(textOf(await call("list_decisions", { project: slug })), /Auto-hébergé — raison : Contrainte du projet/);

// get_task : décisions de la tâche et de ses questions, pas les autres
const directBrief = textOf(await call("get_task", { task_id: DIRECT_TASK }));
assert.match(directBrief, /Décisions liées[\s\S]*JSON — raison : Déjà en place/);
assert.doesNotMatch(directBrief, /Auto-hébergé/);
const viaQuestionBrief = textOf(await call("get_task", { task_id: VIA_QUESTION_TASK }));
assert.match(viaQuestionBrief, /Décisions liées[\s\S]*Auto-hébergé/);
assert.doesNotMatch(viaQuestionBrief, /Hors question/);

// Immuable : aucune route d'écriture
assert.equal((await api("DELETE", `/decisions/${closedId}`)).status, 404);
assert.equal((await api("PATCH", `/decisions/${closedId}`, "{}", JSON_HEADERS)).status, 404);
assert.equal((await api("PUT", `/decisions/${closedId}`, "{}", JSON_HEADERS)).status, 404);
assert.equal((await api("POST", `/projects/${slug}/decisions`, "{}", JSON_HEADERS)).status, 404);

// Une décision survit à sa tâche et à sa question ; seule la suppression du projet l'emporte
assert.equal((await api("DELETE", `/grills/${DECISION_GRILL}`)).status, 204);
const orphaned = (await api("GET", `/decisions/${closedId}`)).json;
assert.equal(orphaned.decision, "JSON", "la décision survit à sa question");
assert.equal(orphaned.question, null);
assert.equal(orphaned.source, "deleted", "source supprimée, pas absente");
assert.equal(orphaned.question_text, "Quel format ?", "le texte de la question est conservé");
assert.match(textOf(await call("list_decisions", { project: slug })), /JSON — raison : Déjà en place — source supprimée \(« Quel format \? »\)/);
assert.match(textOf(await call("get_task", { task_id: DIRECT_TASK })), /JSON — raison : Déjà en place — source supprimée/);
assert.equal((await api("DELETE", `/tasks/${DIRECT_TASK}`)).status, 204);
assert.deepEqual((await api("GET", `/decisions/${closedId}`)).json.tasks, [], "tâche supprimée : liaison retirée");
await api("DELETE", `/projects/${otherProject}`);

// Nettoyage
assert.equal((await api("DELETE", `/projects/${slug}`)).status, 204);
assert.equal((await api("GET", `/projects/${slug}`)).status, 404);
assert.equal((await api("GET", `/decisions/${closedId}`)).status, 404, "la suppression du projet emporte ses décisions");
await client.close();

// ================= Instances isolées =================
// Base propre pour vieillir des dates en SQL et contrôler la file globale, sans toucher l'instance visée par BRIGADE_URL.

interface Isolated {
  base: string;
  db: DatabaseSync;
  call: ReturnType<typeof callOn>;
  api: ReturnType<typeof apiOn>;
  stop: () => Promise<void>;
}
const BOOT_TIMEOUT_MS = 20_000;

function waitForBoot(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Démarrage trop long :\n${output}`)), BOOT_TIMEOUT_MS);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      const port = /écoute sur http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (!port) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${port}`);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Serveur arrêté (code ${code}) :\n${output}`));
    });
  });
}

async function startIsolated(staleMinutes?: string): Promise<Isolated> {
  const dataDir = mkdtempSync(join(tmpdir(), "brigade-smoke-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATA_DIR: dataDir, PORT: "0", HOST: "127.0.0.1", BRIGADE_STALE_MINUTES: staleMinutes },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const removeData = () => rmSync(dataDir, { recursive: true, force: true });
  let base: string;
  try {
    base = await waitForBoot(child);
  } catch (e) {
    child.kill();
    removeData();
    throw e;
  }
  const isolatedClient = new Client({ name: "smoke-isolated", version: "0" });
  await isolatedClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const db = new DatabaseSync(join(dataDir, "brigade.db"));
  const stop = async () => {
    await isolatedClient.close();
    db.close();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    removeData();
  };
  return { base, db, call: callOn(isolatedClient), api: apiOn(base), stop };
}

const MINUTE_MS = 60_000;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS).toISOString();
const taskIdOf = (out: string) => /id (t_[0-9a-f]+)/.exec(out)![1]!;

// Seuil : valeurs refusées, y compris au démarrage réel du serveur
assert.equal(parseStaleMinutes(undefined), 120, "2 h par défaut");
assert.equal(parseStaleMinutes("30"), 30);
for (const invalid of ["", "0", "-5", "1.5", "1e3", " 30", "30 ", "abc", "0x10", "1234567"])
  assert.throws(() => parseStaleMinutes(invalid), /BRIGADE_STALE_MINUTES invalide/, `seuil refusé : « ${invalid} »`);
await assert.rejects(
  // Si le serveur démarre quand même, l'arrêter avant que l'assertion ne constate l'échec.
  async () => (await startIsolated("deux heures")).stop(),
  /BRIGADE_STALE_MINUTES invalide/,
  "le serveur refuse de démarrer",
);

async function checkStale(iso: Isolated): Promise<void> {
  const projectSlug = /slug: ([\w-]+)/.exec(textOf(await iso.call("create_project", { name: "Inactivite" })))![1]!;
  const id = taskIdOf(textOf(await iso.call("create_tasks", { project: projectSlug, tasks: [{ title: "Longue" }] })));
  const setDates = (updated: string, started: string | null) =>
    iso.db.prepare("UPDATE tasks SET updated_at = ?, started_at = ? WHERE id = ?").run(updated, started, id);
  const read = async () => (await iso.api("GET", `/tasks/${id}`)).json;

  assert.equal((await read()).stale, false, "à faire : jamais inactive");
  setDates(minutesAgo(600), null);
  assert.equal((await read()).stale, false, "seules les tâches en cours sont signalées");

  await iso.call("start_task", { task_id: id });
  assert.equal((await read()).stale, false, "vient de démarrer");
  setDates(minutesAgo(119), minutesAgo(119));
  assert.equal((await read()).stale, false, "1 h 59 : sous le seuil");
  setDates(minutesAgo(121), minutesAgo(121));
  const stale = await read();
  assert.equal(stale.stale, true, "2 h 01 : signalée");
  assert.equal(stale.stale_for, "2 h");
  assert.equal(stale.status, "in_progress", "lire une tâche inactive ne la libère pas");
  setDates(minutesAgo(1), minutesAgo(600));
  assert.equal((await read()).stale, false, "modification récente : activité");
  setDates(minutesAgo(600), minutesAgo(1));
  assert.equal((await read()).stale, false, "démarrage récent : activité");

  setDates(minutesAgo(180), minutesAgo(180));
  const reported = textOf(await iso.call("get_project_state", { project: projectSlug }));
  assert.match(reported, /#1 « Longue » est sans activité depuis 3 h : vérifie qu'un agent y travaille encore, sinon release_task/);
  assert.equal((await read()).status, "in_progress", "le signalement ne libère pas la tâche");
  setDates(minutesAgo(1), minutesAgo(600));
  assert.doesNotMatch(textOf(await iso.call("get_project_state", { project: projectSlug })), /sans activité/, "même calcul que le champ de la tâche");

  setDates(minutesAgo(180), minutesAgo(180));
  const released = await iso.api("POST", `/tasks/${id}/action`, JSON.stringify({ action: "release" }), JSON_HEADERS);
  assert.equal(released.json.status, "todo", "libération sur action explicite");
  assert.equal(released.json.stale, false);
}

async function checkStaleThreshold(iso: Isolated): Promise<void> {
  const projectSlug = /slug: ([\w-]+)/.exec(textOf(await iso.call("create_project", { name: "Seuil" })))![1]!;
  const id = taskIdOf(textOf(await iso.call("create_tasks", { project: projectSlug, tasks: [{ title: "Seuil" }] })));
  await iso.call("start_task", { task_id: id });
  const age = (minutes: number) => iso.db.prepare("UPDATE tasks SET updated_at = ?, started_at = ? WHERE id = ?").run(minutesAgo(minutes), minutesAgo(minutes), id);
  age(29);
  assert.equal((await iso.api("GET", `/tasks/${id}`)).json.stale, false, "seuil configuré : en dessous");
  age(31);
  assert.equal((await iso.api("GET", `/tasks/${id}`)).json.stale, true, "seuil configuré : au-dessus");
}

const emptyQueue = { grills: [], human_tasks: [], agent_tasks: [], total: 0, up_to_date: true };
const typesOf = (items: { type: string }[]) => items.map((i) => i.type).sort();

async function checkQueue(iso: Isolated): Promise<void> {
  const queue = async () => (await iso.api("GET", "/queue")).json;
  const makeProject = async (projectName: string) => /slug: ([\w-]+)/.exec(textOf(await iso.call("create_project", { name: projectName })))![1]!;
  const ask = async (project: string, title: string, count: number) => {
    const out = textOf(await iso.call("ask_questions", { project, title, questions: Array.from({ length: count }, (_, i) => ({ text: `Q${i}` })) }));
    return { id: /id: (g_[0-9a-f]+)/.exec(out)![1]!, questions: [...out.matchAll(/\d=(q_[0-9a-f]+)/g)].map((m) => m[1]!) };
  };
  const answer = (qid: string, body: unknown) => iso.api("PUT", `/questions/${qid}/answer`, JSON.stringify(body), JSON_HEADERS);
  const create = async (project: string, task: Record<string, unknown>) => taskIdOf(textOf(await iso.call("create_tasks", { project, tasks: [task] })));
  const age = (id: string) => iso.db.prepare("UPDATE tasks SET updated_at = ?, started_at = ? WHERE id = ?").run(minutesAgo(600), minutesAgo(600), id);
  const finishForReview = async (id: string) => {
    await iso.call("start_task", { task_id: id });
    await iso.call("complete_task", { task_id: id, result: "fait", verification: "contrôle" });
  };

  assert.deepEqual(await queue(), emptyQueue, "base vide : à jour");
  const alpha = await makeProject("Alpha");
  const beta = await makeProject("Beta");
  assert.deepEqual(await queue(), emptyQueue, "projets vides : à jour");

  // Grills : un élément par grill, « Plus tard » n'est pas « sans réponse », un grill terminé sort de la file
  const partial = await ask(alpha, "Partiel", 4);
  await answer(partial.questions[0]!, { text: "oui" });
  await answer(partial.questions[1]!, { outcome: "later" });
  const complete = await ask(beta, "Complet", 2);
  await answer(complete.questions[0]!, { text: "oui" });
  await answer(complete.questions[1]!, { outcome: "later" });
  const submitted = await ask(beta, "Soumis", 2);
  await iso.api("POST", `/grills/${submitted.id}/status`, JSON.stringify({ status: "submitted" }), JSON_HEADERS);

  const withGrills = await queue();
  assert.equal(withGrills.up_to_date, false);
  assert.deepEqual(withGrills.grills.map((g: { grill: { title: string } }) => g.grill.title).sort(), ["Complet", "Partiel"], "un élément par grill ouvert, le grill terminé est exclu");
  const partialItem = withGrills.grills.find((g: { grill: { id: string } }) => g.grill.id === partial.id);
  assert.equal(partialItem.type, "grill_unanswered");
  assert.equal(partialItem.unanswered, 2, "plus tard ne compte pas comme sans réponse");
  assert.equal(partialItem.total, 4);
  assert.equal(partialItem.project.slug, alpha);
  const completeItem = withGrills.grills.find((g: { grill: { id: string } }) => g.grill.id === complete.id);
  assert.equal(completeItem.type, "grill_complete", "entièrement répondu : à marquer terminé");
  assert.equal(completeItem.project.slug, beta);

  // Tâches : chaque type, sur deux projets ; un titre « Faire valider » sans marqueur reste une tâche d'agent
  const inReview = await create(beta, { title: "En relecture", review: true, priority: "low" });
  await finishForReview(inReview);
  const idle = await create(alpha, { title: "Inactive", priority: "urgent" });
  await iso.call("start_task", { task_id: idle });
  age(idle);
  const working = await create(alpha, { title: "En cours recente" });
  await iso.call("start_task", { task_id: working });
  await create(alpha, { title: "Faire valider le design" });
  const humanReady = await create(beta, { title: "Signer", for_human: true });
  assert.equal((await iso.api("GET", `/tasks/${humanReady}`)).json.for_human, true);
  assert.match(textOf(await iso.call("list_tasks", { project: beta })), /\[POUR L'HUMAIN\][^\n]*Signer/);
  assert.doesNotMatch(textOf(await iso.call("list_tasks", { project: alpha })), /POUR L'HUMAIN/, "jamais déduit du titre");
  await iso.call("create_tasks", { project: beta, tasks: [{ ref: "base", title: "Base" }, { title: "Bloquee humaine", depends_on: ["base"], for_human: true }] });

  const full = await queue();
  assert.deepEqual(typesOf(full.agent_tasks), ["task_review", "task_stale"], "tâches d'agents, sans les tâches prêtes ou actives");
  assert.deepEqual(typesOf(full.human_tasks), ["task_human_ready"], "seule la tâche humaine prête est validée");
  assert.deepEqual(full.human_tasks.map((i: { task: { id: string } }) => i.task.id), [humanReady], "groupe séparé");
  assert.equal(full.total, 5);
  assert.equal(full.up_to_date, false);
  assert.deepEqual(full.agent_tasks.map((i: { task: { id: string }; project: { slug: string } }) => [i.task.id, i.project.slug]), [[idle, alpha], [inReview, beta]], "urgentes d'abord, tous projets confondus");
  assert.equal(full.agent_tasks[0].stale_for, "10 h");
  assert.equal((await iso.api("GET", `/tasks/${idle}`)).json.status, "in_progress", "la file ne libère rien");

  // Ajout et retrait du marqueur par l'API
  assert.equal((await iso.api("PATCH", `/tasks/${working}`, JSON.stringify({ for_human: true }), JSON_HEADERS)).json.for_human, true);
  assert.equal((await iso.api("PATCH", `/tasks/${working}`, JSON.stringify({ title: "Renommee" }), JSON_HEADERS)).json.for_human, true, "un patch partiel garde le marqueur");
  assert.equal((await iso.api("PATCH", `/tasks/${working}`, JSON.stringify({ for_human: false }), JSON_HEADERS)).json.for_human, false);
  assert.equal((await iso.api("PATCH", `/tasks/${working}`, JSON.stringify({ for_human: "oui" }), JSON_HEADERS)).status, 400, "booléen strict");
  const viaApi = await iso.api("POST", `/projects/${alpha}/tasks`, JSON.stringify({ title: "Humaine API", for_human: true }), JSON_HEADERS);
  assert.equal(viaApi.json.for_human, true);
  assert.match(textOf(await iso.call("update_task", { task_id: viaApi.json.id, for_human: false })), /Humaine API/);
  assert.equal((await iso.api("GET", `/tasks/${viaApi.json.id}`)).json.for_human, false, "update_task retire le marqueur");
  assert.match(textOf(await iso.call("update_task", { task_id: viaApi.json.id, for_human: true })), /POUR L'HUMAIN/);
  assert.match(textOf(await iso.call("get_task", { task_id: viaApi.json.id })), /Réservée à l'humain/);

  // Une tâche humaine inactive ou en relecture reste dans le groupe humain
  const humanIdle = await create(alpha, { title: "Humaine inactive", for_human: true });
  await iso.call("start_task", { task_id: humanIdle });
  age(humanIdle);
  const humanReview = await create(alpha, { title: "Humaine relue", for_human: true, review: true, priority: "urgent" });
  await finishForReview(humanReview);
  const mixed = await queue();
  assert.deepEqual(typesOf(mixed.human_tasks), ["task_human_ready", "task_human_ready", "task_review", "task_stale"]);
  assert.deepEqual(typesOf(mixed.agent_tasks), ["task_review", "task_stale"], "aucune tâche humaine parmi les tâches d'agents");
  assert.equal(mixed.human_tasks[0].task.id, humanReview, "groupe humain : urgentes d'abord");

  // get_project_state : les tâches humaines sont signalées, jamais proposées aux agents
  const alphaState = textOf(await iso.call("get_project_state", { project: alpha }));
  assert.doesNotMatch(alphaState, /Relire #\d+ « Humaine relue »/, "relecture humaine non suggérée");
  assert.doesNotMatch(alphaState, /Humaine inactive » est sans activité/, "inactivité humaine non suggérée");
  const humanSeq = (await iso.api("GET", `/tasks/${viaApi.json.id}`)).json.seq as number;
  const suggested = /Démarrables maintenant : ([^(]*)\(/.exec(alphaState)?.[1] ?? "";
  assert.doesNotMatch(suggested, new RegExp(`#${humanSeq}\\b`), "tâche humaine prête non suggérée");
  assert.match(alphaState, new RegExp(`Réservées à l'humain, ne les fais pas à sa place : #${humanSeq}\\b`));
  assert.match(alphaState, /### Prêtes, réservées à l'humain\n[^\n]*Humaine API/);
  assert.match(textOf(await iso.call("get_project_state", { project: beta })), /Relire #\d+ « En relecture »/, "la relecture d'agent reste suggérée");

  // Sans aucun grill, la file reste non vide : « À jour » ne regarde pas que les questions
  await iso.api("DELETE", `/grills/${partial.id}`);
  await iso.api("DELETE", `/grills/${complete.id}`);
  assert.equal((await queue()).up_to_date, false, "tâches en attente : pas à jour");
  await iso.api("DELETE", `/projects/${alpha}`);
  await iso.api("DELETE", `/projects/${beta}`);
  assert.deepEqual(await queue(), emptyQueue, "plus rien en attente : à jour");
}

const withIsolated = async (staleMinutes: string | undefined, check: (iso: Isolated) => Promise<void>) => {
  const iso = await startIsolated(staleMinutes);
  try {
    await check(iso);
  } finally {
    await iso.stop();
  }
};
await withIsolated(undefined, checkStale);
await withIsolated("30", checkStaleThreshold);
await withIsolated(undefined, checkQueue);

console.log("SMOKE OK");
