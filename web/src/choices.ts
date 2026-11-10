// Une suggestion retenue occupe une ligne de la réponse : la réponse reste du texte libre, modifiable à la main.

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

export function hasChoice(answer: string, choice: string): boolean {
  const target = normalize(choice);
  return answer.split("\n").some((line) => normalize(line) === target);
}

/** Ajoute la suggestion si elle est absente ; sinon retire toutes ses occurrences. */
export function toggleChoice(answer: string, choice: string): string {
  const target = normalize(choice);
  const lines = answer.split("\n");
  const kept = lines.filter((line) => normalize(line) !== target);
  if (kept.length !== lines.length) return kept.join("\n").trim();
  const base = answer.trimEnd();
  return base ? `${base}\n${target}` : target;
}
