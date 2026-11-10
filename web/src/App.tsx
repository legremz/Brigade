import { useState } from "react";
import { api, type GrillSummary, type Project } from "./api";
import { AgentsPage } from "./AgentsPage";
import { SkillsPage } from "./SkillsPage";
import { Board } from "./Board";
import { Crumbs, ErrorBox, Progress } from "./common";
import { DecisionsPage } from "./DecisionsPage";
import { countsByProject, ForYou } from "./ForYou";
import { GrillPage } from "./GrillPage";
import { ProjectTabs } from "./ProjectTabs";
import { useLoad } from "./hooks";
import { href, useRoute } from "./router";

const date = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// ---------- Accueil ----------

const POLL_MS = 5000;

function Home() {
  const { data, error, reload } = useLoad(() => api.projects(), [], POLL_MS);
  const queue = useLoad(() => api.queue(), [], POLL_MS);
  const pending = countsByProject(queue.data);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const p = await api.createProject(name, description);
      location.hash = href.project(p.slug);
      setName("");
      setDescription("");
      void reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <ForYou queue={queue.data} error={queue.error} />
      <h1 className="section-title">Projets</h1>
      {error && <ErrorBox message={error} />}
      {data?.length === 0 && <p className="muted">Aucun projet pour l'instant. Crée-en un ci-dessous, ou demande à Claude de le faire.</p>}
      <div className="grid">
        {data?.map((p: Project) => (
          <a key={p.id} className="card project" href={href.project(p.slug)}>
            <h2>{p.name}</h2>
            {p.description && <p className="muted">{p.description}</p>}
            {pending.has(p.id) && (
              <p><span className="pill pending">{pending.get(p.id)} à traiter</span></p>
            )}
          </a>
        ))}
      </div>
      <form className="card form" onSubmit={create}>
        <h2>Nouveau projet</h2>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du projet" required />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Objectif (optionnel)" />
        <button type="submit" className="primary">Créer</button>
        {formError && <p className="error">{formError}</p>}
      </form>
    </>
  );
}

// ---------- Projet ----------

function ProjectPage({ slug }: { slug: string }) {
  const project = useLoad(() => api.project(slug), [slug]);
  const grills = useLoad(() => api.grills(slug), [slug], 5000);

  async function remove() {
    if (!confirm(`Supprimer le projet « ${project.data?.name} » et tous ses grills ?`)) return;
    await api.deleteProject(slug);
    location.hash = href.home();
  }

  return (
    <>
      <Crumbs items={[{ label: project.data?.name ?? slug }]} />
      <h1>{project.data?.name ?? slug}</h1>
      {project.data?.description && <p className="muted">{project.data.description}</p>}
      <ProjectTabs slug={slug} active="grills" />
      {(project.error || grills.error) && <ErrorBox message={(project.error ?? grills.error)!} />}
      <h2>Grills</h2>
      {grills.data?.length === 0 && (
        <p className="muted">Aucun grill. Claude en crée un avec l'outil <code>ask_questions</code>.</p>
      )}
      <div className="list">
        {grills.data?.map((g: GrillSummary) => (
          <a key={g.id} className="card row" href={href.grill(slug, g.id)}>
            <div>
              <strong>{g.title}</strong>
              <span className="muted"> · {date(g.created_at)}</span>
            </div>
            <div className="row-right">
              <span className={`pill ${g.status === "submitted" ? "answered" : "pending"}`}>
                {g.status === "submitted" ? "Terminé" : "En cours"}
              </span>
              <Progress answered={g.answered} total={g.total} />
            </div>
          </a>
        ))}
      </div>
      <p>
        <button type="button" className="danger" onClick={() => void remove()}>Supprimer le projet</button>
      </p>
    </>
  );
}

export function App() {
  const route = useRoute();
  return (
    <main className={route.page === "grill" || route.page === "board" ? "wide" : undefined}>
      {route.page === "home" && <Home />}
      {route.page === "project" && <ProjectPage key={route.slug} slug={route.slug} />}
      {route.page === "board" && <Board key={route.slug} slug={route.slug} openId={route.task} />}
      {route.page === "skills" && <SkillsPage key={route.slug} slug={route.slug} />}
      {route.page === "agents" && <AgentsPage key={route.slug} slug={route.slug} />}
      {route.page === "decisions" && <DecisionsPage key={route.slug} slug={route.slug} />}
      {route.page === "grill" && <GrillPage key={route.id} slug={route.slug} id={route.id} targetQuestion={route.question} />}
    </main>
  );
}
