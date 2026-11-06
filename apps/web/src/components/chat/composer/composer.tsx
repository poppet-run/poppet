/** @jsxImportSource preact */
import type { RefObject } from "preact";

import { ComposerForm } from "./composer-form";
import { RecoveryNotice } from "./recovery-notice";

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
    {pending && <RecoveryNotice sending={sending} onRecover={onRecover} onForget={onForget} />}
    <ComposerForm
      textareaRef={textareaRef}
      draft={draft}
      active={active}
      sendDisabled={sendDisabled}
      onDraftChange={onDraftChange}
      onSend={onSend}
      onStop={onStop}
    />
  </div>
);
