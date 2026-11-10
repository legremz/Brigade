// Sans effet de bord (pas d'accès à la base) : importable par le test de fumée.

/** Une tâche en cours sans activité depuis ce délai a peut-être été abandonnée (agent planté). */
export const DEFAULT_STALE_MINUTES = 120;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
/** En dessous de deux jours, les heures restent plus parlantes que « 1 j ». */
const DAYS_DISPLAY_FROM_MINUTES = 2 * MINUTES_PER_DAY;

/** Entier strictement positif et rien d'autre : une valeur douteuse doit empêcher le démarrage, pas changer le seuil en silence. */
export function parseStaleMinutes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_STALE_MINUTES;
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new Error(`BRIGADE_STALE_MINUTES invalide : « ${raw} » (entier de minutes attendu, au moins 1).`);
  return Number(raw);
}

/** Dernière activité connue : le plus récent de la dernière modification et du démarrage. */
export function lastActivity(updatedAt: string, startedAt: string | null): string {
  if (startedAt === null) return updatedAt;
  return Date.parse(startedAt) > Date.parse(updatedAt) ? startedAt : updatedAt;
}

export const minutesSince = (iso: string): number => Math.floor((Date.now() - Date.parse(iso)) / MS_PER_MINUTE);

export function humanDuration(min: number): string {
  if (min < MINUTES_PER_HOUR) return `${min} min`;
  if (min < DAYS_DISPLAY_FROM_MINUTES) return `${Math.round(min / MINUTES_PER_HOUR)} h`;
  return `${Math.round(min / MINUTES_PER_DAY)} j`;
}
