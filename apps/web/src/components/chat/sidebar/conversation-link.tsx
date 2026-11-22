/** @jsxImportSource preact */
import type { ChatSession } from "../../../api/protocol";

interface ConversationLinkProps {
  readonly session: ChatSession;
  readonly active: boolean;
  readonly onNavigate: (id: string) => void;
}

export const ConversationLink = ({ session, active, onNavigate }: ConversationLinkProps) => (
  <a
    class="mb-1 block rounded-md px-[0.6rem] py-2 text-inherit no-underline hover:bg-surface-hover aria-[current=page]:bg-surface-hover mobile:min-h-11"
    href={`/chat/${session.id}`}
    aria-current={active ? "page" : undefined}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
        return;
      event.preventDefault();
      onNavigate(session.id);
    }}
  >
    <span class="block truncate text-[0.8125rem]">{session.title ?? "Untitled conversation"}</span>
  </a>
);
