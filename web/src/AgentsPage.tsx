import { useState } from "react";
import { api, type Agent } from "./api";
import { Crumbs, ErrorBox } from "./common";
import { useLoad } from "./hooks";
import { ProjectTabs } from "./ProjectTabs";
import { href } from "./router";

export function AgentsPage({ slug }: { slug: string }) {
  const project = useLoad(() => api.project(slug), [slug]);
  const agents = useLoad(() => api.agents(slug), [slug], 5000);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);

  async function run(fn: () => Promise<unknown>) {
    try {
      setError(null);
      await fn();
      await Promise.all([project.reload(), agents.reload()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const p = project.data;
  return (
    <>
      <Crumbs items={[{ label: p?.name ?? slug, to: href.project(slug) }, { label: "Agents & réglages" }]} />
      <h1>{p?.name ?? slug}</h1>
      <ProjectTabs slug={slug} active="agents" />
      {(project.error || agents.error || error) && <ErrorBox message={(project.error ?? agents.error ?? error)!} />}

      {p && (
        <section className="card settings">
          <h2>Réglages du projet</h2>
          <label>Mode d'exécution
            <select value={p.mode} onChange={(e) => void run(() => api.updateProject(slug, { mode: e.target.value as "main" | "team" }))}>
              <option value="main">Chat courant seul (modèle par défaut)</option>
              <option value="team">Équipe de sous-agents du projet</option>
            </select>
          </label>
          <label>Modèle par défaut
            <input
              defaultValue={p.default_model}
              key={p.default_model}
              placeholder="ex. sonnet, opus… (vide = celui de la session)"
              onBlur={(e) => e.target.value !== p.default_model && void run(() => api.updateProject(slug, { default_model: e.target.value }))}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={p.review_required} onChange={(e) => void run(() => api.updateProject(slug, { review_required: e.target.checked }))} />
            Relecture exigée avant qu'une tâche soit « terminée » (débloque ses dépendances)
          </label>
          <p className="muted small-note">
            Brigade ne lance aucun agent : c'est Claude Code qui lit la tâche, récupère la définition de l'agent assigné et la
            transmet à un sous-agent.
          </p>
        </section>
      )}

      <div className="grill-head">
        <h2>Agents du projet</h2>
        <button type="button" className="primary" onClick={() => setEditing("new")}>＋ Nouvel agent</button>
      </div>
      {agents.data?.length === 0 && editing !== "new" && <p className="muted">Aucun agent. En mode « chat courant seul », ce n'est pas nécessaire.</p>}

      {editing === "new" && (
        <AgentForm
          onCancel={() => setEditing(null)}
          onSave={(a) => run(() => api.createAgent(slug, a)).then(() => setEditing(null))}
        />
      )}
      {agents.data?.map((a: Agent) =>
        editing === a.id ? (
          <AgentForm key={a.id} agent={a} onCancel={() => setEditing(null)} onSave={(v) => run(() => api.updateAgent(a.id, v)).then(() => setEditing(null))} />
        ) : (
          <article key={a.id} className="card agent">
            <div className="row">
              <div>
                <strong>🤖 {a.name}</strong>
                {a.model && <span className="muted"> · {a.model}</span>}
              </div>
              <span className={`pill ${a.available ? "answered" : "pending"}`}>
                {a.available ? "Disponible" : `Occupé (${a.busy_with.map((b) => "#" + b.seq).join(", ")})`}
              </span>
            </div>
            {a.description && <p className="muted">{a.description}</p>}
            {a.prompt && <pre className="prompt">{a.prompt}</pre>}
            <div className="q-foot">
              <button type="button" className="ghost" onClick={() => setEditing(a.id)}>Modifier</button>
              <button
                type="button"
                className="danger"
                onClick={() => confirm(`Supprimer l'agent « ${a.name} » ? Ses tâches deviennent non assignées.`) && void run(() => api.deleteAgent(a.id))}
              >
                Supprimer
              </button>
            </div>
          </article>
        ),
      )}
    </>
  );
}

function AgentForm({
  agent,
  onSave,
  onCancel,
}: {
  agent?: Agent;
  onSave: (a: { name: string; description: string; model: string; prompt: string }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [prompt, setPrompt] = useState(agent?.prompt ?? "");
  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ name, description, model, prompt });
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom (ex. frontend)" required />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Rôle en une phrase" />
      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Modèle (vide = par défaut du projet)" />
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} placeholder="Instructions de l'agent (markdown)…" />
      <div className="q-foot">
        <button type="submit" className="primary">Enregistrer</button>
        <button type="button" className="ghost" onClick={onCancel}>Annuler</button>
      </div>
    </form>
  );
}
