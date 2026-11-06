import { useEffect, useState } from "react";
import { api, type Grill, type GrillSummary, type Project, type Question } from "./api";
import { Markdown } from "./Markdown";
import { AgentsPage } from "./AgentsPage";
import { SkillsPage } from "./SkillsPage";
import { Board } from "./Board";
import { Crumbs, ErrorBox } from "./common";
import { ProjectTabs } from "./ProjectTabs";
import { QuestionCard } from "./QuestionCard";
import { useLoad } from "./hooks";
import { href, useRoute } from "./router";

const date = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function Progress({ answered, total }: { answered: number; total: number }) {
  return (
    <span className="progress" title={`${answered} répondue(s) sur ${total}`}>
      <span className="bar">
        <span style={{ width: total ? `${(answered / total) * 100}%` : 0 }} />
      </span>
      {answered}/{total}
    </span>
  );
}

// ---------- Accueil ----------

function Home() {
  const { data, error, reload } = useLoad(() => api.projects(), [], 5000);
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
      <h1>Projets</h1>
      {error && <ErrorBox message={error} />}
      {data?.length === 0 && <p className="muted">Aucun projet pour l'instant. Crée-en un ci-dessous, ou demande à Claude de le faire.</p>}
      <div className="grid">
        {data?.map((p: Project) => (
          <a key={p.id} className="card project" href={href.project(p.slug)}>
            <h2>{p.name}</h2>
            {p.description && <p className="muted">{p.description}</p>}
            <p>
              {p.pending_questions ? (
                <span className="pill pending">{p.pending_questions} question(s) à répondre</span>
              ) : (
                <span className="pill answered">À jour</span>
              )}
            </p>
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

// ---------- Grill ----------

function GrillPage({ slug, id }: { slug: string; id: string }) {
  const { data: grill, setData, error } = useLoad(() => api.grill(id), [id]);

  function updateQuestion(q: Question) {
    setData((g: Grill | null) => {
      if (!g) return g;
      const questions = g.questions.map((x) => (x.id === q.id ? q : x));
      return { ...g, questions, answered: questions.filter((x) => x.answered).length };
    });
  }

  // Colonne affichée par question. Une carte en cours d'édition garde sa place,
  // elle ne bascule qu'après la perte du focus.
  const [placed, setPlaced] = useState<Record<string, "todo" | "done">>({});
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!grill) return;
    setPlaced((prev) => {
      const next = { ...prev };
      for (const q of grill.questions) if (q.id !== active || !(q.id in next)) next[q.id] = q.answered ? "done" : "todo";
      return next;
    });
  }, [grill, active]);

  async function setStatus(status: "open" | "submitted") {
    setData(await api.setStatus(id, status));
  }

  async function remove() {
    if (!confirm("Supprimer ce grill et ses réponses ?")) return;
    await api.deleteGrill(id);
    location.hash = href.project(slug);
  }

  if (error) return <ErrorBox message={error} />;
  if (!grill) return <p className="muted">Chargement…</p>;

  const remaining = grill.total - grill.answered;
  return (
    <>
      <Crumbs items={[{ label: grill.project.name, to: href.project(slug) }, { label: grill.title }]} />
      <div className="grill-head">
        <h1>{grill.title}</h1>
        <Progress answered={grill.answered} total={grill.total} />
      </div>
      {grill.context && (
        <section className="card context">
          <Markdown>{grill.context}</Markdown>
        </section>
      )}
      <div className="columns">
        {(["todo", "done"] as const).map((col) => {
          const items = grill.questions.filter((q) => (placed[q.id] ?? (q.answered ? "done" : "todo")) === col);
          return (
            <section key={col} className={`column ${col}`}>
              <h2 className="col-title">
                {col === "todo" ? "À répondre" : "Répondues"} <span className="count">{items.length}</span>
              </h2>
              {items.length === 0 && (
                <p className="muted empty">{col === "todo" ? "Tout est traité 🎉" : "Rien pour l'instant."}</p>
              )}
              {items.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  onUpdate={updateQuestion}
                  onActive={(a) => setActive((cur) => (a ? q.id : cur === q.id ? null : cur))}
                />
              ))}
            </section>
          );
        })}
      </div>
      <section className="card finish">
        {grill.status === "submitted" ? (
          <>
            <p>✔ Marqué terminé. Dis à Claude de consulter tes réponses.</p>
            <button type="button" className="ghost" onClick={() => void setStatus("open")}>Rouvrir</button>
          </>
        ) : (
          <>
            <p>
              {remaining === 0
                ? "Tout est répondu. Tu peux dire à Claude de consulter tes réponses."
                : `${remaining} question(s) sans réponse. Les questions non traitées seront signalées à Claude.`}
            </p>
            <button type="button" className="primary" onClick={() => void setStatus("submitted")}>J'ai fini</button>
          </>
        )}
        <button type="button" className="danger" onClick={() => void remove()}>Supprimer le grill</button>
      </section>
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
      {route.page === "grill" && <GrillPage key={route.id} slug={route.slug} id={route.id} />}
    </main>
  );
}
