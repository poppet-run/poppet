export interface ChatSession {
  readonly id: string;
  readonly title: string | null;
  readonly provider: string;
  readonly model: string;
  readonly updatedAt: number;
}

export interface SessionList {
  readonly sessions: ReadonlyArray<ChatSession>;
  readonly gateways: ReadonlyArray<string>;
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

export interface ChatApproval {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly codeBlock?: { readonly label: string; readonly content: string };
  readonly args?: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly details?: string;
  readonly state: string;
  readonly actor: string | null;
}

export interface InboxApproval {
  readonly card: ChatApproval;
  readonly conversation: string;
  readonly action: string;
  readonly expiresAt: number;
}

export interface ChatSnapshot {
  readonly session: ChatSession;
  readonly messages: ReadonlyArray<{
    readonly id: number;
    readonly runId: string | null;
    readonly approvals?: ReadonlyArray<ChatApproval>;
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
