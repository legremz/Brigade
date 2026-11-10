import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { api } from "./api.js";
import { localOnly } from "./guard.js";
import { createMcpServer } from "./mcp.js";

const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? "0.0.0.0";
const TOKEN = process.env.BRIGADE_TOKEN ?? "";
const WEB_DIR = process.env.WEB_DIR ?? "web/dist";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

// Appliqué avant les routes ; /health reste libre pour le healthcheck Docker.
const guard = localOnly();
app.use("/api/*", guard);
app.use("/mcp", guard);

// Auth par jeton (Bearer) sur le MCP, uniquement si BRIGADE_TOKEN est défini.
// L'interface web et son API restent sans jeton : elles sont protégées par localOnly.
app.use("/mcp", async (c, next) => {
  if (TOKEN && c.req.header("authorization") !== `Bearer ${TOKEN}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// MCP en HTTP streamable, mode stateless : serveur + transport neufs par requête.
app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

app.route("/api", api);

// Interface web (build Vite). Routage côté client en « hash », donc pas de fallback SPA nécessaire.
app.use("/*", serveStatic({ root: WEB_DIR }));

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Brigade à l'écoute sur http://${HOST}:${info.port} (UI: /, MCP: /mcp, API: /api)`);
});
