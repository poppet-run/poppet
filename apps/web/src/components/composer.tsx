/** @jsxImportSource preact */
import type { RefObject } from "preact";

interface ComposerProps {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly active: boolean;
  readonly pending: boolean;
  readonly sending: boolean;
  readonly sendDisabled: boolean;
  readonly atBottom: boolean;
  readonly error: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onForget: () => void;
  readonly onRecover: () => void;
  readonly onLatest: () => void;
}

export const Composer = ({
  textareaRef,
  draft,
  active,
  pending,
  sending,
  sendDisabled,
  atBottom,
  error,
  onDraftChange,
  onSend,
  onStop,
  onRecover,
  onForget,
  onLatest,
}: ComposerProps) => (
  <div class="w-full max-w-[800px] self-center px-8 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] mobile:px-[0.7rem]">
    {!atBottom && (
      <button class="mx-auto mb-[0.6rem] block" onClick={onLatest}>
        ↓ Latest messages
      </button>
    )}
    {error && (
      <p class="text-[0.85rem] text-error" role="alert">
        {error}
      </p>
    )}
    {pending && (
      <div class="mb-[0.7rem] flex items-center gap-[0.7rem] rounded-md bg-surface-raised p-[0.7rem] text-[0.8rem] mobile:flex-col mobile:items-stretch">
        <span>
          Delivery needs confirmation. Recover without creating a duplicate, or forget recovery.
          Forgetting does not cancel a reply; check history before resending.
        </span>
        <button class="shrink-0" disabled={sending} onClick={onRecover}>
          Recover submission
        </button>
        <button class="shrink-0" disabled={sending} onClick={onForget}>
          Forget recovery
        </button>
      </div>
    )}
    <form
      class="rounded-lg border border-control-border bg-surface p-[0.6rem] focus-within:border-accent"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        class="min-h-11 max-h-[30dvh] w-full resize-y border-0 bg-transparent p-1 text-inherit outline-none placeholder:text-muted placeholder:opacity-100 focus-visible:outline-none mobile:text-base"
        ref={textareaRef}
        aria-label="Message Poppet"
        placeholder="Message Poppet…"
        value={draft}
        rows={2}
        maxLength={32768}
        onInput={(event) => onDraftChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div class="flex items-center justify-between gap-[0.8rem]">
        <small class="text-[0.7rem] text-muted">
          {active ? "Draft your next message…" : "Enter to send · Shift+Enter for a new line"}
        </small>
        {active ? (
          <button type="button" onClick={onStop}>
            Stop reply
          </button>
        ) : (
          <button
            class="border-transparent bg-accent font-[650] text-navy hover:bg-accent-hover"
            type="submit"
            disabled={sendDisabled}
          >
            Send ↑
          </button>
        )}
      </div>
    </form>
  </div>
);
