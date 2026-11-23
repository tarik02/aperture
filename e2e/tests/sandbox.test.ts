import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { firstTab } from "../src/network.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { until } from "../src/wait.ts";

/** What the session settles for its browser, as `policy()` of the runner's browser has it. */
const POLICY: Readonly<Record<string, string>> = {
  PasswordManagerEnabled: "false",
  PasswordLeakDetectionEnabled: "false",
  AutofillAddressEnabled: "false",
  AutofillCreditCardEnabled: "false",
  TranslateEnabled: "false",
  BrowserSignin: "0",
  SyncDisabled: "true",
  DefaultBrowserSettingEnabled: "false",
  PromotionalTabsEnabled: "false",
  PrivacySandboxPromptEnabled: "false",
  MetricsReportingEnabled: "false",
};

/**
 * All a browser may have in its `/etc`: what the session makes for it, and what it is shown
 * of the machine's where the machine has it.
 */
const SHOWN = [
  "passwd",
  "group",
  "nsswitch.conf",
  "hosts",
  "resolv.conf",
  "chromium",
  "opt",
  "fonts",
  "ssl",
  "pki",
  "ca-certificates",
  "static",
  "localtime",
  "glvnd",
  "drirc",
];

/** Files a machine has in its `/etc` that no browser is shown. */
const KEPT = ["hostname", "os-release", "machine-id", "shadow"];

const Row = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  level: Schema.String,
  source: Schema.String,
  status: Schema.String,
});

/**
 * An expression for `chrome://policy`: the policies that are set, each as its row tells it.
 * The rows are in shadow trees, which no selector of the document reaches into.
 */
const policyRows = `
  (() => {
    const within = (root, found = []) => {
      for (const element of root.querySelectorAll("*")) {
        if (element.localName === "policy-row") found.push(element);
        if (element.shadowRoot) within(element.shadowRoot, found);
      }
      return found;
    };
    const said = (row, part) => row.shadowRoot.querySelector(part)?.textContent.trim() ?? "";
    return within(document)
      .map((row) => ({
        name: said(row, ".name"),
        value: said(row, ".value"),
        level: said(row, ".level"),
        source: said(row, ".source"),
        status: said(row, ".messages"),
      }))
      .filter((row) => row.value !== "");
  })()
`;

/** An expression for a directory as the browser lists it: the names in it. */
const listed = `[...document.querySelectorAll("#tbody a")].map((entry) => entry.textContent.replace(/\\/$/, ""))`;

/**
 * An expression for a page that was handed a file by its path, as an upload is: what the
 * browser, which is what opens it, read of it, or `unread` where it could not.
 */
const handed = `document.querySelector("input").files[0].text().then(() => "read", () => "unread")`;

const Document = Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Number }) });
const Found = Schema.Struct({ nodeId: Schema.Number });
const Navigated = Schema.Struct({ errorText: Schema.optional(Schema.String) });

suite(Runner.layer({ features: ["cdp"] }))("what a session's browser sees", (it) => {
  it.effect("its policy is the session's, all of it", () =>
    Effect.gen(function* () {
      const tab = yield* firstTab(yield* Runner.Runner);
      yield* tab.open("chrome://policy/");
      const rows = yield* until(
        "the browser listing its policies",
        tab
          .evaluate(policyRows, Schema.Array(Row))
          .pipe(Effect.map((rows) => (rows.length > 0 ? rows : undefined))),
        "30 seconds",
      );
      expect(Object.fromEntries(rows.map((row) => [row.name, row.value]))).toEqual(POLICY);
      for (const row of rows) {
        expect(row, row.name).toMatchObject({ level: "Mandatory", source: "Platform" });
        // Deprecated is what the browser says of a policy it still follows and has another for.
        expect(["OK", "Deprecated"], row.name).toContain(row.status);
      }
    }),
  );

  it.effect("a page loads over HTTPS", () =>
    Effect.gen(function* () {
      const tab = yield* firstTab(yield* Runner.Runner);
      expect(yield* tab.open("https://example.com/")).toBe("Example Domain");
    }),
  );

  it.effect("its /etc has nothing of the machine's but what it is shown", () =>
    Effect.gen(function* () {
      const tab = yield* firstTab(yield* Runner.Runner);
      yield* tab.open("file:///etc/");
      const names = yield* tab.evaluate(listed, Schema.Array(Schema.String));
      expect(names).toEqual(expect.arrayContaining(["passwd", "chromium"]));
      expect(names.filter((name) => !SHOWN.includes(name))).toEqual([]);

      yield* tab.open("file:///etc/passwd");
      const users = yield* tab.evaluate("document.body.innerText.trim()", Schema.String);
      expect(users).toMatch(/^browser:x:\d+:\d+:[^\n]*$/);
    }),
  );

  it.effect("a file of the machine's /etc is read by no page, and not by the browser", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* Runner.Runner;
      const kept = yield* Effect.filter(KEPT, (name) => fs.exists(`/etc/${name}`));
      expect(kept, "what this machine has of the files no browser is shown").not.toEqual([]);

      const targets = yield* runner.targets;
      const cdp = yield* runner.cdp;
      const page = yield* cdp.attach(targets[0]?.id ?? "");
      for (const name of kept) {
        const path = `/etc/${name}`;
        const went = yield* page.call("Page.navigate", { url: `file://${path}` }, Navigated);
        expect(went.errorText, path).toBe("net::ERR_FILE_NOT_FOUND");

        yield* page.call("Page.navigate", { url: "about:blank" });
        yield* page.evaluate(`document.body.innerHTML = '<input type="file">'`);
        const { root } = yield* page.call("DOM.getDocument", {}, Document);
        const input = yield* page.call(
          "DOM.querySelector",
          { nodeId: root.nodeId, selector: "input" },
          Found,
        );
        yield* page.call("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [path] });
        expect(yield* page.evaluate(handed, Schema.String), path).toBe("unread");
      }
    }),
  );
});
