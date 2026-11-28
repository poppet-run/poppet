/** @jsxImportSource preact */
import { useState } from "preact/hooks";

import { api } from "../../../api/client";
import type { ChatApproval } from "../../../api/protocol";

export const ApprovalCard = ({
  approval,
  onDecided,
}: {
  approval: ChatApproval;
  onDecided?: () => void;
}) => {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const decide = async (decision: "approved" | "denied") => {
    setSending(true);
    setError("");

    try {
      await api.decide(approval.id, decision);
      onDecided?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save decision.");
    } finally {
      setSending(false);
    }
  };

  return (
    <article class="mb-7 rounded-lg border border-control-border bg-surface p-4 wrap-anywhere">
      <h3 class="font-medium">{approval.title}</h3>
      <p>Reason: {approval.summary}</p>
      {approval.codeBlock && (
        <>
          <strong>{approval.codeBlock.label}</strong>
          <pre class="overflow-auto">
            <code>{approval.codeBlock.content}</code>
          </pre>
        </>
      )}
      {approval.fields.map((field) => (
        <div key={field.label}>
          <strong>{field.label}</strong> {field.value}
        </div>
      ))}
      {approval.args?.map((arg) => (
        <div key={arg.key}>
          {arg.key} <code>{arg.value}</code>
        </div>
      ))}
      {approval.details && (
        <details>
          <summary>Full request</summary>
          <pre class="overflow-auto">{approval.details}</pre>
        </details>
      )}
      {approval.state === "pending" ? (
        <div class="mt-3 flex gap-2">
          <button type="button" disabled={sending} onClick={() => decide("approved")}>
            Approve once
          </button>
          <button type="button" disabled={sending} onClick={() => decide("denied")}>
            Deny
          </button>
        </div>
      ) : (
        <p role="status">
          {approval.state === "approved"
            ? "Approved once"
            : approval.state[0]?.toUpperCase() + approval.state.slice(1)}
          {approval.actor && ` by ${approval.actor}`}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
};
