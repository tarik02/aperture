import type { Offers } from "@aperture-browser/control-api";
import type { LimitsInit, proto } from "@aperture-browser/executor-client";
import type { Effective } from "./service.ts";

/** A setting as a limit is given: left out for each node's own, zero for none. */
const given = (setting: Effective[keyof Effective]) =>
  setting.source === "node" ? undefined : Number(setting.value ?? 0);

/**
 * The limits a session's node holds it to, as its settings come to: what no level says is
 * left out, for the node's own, and never or no limit is zero, which is none whatever the
 * node has. What it uses is limited only on a node that holds sessions to that: another
 * refuses a session that asks.
 */
export const limitsOf = (effective: Effective, holdsResources: boolean): LimitsInit => {
  const idle = given(effective.suspendIdleAfter);
  const memory = holdsResources ? given(effective.sessionMemory) : undefined;
  const cpus = holdsResources ? given(effective.sessionCpus) : undefined;
  const kept = given(effective.recordingRetention);
  return {
    ...(kept === undefined ? {} : { keepRecordings: { seconds: BigInt(kept) } }),
    ...(idle === undefined ? {} : { suspendIdleAfter: { seconds: BigInt(idle) } }),
    ...(memory === undefined ? {} : { memoryBytes: BigInt(memory) }),
    ...(cpus === undefined ? {} : { cpus }),
  };
};

/** What a node tells of a limit: its own where none is asked, and none for zero. */
const expected = <A extends bigint | number>(asked: A | undefined, own: A | undefined) =>
  asked === undefined
    ? own === undefined || Number(own) === 0
      ? undefined
      : own
    : Number(asked) === 0
      ? undefined
      : asked;

/**
 * Whether a node holds a session to the limits it is to be held to, as the node tells the
 * session's: its own where it has them, the node's where not, and none left out.
 */
export const holds = (
  told: proto.Limits | undefined,
  wanted: LimitsInit,
  own: Offers["limits"] | undefined,
) => {
  const idle = expected(
    wanted.suspendIdleAfter?.seconds,
    own?.suspendIdleAfterSeconds === undefined ? undefined : BigInt(own.suspendIdleAfterSeconds),
  );
  const memory = expected(
    wanted.memoryBytes,
    own?.memoryBytes === undefined ? undefined : BigInt(own.memoryBytes),
  );
  const cpus = expected(wanted.cpus, own?.cpus);
  const kept = expected(wanted.keepRecordings?.seconds, undefined);
  return (
    told?.keepRecordings?.seconds === kept &&
    told?.suspendIdleAfter?.seconds === idle &&
    told?.memoryBytes === memory &&
    told?.cpus === cpus
  );
};

/** The level a bound of a setting is told as set by: the instance, where no level set it. */
export const boundBy = (setting: Effective[keyof Effective]) =>
  setting.source === "instance" ||
  setting.source === "workspace" ||
  setting.source === "account" ||
  setting.source === "session"
    ? setting.source
    : "instance";
