import { useState } from "react";
import { api, ApiError, type Status, type Task } from "./api";
import { Crumbs, ErrorBox } from "./common";
import { useLoad } from "./hooks";
import { ProjectTabs } from "./ProjectTabs";
import { href } from "./router";
import { DIFFICULTY_LABEL, PRIORITY_LABEL, TaskDrawer } from "./TaskDrawer";

const COLUMNS: { status: Status; label: string }[] = [
  { status: "todo", label: "À faire" },
  { status: "in_progress", label: "En cours" },
  { status: "review", label: "En relecture" },
  { status: "done", label: "Terminées" },
];

/** Si le serveur refuse le passage en « Terminées », propose de l'imposer ; un refus laisse le motif s'afficher. */
async function moveTask(id: string, status: Status): Promise<void> {
  try {
    await api.taskAction(id, { action: "move", status });
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "force_required") throw err;
    if (!confirm(`${err.message}\n\nForcer quand même le passage en « Terminées » ?`)) throw err;
    await api.taskAction(id, { action: "move", status, force: true });
  }
}

export function Board({ slug, openId }: { slug: string; openId?: string }) {
  const project = useLoad(() => api.project(slug), [slug], 8000);
  const tasks = useLoad(() => api.tasks(slug), [slug], 4000);
  const agents = useLoad(() => api.agents(slug), [slug], 4000);
  const questions = useLoad(() => api.projectQuestions(slug), [slug], 8000);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);

  const list = tasks.data ?? [];
  const open = openId ? list.find((t) => t.id === openId) : undefined;

  function refresh() {
    void tasks.reload();
    void agents.reload();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const t = await api.createTask(slug, title.trim());
      setTitle("");
      refresh();
      location.hash = href.board(slug, t.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function drop(status: Status, id: string) {
    setOver(null);
    const t = list.find((x) => x.id === id);
    if (!t || t.status === status) return;
    if (status !== "todo" && status !== "done" && t.blocked_by.length && !confirm("Cette tâche est bloquée par une dépendance. La déplacer quand même ?")) return;
    try {
      await moveTask(id, status);
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <Crumbs items={[{ label: project.data?.name ?? slug, to: href.project(slug) }, { label: "Kanban" }]} />
      <h1>{project.data?.name ?? slug}</h1>
      <ProjectTabs slug={slug} active="board" />
      {(tasks.error || error) && <ErrorBox message={(tasks.error ?? error)!} />}

      <form className="quick-add" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nouvelle tâche… (Entrée pour créer)" />
        <button type="submit" className="primary">Ajouter</button>
      </form>

      <div className="board">
        {COLUMNS.map(({ status, label }) => {
          const items = list.filter((t) => t.status === status);
          const collapsed = status === "done" && !doneOpen;
          return (
            <section
              key={status}
              className={`bcol${over === status ? " over" : ""}${collapsed ? " collapsed" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver((o) => (o === status ? null : o))}
              onDrop={(e) => void drop(status, e.dataTransfer.getData("text/plain"))}
            >
              {status === "done" ? (
                <button type="button" className="col-title col-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen((v) => !v)}>
                  {doneOpen ? "▾" : "▸"} {label} <span className="count">{items.length}</span>
                </button>
              ) : (
                <h2 className="col-title">{label} <span className="count">{items.length}</span></h2>
              )}
              {!collapsed && items.map((t) => <TaskCard key={t.id} task={t} slug={slug} />)}
            </section>
          );
        })}
      </div>

      {open && (
        <TaskDrawer
          slug={slug}
          task={open}
          tasks={list}
          agents={agents.data ?? []}
          questions={questions.data ?? []}
          onChange={refresh}
          onClose={() => (location.hash = href.board(slug))}
        />
      )}
    </>
  );
}

function TaskCard({ task, slug }: { task: Task; slug: string }) {
  const blocked = task.status === "todo" && task.blocked_by.length > 0;
  return (
    <a
      className={`card task prio-${task.priority}${blocked ? " blocked" : ""}`}
      href={href.board(slug, task.id)}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
    >
      <div className="task-top">
        <span className="muted">#{task.seq}</span>
        <span className={`pill prio ${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
      </div>
      <strong>{task.title}</strong>
      <div className="task-meta">
        <span title="Difficulté">⚙ {DIFFICULTY_LABEL[task.difficulty]}</span>
        {task.for_human && <span className="human-tag">👤 pour toi</span>}
        {task.assignee && <span className="agent-tag">🤖 {task.assignee.name}</span>}
        {task.question_ids.length > 0 && <span title="Questions du grill liées">❓ {task.question_ids.length}</span>}
        {task.depends_on.length > 0 && (
          <span title={task.depends_on.map((d) => `#${d.seq} ${d.title}`).join("\n")}>🔗 {task.depends_on.length}</span>
        )}
      </div>
      {blocked && <div className="lock">🔒 bloquée par {task.blocked_by.map((d) => `#${d.seq}`).join(", ")}</div>}
      {task.ready && <div className="ready">✔ prête</div>}
      {task.stale && <div className="stale">⏰ sans activité depuis {task.stale_for}</div>}
    </a>
  );
}
