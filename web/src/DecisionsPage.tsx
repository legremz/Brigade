import { api, type Decision } from "./api";
import { Crumbs, ErrorBox } from "./common";
import { useLoad } from "./hooks";
import { ProjectTabs } from "./ProjectTabs";
import { href } from "./router";

const date = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const EXCERPT_CHARS = 80;

function DecisionSource({ slug, decision }: { slug: string; decision: Decision }) {
  const { question, question_text: questionText } = decision;
  if (question)
    return (
      <a href={href.grill(slug, question.grill_id, question.id)}>
        Question {question.position} : {question.text.slice(0, EXCERPT_CHARS)}
      </a>
    );
  if (decision.source === "deleted")
    return <span className="source-gone">Source supprimée : {questionText?.slice(0, EXCERPT_CHARS)}</span>;
  return <span>Jamais de source</span>;
}

function DecisionCard({ slug, decision }: { slug: string; decision: Decision }) {
  const { tasks } = decision;
  return (
    <article className="card decision">
      <h2>{decision.decision}</h2>
      <p>
        <span className="muted">Raison :</span> {decision.reason}
      </p>
      <div className="decision-meta">
        <span>{date(decision.created_at)}</span>
        <DecisionSource slug={slug} decision={decision} />
        {tasks.map((t) => (
          <a key={t.id} href={href.board(slug, t.id)}>
            #{t.seq} {t.title}
          </a>
        ))}
      </div>
    </article>
  );
}

/** Registre en lecture seule : les décisions s'écrivent par le MCP et sont immuables. */
export function DecisionsPage({ slug }: { slug: string }) {
  const project = useLoad(() => api.project(slug), [slug]);
  const decisions = useLoad(() => api.decisions(slug), [slug], 5000);
  const name = project.data?.name ?? slug;
  const loadError = project.error ?? decisions.error;
  return (
    <>
      <Crumbs items={[{ label: name, to: href.project(slug) }, { label: "Décisions" }]} />
      <h1>{name}</h1>
      <ProjectTabs slug={slug} active="decisions" />
      {loadError && <ErrorBox message={loadError} />}
      {decisions.data?.length === 0 && (
        <p className="muted">Aucune décision. Claude les enregistre avec l'outil <code>record_decision</code>.</p>
      )}
      {decisions.data?.map((d) => <DecisionCard key={d.id} slug={slug} decision={d} />)}
    </>
  );
}
