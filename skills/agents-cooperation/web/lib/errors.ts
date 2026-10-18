import type { Issue } from "../../scripts/lib/json-schema.ts";

/** Only explicitly safe diagnostics may cross the HTTP boundary. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public issues?: Issue[]) { super(message); }
}
