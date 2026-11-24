import * as Schema from "effect/Schema";

/** The file given as v1's database is none this program reads. */
export class V1DatabaseUnusable extends Schema.TaggedError<V1DatabaseUnusable>()(
  "V1DatabaseUnusable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `v1's database ${this.file} cannot be read: ${this.reason}`;
  }
}

/** v1's database is of another version of v1 than the one this program knows. */
export class V1SchemaUnexpected extends Schema.TaggedError<V1SchemaUnexpected>()(
  "V1SchemaUnexpected",
  { file: Schema.String, found: Schema.Number, expected: Schema.Number },
) {
  override get message() {
    return `v1's database ${this.file} is at migration ${this.found}, and this program reads migration ${this.expected}: bring v1 to its last release first`;
  }
}

/** The directory given as a node's store is none. */
export class NodeStoreUnusable extends Schema.TaggedError<NodeStoreUnusable>()(
  "NodeStoreUnusable",
  { dir: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `the node's store ${this.dir} cannot be used: ${this.reason}`;
  }
}

/** The profile of a snapshot or of a session did not get into the node's store. */
export class ProfileNotCopied extends Schema.TaggedError<ProfileNotCopied>()("ProfileNotCopied", {
  of: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `the profile of ${this.of} was not copied: ${this.reason}`;
  }
}

/** The file the secrets of new tokens are written to cannot be written. */
export class SecretsFileUnusable extends Schema.TaggedError<SecretsFileUnusable>()(
  "SecretsFileUnusable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `the secrets file ${this.file} cannot be written: ${this.reason}`;
  }
}

/** Some of what v1 has goes nowhere in v2 as things are, so nothing is moved. */
export class NotMappable extends Schema.TaggedError<NotMappable>()("NotMappable", {
  conflicts: Schema.Number,
}) {
  override get message() {
    return `${this.conflicts} of what v1 has cannot be moved as things are; see the plan`;
  }
}

/** A step of the move did not come about; what was moved before it stays moved. */
export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  what: Schema.String,
  label: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.what} ${this.label} was not moved: ${this.reason}`;
  }
}
