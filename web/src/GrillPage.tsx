import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api, type Grill, type Question } from "./api";
import { AnswerDraft } from "./answerDraft";
import { Crumbs, ErrorBox, Progress } from "./common";
import { useLoad } from "./hooks";
import { Markdown } from "./Markdown";
import { answerStatus, QuestionCard, STATUS_LABEL } from "./QuestionCard";
import { href } from "./router";

type Column = "todo" | "done";
const COLUMNS: readonly Column[] = ["todo", "done"];

const HEAD_GAP_PX = 12;
/** Le temps qu'un enregistrement revienne et déplace la carte quittée. */
const JUMP_SETTLE_MS = 1000;
const READ_MARKS_POLL_MS = 5000;

const cardDomId = (id: string) => `q-${id}`;

/** Reporte l'état de lecture du serveur sans toucher aux réponses, dont la page reste maîtresse. */
function mergeReadMarks(current: Grill, fresh: Grill): Grill {
  const fromServer = new Map(fresh.questions.map((q) => [q.id, q]));
  return {
    ...current,
    last_read_at: fresh.last_read_at,
    questions: current.questions.map((q) => {
      const latest = fromServer.get(q.id);
      return latest ? { ...q, modified_since_read: latest.modified_since_read, awaiting_decision: latest.awaiting_decision } : q;
    }),
  };
}

/** Une lecture par l'agent lève le marquage alors que la page est ouverte : il faut le voir sans recharger. */
function useReadMarks(id: string, setData: Dispatch<SetStateAction<Grill | null>>) {
  const [syncError, setSyncError] = useState<string | null>(null);
  useEffect(() => {
    async function refresh() {
      try {
        const fresh = await api.grill(id);
        setData((current) => current && mergeReadMarks(current, fresh));
        setSyncError(null);
      } catch (e) {
        setSyncError(e instanceof Error ? e.message : String(e));
      }
    }
    const timer = setInterval(() => void refresh(), READ_MARKS_POLL_MS);
    return () => clearInterval(timer);
  }, [id, setData]);
  return syncError;
}

/** Une saisie par question, stable pendant toute la vie de la page et envoyée avant de la quitter. */
function useAnswerDrafts(onSaved: (q: Question) => void) {
  const drafts = useRef(new Map<string, AnswerDraft>());

  useEffect(() => {
    const flushAll = () => {
      for (const draft of drafts.current.values()) draft.flush();
    };
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.removeEventListener("pagehide", flushAll);
      flushAll();
    };
  }, []);

  return (q: Question): AnswerDraft => {
    const existing = drafts.current.get(q.id);
    if (existing) return existing;
    const draft = new AnswerDraft(q.id, q.answer_text, onSaved);
    drafts.current.set(q.id, draft);
    return draft;
  };
}

/** Colonne affichée par question. Une carte en cours d'édition garde sa place, elle ne bascule qu'après la perte du focus. */
function usePlacement(grill: Grill | null, active: string | null) {
  const [placed, setPlaced] = useState<Record<string, Column>>({});
  useEffect(() => {
    if (!grill) return;
    setPlaced((prev) => {
      const next = { ...prev };
      for (const q of grill.questions) if (q.id !== active || !(q.id in next)) next[q.id] = q.answered ? "done" : "todo";
      // Même objet si rien ne bouge : l'identité sert de signal « une carte a changé de colonne ».
      return grill.questions.every((q) => prev[q.id] === next[q.id]) ? prev : next;
    });
  }, [grill, active]);
  return placed;
}

/** Saut vers une carte, sous l'en-tête collant. */
function useJump(head: RefObject<HTMLElement | null>, placed: Record<string, Column>) {
  const settling = useRef<string | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const align = useCallback(
    (id: string) => {
      const card = document.getElementById(cardDomId(id));
      if (!card) return;
      const offset = (head.current?.offsetHeight ?? 0) + HEAD_GAP_PX;
      window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - offset });
    },
    [head],
  );

  // La carte quittée change de colonne au retour de l'enregistrement : la cible ne doit pas partir sous l'en-tête.
  useLayoutEffect(() => {
    if (settling.current) align(settling.current);
  }, [placed, align]);

  // Dès que l'utilisateur reprend la main, plus aucun recalage : la page ne doit pas bouger sous son pointeur.
  useEffect(() => {
    const stop = () => {
      settling.current = null;
    };
    const events = ["pointerdown", "wheel", "touchstart"] as const;
    for (const event of events) window.addEventListener(event, stop, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, stop);
    };
  }, []);

  return useCallback(
    (id: string) => {
      align(id);
      settling.current = id;
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        settling.current = null;
      }, JUMP_SETTLE_MS);
      document.querySelector<HTMLTextAreaElement>(`#${cardDomId(id)} textarea:not(:disabled)`)?.focus({ preventScroll: true });
    },
    [align],
  );
}

/** Première question encore ouverte après `cursor`, en bouclant sur le début du grill. */
function nextOpenQuestion(questions: Question[], cursor: string | null, isOpen: (q: Question) => boolean): Question | undefined {
  const start = questions.findIndex((q) => q.id === cursor);
  return [...questions.slice(start + 1), ...questions.slice(0, start + 1)].find(isOpen);
}

function GrillIndex({
  questions,
  cursor,
  onJump,
}: {
  questions: Question[];
  cursor: string | null;
  onJump: (q: Question) => void;
}) {
  return (
    <nav className="grill-index" aria-label="Index des questions">
      {questions.map((q) => {
        const status = answerStatus(q);
        const label = STATUS_LABEL[status] + (q.modified_since_read ? ", modifié depuis la lecture" : "");
        return (
          <button
            key={q.id}
            type="button"
            className={`idx ${status}${q.modified_since_read ? " modified" : ""}`}
            aria-current={q.id === cursor ? "true" : undefined}
            aria-label={`Question ${q.position} : ${label}`}
            title={label}
            onClick={() => onJump(q)}
          >
            {q.position}
          </button>
        );
      })}
    </nav>
  );
}

function finishNotice(submitted: boolean, remaining: number): string {
  if (submitted) return "✔ Marqué terminé. Tes réponses restent modifiables. Dis à Claude de consulter tes réponses.";
  if (remaining === 0) return "Tout est répondu. Tu peux dire à Claude de consulter tes réponses.";
  return `${remaining} question(s) sans réponse. Les questions non traitées seront signalées à Claude.`;
}

function GrillHead({
  grill,
  headRef,
  cursor,
  onNext,
  onSetStatus,
  onJump,
}: {
  grill: Grill;
  headRef: RefObject<HTMLDivElement | null>;
  cursor: string | null;
  onNext: () => void;
  onSetStatus: (status: "open" | "submitted") => Promise<void>;
  onJump: (q: Question) => void;
}) {
  return (
    <div className="grill-sticky" ref={headRef}>
      <div className="grill-head">
        <h1 title={grill.title}>{grill.title}</h1>
        <div className="row-right">
          <Progress answered={grill.answered} total={grill.total} />
          <button type="button" className="ghost" disabled={grill.answered === grill.total} onClick={onNext}>
            Prochaine sans réponse
          </button>
          {grill.status === "submitted" ? (
            <button type="button" className="ghost" onClick={() => void onSetStatus("open")}>Rouvrir</button>
          ) : (
            <button type="button" className="primary" onClick={() => void onSetStatus("submitted")}>J'ai fini</button>
          )}
        </div>
      </div>
      <GrillIndex questions={grill.questions} cursor={cursor} onJump={onJump} />
    </div>
  );
}

function GrillColumn({
  column,
  items,
  draftOf,
  onUpdate,
  onActive,
  onAnswered,
}: {
  column: Column;
  items: Question[];
  draftOf: (q: Question) => AnswerDraft;
  onUpdate: (q: Question) => void;
  onActive: (q: Question, isActive: boolean) => void;
  onAnswered: (q: Question) => void;
}) {
  const isTodo = column === "todo";
  return (
    <section className={`column ${column}`}>
      <h2 className="col-title">
        {isTodo ? "À répondre" : "Répondues"} <span className="count">{items.length}</span>
      </h2>
      {items.length === 0 && <p className="muted empty">{isTodo ? "Tout est traité 🎉" : "Rien pour l'instant."}</p>}
      {items.map((q) => (
        <QuestionCard
          key={q.id}
          domId={cardDomId(q.id)}
          question={q}
          draft={draftOf(q)}
          onUpdate={onUpdate}
          onActive={(isActive) => onActive(q, isActive)}
          onAnswered={() => onAnswered(q)}
        />
      ))}
    </section>
  );
}

export function GrillPage({ slug, id, targetQuestion }: { slug: string; id: string; targetQuestion?: string }) {
  const { data: grill, setData, error } = useLoad(() => api.grill(id), [id]);
  const head = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  function updateQuestion(q: Question) {
    setData((g: Grill | null) => {
      if (!g) return g;
      const questions = g.questions.map((x) => (x.id === q.id ? q : x));
      return { ...g, questions, answered: questions.filter((x) => x.answered).length };
    });
  }

  const syncError = useReadMarks(id, setData);
  const draftOf = useAnswerDrafts(updateQuestion);
  const placed = usePlacement(grill, active);
  const jumpToCard = useJump(head, placed);

  // Arrivée par un lien vers une question (registre des décisions).
  const reached = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!grill || !targetQuestion || reached.current === targetQuestion) return;
    reached.current = targetQuestion;
    setCursor(targetQuestion);
    jumpToCard(targetQuestion);
  }, [grill, targetQuestion, jumpToCard]);

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

  const isOpen = (q: Question) => !q.answered && draftOf(q).getState().text.trim() === "";
  const jump = (q: Question) => {
    setCursor(q.id);
    jumpToCard(q.id);
  };

  function jumpToNextOpen() {
    if (!grill) return;
    const next = nextOpenQuestion(grill.questions, cursor, isOpen);
    if (next) jump(next);
  }

  /** Après une réponse : la carte quittée peut basculer, son texte reste dans sa saisie. */
  function advanceFrom(q: Question) {
    if (!grill) return;
    const next = nextOpenQuestion(grill.questions, q.id, (x) => x.id !== q.id && isOpen(x));
    if (next) jump(next);
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function onCardActive(q: Question, isActive: boolean) {
    if (isActive) setCursor(q.id);
    setActive((cur) => {
      if (isActive) return q.id;
      return cur === q.id ? null : cur;
    });
  }

  const submitted = grill.status === "submitted";
  const remaining = grill.total - grill.answered;
  const modifiedCount = grill.questions.filter((q) => q.modified_since_read).length;
  return (
    <>
      <Crumbs items={[{ label: grill.project.name, to: href.project(slug) }, { label: grill.title }]} />
      <GrillHead grill={grill} headRef={head} cursor={cursor} onNext={jumpToNextOpen} onSetStatus={setStatus} onJump={jump} />
      <p className="muted finish-note">{finishNotice(submitted, remaining)}</p>
      {modifiedCount > 0 && (
        <p className="finish-note modified-note">{modifiedCount} réponse(s) modifiée(s) depuis la dernière lecture : préviens Claude de les relire.</p>
      )}
      {syncError && <p className="error finish-note">État de lecture non actualisé : {syncError}</p>}
      {grill.context && (
        <section className="card context">
          <Markdown>{grill.context}</Markdown>
        </section>
      )}
      <div className="columns">
        {COLUMNS.map((col) => (
          <GrillColumn
            key={col}
            column={col}
            items={grill.questions.filter((q) => (placed[q.id] ?? (q.answered ? "done" : "todo")) === col)}
            draftOf={draftOf}
            onUpdate={updateQuestion}
            onActive={onCardActive}
            onAnswered={advanceFrom}
          />
        ))}
      </div>
      <section className="finish">
        <button type="button" className="danger" onClick={() => void remove()}>Supprimer le grill</button>
      </section>
    </>
  );
}
