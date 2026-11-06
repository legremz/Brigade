import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { InvalidError, NotFoundError, getProject } from "./store.js";

const now = () => new Date().toISOString();
const newId = () => `sk_${randomBytes(4).toString("hex")}`;

export interface Skill {
  id: string;
  project_id: string;
  name: string;
  description: string;
  content: string;
  /** À lire au démarrage de toute session sur le projet (conventions, stack, règles). */
  always: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkillInput {
  name: string;
  description?: string;
  content?: string;
  always?: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const toSkill = (r: Record<string, unknown>): Skill => ({ ...(r as unknown as Skill), always: Number(r.always) === 1 });

function checkName(name: string): string {
  const n = name.trim();
  if (!NAME_RE.test(n))
    throw new InvalidError(`Nom de skill invalide : « ${name} ». Attendu : minuscules, chiffres et tirets (ex. conventions-api).`);
  return n;
}

export function listSkills(projectRef: string): Omit<Skill, "content">[] {
  const p = getProject(projectRef);
  const rows = db
    .prepare("SELECT * FROM skills WHERE project_id = ? ORDER BY always DESC, name")
    .all(p.id) as Record<string, unknown>[];
  return rows.map((r) => {
    const { content: _c, ...rest } = toSkill(r);
    return rest;
  });
}

/** Résout un skill par id ou nom dans un projet. */
export function getSkill(projectRef: string, ref: string): Skill {
  const p = getProject(projectRef);
  const r = db.prepare("SELECT * FROM skills WHERE project_id = ? AND (id = ? OR name = ?)").get(p.id, ref, ref);
  if (!r) throw new NotFoundError(`Skill introuvable dans ce projet : « ${ref} ». Utilise list_skills.`);
  return toSkill(r as Record<string, unknown>);
}

export function getSkillById(id: string): Skill {
  const r = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
  if (!r) throw new NotFoundError(`Skill introuvable : « ${id} ».`);
  return toSkill(r as Record<string, unknown>);
}

/** Crée le skill, ou le met à jour s'il existe déjà (même nom). */
export function saveSkill(projectRef: string, input: SkillInput): { skill: Skill; created: boolean } {
  const p = getProject(projectRef);
  const name = checkName(input.name);
  const existing = db.prepare("SELECT id FROM skills WHERE project_id = ? AND name = ?").get(p.id, name) as { id: string } | undefined;
  const t = now();
  if (!existing) {
    const id = newId();
    db.prepare(
      "INSERT INTO skills (id, project_id, name, description, content, always, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(id, p.id, name, input.description ?? "", input.content ?? "", input.always ? 1 : 0, t, t);
    return { skill: getSkillById(id), created: true };
  }
  const cur = getSkillById(existing.id);
  db.prepare("UPDATE skills SET description = ?, content = ?, always = ?, updated_at = ? WHERE id = ?").run(
    input.description ?? cur.description,
    input.content ?? cur.content,
    (input.always ?? cur.always) ? 1 : 0,
    t,
    cur.id,
  );
  return { skill: getSkillById(cur.id), created: false };
}

export function updateSkillById(id: string, patch: Partial<SkillInput>): Skill {
  const cur = getSkillById(id);
  const name = patch.name !== undefined ? checkName(patch.name) : cur.name;
  if (name !== cur.name && db.prepare("SELECT 1 FROM skills WHERE project_id = ? AND name = ?").get(cur.project_id, name))
    throw new InvalidError(`Un skill « ${name} » existe déjà dans ce projet.`);
  db.prepare("UPDATE skills SET name = ?, description = ?, content = ?, always = ?, updated_at = ? WHERE id = ?").run(
    name,
    patch.description ?? cur.description,
    patch.content ?? cur.content,
    (patch.always ?? cur.always) ? 1 : 0,
    now(),
    id,
  );
  return getSkillById(id);
}

export function deleteSkill(id: string): void {
  getSkillById(id);
  db.prepare("DELETE FROM skills WHERE id = ?").run(id);
}

// ---- Format SKILL.md (compatible Claude Code) ----

/** Sérialise un skill en SKILL.md : frontmatter `name` / `description`, puis le corps. */
export function toSkillMd(s: Pick<Skill, "name" | "description" | "content">): string {
  const desc = s.description.replace(/\s*\n\s*/g, " ").trim();
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${s.content.trim()}\n`;
}

/** Lit un SKILL.md. Tolère l'absence de frontmatter (le nom doit alors être fourni). */
export function parseSkillMd(md: string, fallbackName?: string): SkillInput {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md.trim() + "\n");
  const meta: Record<string, string> = {};
  let body = md.trim();
  if (m) {
    body = m[2]!.trim();
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      let v = kv[2]!.trim();
      if (/^".*"$/.test(v)) {
        try {
          v = JSON.parse(v);
        } catch {
          v = v.slice(1, -1);
        }
      } else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
      meta[kv[1]!.toLowerCase()] = v;
    }
  }
  const name = meta.name ?? fallbackName;
  if (!name) throw new InvalidError("SKILL.md sans champ `name` dans le frontmatter : précise le nom.");
  return { name, description: meta.description ?? "", content: body };
}
