import { api, type Outcome, type Question } from "./api";

export type SaveState = "idle" | "saving" | "saved" | "error";
export interface DraftState {
  readonly text: string;
  readonly save: SaveState;
  readonly error: string | null;
}

const SAVE_DELAY_MS = 700;

/**
 * Saisie d'une réponse, conservée hors de la carte : changer de colonne recrée la carte,
 * et la saisie comme l'enregistrement en cours doivent y survivre.
 */
export class AnswerDraft {
  private state: DraftState;
  private lastSaved: string;
  private latest: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Échange en cours avec le serveur : les envois sont strictement à la suite. */
  private inFlight: Promise<unknown> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly questionId: string,
    initialText: string,
    private readonly onSaved: (q: Question) => void,
  ) {
    this.state = { text: initialText, save: "idle", error: null };
    this.lastSaved = initialText;
    this.latest = initialText;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): DraftState => this.state;

  edit(text: string): void {
    this.setState({ text, save: "idle" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Envoie tout de suite la saisie courante, sans attendre le délai. */
  flush(): void {
    clearTimeout(this.timer);
    this.latest = this.state.text;
    this.startSend();
  }

  /** Envoie la sortie avec le texte courant, en une seule écriture : un texte en retard ne doit pas pouvoir la retirer. */
  async chooseOutcome(outcome: Outcome | null): Promise<boolean> {
    clearTimeout(this.timer);
    while (this.inFlight) await this.inFlight;
    const accepted = await this.track(this.sendOutcome(outcome));
    this.flush(); // ce qui a été saisi pendant l'échange
    return accepted;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => {
      this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async sendOutcome(outcome: Outcome | null): Promise<boolean> {
    const sent = this.state.text;
    this.setState({ save: "saving", error: null });
    try {
      const q = await api.answer(this.questionId, { text: sent, outcome });
      this.lastSaved = sent;
      this.latest = sent;
      this.onSaved(q);
      this.setState({ save: this.state.text === sent ? "saved" : "idle" });
      return true;
    } catch (e) {
      this.setState({ save: "error", error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  private startSend(): void {
    if (this.inFlight || this.latest === this.lastSaved) return;
    void this.track(this.sendText());
  }

  // Les PUT sont sérialisés : l'envoi en vol reprend ensuite la dernière valeur, pour que le serveur finisse sur ce qui est affiché.
  private async sendText(): Promise<void> {
    this.setState({ save: "saving", error: null });
    try {
      while (this.latest !== this.lastSaved) {
        const sent = this.latest;
        const q = await api.answer(this.questionId, { text: sent });
        this.lastSaved = sent;
        this.onSaved(q);
      }
      this.setState({ save: this.state.text === this.lastSaved ? "saved" : "idle" });
    } catch (e) {
      this.setState({ save: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  private setState(patch: Partial<DraftState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
