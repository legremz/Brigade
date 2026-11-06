import { useEffect, useRef, useState } from "react";
import { api, type Attachment, type Question } from "./api";
import { Markdown } from "./Markdown";
import { prepareImage } from "./image";

type SaveState = "idle" | "saving" | "saved" | "error";

export function QuestionCard({
  question,
  onUpdate,
  onActive,
}: {
  question: Question;
  onUpdate: (q: Question) => void;
  /** Signale que la carte est en cours d'édition (focus dedans) : la page ne la déplace pas de colonne. */
  onActive?: (active: boolean) => void;
}) {
  const [text, setText] = useState(question.answer_text);
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSaved = useRef(question.answer_text);
  const fileInput = useRef<HTMLInputElement>(null);

  // Annule une sauvegarde différée si la carte disparaît.
  useEffect(() => () => clearTimeout(timer.current), []);

  async function persist(value: string) {
    clearTimeout(timer.current);
    if (value === lastSaved.current) return;
    setSave("saving");
    try {
      const q = await api.answer(question.id, { text: value });
      lastSaved.current = value;
      onUpdate(q);
      setSave("saved");
    } catch (e) {
      setSave("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onChange(value: string) {
    setText(value);
    setSave("idle");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(value), 700);
  }

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

  async function toggleSkip() {
    try {
      onUpdate(await api.answer(question.id, { skipped: !question.skipped }));
      onActive?.(false); // action explicite : la carte change de colonne tout de suite
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function pickChoice(choice: string) {
    const next = text.trim() ? `${text.replace(/\s+$/, "")}\n${choice}` : choice;
    onChange(next);
    void persist(next);
  }

  const status = question.skipped ? "skipped" : question.answered ? "answered" : "pending";

  return (
    <article
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
        <span className={`pill ${status}`}>
          {status === "answered" ? "Répondue" : status === "skipped" ? "Passée" : "À répondre"}
        </span>
      </header>

      <Markdown>{question.text}</Markdown>
      {question.hint && <p className="hint">{question.hint}</p>}

      {question.choices && (
        <div className="chips">
          {question.choices.map((c) => (
            <button key={c} type="button" className="chip" onClick={() => pickChoice(c)} disabled={question.skipped}>
              {c}
            </button>
          ))}
        </div>
      )}

      <textarea
        value={text}
        disabled={question.skipped}
        placeholder={question.skipped ? "Question passée" : "Ta réponse… (markdown accepté, colle une capture avec Ctrl+V)"}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => void persist(text)}
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
        <button type="button" className="ghost" onClick={() => void toggleSkip()}>
          {question.skipped ? "Reprendre" : "Passer"}
        </button>
        <span className={`save ${save}`}>
          {save === "saving" ? "Enregistrement…" : save === "saved" ? "Enregistré ✓" : save === "error" ? "Échec" : ""}
        </span>
      </footer>
      {error && <p className="error">{error}</p>}

      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <img src={api.attachmentUrl(zoom.id)} alt={zoom.filename} />
        </div>
      )}
    </article>
  );
}
