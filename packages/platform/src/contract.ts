import { Data, Schema } from "effect";

/** Lifecycle commands supported by the platform's background-worker manager. */
export const WorkerAction = Schema.Literals([
  "install",
  "start",
  "stop",
  "status",
  "logs",
  "uninstall",
]);

export type WorkerAction = typeof WorkerAction.Type;

/** A failure to install, control, or inspect the platform's background worker. */
export class WorkerError extends Data.TaggedError("WorkerError")<{
  readonly message: string;
}> {}

/** The exact process invocation and environment to preserve in a background-worker installation. */
export interface WorkerLaunch {
  readonly dataDirectory: string;
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly workingDirectory: string;
  readonly environment: ReadonlyMap<string, string>;
}

/** Whether a background-worker service is installed and currently active. */
export interface WorkerStatus {
  readonly installed: boolean;
  readonly active: boolean;
  readonly file: string;
  readonly log: string;
}
