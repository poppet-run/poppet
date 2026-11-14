import type { ChatSession, ChatSnapshot, Receipt, Submission } from "./protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async <T>(
  path: string,
  body?: Submission | { readonly key: string } | Record<string, never>,
): Promise<T> => {
  const response = await fetch(
    path,
    body === undefined
      ? { credentials: "same-origin" }
      : {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );

  if (!response.ok) {
    const error: { message?: string } = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      error.message ?? `Request failed (HTTP ${response.status}).`,
    );
  }

  return response.json();
};

export const api = {
  snapshot: (id: string) => request<ChatSnapshot>(`/api/sessions/${encodeURIComponent(id)}`),
  sessions: () => request<ReadonlyArray<ChatSession>>("/api/sessions"),
  login: (key: string) => request("/api/login", { key }),
  logout: () => request("/api/logout", {}),
  receipt: (id: string) => request<Receipt>(`/api/submissions/${encodeURIComponent(id)}`),
  submit: (submission: Submission) => request<Receipt>("/api/submissions", submission),
  stop: (id: string) => request(`/api/sessions/${encodeURIComponent(id)}/stop`, {}),
};
