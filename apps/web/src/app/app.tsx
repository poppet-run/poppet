/** @jsxImportSource preact */
import { useStore } from "@nanostores/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { Connecting } from "../components/auth/connecting";
import { Login } from "../components/auth/login";
import { ChatHeader } from "../components/chat/chat-header";
import { Composer } from "../components/chat/composer/composer";
import { Sidebar } from "../components/chat/sidebar/sidebar";
import { Transcript } from "../components/chat/transcript/transcript";
import { createChatStore } from "../stores/chat-store";

export const App = () => {
  const [store] = useState(createChatStore);

  const {
    authenticated,
    key,
    sessions,
    source,
    gateways,
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

  const waiting =
    !active && snapshot?.receipts.some((receipt) => receipt.status === "accepted") === true;

  useEffect(() => store.start(), [store]);

  const navigate = (id: string | null) => {
    store.navigate(id);
    composer.current?.focus();
  };

  if (authenticated === null) {
    return <Connecting error={error} onRetry={store.refresh} />;
  }

  if (!authenticated) {
    return (
      <Login
        accessKey={key}
        sending={sending}
        error={error}
        onAccessKeyChange={(value) => store.set("key", value)}
        onSignIn={() => store.login(key)}
      />
    );
  }

  return (
    <div class="flex h-dvh overflow-hidden">
      <Sidebar
        open={sidebar}
        sessions={sessions}
        source={source}
        gateways={gateways}
        onFilter={store.filterSessions}
        sessionId={sessionId}
        onClose={() => store.set("sidebar", false)}
        onNavigate={navigate}
        onSignOut={store.logout}
      />
      <main class="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          session={snapshot?.session ?? null}
          reconnecting={!!sessionId && !connected}
          deletable={connected && !active && !waiting}
          onOpenSidebar={() => store.set("sidebar", true)}
          onDelete={store.remove}
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
          waiting={waiting}
          active={!!active}
          pending={!!pending}
          sending={sending}
          sendDisabled={
            waiting || sending || !!pending || !draft.trim() || (!!sessionId && !connected)
          }
          atBottom={atBottom}
          error={error}
          onDraftChange={(value) =>
            store.set("drafts", { ...store.$state.get().drafts, [draftKey]: value })
          }
          onSend={store.send}
          onStop={store.stop}
          onRecover={() => {
            if (pending) {
              void store.deliver(pending);
            }
          }}
          onForget={store.forget}
          onLatest={() => store.set("atBottom", true)}
        />
      </main>
    </div>
  );
};
