import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

/** What Prometheus is told at a metrics address, as it reads it. */
export interface Scraped {
  readonly contentType: string;
  /** Each family by its name, with its type. */
  readonly types: Readonly<Record<string, string>>;
  /** The lines of series, as they are written. */
  readonly series: ReadonlyArray<string>;
  /** The lines that are none the text format has. */
  readonly invalid: ReadonlyArray<string>;
}

const NAME = "[a-zA-Z_:][a-zA-Z0-9_:]*";
const LABELS = String.raw`\{(?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\["\\n])*",?)*\}`;
const VALUE = String.raw`(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|NaN|[-+]Inf)`;
const SERIES = new RegExp(`^${NAME}(?:${LABELS})? ${VALUE}$`, "u");
const HELP = new RegExp(`^# HELP ${NAME}(?: .*)?$`, "u");
const TYPE = new RegExp(`^# TYPE (${NAME}) (counter|gauge|histogram|summary|untyped)$`, "u");

/** The metrics at an address, line by line as the text format has them. */
export const scrape = Effect.fn("scrape")(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  const answer = yield* client.get(url);
  const text = yield* answer.text;
  const types: Record<string, string> = {};
  const series: Array<string> = [];
  const invalid: Array<string> = [];
  for (const line of text.split("\n")) {
    const typed = TYPE.exec(line);
    if (typed?.[1] !== undefined && typed[2] !== undefined) {
      types[typed[1]] = typed[2];
    } else if (SERIES.test(line)) {
      series.push(line);
    } else if (line !== "" && !HELP.test(line)) {
      invalid.push(line);
    }
  }
  return {
    contentType: answer.headers["content-type"] ?? "",
    types,
    series,
    invalid,
  } satisfies Scraped;
});
