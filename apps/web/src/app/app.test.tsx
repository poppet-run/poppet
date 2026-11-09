/** @jsxImportSource preact */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { JSDOM } from "jsdom";
import { render } from "preact";
import { act } from "preact/test-utils";

import type { ChatSnapshot, Submission } from "../api/protocol";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:8080",
  pretendToBeVisual: true,
});

const globals = {
  window: dom.window,
  document: dom.window.document,
  history: dom.window.history,
  location: dom.window.location,
  sessionStorage: dom.window.sessionStorage,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  addEventListener: dom.window.addEventListener.bind(dom.window),
  removeEventListener: dom.window.removeEventListener.bind(dom.window),
};

const previous = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

beforeAll(() => {
  Object.assign(globalThis, globals);
});

afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }

  dom.window.close();
});

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

test("renders Markdown without executable HTML, tracking images or script URLs", async () => {
  const { Markdown } = await import("../components/chat/transcript/markdown");
  const root = document.createElement("div");
  document.body.append(root);

  try {
    await act(() =>
      render(
        <Markdown
          text={
            '# Hello\n\n**World**\n\n<script>window.hacked=true</script><img src="https://tracker.test/pixel" onerror="alert(1)"><a href="javascript:alert(1)">click</a>'
          }
        />,
        root,
      ),
    );

    expect(root.querySelector("h1")?.textContent).toBe("Hello");
    expect(root.querySelector("strong")?.textContent).toBe("World");
    expect(root.querySelector("script, img, [onerror]")).toBeNull();
    expect(root.querySelector("a")?.getAttribute("href")).toBeNull();
  } finally {
    render(null, root);
    root.remove();
  }
});

test("preserves ambiguous submissions and recovers with the same identifier without auto-resending", async () => {
  const { App } = await import("./app");
  const originalFetch = globalThis.fetch;
  const submissions: Submission[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  sessionStorage.clear();

  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (input === "/api/sessions") return Response.json([]);

    if (input === "/api/submissions" && init?.body) {
      submissions.push(JSON.parse(String(init.body)));
      throw new Error("Connection lost");
    }

    throw new Error("Unexpected request");
  };

  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });

  try {
    await act(async () => {
      render(<App />, root);
      await Promise.resolve();
    });
    await flush();

    const composer = root.querySelector("textarea")!;
    await act(() => {
      composer.value = "Keep this message";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
      );
      await Promise.resolve();
    });
    expect(submissions).toHaveLength(0);
    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    expect(submissions).toHaveLength(1);
    expect(sessionStorage.getItem("poppet-submission")).toContain("Keep this message");
    expect(root.querySelector("textarea")?.value).toBe("Keep this message");
    await act(() => render(null, root));
    await act(async () => {
      render(<App />, root);
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(submissions).toHaveLength(1);

    const recovery = [...root.querySelectorAll("button")].find(
      (button) => button.textContent === "Recover submission",
    )!;

    expect(recovery).toBeDefined();
    await act(async () => {
      recovery.click();
      await Promise.resolve();
    });
    await flush();
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
  } finally {
    render(null, root);
    root.remove();
    globalThis.fetch = originalFetch;
    sessionStorage.clear();
  }
});

test("streaming preserves the reading position and settles into one saved answer", async () => {
  const { Transcript } = await import("../components/chat/transcript/transcript");
  const root = document.createElement("div");
  document.body.append(root);

  const snapshot: ChatSnapshot = {
    session: { id: "session", title: "Test", provider: "test", model: "test", updatedAt: 0 },
    messages: [{ id: 1, runId: "run", role: "user", text: "Hello" }],
    receipts: [],
    active: { id: "run", input: "Hello", text: "" },
  };

  const show = (value: ChatSnapshot, atBottom: boolean) =>
    act(() =>
      render(
        <Transcript
          snapshot={value}
          sessionId="session"
          atBottom={atBottom}
          onAtBottomChange={() => {}}
        />,
        root,
      ),
    );

  try {
    await show(snapshot, false);
    expect(root.textContent).toContain("Thinking…");
    const transcript = root.querySelector<HTMLDivElement>(".transcript")!;
    Object.defineProperty(transcript, "scrollHeight", { value: 400, configurable: true });
    transcript.scrollTop = 40;
    const responding = { ...snapshot, active: { id: "run", input: "Hello", text: "Hi there" } };
    await show(responding, false);
    expect(root.textContent).toContain("Responding…");
    expect(root.textContent).toContain("Hi there");
    expect(root.textContent).not.toContain("Thinking…");
    expect(transcript.scrollTop).toBe(40);
    await show(responding, true);
    expect(transcript.scrollTop).toBe(400);
    await show(
      {
        ...responding,
        active: null,
        messages: [
          ...snapshot.messages,
          { id: 2, runId: "run", role: "assistant", text: "Hi there" },
        ],
      },
      true,
    );
    expect(root.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect(root.textContent).not.toContain("Responding…");
    expect(root.textContent).toContain("Hi there");
  } finally {
    render(null, root);
    root.remove();
  }
});

test("sign-out ignores a late session query and sign-in fetches fresh history", async () => {
  const { createChatStore } = await import("../stores/chat-store");
  const originalFetch = globalThis.fetch;
  let resolveSessions!: (response: Response) => void;
  let requests = 0;

  const fakeFetch = async (input: Parameters<typeof fetch>[0]) => {
    if (input === "/api/sessions") {
      requests++;

      if (requests === 1)
        return new Promise<Response>((resolve) => {
          resolveSessions = resolve;
        });

      return Response.json([
        { id: "fresh", title: "Fresh", provider: "test", model: "test", updatedAt: 0 },
      ]);
    }

    return Response.json({});
  };

  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
  history.replaceState(null, "", "/");
  const store = createChatStore();
  const dispose = store.start();

  try {
    await store.logout();
    resolveSessions(Response.json([{ id: "private", title: "Old history" }]));
    await flush();
    expect(store.$state.get().authenticated).toBe(false);
    expect(store.$state.get().sessions).toEqual([]);
    await store.login("test-key");
    await flush();
    expect(store.$state.get().authenticated).toBe(true);
    expect(store.$state.get().sessions.map((session) => session.id)).toEqual(["fresh"]);
    // A second mutation must work after the first completes.
    await store.logout();
    expect(store.$state.get().authenticated).toBe(false);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
  }
});

test("duplicate sends are throttled and navigation closes streams without stopping a run", async () => {
  const { createChatStore } = await import("../stores/chat-store");
  const originalFetch = globalThis.fetch;
  const originalEvents = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const streams: FakeEvents[] = [];
  let didReconnect!: () => void;

  const reconnected = new Promise<void>((resolve) => {
    didReconnect = resolve;
  });

  class FakeEvents extends dom.window.EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) {
      super();
      streams.push(this);

      if (streams.length === 3) didReconnect();
    }
    close() {
      this.readyState = FakeEvents.CLOSED;
    }
    snapshot(id: string) {
      this.dispatchEvent(
        new dom.window.MessageEvent("message", {
          data: JSON.stringify({ session: { id }, messages: [], receipts: [], active: null }),
        }),
      );
    }
  }

  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEvents });
  let resolveSubmission!: (response: Response) => void;
  const requests: string[] = [];
  const probes: Array<(response: Response) => void> = [];

  const fakeFetch = async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input));

    if (input === "/api/sessions") return Response.json([]);

    if (String(input).startsWith("/api/submissions/"))
      return Response.json({ sessionId: "second", status: "accepted", error: null });

    if (input === "/api/sessions/second")
      return new Promise<Response>((resolve) => probes.push(resolve));

    if (input === "/api/submissions")
      return new Promise<Response>((resolve) => {
        resolveSubmission = resolve;
      });
    throw new Error(`Unexpected request ${input}`);
  };

  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
  history.replaceState(null, "", "/");
  sessionStorage.clear();
  const store = createChatStore();
  const dispose = store.start();

  try {
    await flush();
    store.set("drafts", { new: "Hello" });
    store.send();
    store.send();
    expect(requests.filter((path) => path === "/api/submissions")).toHaveLength(1);
    // A draft edited while delivery is pending must survive acknowledgement.
    store.set("drafts", { new: "Next message" });
    resolveSubmission(Response.json({ sessionId: "first" }));
    await flush();
    expect(store.$state.get().pending).toBeNull();
    expect(store.$state.get().drafts.new).toBe("Next message");
    expect(sessionStorage.getItem("poppet-submission")).toBeNull();
    streams[0]!.snapshot("first");
    expect(store.$state.get().connected).toBe(true);
    store.navigate("second");
    expect(streams[0]!.readyState).toBe(FakeEvents.CLOSED);
    streams[0]!.snapshot("first");
    expect(store.$state.get().snapshot).toBeNull();
    streams[1]!.snapshot("second");
    expect(store.$state.get().snapshot?.session.id).toBe("second");
    store.set("pending", {
      id: crypto.randomUUID(),
      sessionId: "second",
      text: "Already accepted",
    });
    await store.forget();
    expect(store.$state.get().pending).toBeNull();
    expect(store.$state.get().sessionId).toBe("second");
    expect(requests.filter((path) => path === "/api/submissions")).toHaveLength(1);
    streams[1]!.readyState = 0;
    streams[1]!.dispatchEvent(new dom.window.Event("error"));
    streams[1]!.readyState = FakeEvents.CLOSED;
    streams[1]!.dispatchEvent(new dom.window.Event("error"));
    expect(probes).toHaveLength(2);
    probes[0]!(Response.json({}));
    probes[1]!(Response.json({}));
    await reconnected;
    await flush();
    expect(streams).toHaveLength(3);
    streams[1]!.snapshot("stale");
    expect(store.$state.get().snapshot?.session.id).toBe("second");
    streams[2]!.snapshot("second");
    expect(store.$state.get().connected).toBe(true);
    dispose();
    expect(streams[2]!.readyState).toBe(FakeEvents.CLOSED);
    expect(requests.some((path) => path.endsWith("/stop"))).toBe(false);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;

    if (originalEvents) Object.defineProperty(globalThis, "EventSource", originalEvents);
    else Reflect.deleteProperty(globalThis, "EventSource");
    history.replaceState(null, "", "/");
    sessionStorage.clear();
  }
});

test("submission rejection and explicit recovery forgetting unlock the composer safely", async () => {
  const { createChatStore } = await import("../stores/chat-store");
  const originalFetch = globalThis.fetch;
  let status = 403;
  let receiptStatus = 500;
  const submission = { id: crypto.randomUUID(), sessionId: null, text: "Keep my draft" };

  const fakeFetch = async (input: Parameters<typeof fetch>[0]) => {
    if (input === "/api/sessions") return Response.json([]);

    return Response.json(
      { message: "Unavailable" },
      { status: input === "/api/submissions" ? status : receiptStatus },
    );
  };

  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
  const store = createChatStore();
  const dispose = store.start();

  try {
    await flush();
    store.set("drafts", { new: submission.text });
    await store.deliver(submission);
    expect(store.$state.get().pending).toBeNull();
    expect(sessionStorage.getItem("poppet-submission")).toBeNull();
    status = 500;
    await store.deliver(submission);
    expect(store.$state.get().pending).toEqual(submission);
    await store.forget();
    expect(store.$state.get().pending).toEqual(submission);
    receiptStatus = 404;
    await store.forget();
    expect(store.$state.get().pending).toBeNull();
    expect(store.$state.get().drafts.new).toBe(submission.text);
    expect(store.$state.get().error).toContain("The message may still arrive");
    expect(sessionStorage.getItem("poppet-submission")).toBeNull();
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    sessionStorage.clear();
  }
});

test("successful polling clears only refresh errors and expired sign-out clears local access", async () => {
  const { createChatStore } = await import("../stores/chat-store");
  const originalFetch = globalThis.fetch;
  let failRefresh = true;

  const fakeFetch = async (input: Parameters<typeof fetch>[0]) => {
    if (input === "/api/logout") return Response.json({ message: "Sign in" }, { status: 401 });

    if (failRefresh) return Response.json({ message: "Offline" }, { status: 502 });

    return Response.json([]);
  };

  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
  const store = createChatStore();
  const dispose = store.start();

  try {
    await flush();
    expect(store.$state.get().refreshError).toBe("Offline");
    store.set("error", "A submission failed");
    failRefresh = false;
    store.refresh();
    await flush();
    expect(store.$state.get().refreshError).toBe("");
    expect(store.$state.get().error).toBe("A submission failed");
    expect(store.$state.get().authenticated).toBe(true);
    store.set("drafts", { new: "Private draft" });
    await store.logout();
    expect(store.$state.get().authenticated).toBe(false);
    expect(store.$state.get().drafts).toEqual({});
    expect(store.$state.get().sessions).toEqual([]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
  }
});
