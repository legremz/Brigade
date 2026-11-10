import { useLayoutEffect, useState } from "react";
import { Markdown } from "./Markdown";

/** Texte markdown affiché en lecture ; « Modifier » ouvre un éditeur. */
export function EditableMarkdown({
  value,
  placeholder,
  onSave,
  readOnly,
  onDirtyChange,
}: {
  value: string;
  placeholder: string;
  /** Renvoyer false garde l'éditeur ouvert (échec d'enregistrement). */
  onSave: (v: string) => boolean | void | Promise<boolean | void>;
  readOnly?: boolean;
  /** Signale qu'un brouillon non enregistré existe, pour protéger la fermeture du conteneur. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const dirty = editing && draft !== value;
  // Effet de mise en page : le conteneur doit connaître le brouillon avant la touche suivante.
  useLayoutEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  if (editing) {
    return (
      <div>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.max(5, draft.split("\n").length + 1)} autoFocus />
        <div className="q-foot">
          <button
            type="button"
            className="primary"
            onClick={async () => {
              if ((await onSave(draft)) !== false) setEditing(false);
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
