/** @jsxImportSource preact */
interface RecoveryNoticeProps {
  readonly sending: boolean;
  readonly onRecover: () => void;
  readonly onForget: () => void;
}

export const RecoveryNotice = ({ sending, onRecover, onForget }: RecoveryNoticeProps) => (
  <div class="mb-[0.7rem] flex items-center gap-[0.7rem] rounded-md bg-surface-raised p-[0.7rem] text-[0.8rem] mobile:flex-col mobile:items-stretch">
    <span>
      Delivery is unconfirmed. Recover to send or check the message without duplicating it.
      Forgetting recovery does not cancel a reply. Check history before resending.
    </span>
    <button class="shrink-0" disabled={sending} onClick={onRecover}>
      Recover submission
    </button>
    <button class="shrink-0" disabled={sending} onClick={onForget}>
      Forget recovery
    </button>
  </div>
);
