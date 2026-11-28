/** @jsxImportSource preact */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { JSDOM } from "jsdom";
import { render } from "preact";
import { act } from "preact/test-utils";

import type { ChatSession, ChatSnapshot, Submission } from "../api/protocol";

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
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }

  dom.window.close();
});

const chatSession = (id: string): ChatSession => ({
  id,
  title: id,
  provider: "test",
  model: "test",
  updatedAt: 0,
});

const sessionList = (
  sessions: ReadonlyArray<ChatSession> = [],
  gateways: ReadonlyArray<string> = [],
) => Response.json({ sessions, gateways });

const flush = () =>
  act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });

test("when Markdown contains links and interactive HTML, shows plain text until the renderer loads, then renders safe links and removes controls", async () => {
  const { Markdown } = await import("../components/chat/transcript/markdown");
  const root = document.createElement("div");
  document.body.append(root);

  const text = [
    "# Hello",
    "**World**",
    '<script>window.hacked=true</script><img src="https://tracker.test/pixel" onerror="alert(1)"><a href="javascript:alert(1)">raw</a>',
    '<textarea>spoof</textarea><fieldset><label>Choose<select><option>One</option></select></label></fieldset><dialog open>Message</dialog><meter value="1"></meter><progress></progress>',
    '<div style="position:fixed" onclick="alert(1)">block</div>',
    'Line<br>break and <b onclick="alert(1)">bold</b> and <kbd>K</kbd>',
    "[Read more](https://example.com) [mail](mailto:hi@example.com) [here](/chat/abc)",
    "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](<java\tscript:alert(1)>) [d](data:text/html,<script>x</script>) [e](vbscript:x)",
    String.raw`<javascript:alert(1)> [f](https://example.com "t\" onmouseover=\"alert(1)")`,
    "![pixel](https://tracker.test/pixel.png)",
    "- [x] done\n- [ ] todo",
    "| a | b |\n|:-|-:|\n| 1 | 2 |",
    '```js\nconst x = "<script>";\n```',
  ].join("\n\n");

  try {
    render(<Markdown text={text} />, root);
    expect(root.querySelector(".whitespace-pre-wrap")?.textContent).toBe(text);

    for (let attempt = 0; attempt < 50 && !root.querySelector(".markdown"); attempt++) {
      await flush();
    }

    expect(root.querySelector("h1")?.textContent).toBe("Hello");
    expect(root.querySelector("strong")?.textContent).toBe("World");
    expect(root.querySelector("br")).not.toBeNull();
    expect(root.querySelector("kbd")?.textContent).toBe("K");
    expect(root.querySelector("td")?.textContent).toBe("1");
    expect(root.querySelector("code")?.textContent).toContain('"<script>"');
    expect(root.textContent).toContain("<script>window.hacked=true</script>");
    expect(root.textContent).toContain("pixel");

    expect([...root.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com",
      "mailto:hi@example.com",
      "/chat/abc",
      "https://example.com",
    ]);

    for (const link of root.querySelectorAll("a")) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }

    const allowedTags = new Set(
      "h1 p strong em br b kbd a ul li table thead tbody tr th td pre code".split(" "),
    );

    const allowedAttributes = new Set(["href", "title", "target", "rel", "align", "class"]);

    for (const element of root.querySelectorAll(".markdown *")) {
      expect(allowedTags).toContain(element.tagName.toLowerCase());

      for (const attribute of element.getAttributeNames()) {
        expect(allowedAttributes).toContain(attribute);
      }
    }
  } finally {
    render(null, root);
    root.remove();
  }
});

test("when a conversation link is clicked with a modifier or a nonprimary button, leaves navigation to the browser", async () => {
  const { ConversationLink } = await import("../components/chat/sidebar/conversation-link");
  const root = document.createElement("div");
  const navigated: Array<string> = [];

  try {
    render(
      <ConversationLink
        session={{
          id: "saved",
          title: "Saved",
          provider: "provider",
          model: "model",
          updatedAt: 0,
        }}
        active={false}
        onNavigate={(id) => navigated.push(id)}
      />,
      root,
    );

    const link = root.querySelector("a")!;
    const intercepted: Array<boolean> = [];
    link.addEventListener("click", (event) => {
      intercepted.push(event.defaultPrevented);
      event.preventDefault();
    });

    for (const options of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = new dom.window.MouseEvent("click", { cancelable: true, ...options });
      link.dispatchEvent(event);
    }

    expect(navigated).toEqual([]);
    const primary = new dom.window.MouseEvent("click", { cancelable: true });
    link.dispatchEvent(primary);
    expect(intercepted).toEqual([false, false, false, false, false, true]);
    expect(navigated).toEqual(["saved"]);
  } finally {
    render(null, root);
  }
});

test("preserves ambiguous submissions and recovers with the same identifier without auto-resending", async () => {
  const { App } = await import("./app");
  const originalFetch = globalThis.fetch;
  const submissions: Array<Submission> = [];
  const root = document.createElement("div");
  document.body.append(root);
  sessionStorage.clear();

  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (input === "/api/session-list?source=chat") {
      return sessionList();
    }

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

test("when switching sidebar filters, keeps the open chat and ignores late results", async () => {
  const { App } = await import("./app");
  const root = document.createElement("div");
  const originalFetch = globalThis.fetch;
  const originalEvents = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  history.replaceState(null, "", "/chat/direct");
  const streams: Array<string> = [];

  class FakeEvents extends dom.window.EventTarget {
    constructor(url: string) {
      super();
      streams.push(url);
    }
    close() {}
  }

  let finishTasks!: (response: Response) => void;

  const fakeFetch = async (input: Parameters<typeof fetch>[0]) => {
    if (input === "/api/session-list?source=scheduled") {
      return new Promise<Response>((resolve) => {
        finishTasks = resolve;
      });
    }

    if (input === "/api/session-list?source=gateway%3Aslack") {
      return sessionList([chatSession("Slack thread")], ["slack"]);
    }

    if (input === "/api/session-list?source=chat") {
      return sessionList([chatSession("direct")], ["slack"]);
    }

    throw new Error("Unexpected session list request");
  };

  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEvents });
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });

  try {
    await act(() => render(<App />, root));
    await flush();
    const select = root.querySelector("select")!;
    expect(select.value).toBe("chat");
    expect([...select.options].map((option) => option.text)).toEqual([
      "Chats",
      "Scheduled tasks",
      "Slack",
      "All sessions",
    ]);
    const composer = root.querySelector("textarea")!;
    await act(() => {
      composer.value = "Draft for direct";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const choose = (value: string) =>
      act(() => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });

    await choose("scheduled");
    await choose("gateway:slack");
    await flush();
    finishTasks(sessionList([chatSession("Late task")], ["slack"]));
    await flush();
    expect(root.querySelector("nav")?.textContent).toBe("Slack thread");
    expect(location.pathname).toBe("/chat/direct");
    expect(composer.value).toBe("Draft for direct");
    expect(streams).toEqual(["/api/sessions/direct/events"]);

    const newChat = [...root.querySelectorAll("button")].find(
      (button) => button.textContent === "+ New conversation",
    )!;

    await act(() => newChat.click());
    await flush();
    expect(select.value).toBe("chat");
    expect(location.pathname).toBe("/");
    expect(root.querySelector("nav")?.textContent).toBe("direct");
  } finally {
    render(null, root);
    globalThis.fetch = originalFetch;

    if (originalEvents) {
      Object.defineProperty(globalThis, "EventSource", originalEvents);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }

    history.replaceState(null, "", "/");
  }
});

test("sign-out ignores a late session query and sign-in fetches fresh history", async () => {
  const { createChatStore } = await import("../stores/chat-store");
  const originalFetch = globalThis.fetch;
  let resolveSessions!: (response: Response) => void;
  let requests = 0;

  const fakeFetch = async (input: Parameters<typeof fetch>[0]) => {
    if (input === "/api/session-list?source=chat") {
      requests++;

      if (requests === 1) {
        return new Promise<Response>((resolve) => {
          resolveSessions = resolve;
        });
      }

      return sessionList([
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
    resolveSessions(
      sessionList([
        { id: "private", title: "Old history", provider: "test", model: "test", updatedAt: 0 },
      ]),
    );
    await flush();
    expect(store.$state.get().authenticated).toBe(false);
    expect(store.$state.get().sessions).toEqual([]);
    await store.login("test-key");
    await flush();
    expect(store.$state.get().authenticated).toBe(true);
    expect(store.$state.get().sessions.map((session) => session.id)).toEqual(["fresh"]);
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
  const streams: Array<FakeEvents> = [];
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

      if (streams.length === 3) {
        didReconnect();
      }
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
  const requests: Array<string> = [];
  const probes: Array<(response: Response) => void> = [];

  const fakeFetch = async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input));

    if (input === "/api/session-list?source=chat") {
      return sessionList();
    }

    if (String(input).startsWith("/api/submissions/")) {
      return Response.json({ sessionId: "second", status: "accepted", error: null });
    }

    if (input === "/api/sessions/second") {
      return new Promise<Response>((resolve) => {
        probes.push(resolve);
      });
    }

    if (input === "/api/submissions") {
      return new Promise<Response>((resolve) => {
        resolveSubmission = resolve;
      });
    }

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

    if (originalEvents) {
      Object.defineProperty(globalThis, "EventSource", originalEvents);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }

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
    if (input === "/api/session-list?source=chat") {
      return sessionList();
    }

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

test("when signing out during a send, clears the message, unlocks sign-in, and keeps a later send locked", async () => {
  const { createChatStore } = await import("../stores/chat-store");
  const originalFetch = globalThis.fetch;
  const submits: Array<(response: Response) => void> = [];

  const fakeFetch = async (input: Parameters<typeof fetch>[0]) => {
    if (input === "/api/submissions") {
      return new Promise<Response>((resolve) => {
        submits.push(resolve);
      });
    }

    return input === "/api/session-list?source=chat" ? sessionList() : Response.json({});
  };

  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
  history.replaceState(null, "", "/");
  sessionStorage.clear();
  const store = createChatStore();
  const dispose = store.start();

  try {
    await flush();
    void store.deliver({ id: "first", sessionId: null, text: "Private message" });
    await flush();
    await store.logout();
    expect(store.$state.get()).toMatchObject({ sending: false, pending: null });
    expect(sessionStorage.getItem("poppet-submission")).toBeNull();

    await store.login("test-key");
    void store.deliver({ id: "second", sessionId: null, text: "Next message" });
    await flush();
    submits[0]?.(
      Response.json({ id: "first", sessionId: "chat", status: "accepted", error: null }),
    );
    await flush();
    expect(store.$state.get()).toMatchObject({ sending: true, pending: { id: "second" } });
    submits[1]?.(Response.json({ message: "Busy" }, { status: 409 }));
    await flush();
    expect(store.$state.get()).toMatchObject({ sending: false, pending: null });
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
    if (input === "/api/logout") {
      return Response.json({ message: "Sign in" }, { status: 401 });
    }

    if (failRefresh) {
      return Response.json({ message: "Offline" }, { status: 502 });
    }

    return sessionList();
  };

  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
  const store = createChatStore();
  const dispose = store.start();

  try {
    await flush();
    expect(store.$state.get().refreshError).toBe("Offline");
    store.set("error", "A submission failed");
    failRefresh = false;
    await store.refresh();
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

test("deleting a conversation asks first, keeps it on refusal and leaves it after success", async () => {
  const { createChatStore } = await import("../stores/chat-store");
  const originalFetch = globalThis.fetch;
  const originalEvents = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const originalConfirm = Object.getOwnPropertyDescriptor(globalThis, "confirm");
  const streams: Array<FakeEvents> = [];
  const deletes: Array<string> = [];
  const answers = [false, true, true];
  let deleteStatus = 409;

  class FakeEvents extends dom.window.EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) {
      super();
      streams.push(this);
    }
    close() {
      this.readyState = FakeEvents.CLOSED;
    }
  }

  const session = { id: "old", title: "Old plans", provider: "test", model: "test", updatedAt: 0 };

  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (init?.method === "DELETE") {
      deletes.push(String(input));

      return Response.json({ message: "Stop the current reply first." }, { status: deleteStatus });
    }

    if (input === "/api/session-list?source=chat") {
      return sessionList(deleteStatus === 200 ? [] : [session]);
    }

    throw new Error(`Unexpected request ${input}`);
  };

  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEvents });
  Object.defineProperty(globalThis, "confirm", {
    configurable: true,
    value: () => answers.shift(),
  });
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
  history.replaceState(null, "", "/chat/old");
  const store = createChatStore();
  const dispose = store.start();

  try {
    await flush();
    store.set("drafts", { old: "Unsent", new: "Other" });
    streams[0]!.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: JSON.stringify({ session, messages: [], receipts: [], active: null }),
      }),
    );

    await store.remove();
    expect(deletes).toEqual([]);

    await store.remove();
    expect(deletes).toEqual(["/api/sessions/old"]);
    expect(store.$state.get().sessionId).toBe("old");
    expect(store.$state.get().error).toBe("Stop the current reply first.");

    deleteStatus = 200;
    await store.remove();
    await flush();
    expect(deletes).toHaveLength(2);
    expect(location.pathname).toBe("/");
    expect(store.$state.get()).toMatchObject({
      sessionId: null,
      sessions: [],
      drafts: { new: "Other" },
      error: "",
    });
    expect(streams[0]!.readyState).toBe(FakeEvents.CLOSED);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;

    for (const [key, descriptor] of [
      ["EventSource", originalEvents],
      ["confirm", originalConfirm],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }

    history.replaceState(null, "", "/");
  }
});

test("when navigating to the current session, avoids duplicate history entries and unauthenticates on 401 stop", async () => {
  const { createChatStore } = await import("../stores/chat-store");
  const originalFetch = globalThis.fetch;
  const originalEvents = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const streams: Array<FakeEvents> = [];

  class FakeEvents extends dom.window.EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) {
      super();
      streams.push(this);
    }
    close() {
      this.readyState = FakeEvents.CLOSED;
    }
  }

  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEvents });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      if (input === "/api/session-list?source=chat") {
        return sessionList();
      }

      if (String(input).endsWith("/stop")) {
        return Response.json({ message: "Sign in" }, { status: 401 });
      }

      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
  history.replaceState(null, "", "/chat/same");
  const store = createChatStore();
  const dispose = store.start();

  try {
    await flush();
    const before = history.length;
    store.navigate("same");
    expect(history.length).toBe(before);

    streams[0]!.dispatchEvent(new dom.window.MessageEvent("message", { data: "{bad json" }));
    expect(store.$state.get().connected).toBe(false);

    await store.stop();
    expect(store.$state.get().authenticated).toBe(false);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;

    if (originalEvents) {
      Object.defineProperty(globalThis, "EventSource", originalEvents);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }

    history.replaceState(null, "", "/");
  }
});

test("when a pending approval is expanded and denied, shows the command and refreshes the inbox", async () => {
  const { ApprovalInbox } = await import("../components/chat/sidebar/approval-inbox");
  const root = document.createElement("div");
  const originalFetch = globalThis.fetch;
  const prototype = dom.window.HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value() {} });
  const decisions: Array<string> = [];

  const item = {
    conversation: "discord:thread",
    action: "restart service",
    expiresAt: Date.now() + 60_000,
    card: {
      id: "request",
      title: "Bash approval required",
      summary: "Restart the service",
      codeBlock: { label: "Command", content: "restart service" },
      fields: [],
      state: "pending",
      actor: null,
    },
  };

  const fakeFetch = async (path: RequestInfo | URL, init?: RequestInit) => {
    if (path === "/api/approvals/request" && init?.method === "POST") {
      decisions.push(String(init.body));

      return Response.json({ state: "denied" });
    }

    if (path === "/api/approvals") {
      return Response.json(decisions.length ? [] : [item]);
    }

    throw new Error("Unexpected request");
  };

  globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });

  try {
    await act(() => render(<ApprovalInbox onClose={() => {}} />, root));
    await flush();
    const details = root.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("discord:thread");
    details.open = true;
    expect(details.querySelector("code")?.textContent).toBe("restart service");
    await act(() => {
      [...details.querySelectorAll("button")]
        .find((button) => button.textContent === "Deny")!
        .click();
    });

    for (let attempt = 0; attempt < 50 && root.querySelector("details"); attempt++) {
      await flush();
    }

    expect(decisions).toEqual([JSON.stringify({ decision: "denied" })]);
    expect(root.textContent).toContain("No pending approvals.");
  } finally {
    render(null, root);
    globalThis.fetch = originalFetch;

    if (showModal) {
      Object.defineProperty(prototype, "showModal", showModal);
    } else {
      Reflect.deleteProperty(prototype, "showModal");
    }
  }
});
