import { escapedApprovalJSON } from "@poppet/agent";
import { ToolReview } from "@poppet/store";
import { Schema } from "effect";

import { fields, time } from "#src/output";

export const ReviewedCall = Schema.Struct({
  runId: Schema.String,
  serverId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  toolName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  arguments: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  failureReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  review: Schema.optionalKey(Schema.NullOr(ToolReview)),
});

export const renderReviewedCall = (call: typeof ReviewedCall.Type) => {
  const { review } = call;

  if (review === null || review === undefined) {
    return [];
  }

  return [
    fields([
      ["Run", call.runId],
      ["Tool", `${call.serverId}/${call.toolName}`],
      ["Arguments", call.arguments === undefined ? "-" : escapedApprovalJSON(call.arguments)],
      ["Review", review.decision],
      ["Reason", escapedApprovalJSON(review.reason)],
      ["Target", review.target === undefined ? "-" : escapedApprovalJSON(review.target)],
      [
        "Expected effects",
        review.effects === undefined ? "-" : escapedApprovalJSON(review.effects),
      ],
      [
        "Approved by",
        review.decision === "allow"
          ? "reviewer"
          : review.approval?.decision === "approved"
            ? `${review.approval.adapter}/${review.approval.senderId}`
            : "-",
      ],
      review.approval === undefined
        ? null
        : [
            "Owner decision",
            `${review.approval.decision} by ${review.approval.adapter}/${review.approval.senderId} at ${time(review.approval.at)}`,
          ],
      ["Outcome", call.status ?? "-"],
      ["Failure", call.failureReason ?? "-"],
    ]),
  ];
};
