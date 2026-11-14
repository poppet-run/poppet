export interface ChatSession {
  readonly id: string;
  readonly title: string | null;
  readonly provider: string;
  readonly model: string;
  readonly updatedAt: number;
}

export interface Submission {
  readonly id: string;
  readonly sessionId: string | null;
  readonly text: string;
}

export interface Receipt {
  readonly id: string;
  readonly sessionId: string;
  readonly status: "accepted" | "completed" | "failed" | "interrupted";
  readonly error: string | null;
}

export interface ChatSnapshot {
  readonly session: ChatSession;
  readonly messages: ReadonlyArray<{
    readonly id: number;
    readonly runId: string | null;
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
  readonly receipts: ReadonlyArray<Receipt>;
  readonly active: {
    readonly id: string;
    readonly input: string;
    readonly text: string;
  } | null;
}
