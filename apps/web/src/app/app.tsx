/** @jsxImportSource preact */
import { useStore } from "@nanostores/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { ChatHeader } from "../components/chat-header";
import { Composer } from "../components/composer";
import { Login } from "../components/login";
import { Sidebar } from "../components/sidebar";
import { Transcript } from "../components/transcript";
import { createChatStore } from "../stores/chat-store";

export const App = () => {
  const [store] = useState(createChatStore);

  const {
    authenticated,
    key,
    sessions,
    sessionId,
    snapshot,
    drafts,
    pending,
    sending,
    error: actionError,
    refreshError,
    connected,
    sidebar,
    atBottom,
  } = useStore(store.$state);

  const error = actionError || refreshError;

  const composer = useRef<HTMLTextAreaElement>(null);
  const draftKey = sessionId ?? "new";
  const draft = drafts[draftKey] ?? "";
  const active = snapshot?.active ?? null;
  useEffect(() => store.start(), [store]);

  const navigate = (id: string | null) => {
    store.navigate(id);
    composer.current?.focus();
  };

  if (authenticated === null)
    return (
      <main class="grid min-h-dvh place-items-center p-6">
        <p>Connecting to Poppet…</p>
        {error && (
          <>
            <p class="text-[0.85rem] text-error" role="alert">
              {error}
            </p>
            <button onClick={() => store.refresh()}>Try connecting again</button>
          </>
        )}
      </main>
    );

  if (!authenticated)
    return (
      <Login
        accessKey={key}
        sending={sending}
        error={error}
        onAccessKeyChange={(value) => store.set("key", value)}
        onSignIn={() => store.$login.mutate(key)}
      />
    );

  return (
    <div class="flex h-dvh overflow-hidden">
      <Sidebar
        open={sidebar}
        sessions={sessions}
        sessionId={sessionId}
        onClose={() => store.set("sidebar", false)}
        onNavigate={navigate}
        onSignOut={() => store.$logout.mutate()}
      />
      <main class="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          session={snapshot?.session ?? null}
          reconnecting={!!sessionId && !connected}
          onOpenSidebar={() => store.set("sidebar", true)}
        />
        <Transcript
          snapshot={snapshot}
          sessionId={sessionId}
          atBottom={atBottom}
          onAtBottomChange={(value) => store.set("atBottom", value)}
        />
        <Composer
          textareaRef={composer}
          draft={draft}
          active={!!active}
          pending={!!pending}
          sending={sending}
          sendDisabled={sending || !!pending || !draft.trim() || (!!sessionId && !connected)}
          atBottom={atBottom}
          error={error}
          onDraftChange={(value) =>
            store.set("drafts", { ...store.$state.get().drafts, [draftKey]: value })
          }
          onSend={store.send}
          onStop={() => store.$stop.mutate()}
          onRecover={() => {
            if (pending) void store.$delivery.mutate(pending);
          }}
          onForget={() => store.$forget.mutate()}
          onLatest={() => store.set("atBottom", true)}
        />
      </main>
    </div>
  );
};
