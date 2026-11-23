/** @jsxImportSource preact */
import type { ChatSession } from "../../../api/protocol";
import { Wordmark } from "../../shared/wordmark";
import { ConversationLink } from "./conversation-link";

interface SidebarProps {
  readonly open: boolean;
  readonly source: string;
  readonly gateways: ReadonlyArray<string>;
  readonly onFilter: (source: string) => void;
  readonly sessions: ReadonlyArray<ChatSession>;
  readonly sessionId: string | null;
  readonly onClose: () => void;
  readonly onNavigate: (id: string | null) => void;
  readonly onSignOut: () => void;
}

export const Sidebar = ({
  open,
  source,
  gateways,
  onFilter,
  sessions,
  sessionId,
  onClose,
  onNavigate,
  onSignOut,
}: SidebarProps) => (
  <>
    {open && (
      <button
        type="button"
        class="fixed inset-0 z-2 hidden rounded-none border-0 bg-navy/80 mobile:block"
        aria-label="Close conversations"
        onClick={onClose}
      />
    )}
    <aside
      class={`flex w-[232px] shrink-0 flex-col gap-3 border-r border-line bg-surface-recessed px-3 py-4 mobile:fixed mobile:inset-y-0 mobile:left-0 mobile:z-3 mobile:w-[min(85vw,300px)] ${open ? "mobile:translate-x-0" : "mobile:-translate-x-full"}`}
      aria-label="Conversations"
    >
      <Wordmark />
      <button
        type="button"
        class="bg-transparent text-left hover:bg-surface-hover"
        onClick={() => {
          onFilter("chat");
          onNavigate(null);
        }}
      >
        + New conversation
      </button>
      <label class="flex items-center gap-2 px-1 text-muted">
        Show
        <select
          class="min-w-0 flex-1 rounded-md border border-line bg-surface-raised px-2 py-1 text-cream mobile:min-h-11"
          value={source}
          onChange={(event) => onFilter(event.currentTarget.value)}
        >
          <option value="chat">Chats</option>
          <option value="scheduled">Scheduled tasks</option>
          {gateways.map((gateway) => (
            <option key={gateway} value={`gateway:${gateway}`}>
              {gateway.charAt(0).toUpperCase() + gateway.slice(1)}
            </option>
          ))}
          <option value="all">All sessions</option>
        </select>
      </label>
      <nav class="min-h-0 flex-1 overflow-y-auto">
        {sessions.map((session) => (
          <ConversationLink
            key={session.id}
            session={session}
            active={session.id === sessionId}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
      <button
        type="button"
        class="border-transparent bg-transparent text-muted hover:bg-surface-hover"
        onClick={onSignOut}
      >
        Sign out
      </button>
    </aside>
  </>
);
