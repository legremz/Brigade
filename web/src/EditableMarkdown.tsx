import { useState } from "react";
import { Markdown } from "./Markdown";

/** Texte markdown affiché en lecture ; « Modifier » ouvre un éditeur. */
export function EditableMarkdown({
  value,
  placeholder,
  onSave,
  readOnly,
}: {
  value: string;
  placeholder: string;
  onSave: (v: string) => void | Promise<void>;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (editing) {
    return (
      <div>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.max(5, draft.split("\n").length + 1)} autoFocus />
        <div className="q-foot">
          <button
            type="button"
            className="primary"
            onClick={async () => {
              await onSave(draft);
              setEditing(false);
            }}
          >
            Enregistrer
          </button>
          <button type="button" className="ghost" onClick={() => setEditing(false)}>Annuler</button>
        </div>
      </div>
    );
  }
  return (
    <div className="editable">
      {value.trim() ? <Markdown>{value}</Markdown> : <p className="muted">{placeholder}</p>}
      {!readOnly && (
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
        >
          Modifier
        </button>
      )}
    </div>
  );
}
