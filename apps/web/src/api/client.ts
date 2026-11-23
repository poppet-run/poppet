import type { SessionList, ChatSnapshot, Receipt, Submission } from "./protocol";

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
  method = body === undefined ? "GET" : "POST",
): Promise<T> => {
  const response = await fetch(
    path,
    body === undefined
      ? { method, credentials: "same-origin" }
      : {
          method,
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );

  if (!response.ok) {
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- HTTP error body is JSON.
    const error: { message?: string } = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      error.message ?? `Request failed (HTTP ${response.status}).`,
    );
  }

  // oxlint-disable-next-line typescript/no-unsafe-return -- Callers specify the endpoint's JSON response type.
  return response.json();
};

export const api = {
  snapshot: (id: string) => request<ChatSnapshot>(`/api/sessions/${encodeURIComponent(id)}`),
  sessions: (source: string) =>
    request<SessionList>(`/api/session-list?source=${encodeURIComponent(source)}`),
  login: (key: string) => request("/api/login", { key }),
  logout: () => request("/api/logout", {}),
  receipt: (id: string) => request<Receipt>(`/api/submissions/${encodeURIComponent(id)}`),
  submit: (submission: Submission) => request<Receipt>("/api/submissions", submission),
  remove: (id: string) => request(`/api/sessions/${encodeURIComponent(id)}`, undefined, "DELETE"),
  stop: (id: string) => request(`/api/sessions/${encodeURIComponent(id)}/stop`, {}),
};
