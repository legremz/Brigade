import { useCallback, useLayoutEffect, useState } from "react";
import { api, type Agent, type Difficulty, type Priority, type ProjectQuestion, type Task } from "./api";
import { EditableMarkdown } from "./EditableMarkdown";
import { Markdown } from "./Markdown";
import { href } from "./router";

export const PRIORITY_LABEL: Record<Priority, string> = { low: "Basse", medium: "Moyenne", high: "Haute", urgent: "Urgente" };
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: "Facile", medium: "Moyenne", hard: "Difficile" };
const STATUS_LABEL = { todo: "À faire", in_progress: "En cours", review: "En relecture", done: "Terminée" } as const;

const LOSE_DRAFT_MESSAGE = "Un brouillon n'est pas enregistré. Fermer et le perdre ?";

export function TaskDrawer({
  slug,
  task,
  tasks,
  agents,
  questions,
  onChange,
  onClose,
}: {
  slug: string;
  task: Task;
  tasks: Task[];
  agents: Agent[];
  questions: ProjectQuestion[];
  onChange: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [verification, setVerification] = useState("");
  const [notes, setNotes] = useState("");
  const [titleDirty, setTitleDirty] = useState(false);
  const [descriptionDirty, setDescriptionDirty] = useState(false);

  const hasDraft = titleDirty || descriptionDirty || [result, verification, notes].some((draft) => draft.trim() !== "");
  const requestClose = useCallback(() => {
    if (!hasDraft || confirm(LOSE_DRAFT_MESSAGE)) onClose();
  }, [hasDraft, onClose]);

  // En capture : couvre aussi les liens rendus depuis le markdown, qui quittent le tiroir sans passer par requestClose.
  function guardLinks(e: React.MouseEvent) {
    const onLink = e.target instanceof Element && e.target.closest("a[href]") !== null;
    if (onLink && hasDraft && !confirm(LOSE_DRAFT_MESSAGE)) e.preventDefault();
  }

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [requestClose]);

  /** Renvoie false en cas d'échec, pour que l'appelant conserve la saisie. */
  async function run<T>(fn: () => Promise<T>): Promise<boolean> {
    try {
      setError(null);
      await fn();
      onChange();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  const patch = (p: Parameters<typeof api.updateTask>[1]) => run(() => api.updateTask(task.id, p));
  const action = (body: Record<string, unknown>) => run(() => api.taskAction(task.id, body));

  const linked = task.question_ids.map((id) => questions.find((q) => q.id === id)).filter((q): q is ProjectQuestion => !!q);
  const depCandidates = tasks.filter((t) => t.id !== task.id && !task.depends_on.some((d) => d.id === t.id));
  const questionCandidates = questions.filter((q) => !task.question_ids.includes(q.id));

  return (
    <div className="drawer-backdrop" onClick={requestClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} onClickCapture={guardLinks}>
        <header className="drawer-head">
          <span className="muted">#{task.seq} · {STATUS_LABEL[task.status]}</span>
          <button type="button" className="ghost" onClick={requestClose}>Fermer ✕</button>
        </header>

        <input
          className="title-input"
          defaultValue={task.title}
          key={task.title}
          onChange={(e) => setTitleDirty(e.target.value !== task.title)}
          onBlur={(e) => {
            setTitleDirty(false);
            if (e.target.value !== task.title) void patch({ title: e.target.value });
          }}
        />

        {task.blocked_by.length > 0 && task.status === "todo" && (
          <p className="error box">
            🔒 Bloquée par {task.blocked_by.map((d) => `#${d.seq} « ${d.title} » (${STATUS_LABEL[d.status]})`).join(", ")}.
          </p>
        )}
        {task.stale && (
          <div className="stale-alert">
            <span>⏰ Sans activité depuis {task.stale_for} : l'agent a peut-être planté.</span>
            <button type="button" onClick={() => void action({ action: "release" })}>Remettre à faire</button>
          </div>
        )}
        {error && <p className="error box">{error}</p>}

        <div className="fields">
          <label>Priorité
            <select value={task.priority} onChange={(e) => void patch({ priority: e.target.value as Priority })}>
              {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          <label>Difficulté
            <select value={task.difficulty} onChange={(e) => void patch({ difficulty: e.target.value as Difficulty })}>
              {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => <option key={d} value={d}>{DIFFICULTY_LABEL[d]}</option>)}
            </select>
          </label>
          <label>Assignée à
            <select value={task.assignee?.id ?? ""} onChange={(e) => void patch({ assignee: e.target.value || null })}>
              <option value="">— personne (agent maître) —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.available ? "" : " (occupé)"}</option>
              ))}
            </select>
          </label>
          <label>Relecture
            <select
              value={reviewChoice(task.review_required)}
              onChange={(e) => void patch({ review: e.target.value === "inherit" ? null : e.target.value === "yes" })}
            >
              <option value="inherit">Selon le projet ({task.review_effective ? "oui" : "non"})</option>
              <option value="yes">Toujours</option>
              <option value="no">Jamais</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={task.for_human} onChange={(e) => void patch({ for_human: e.target.checked })} />
            Pour l'humain : aucun agent ne doit la prendre
          </label>
        </div>

        <h3>Description</h3>
        <EditableMarkdown value={task.description} placeholder="Aucune description." onSave={(v) => patch({ description: v })} onDirtyChange={setDescriptionDirty} />

        <h3>Dépend de</h3>
        <div className="chips">
          {task.depends_on.length === 0 && <span className="muted">Aucune dépendance.</span>}
          {task.depends_on.map((d) => (
            <span key={d.id} className={`chip static ${d.status === "done" ? "ok" : "wait"}`}>
              #{d.seq} {d.title} · {STATUS_LABEL[d.status]}
              <button type="button" className="x-inline" onClick={() => void patch({ remove_depends_on: [d.id] })}>×</button>
            </span>
          ))}
          <select value="" onChange={(e) => e.target.value && void patch({ add_depends_on: [e.target.value] })}>
            <option value="">＋ ajouter une dépendance…</option>
            {depCandidates.map((t) => <option key={t.id} value={t.id}>#{t.seq} {t.title}</option>)}
          </select>
        </div>

        <h3>Questions du grill liées</h3>
        <div className="linked">
          {linked.length === 0 && <span className="muted">Aucune question liée.</span>}
          {linked.map((q) => (
            <div key={q.id} className="linked-q">
              <a href={href.grill(slug, q.grill_id)}>{q.grill_title} · Q{q.position}</a>
              <span className={`pill ${q.answered ? "answered" : "pending"}`}>{q.answered ? "répondue" : "sans réponse"}</span>
              <button type="button" className="x-inline" onClick={() => void patch({ unlink_questions: [q.id] })}>×</button>
              <div className="muted clamp">{q.text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ")}</div>
            </div>
          ))}
          <select value="" onChange={(e) => e.target.value && void patch({ link_questions: [e.target.value] })}>
            <option value="">＋ lier une question…</option>
            {questionCandidates.map((q) => (
              <option key={q.id} value={q.id}>{q.grill_title} · Q{q.position} — {q.text.slice(0, 60)}</option>
            ))}
          </select>
        </div>

        {task.review_notes && (
          <>
            <h3>Notes de relecture</h3>
            <section className="card context"><Markdown>{task.review_notes}</Markdown></section>
          </>
        )}
        {task.forced_note && <p className="error box">⚠ {task.forced_note}</p>}
        {task.result && (
          <>
            <h3>Résultat</h3>
            <section className="card"><Markdown>{task.result}</Markdown></section>
            {task.verification && (
              <>
                <h3>Vérification</h3>
                <section className="card"><Markdown>{task.verification}</Markdown></section>
              </>
            )}
          </>
        )}

        <h3>Actions</h3>
        <TaskActions
          task={task}
          result={result}
          onResult={setResult}
          verification={verification}
          onVerification={setVerification}
          notes={notes}
          onNotes={setNotes}
          action={action}
          onDelete={() => {
            if (confirm(`Supprimer la tâche #${task.seq} ?`)) void run(() => api.deleteTask(task.id)).then((deleted) => {
              if (deleted) onClose();
            });
          }}
        />
      </aside>
    </div>
  );
}

const reviewChoice = (required: boolean | null): "inherit" | "yes" | "no" => {
  if (required === null) return "inherit";
  return required ? "yes" : "no";
};

function TaskActions({
  task,
  result,
  onResult,
  verification,
  onVerification,
  notes,
  onNotes,
  action,
  onDelete,
}: {
  task: Task;
  result: string;
  onResult: (v: string) => void;
  verification: string;
  onVerification: (v: string) => void;
  notes: string;
  onNotes: (v: string) => void;
  action: (body: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
}) {
  async function complete() {
    if (!(await action({ action: "complete", result, verification }))) return;
    onResult("");
    onVerification("");
  }
  async function review(verdict: "approve" | "changes") {
    if (await action({ action: verdict, notes })) onNotes("");
  }

  return (
    <div className="actions">
      {task.status === "todo" && (
        <button type="button" className="primary" disabled={!task.ready} title={task.ready ? "" : "Dépendances non terminées"} onClick={() => void action({ action: "start", agent: task.assignee?.id })}>
          ▶ Démarrer
        </button>
      )}
      {task.status === "in_progress" && (
        <>
          <textarea value={result} onChange={(e) => onResult(e.target.value)} placeholder="Résultat : ce qui a été fait…" rows={3} />
          <textarea value={verification} onChange={(e) => onVerification(e.target.value)} placeholder="Vérification : commande ou contrôle réalisé…" rows={2} />
          <button type="button" className="primary" onClick={() => void complete()}>
            ✔ Terminer{task.review_effective ? " (→ relecture)" : ""}
          </button>
        </>
      )}
      {task.status === "review" && (
        <>
          <textarea value={notes} onChange={(e) => onNotes(e.target.value)} placeholder="Notes de relecture (obligatoires pour demander des changements)…" rows={3} />
          <button type="button" className="primary" onClick={() => void review("approve")}>👍 Approuver</button>
          <button type="button" onClick={() => void review("changes")}>↩ Demander des changements</button>
        </>
      )}
      {((task.status === "in_progress" && !task.stale) || task.status === "review") && (
        <button type="button" className="ghost" onClick={() => void action({ action: "release" })}>Remettre à faire</button>
      )}
      {task.status === "done" && (
        <button type="button" className="ghost" onClick={() => void action({ action: "move", status: "todo" })}>Rouvrir</button>
      )}
      <button type="button" className="danger" onClick={onDelete}>Supprimer</button>
    </div>
  );
}
