/** @jsxImportSource preact */
import type { ChatSession } from "../api/protocol";

interface ChatHeaderProps {
  readonly session: ChatSession | null;
  readonly reconnecting: boolean;
  readonly onOpenSidebar: () => void;
}

export const ChatHeader = ({ session, reconnecting, onOpenSidebar }: ChatHeaderProps) => (
  <header class="flex min-h-[60px] items-center gap-4 border-b border-line px-5 py-[0.65rem] mobile:gap-[0.65rem] mobile:p-[0.8rem]">
    <button class="hidden mobile:block" aria-label="Open conversations" onClick={onOpenSidebar}>
      ☰
    </button>
    <div class="min-w-0 flex-1">
      <h1 class="m-0 truncate text-sm font-semibold">{session?.title ?? "New conversation"}</h1>
      <p class="mt-[0.15rem] text-xs wrap-anywhere text-muted">
        {session
          ? `${session.provider} · ${session.model}`
          : "Uses your configured provider and model"}
      </p>
    </div>
    {reconnecting && (
      <span class="text-xs text-muted" role="status">
        Reconnecting…
      </span>
    )}
  </header>
);
