import * as Data from "effect/Data";

/** A program that was run did not do what it was run for. */
export class ProgramFailed extends Data.TaggedError("ProgramFailed")<{
  readonly program: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.program}: ${this.reason}`;
  }
}

/** A file of the tree is not as this tool reads it. */
export class TreeUnexpected extends Data.TaggedError("TreeUnexpected")<{
  readonly file: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.file}: ${this.reason}`;
  }
}

/** What CI or a release was to get is not there. */
export class Missing extends Data.TaggedError("Missing")<{
  readonly what: string;
}> {
  override get message() {
    return `${this.what} is missing`;
  }
}

/** What was started did not come to answer as its users would have it answer. */
export class SmokeFailed extends Data.TaggedError("SmokeFailed")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}
