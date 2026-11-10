import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type Attachment, type Outcome, type Question } from "./api";
import type { AnswerDraft, SaveState } from "./answerDraft";
import { hasChoice, toggleChoice } from "./choices";
import { Markdown } from "./Markdown";
import { prepareImage } from "./image";
import { OutcomeBar } from "./OutcomeBar";

type AnswerStatus = "pending" | "answered" | "skipped" | Outcome;

export const STATUS_LABEL: Record<AnswerStatus, string> = {
  pending: "À répondre",
  answered: "Répondue",
  skipped: "Passée",
  accept_default: "Proposition validée",
  decide_for_me: "Décide pour moi",
  not_relevant: "Pas pertinent",
  later: "Plus tard",
};
const SAVE_LABEL: Record<SaveState, string> = { idle: "", saving: "Enregistrement…", saved: "Enregistré ✓", error: "Échec" };

export function answerStatus(question: Question): AnswerStatus {
  if (question.outcome) return question.outcome;
  if (question.skipped) return "skipped";
  return question.answered ? "answered" : "pending";
}

function fieldPlaceholder(question: Question): string {
  if (question.skipped) return "Question passée";
  if (question.outcome === "later") return "Écrire ici retire « Plus tard »…";
  if (question.outcome) return "Note facultative pour l'agent…";
  return "Ta réponse… (markdown accepté, colle une capture avec Ctrl+V)";
}

export function QuestionCard({
  domId,
  question,
  draft,
  onUpdate,
  onActive,
  onAnswered,
}: {
  domId: string;
  question: Question;
  draft: AnswerDraft;
  onUpdate: (q: Question) => void;
  /** Signale que la carte est en cours d'édition (focus dedans) : la page ne la déplace pas de colonne. */
  onActive?: (active: boolean) => void;
  /** Une réponse vient d'être donnée : la page amène à la question suivante. */
  onAnswered?: () => void;
}) {
  const { text, save, error: saveError } = useSyncExternalStore(draft.subscribe, draft.getState);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const choosing = useRef(false); // pas d'état ni de `disabled` : un bouton désactivé perdrait le focus
  const field = useRef<HTMLTextAreaElement>(null);
  const focusOnResume = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function addImages(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of images) {
        const blob = await prepareImage(f);
        await api.upload(question.id, blob, f.name || "capture");
      }
      onUpdate(await api.answer(question.id, {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeImage(id: string) {
    try {
      await api.deleteAttachment(id);
      onUpdate(await api.answer(question.id, {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Le champ n'est réactivé qu'au rendu suivant : focus demandé avant, il serait ignoré sur un champ encore désactivé.
  useEffect(() => {
    if (!focusOnResume.current || question.skipped) return;
    focusOnResume.current = false;
    field.current?.focus();
  }, [question.skipped]);

  /** Le bouton cliqué disparaît : le focus revient au champ, sinon la carte resterait « en cours d'édition ». */
  async function resume() {
    focusOnResume.current = true;
    try {
      onUpdate(await api.answer(question.id, { skipped: false }));
    } catch (e) {
      focusOnResume.current = false;
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function chooseOutcome(outcome: Outcome | null) {
    if (choosing.current) return;
    choosing.current = true;
    const accepted = await draft.chooseOutcome(outcome);
    choosing.current = false;
    if (!accepted) return;
    if (outcome) {
      onActive?.(false); // action explicite : la carte change de colonne tout de suite
      onAnswered?.();
    } else {
      field.current?.focus();
    }
  }

  function pickChoice(choice: string) {
    draft.edit(toggleChoice(text, choice));
    draft.flush();
  }

  function finishAnswer() {
    draft.flush();
    onAnswered?.();
  }

  const status = answerStatus(question);
  const placeholder = fieldPlaceholder(question);

  return (
    <article
      id={domId}
      className={`card question ${status}${dragging ? " dragging" : ""}`}
      onFocus={() => onActive?.(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onActive?.(false);
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files];
        if (files.some((f) => f.type.startsWith("image/"))) {
          e.preventDefault();
          void addImages(files);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addImages([...e.dataTransfer.files]);
      }}
    >
      <header className="q-head">
        <span className="q-num">{question.position}</span>
        <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
        {question.critical && <span className="pill critical">Critique</span>}
        {question.modified_since_read && <span className="pill modified">Modifié depuis la lecture</span>}
      </header>

      <Markdown>{question.text}</Markdown>
      {question.hint && <p className="hint">{question.hint}</p>}
      {question.default_answer && (
        <p className="default-answer">
          <span className="muted">Proposition de l'agent :</span> {question.default_answer}
        </p>
      )}

      {question.choices && (
        <div className="chips">
          {question.choices.map((c) => {
            const selected = hasChoice(text, c);
            return (
              <button
                key={c}
                type="button"
                className={`chip${selected ? " selected" : ""}`}
                aria-pressed={selected}
                onClick={() => pickChoice(c)}
                disabled={question.skipped}
              >
                {c}
              </button>
            );
          })}
        </div>
      )}

      <textarea
        ref={field}
        value={text}
        disabled={question.skipped}
        placeholder={placeholder}
        onChange={(e) => draft.edit(e.target.value)}
        onBlur={() => draft.flush()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            finishAnswer();
          }
        }}
        rows={Math.max(3, Math.min(14, text.split("\n").length + 1))}
      />

      {question.attachments.length > 0 && (
        <div className="thumbs">
          {question.attachments.map((a) => (
            <figure key={a.id} className="thumb">
              <img src={api.attachmentUrl(a.id)} alt={a.filename} onClick={() => setZoom(a)} />
              <button type="button" className="x" title="Retirer l'image" onClick={() => void removeImage(a.id)}>
                ×
              </button>
            </figure>
          ))}
        </div>
      )}

      <OutcomeBar question={question} onChoose={(o) => void chooseOutcome(o)} />

      <footer className="q-foot">
        <button type="button" className="ghost" onClick={() => fileInput.current?.click()} disabled={busy || question.skipped}>
          {busy ? "Envoi…" : "＋ Image"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addImages([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        {question.skipped && (
          <button type="button" className="ghost" onClick={() => void resume()}>
            Reprendre
          </button>
        )}
        <button type="button" className="ghost" title="Enregistre et passe à la prochaine sans réponse (Ctrl+Entrée)" onClick={finishAnswer}>
          Suivante
        </button>
        <span className={`save ${save}`}>{SAVE_LABEL[save]}</span>
      </footer>
      {(saveError ?? error) && <p className="error">{saveError ?? error}</p>}

      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <img src={api.attachmentUrl(zoom.id)} alt={zoom.filename} />
        </div>
      )}
    </article>
  );
}
