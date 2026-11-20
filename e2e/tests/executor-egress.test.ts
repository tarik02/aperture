import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Executor } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import { freePort, run } from "../src/process.ts";
import { programs } from "../src/programs.ts";
import * as Site from "../src/site.ts";
import { suite } from "../src/suite.ts";
import { happens, until } from "../src/wait.ts";

/** The one local address the node lets its sessions' browsers reach. */
const ALLOWED = "127.0.0.2";
/** Where a session's browser serves DevTools, inside its sandbox. */
const DEVTOOLS_PORT = 9222;
const TUNNEL_SECRET = "s3cret";

/** Listens on a port of its own on the allowed address until the scope ends. */
const listening = <S extends Server | HttpServer>(server: S) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<number>((listens) => {
          server.listen(0, ALLOWED, () => {
            const address = server.address();
            listens(typeof address === "object" && address !== null ? address.port : 0);
          });
        }),
    ),
    () => Effect.sync(() => server.close()),
  );

/** A page on the allowed address for sessions' browsers to fetch. */
class Reachable extends Context.Service<Reachable, { readonly port: number }>()(
  "@aperture-browser/e2e/Reachable",
) {}

// It closes after every answer: a browser would keep the connection for its next request,
// and rules decide for new connections only.
const reachable = Layer.effect(
  Reachable,
  listening(
    createHttpServer((_, response) => {
      response.setHeader("Connection", "close").end("reachable");
    }),
  ).pipe(Effect.map((port) => ({ port }))),
);

const node = Layer.mergeAll(
  Node.layer({ features: ["cdp", "tunnel"], env: { APERTURE_EGRESS_ALLOW: ALLOWED } }),
  reachable,
);

/** Passes everything a proxy is given on to the reachable page, wherever it was asked to. */
const relay = (socket: Socket, port: number) => {
  const upstream = connect(port, ALLOWED);
  socket.pipe(upstream).pipe(socket);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
};

const SOCKS_NO_AUTHENTICATION = Buffer.from([5, 0]);
const SOCKS_GRANTED = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
/** Where a SOCKS5 request for a name has the name's length; the name follows it. */
const SOCKS_NAME_LENGTH_AT = 4;

/** A SOCKS5 proxy that notes the names it is asked for. */
const socksProxy = (asked: string[], port: number) =>
  createTcpServer((socket) => {
    socket.once("data", () => {
      socket.write(SOCKS_NO_AUTHENTICATION);
      socket.once("data", (request: Buffer) => {
        const from = SOCKS_NAME_LENGTH_AT + 1;
        const name = request.subarray(from, from + request[SOCKS_NAME_LENGTH_AT]!);
        asked.push(`socks ${name.toString()}`);
        socket.write(SOCKS_GRANTED);
        relay(socket, port);
      });
    });
  });

/** An HTTP proxy that notes what it is asked to connect to. */
const httpProxy = (asked: string[], port: number) =>
  createHttpServer().on("connect", (request, socket: Socket) => {
    asked.push(`http ${request.url}`);
    socket.write("HTTP/1.1 200 OK\r\n\r\n");
    relay(socket, port);
  });

/** Waits until something takes connections at an address. */
const accepting = (host: string, port: number) =>
  until(
    `${host}:${port} taking connections`,
    Effect.promise(
      () =>
        new Promise<boolean>((answered) => {
          const socket = connect(port, host);
          socket.once("connect", () => {
            socket.destroy();
            answered(true);
          });
          socket.once("error", () => answered(false));
        }),
    ),
  );

suite(node)("what a session's browser reaches from a node", (it) => {
  let session: string;
  let page: Node.Opened;
  let tunnelPath: string;
  let allowed: string;
  let operatorPort: number;
  let dev: Site.Site;
  let attached: { readonly pid: number | undefined };

  /** Whether a page of the session gets an answer from an address. */
  const reaches = (url: string) =>
    page.page.evaluate(
      `fetch(${JSON.stringify(url)}, { mode: "no-cors" }).then(() => true, () => false)`,
    );

  /** The node's own address by a name, which only a route through somewhere else reaches. */
  const nodeByName = Effect.gen(function* () {
    const executor = yield* Executor;
    return `http://localhost:${new URL(executor.url).port}/`;
  });

  /** Routes what goes to the node's own address by a name through the operator's tunnel. */
  const throughOperator = (auth: string) =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.setProxy(session, {
        upstreams: {
          operator: { url: `ws+yamux+socks5://${ALLOWED}:${operatorPort}/x`, auth },
        },
        rules: [{ match: new URL(yield* nodeByName).host, via: "operator" }],
      });
    });

  it.effect("a page cannot reach the executor on loopback", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const created = yield* executor.client.sessions.create();
      session = created.id;
      tunnelPath = created.endpoints?.tunnelPath ?? "";
      page = yield* Node.open(executor, session, Node.TRIAL_PAGE);
      allowed = `http://${ALLOWED}:${(yield* Reachable).port}/`;

      expect(yield* reaches(`${executor.url}/`)).toBe(false);
    }),
  );

  it.effect("a page cannot reach its own DevTools endpoint", () =>
    Effect.gen(function* () {
      expect(yield* reaches(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`)).toBe(false);
    }),
  );

  it.effect("a page cannot reach the node's own address by a name", () =>
    Effect.gen(function* () {
      expect(yield* reaches(yield* nodeByName)).toBe(false);
    }),
  );

  it.effect("a page reaches what the node allows", () =>
    Effect.gen(function* () {
      expect(yield* reaches(allowed)).toBe(true);
    }),
  );

  it.effect("a rule refuses what the node allows", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.setProxy(session, {
        rules: [{ match: new URL(allowed).host, via: "refuse" }],
      });
      expect(yield* reaches(allowed)).toBe(false);
    }),
  );

  it.effect("without the rule it is reached again", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.setProxy(session);
      expect(yield* reaches(allowed)).toBe(true);
    }),
  );

  it.effect("a rule that names no upstream is refused", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const answer = yield* executor.rpc("UpdateSessionProxy", {
        id: session,
        proxy: { rules: [{ match: "*", via: "nowhere" }] },
      });
      expect(answer.body.code).toBe("invalid_argument");
    }),
  );

  // Two proxies that make every connection to the reachable page, and note what they were
  // asked for.
  const asked: string[] = [];

  it.effect("a rule routes through a SOCKS5 upstream, by name", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const { port } = yield* Reachable;
      const socks = yield* Node.lasting(listening(socksProxy(asked, port)));
      const http = yield* Node.lasting(listening(httpProxy(asked, port)));
      yield* executor.client.sessions.setProxy(session, {
        upstreams: { corp: { url: `socks5://${ALLOWED}:${socks}` } },
        rules: [
          { match: "*.via-socks.example", via: "corp" },
          { match: "via-http.example", via: `http://${ALLOWED}:${http}` },
          { match: "via-forbidden.example", via: `socks5://127.0.0.1:${socks}` },
        ],
      });

      expect(yield* reaches("http://www.via-socks.example/")).toBe(true);
      expect(asked).toContain("socks www.via-socks.example");
    }),
  );

  it.effect("a rule routes through an HTTP proxy", () =>
    Effect.gen(function* () {
      expect(yield* reaches("http://via-http.example/")).toBe(true);
      expect(asked).toContain("http via-http.example:80");
    }),
  );

  it.effect("an upstream on an address the node forbids is not reached", () =>
    Effect.gen(function* () {
      expect(yield* reaches("http://via-forbidden.example/")).toBe(false);
    }),
  );

  // A tunnel the session dials: yamux over a WebSocket, to an operator's end.
  it.effect("a tunnel with the wrong secret carries nothing", () =>
    Effect.gen(function* () {
      operatorPort = yield* freePort;
      yield* Node.lasting(
        run(`${programs}/aperture-tunnel`, [
          "listen",
          `${ALLOWED}:${operatorPort}`,
          "--auth",
          TUNNEL_SECRET,
        ]),
      );
      yield* accepting(ALLOWED, operatorPort);

      yield* throughOperator("wrong");
      expect(yield* reaches(yield* nodeByName)).toBe(false);
    }),
  );

  it.effect("a rule routes through a tunnel, to what the far end reaches", () =>
    Effect.gen(function* () {
      yield* throughOperator(TUNNEL_SECRET);
      expect(yield* reaches(yield* nodeByName)).toBe(true);
    }),
  );

  it.effect("what no rule names still goes by the node's own", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      expect(yield* reaches(`${executor.url}/`)).toBe(false);
    }),
  );

  // A tunnel a client attaches: connections are made on the client's machine.
  it.effect("a local route fails while no client is attached", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      dev = yield* Node.lasting(Site.serve(Site.html("dev")));
      const devPort = new URL(dev.url).port;
      yield* executor.client.sessions.setProxy(session, {
        rules: [{ match: `localhost:${devPort}`, via: "local" }],
      });
      expect(yield* reaches(`http://localhost:${devPort}/`)).toBe(false);
    }),
  );

  it.effect("a local route reaches the client's own localhost", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const client = yield* Node.lasting(
        run(`${programs}/aperture-tunnel`, [
          "attach",
          `${executor.url.replace(/^http/u, "ws")}${tunnelPath}`,
          "--token",
          executor.token,
        ]),
      );
      attached = { pid: client.child.pid };

      const devPort = new URL(dev.url).port;
      const reached = yield* happens(reaches(`http://localhost:${devPort}/`), 10_000);
      expect(reached).toBe(true);
    }),
  );

  it.effect("the local route fails again once the client is gone", () =>
    Effect.gen(function* () {
      expect(attached.pid).toBeDefined();
      process.kill(attached.pid!, "SIGKILL");

      const devPort = new URL(dev.url).port;
      const fails = yield* happens(
        reaches(`http://localhost:${devPort}/`).pipe(Effect.map((reached) => !reached)),
        10_000,
      );
      expect(fails).toBe(true);
    }),
  );
});
