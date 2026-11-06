import { useRef, useState } from "react";
import { api, type Skill } from "./api";
import { Crumbs, ErrorBox } from "./common";
import { useLoad } from "./hooks";
import { ProjectTabs } from "./ProjectTabs";
import { href } from "./router";

export function SkillsPage({ slug }: { slug: string }) {
  const project = useLoad(() => api.project(slug), [slug]);
  const skills = useLoad(() => api.skills(slug), [slug], 5000);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<unknown>) {
    try {
      setError(null);
      await fn();
      await skills.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      // un skill Claude Code est un dossier/SKILL.md : à défaut de frontmatter, on prend le nom du fichier
      const fallback = f.name.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      await run(async () => api.importSkill(slug, await f.text(), fallback === "skill" ? undefined : fallback));
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <>
      <Crumbs items={[{ label: project.data?.name ?? slug, to: href.project(slug) }, { label: "Skills" }]} />
      <h1>{project.data?.name ?? slug}</h1>
      <ProjectTabs slug={slug} active="skills" />
      {(project.error || skills.error || error) && <ErrorBox message={(project.error ?? skills.error ?? error)!} />}

      <p className="muted small-note">
        Instructions durables du projet (conventions, stack, commandes de test). L'IA les lit via le MCP ; celles marquées
        « toujours » sont signalées dès la reprise du projet. Format compatible <code>SKILL.md</code> : import et export possibles.
      </p>
      <div className="grill-head">
        <h2>Skills du projet</h2>
        <div className="q-foot">
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>⇪ Importer un SKILL.md</button>
          <button type="button" className="primary" onClick={() => setEditing("new")}>＋ Nouveau skill</button>
        </div>
        <input ref={fileRef} type="file" accept=".md,text/markdown" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
      </div>

      {skills.data?.length === 0 && editing !== "new" && <p className="muted">Aucun skill pour l'instant.</p>}
      {editing === "new" && (
        <SkillForm onCancel={() => setEditing(null)} onSave={(v) => run(() => api.createSkill(slug, v)).then(() => setEditing(null))} />
      )}
      {skills.data?.map((s) =>
        editing === s.id ? (
          <SkillEditor key={s.id} id={s.id} onCancel={() => setEditing(null)} onSave={(v) => run(() => api.updateSkill(s.id, v)).then(() => setEditing(null))} />
        ) : (
          <article key={s.id} className="card agent">
            <div className="row">
              <strong>📘 {s.name}</strong>
              {s.always && <span className="pill answered">Toujours lu</span>}
            </div>
            {s.description && <p className="muted">{s.description}</p>}
            <div className="q-foot">
              <button type="button" className="ghost" onClick={() => setEditing(s.id)}>Modifier</button>
              <a className="ghost btn" href={api.skillMdUrl(s.id)} download={`${s.name}.SKILL.md`}>⇩ Exporter</a>
              <button
                type="button"
                className="danger"
                onClick={() => confirm(`Supprimer le skill « ${s.name} » ?`) && void run(() => api.deleteSkill(s.id))}
              >
                Supprimer
              </button>
            </div>
          </article>
        ),
      )}
    </>
  );
}

/** Charge le contenu complet (la liste ne le contient pas) avant d'ouvrir le formulaire. */
function SkillEditor({ id, onSave, onCancel }: { id: string; onSave: (v: Partial<Skill> & { name: string }) => void | Promise<void>; onCancel: () => void }) {
  const full = useLoad(() => api.skill(id), [id]);
  if (full.error) return <ErrorBox message={full.error} />;
  if (!full.data) return <p className="muted">Chargement…</p>;
  return <SkillForm skill={full.data} onSave={onSave} onCancel={onCancel} />;
}

function SkillForm({
  skill,
  onSave,
  onCancel,
}: {
  skill?: Skill;
  onSave: (v: { name: string; description: string; content: string; always: boolean }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? "");
  const [always, setAlways] = useState(skill?.always ?? false);
  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ name, description, content, always });
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom (minuscules et tirets, ex. conventions-api)" required pattern="[a-z0-9][a-z0-9\-]*" />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Quand l'utiliser, en une phrase" />
      <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={12} placeholder="Instructions (markdown)…" />
      <label className="check">
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        À lire au démarrage de toute session sur ce projet
      </label>
      <div className="q-foot">
        <button type="submit" className="primary">Enregistrer</button>
        <button type="button" className="ghost" onClick={onCancel}>Annuler</button>
      </div>
    </form>
  );
}
