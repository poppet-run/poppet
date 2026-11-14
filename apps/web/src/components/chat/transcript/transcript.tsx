/** @jsxImportSource preact */
import { useLayoutEffect, useRef } from "preact/hooks";

import type { ChatSnapshot } from "../../../api/protocol";
import { Message } from "./message";

interface TranscriptProps {
  readonly snapshot: ChatSnapshot | null;
  readonly sessionId: string | null;
  readonly atBottom: boolean;
  readonly onAtBottomChange: (value: boolean) => void;
}

export const Transcript = ({
  snapshot,
  sessionId,
  atBottom,
  onAtBottomChange,
}: TranscriptProps) => {
  const transcript = useRef<HTMLDivElement>(null);
  const active = snapshot?.active ?? null;
  const latest = snapshot?.receipts.at(-1);

  useLayoutEffect(() => {
    if (atBottom && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [snapshot, atBottom]);

  return (
    <div
      class="transcript min-h-0 flex-1 overflow-y-auto overscroll-contain"
      ref={transcript}
      onScroll={(event) => {
        const element = event.currentTarget;
        onAtBottomChange(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
      }}
    >
      <div class="mx-auto max-w-[800px] px-8 pt-6 pb-3 mobile:px-4 mobile:pb-2">
        {!sessionId && (
          <div class="pt-[min(10vh,5rem)]">
            <h2 class="my-[0.65rem] text-xl font-medium tracking-[-0.02em]">How can I help?</h2>
          </div>
        )}
        {snapshot?.messages.map((message) => (
          <Message key={message.id} role={message.role} text={message.text} />
        ))}
        {active && (
          <>
            {!snapshot?.messages.some(
              (message) => message.runId === active.id && message.role === "user",
            ) && <Message role="user" text={active.input} />}
            <Message role="assistant" text={active.text} streaming />
          </>
        )}
        {!active && latest?.error && (
          <p class="text-[0.85rem] text-error" role="status">
            {latest.error}
          </p>
        )}
      </div>
    </div>
  );
};
