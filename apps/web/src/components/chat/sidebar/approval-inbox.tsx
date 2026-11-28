/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";

import { api } from "../../../api/client";
import type { InboxApproval } from "../../../api/protocol";
import { ApprovalCard } from "../transcript/approval-card";

export const ApprovalInbox = ({ onClose }: { onClose: () => void }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<ReadonlyArray<InboxApproval> | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;

    const refresh = async () => {
      try {
        const pending = await api.approvals();

        if (!closed) {
          setItems(pending);
          setError("");
        }
      } catch (cause) {
        if (!closed) {
          setError(cause instanceof Error ? cause.message : "Could not load approvals.");
        }
      } finally {
        if (!closed) {
          timer = setTimeout(() => {
            void refresh();
          }, 5000);
        }
      }
    };

    void refresh();

    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [revision]);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="inbox-title"
      class="m-auto max-h-[85dvh] w-[min(95vw,42rem)] rounded-lg border border-line bg-surface-recessed p-5 text-cream backdrop:bg-navy/80"
    >
      <header class="mb-4 flex items-center justify-between">
        <h2 id="inbox-title" class="text-lg font-semibold">
          Needs you
        </h2>
        <button type="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!error && !items?.length && (
        <p role="status">{items ? "No pending approvals." : "Loading approvals…"}</p>
      )}
      {items?.map((item) => (
        <details key={item.card.id} class="mb-2 rounded-md border border-line p-3">
          <summary class="cursor-pointer wrap-anywhere">
            <span class="font-medium">{item.conversation}</span>
            <span class="block truncate">{item.action}</span>
            <small class="text-muted">Expires {new Date(item.expiresAt).toLocaleString()}</small>
          </summary>
          <ApprovalCard approval={item.card} onDecided={() => setRevision((value) => value + 1)} />
        </details>
      ))}
    </dialog>
  );
};
