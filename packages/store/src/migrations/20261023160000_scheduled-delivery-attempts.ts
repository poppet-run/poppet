export const scheduledDeliveryAttempts = `
  DROP INDEX scheduled_gateway_result;

  CREATE UNIQUE INDEX scheduled_gateway_result
    ON gateway_inbox (occurrence_id, run_id)
    WHERE occurrence_id IS NOT NULL;
`;
