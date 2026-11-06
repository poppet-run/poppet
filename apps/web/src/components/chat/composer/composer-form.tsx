/** @jsxImportSource preact */
import type { RefObject } from "preact";

interface ComposerFormProps {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly active: boolean;
  readonly sendDisabled: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
}

export const ComposerForm = ({
  textareaRef,
  draft,
  active,
  sendDisabled,
  onDraftChange,
  onSend,
  onStop,
}: ComposerFormProps) => (
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
);
