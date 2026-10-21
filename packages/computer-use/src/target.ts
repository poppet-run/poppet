import { Context, Schema } from "effect";

export const CalculatorTarget = Schema.Struct({
  pid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
  windowId: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
});

export type CalculatorTarget = typeof CalculatorTarget.Type;

/** This per-request service is supplied by the local CLI, never by model or worker arguments. */
export class ComputerTarget extends Context.Service<ComputerTarget, CalculatorTarget>()(
  "poppet/ComputerTarget",
) {}

export const parseComputerTarget = (text: string) => {
  Schema.decodeUnknownSync(
    Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/)),
  )(text);
  const [pid, windowId] = text.split(":").map(Number);

  return Schema.decodeUnknownSync(CalculatorTarget)({ pid, windowId });
};
