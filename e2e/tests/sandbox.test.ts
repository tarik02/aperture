import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as Cdp from "../src/cdp.ts";
import { Executor } from "../src/executor.ts";
import { firstTab } from "../src/network.ts";
import * as Node from "../src/node.ts";
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

/**
 * What a browser may have at its root: its system's trees, what a sandbox has of its own,
 * and where its profile and its files are. A session's own directories are there under the
 * names they have outside as well, with nothing beside them on the way.
 */
const ROOTS = ["bin", "dev", "etc", "files", "lib", "lib64", "nix", "proc", "profile", "run"];
const SYSTEMS = ["sys", "tmp", "usr", "var"];

/** Directories a machine has that are someone's, and no browser's. */
const SOMEONES = ["/home", "/root", "/var/lib", "/var/log", "/run/user", "/run/secrets"];

const Document = Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Number }) });
const Found = Schema.Struct({ nodeId: Schema.Number });
const Navigated = Schema.Struct({ errorText: Schema.optional(Schema.String) });

/** What a page tells of a file it is sent to: the error the browser has for one it cannot open. */
const sentTo = (page: Cdp.Attached, path: string) =>
  page
    .call("Page.navigate", { url: `file://${path}` }, Navigated)
    .pipe(Effect.map((went) => went.errorText));

/** What the browser read of a file a page was handed by its path, as an upload is. */
const handedTo = (page: Cdp.Attached, path: string) =>
  Effect.gen(function* () {
    yield* page.call("Page.navigate", { url: "about:blank" });
    yield* page.evaluate(`document.body.innerHTML = '<input type="file">'`);
    const { root } = yield* page.call("DOM.getDocument", {}, Document);
    const input = yield* page.call(
      "DOM.querySelector",
      { nodeId: root.nodeId, selector: "input" },
      Found,
    );
    yield* page.call("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [path] });
    return yield* page.evaluate(handed, Schema.String);
  });

/** The names in a directory as the browser lists it to a page. */
const lists = (page: Cdp.Attached, path: string) =>
  Effect.gen(function* () {
    yield* page.call("Page.navigate", { url: `file://${path}/` });
    yield* until(`${path} being listed`, page.evaluate("document.readyState === 'complete'"));
    return yield* page.evaluate(listed, Schema.Array(Schema.String));
  });

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
      expect(yield* tab.reaches("https://example.com/")).toBe(true);
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
        expect(yield* sentTo(page, path), path).toBe("net::ERR_FILE_NOT_FOUND");
        expect(yield* handedTo(page, path), path).toBe("unread");
      }
    }),
  );

  it.effect("of the machine it has its system's trees, and nothing that is someone's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* Runner.Runner;
      const cdp = yield* runner.cdp;
      const page = yield* cdp.attach((yield* runner.targets)[0]?.id ?? "");

      // The session's own directories are where they are outside, below the same names.
      const [own = ""] = runner.files.split("/").filter((part) => part !== "");
      const roots = yield* lists(page, "");
      expect(roots).toEqual(expect.arrayContaining(["etc", "files", "profile"]));
      expect(roots.filter((name) => ![...ROOTS, ...SYSTEMS, own].includes(name))).toEqual([]);
      // Of what a machine keeps in `/var` and `/run`, how fonts are found and a GPU's drivers.
      const kept = yield* lists(page, "/var");
      expect(kept.filter((name) => name !== "cache")).toEqual([]);
      if (kept.length > 0) {
        expect(yield* lists(page, "/var/cache")).toEqual(["fontconfig"]);
      }
      const run = yield* lists(page, "/run");
      expect(run.filter((name) => name !== "opengl-driver" && name !== own)).toEqual([]);

      const someones = yield* Effect.filter(SOMEONES, (path) => fs.exists(path));
      expect(someones, "what this machine has that is someone's").not.toEqual([]);
      for (const path of someones) {
        expect(yield* sentTo(page, path), path).toBe("net::ERR_FILE_NOT_FOUND");
      }
    }),
  );

  it.effect("of the session it has its files, and neither its token nor its profile's place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* Runner.Runner;
      const cdp = yield* runner.cdp;
      const page = yield* cdp.attach((yield* runner.targets)[0]?.id ?? "");
      const data = runner.files.replace(/\/files$/u, "");
      expect(yield* fs.readFileString(`${data}/token`)).toBe(runner.token);

      const shown = yield* lists(page, data);
      expect(shown).toContain("files");
      expect(shown.filter((name) => name !== "files" && name !== "cache")).toEqual([]);
      for (const path of [`${data}/token`, `${data}/upper`, `${data}/profile`]) {
        expect(yield* sentTo(page, path), path).toBe("net::ERR_FILE_NOT_FOUND");
      }
      expect(yield* handedTo(page, `${data}/token`)).toBe("unread");
    }),
  );
});

suite(Node.layer({ features: ["cdp"] }))("what a session's browser sees of its node", (it) => {
  it.effect("nothing of another session, nor what lets the operator in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const executor = yield* Executor;
      const own = (yield* executor.client.sessions.create()).id;
      const other = (yield* executor.client.sessions.create()).id;
      const cdp = yield* executor.cdp(own);
      const [target] = yield* Node.targets(executor, own);
      const page = yield* cdp.attach(target?.id ?? "");
      const sessions = `${executor.data}/sessions`;
      expect(yield* fs.exists(`${sessions}/${other}/files`)).toBe(true);
      expect(yield* fs.readFileString(`${executor.data}/token`)).toBe(executor.token);

      expect(yield* lists(page, executor.data)).toEqual(["sessions"]);
      expect(yield* lists(page, sessions)).toEqual([own]);
      const shown = yield* lists(page, `${sessions}/${own}`);
      expect(shown.filter((name) => name !== "files" && name !== "cache")).toEqual([]);
      const kept = [
        `${executor.data}/token`,
        `${executor.data}/layers`,
        `${sessions}/${other}`,
        `${sessions}/${other}/files`,
        `${sessions}/${own}/upper`,
        `${sessions}/${own}/session.json`,
        `${sessions}/${own}/logs/runner.log`,
        `${executor.runtime}/${other}`,
      ];
      for (const path of kept) {
        expect(yield* sentTo(page, path), path).toBe("net::ERR_FILE_NOT_FOUND");
      }
      expect(yield* handedTo(page, `${executor.data}/token`)).toBe("unread");
      expect(yield* handedTo(page, `${sessions}/${own}/session.json`)).toBe("unread");
    }),
  );
});
