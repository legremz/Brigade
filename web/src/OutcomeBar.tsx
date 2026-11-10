import type { Outcome, Question } from "./api";

const BUTTON_LABEL: Record<Outcome, string> = {
  accept_default: "Valider la proposition",
  decide_for_me: "Décide pour moi",
  not_relevant: "Pas pertinent",
  later: "Plus tard",
};

function outcomeEffect(question: Question, outcome: Outcome): string {
  if (outcome === "decide_for_me" && !question.awaiting_decision) return "Décision enregistrée : voir l'onglet Décisions.";
  return OUTCOME_EFFECT[outcome];
}

const OUTCOME_EFFECT: Record<Outcome, string> = {
  accept_default: "La proposition fait foi pour l'agent.",
  decide_for_me: "L'agent tranchera et écrira sa décision.",
  not_relevant: "L'agent écartera cette question.",
  later: "La question reste ouverte pour l'agent, sans rien présumer.",
};

/** Ce que devient le texte du champ sous une sortie : une note, sauf « plus tard » où écrire, c'est répondre. */
export function textRole(outcome: Outcome): string {
  return outcome === "later" ? "Écrire une réponse retire « Plus tard »." : "Ton texte reste une note pour l'agent.";
}

export function OutcomeBar({
  question,
  onChoose,
}: {
  question: Question;
  onChoose: (outcome: Outcome | null) => void;
}) {
  const { outcome } = question;
  return (
    <>
      <div className="outcomes" role="group" aria-label="Sortie de la question">
        {question.available_outcomes.map((o) => (
          <button
            key={o}
            type="button"
            className={`ghost small-btn${o === outcome ? " chosen" : ""}`}
            aria-pressed={o === outcome}
            disabled={o === outcome}
            onClick={() => onChoose(o)}
          >
            {BUTTON_LABEL[o]}
          </button>
        ))}
      </div>
      {outcome && (
        <p className="outcome-note">
          {outcomeEffect(question, outcome)} {textRole(outcome)}{" "}
          <button type="button" className="link" onClick={() => onChoose(null)}>
            Annuler la sortie
          </button>
        </p>
      )}
    </>
  );
}
