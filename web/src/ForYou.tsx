import type { GrillQueueItem, HumanQueue, QueueItem, TaskQueueItem } from "./api";
import { ErrorBox } from "./common";
import { href } from "./router";

function targetOf(item: QueueItem): string {
  return "grill" in item ? href.grill(item.project.slug, item.grill.id) : href.board(item.project.slug, item.task.id);
}

function grillDetail(item: GrillQueueItem): string {
  if (item.type === "grill_unanswered") return `${item.unanswered} question(s) sans réponse sur ${item.total}`;
  return "Tout est répondu : à marquer terminé";
}

function taskDetail(item: TaskQueueItem): string {
  switch (item.type) {
    case "task_review":
      return "À relire";
    case "task_stale":
      return `Sans activité depuis ${item.stale_for}`;
    case "task_human_ready":
      return "À faire par toi";
    default: {
      const unknownItem: never = item;
      throw new Error(`Élément inconnu : ${JSON.stringify(unknownItem)}`);
    }
  }
}

const titleOf = (item: QueueItem): string => ("grill" in item ? item.grill.title : `#${item.task.seq} ${item.task.title}`);
const detailOf = (item: QueueItem): string => ("grill" in item ? grillDetail(item) : taskDetail(item));
const keyOf = (item: QueueItem): string => `${item.type}-${"grill" in item ? item.grill.id : item.task.id}`;

function QueueGroup({ title, items }: { title: string; items: QueueItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="queue-group">
      <h2 className="col-title">{title} <span className="count">{items.length}</span></h2>
      {items.map((item) => (
        <a key={keyOf(item)} className={`card queue-item ${item.type}`} href={targetOf(item)}>
          <div>
            <strong>{titleOf(item)}</strong>
            <span className="muted"> · {item.project.name}</span>
          </div>
          <span className="pill pending">{detailOf(item)}</span>
        </a>
      ))}
    </section>
  );
}

export function ForYou({ queue, error }: { queue: HumanQueue | null; error: string | null }) {
  return (
    <>
      <h1>Pour toi</h1>
      {error && <ErrorBox message={error} />}
      {queue?.up_to_date && !error && <p className="up-to-date"><span className="pill answered">À jour</span> Rien ne t'attend.</p>}
      {queue && (
        <>
          <QueueGroup title="Questions" items={queue.grills} />
          <QueueGroup title="Validations humaines" items={queue.human_tasks} />
          <QueueGroup title="Tâches d'agents" items={queue.agent_tasks} />
        </>
      )}
    </>
  );
}

/** Nombre d'éléments en attente par projet, pour les vignettes de l'accueil. */
export function countsByProject(queue: HumanQueue | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (!queue) return counts;
  for (const item of [...queue.grills, ...queue.human_tasks, ...queue.agent_tasks])
    counts.set(item.project.id, (counts.get(item.project.id) ?? 0) + 1);
  return counts;
}
