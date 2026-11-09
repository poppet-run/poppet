import { map } from "nanostores";

import { api, ApiError } from "../api/client";
import type { ChatSession, ChatSnapshot, Receipt, Submission } from "../api/protocol";

const sessionFromUrl = () => /^\/chat\/([A-Za-z0-9_-]+)$/.exec(location.pathname)?.[1] ?? null;

const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Connection lost. Check delivery before sending again.";

type ChatState = {
  authenticated: boolean | null;
  key: string;
  sessions: ReadonlyArray<ChatSession>;
  sessionId: string | null;
  snapshot: ChatSnapshot | null;
  drafts: Record<string, string>;
  pending: Submission | null;
  sending: boolean;
  error: string;
  refreshError: string;
  connected: boolean;
  sidebar: boolean;
  atBottom: boolean;
};

// Each mounted app has its own state. Sign-in and sign-out change the generation, so late replies are ignored.
export const createChatStore = () => {
  const $state = map<ChatState>({
    authenticated: null,
    key: "",
    sessions: [],
    sessionId: sessionFromUrl(),
    snapshot: null,
    drafts: {},
    pending: null,
    sending: false,
    error: "",
    refreshError: "",
    connected: false,
    sidebar: false,
    atBottom: true,
  });

  const set = <K extends keyof ChatState>(key: K, value: ChatState[K]) => {
    if (value !== $state.get()[key]) $state.set({ ...$state.get(), [key]: value });
  };

  let generation = 0;
  let deliveryLock = false;

  const unauthenticate = () => {
    generation++;
    set("refreshError", "");
    set("authenticated", false);
    set("sessions", []);
    set("snapshot", null);
  };

  const refresh = async () => {
    const requestGeneration = generation;

    try {
      const sessions = await api.sessions();

      if (requestGeneration !== generation) return;
      set("refreshError", "");
      set("sessions", sessions);
      set("authenticated", true);
    } catch (cause) {
      if (requestGeneration !== generation) return;

      if (cause instanceof ApiError && cause.status === 401) unauthenticate();
      else set("refreshError", errorMessage(cause));
    }
  };

  const navigate = (id: string | null) => {
    if (id !== $state.get().sessionId) {
      set("snapshot", null);
      set("connected", false);
    }

    history.pushState(null, "", id ? `/chat/${id}` : "/");
    set("sessionId", id);
    set("sidebar", false);
    set("error", "");
  };

  const settle = (submission: Submission, receipt: Receipt) => {
    sessionStorage.removeItem("poppet-submission");
    set("pending", null);
    const submittedKey = submission.sessionId ?? "new";
    const drafts = $state.get().drafts;

    if (drafts[submittedKey] === submission.text) set("drafts", { ...drafts, [submittedKey]: "" });
    navigate(receipt.sessionId);

    if (receipt.error) set("error", receipt.error);
    void refresh();
  };

  const deliver = async (submission: Submission) => {
    if (deliveryLock) return;
    deliveryLock = true;
    set("sending", true);
    set("error", "");
    const requestGeneration = generation;

    try {
      // Save the recovery ID before sending so it survives a page refresh.
      sessionStorage.setItem("poppet-submission", JSON.stringify(submission));
      set("pending", submission);
      const receipt = await api.submit(submission);

      if (requestGeneration !== generation) return;
      settle(submission, receipt);
      set("atBottom", true);
    } catch (cause) {
      if (requestGeneration !== generation) return;

      if (cause instanceof ApiError && [400, 403, 404, 409, 413, 415, 429].includes(cause.status)) {
        sessionStorage.removeItem("poppet-submission");
        set("pending", null);
      }

      if (cause instanceof ApiError && cause.status === 401) unauthenticate();
      set("error", errorMessage(cause));
    } finally {
      deliveryLock = false;
      set("sending", false);
    }
  };

  const send = () => {
    const draft = $state.get().drafts[$state.get().sessionId ?? "new"] ?? "";

    if (
      !draft.trim() ||
      $state.get().sending ||
      $state.get().pending ||
      $state.get().snapshot?.active ||
      ($state.get().sessionId && !$state.get().connected)
    )
      return;
    void deliver({ id: crypto.randomUUID(), sessionId: $state.get().sessionId, text: draft });
  };

  const login = async (accessKey: string) => {
    set("sending", true);
    set("error", "");

    try {
      await api.login(accessKey);
      set("key", "");
      generation++;
      void refresh();
    } catch (cause) {
      set("error", errorMessage(cause));
    } finally {
      set("sending", false);
    }
  };

  const logout = async () => {
    try {
      await api.logout();
      unauthenticate();
      set("drafts", {});
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        unauthenticate();
        set("drafts", {});
      } else set("error", errorMessage(cause));
    }
  };

  // Check the receipt before forgetting local recovery. This never cancels a worker run.
  const forget = async () => {
    const submission = $state.get().pending;

    if (!submission || $state.get().sending) return;
    const requestGeneration = generation;
    set("sending", true);

    try {
      const receipt = await api.receipt(submission.id);

      if (requestGeneration !== generation) return;
      settle(submission, receipt);
    } catch (cause) {
      if (requestGeneration !== generation) return;

      if (cause instanceof ApiError && cause.status === 404) {
        sessionStorage.removeItem("poppet-submission");
        set("pending", null);
        set(
          "error",
          "Recovery cleared. The message may still arrive. Check history before sending it again.",
        );
      } else {
        if (cause instanceof ApiError && cause.status === 401) unauthenticate();
        set("error", errorMessage(cause));
      }
    } finally {
      set("sending", false);
    }
  };

  const stop = async () => {
    try {
      await api.stop($state.get().sessionId!);
    } catch (cause) {
      set("error", errorMessage(cause));
    }
  };

  const stream = (sessionId: string) => {
    let listening = true;
    let events: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      retry = undefined;

      if (!listening) return;
      events?.close();
      const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
      events = source;
      source.addEventListener("message", (event) => {
        if (!listening || source !== events) return;
        const value: ChatSnapshot = JSON.parse(event.data);
        set("snapshot", value);
        set("connected", true);
      });
      source.addEventListener("error", async () => {
        if (!listening || source !== events) return;
        set("connected", false);

        try {
          await api.snapshot(sessionId);
        } catch (cause) {
          if (!listening || source !== events) return;

          if (cause instanceof ApiError && cause.status === 401) return unauthenticate();

          if (cause instanceof ApiError && cause.status === 404) {
            listening = false;
            clearTimeout(retry);
            source.close();

            return set("error", cause.message);
          }
        }

        // EventSource stops retrying after a non-200 response, such as a proxy 502.
        if (
          listening &&
          source === events &&
          retry === undefined &&
          source.readyState === EventSource.CLOSED
        )
          retry = setTimeout(connect, 2000);
      });
    };

    connect();

    return () => {
      listening = false;
      clearTimeout(retry);
      events.close();
    };
  };

  const pop = () => set("sessionId", sessionFromUrl());

  const start = () => {
    try {
      const saved = sessionStorage.getItem("poppet-submission");

      if (saved) {
        const value: Submission = JSON.parse(saved);

        if (value.id && value.text && (value.sessionId === null || value.sessionId))
          set("pending", value);
      }
    } catch {
      set("error", "Could not restore this tab's unsent or unconfirmed message.");
    }

    let closeStream: (() => void) | undefined;
    let streamKey = "";

    const unsubscribeState = $state.subscribe(({ authenticated, sessionId }) => {
      const next = authenticated && sessionId ? `${generation}:${sessionId}` : "";

      if (next === streamKey) return;
      streamKey = next;
      closeStream?.();
      closeStream = undefined;
      set("snapshot", null);
      set("connected", false);
      set("atBottom", true);

      if (authenticated && sessionId) closeStream = stream(sessionId);
    });

    void refresh();

    // Poll only while signed in or still connecting, and never from a hidden tab.
    const polling = setInterval(() => {
      if ($state.get().authenticated !== false && !document.hidden) void refresh();
    }, 5000);

    addEventListener("popstate", pop);

    return () => {
      clearInterval(polling);
      unsubscribeState();
      closeStream?.();
      removeEventListener("popstate", pop);
    };
  };

  return {
    $state,
    deliver,
    login,
    logout,
    forget,
    stop,
    set,
    start,
    refresh,
    navigate,
    send,
  };
};
