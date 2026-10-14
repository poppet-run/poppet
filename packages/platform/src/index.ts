import { Data, Schema } from "effect";

export const WorkerAction = Schema.Literals([
  "install",
  "start",
  "stop",
  "status",
  "logs",
  "uninstall",
]);

export type WorkerAction = typeof WorkerAction.Type;

export class WorkerError extends Data.TaggedError("WorkerError")<{
  readonly message: string;
}> {}

export interface WorkerLaunch {
  readonly dataDirectory: string;
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly workingDirectory: string;
  readonly environment: ReadonlyMap<string, string>;
}
