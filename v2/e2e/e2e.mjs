// The executor end to end, on real sessions: the store, the runner, the compositor, targets,
// WebRTC and automation. It starts an executor of its own on port 7911, with its data in
// /tmp/aperture-v2-e2e, and prints PASS or FAIL for each thing it checks.
//
//   cd v2 && cargo build && node e2e/e2e.mjs "$PWD/target/debug"
//
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";

const [bin] = process.argv.slice(2);
const D = "/tmp/aperture-v2-e2e";
// Runners a run that crashed left behind would be taken for this run's.
execSync(`pkill -KILL -f "[a]perture-runner ${D}/" || true`);
rmSync(D, { recursive: true, force: true });
mkdirSync(D, { recursive: true });
const base = "http://127.0.0.1:7911";
// Sessions' browsers may reach nothing local but this one address, where a page for them
// to fetch is served.
// It closes after every answer: a browser would keep the connection for its next request, and
// rules decide for new connections only.
const reachable = createServer((_, res) => res.setHeader("Connection", "close").end("reachable")).listen(7921, "127.0.0.2");
const env = { ...process.env, APERTURE_DATA_DIR: `${D}/data`, APERTURE_RUNTIME_DIR: `${D}/run`, APERTURE_LISTEN: "127.0.0.1:7911", APERTURE_EGRESS_ALLOW: "127.0.0.2" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let executor;
process.on("exit", () => executor?.kill("SIGINT"));
process.on("uncaughtException", (err) => { console.log(err); process.exit(1); });
async function startExecutor() {
  executor = spawn(`${bin}/aperture-executor`, [], { env, stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 100 && !existsSync(`${D}/data/token`); i++) await sleep(50);
  await sleep(300);
}
await startExecutor();
const token = readFileSync(`${D}/data/token`, "utf8").trim();
const auth = { Authorization: `Bearer ${token}` };
async function rpc(method, body = {}) {
  const started = Date.now();
  const res = await fetch(`${base}/aperture.executor.v1.ExecutorService/${method}`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`${method} ${res.status} ${Date.now() - started}ms`, JSON.stringify(json).slice(0, 260));
  return json;
}
const cdp = (sessionId) => cdpAt(`ws://127.0.0.1:7911/sessions/${sessionId}/cdp`, { headers: auth });
function cdpAt(url, options) {
  const ws = new WebSocket(url, options);
  let next = 1; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const open = new Promise((ok, fail) => { ws.addEventListener("open", ok); ws.addEventListener("error", (e) => fail(new Error("ws error " + (e.message ?? "")))); });
  return {
    async send(method, params = {}, sessionId) {
      await open;
      const id = next++;
      const reply = new Promise((r) => pending.set(id, r));
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      const m = await reply;
      if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`);
      return m.result;
    },
    close: () => ws.close(),
  };
}
const cookie = (name) => ({ name, value: "1", domain: "example.test", path: "/", expires: Date.now() / 1000 + 86400 });
const cookies = async (id) => { const c = cdp(id); const r = await c.send("Storage.getCookies"); c.close(); return r.cookies.filter((x) => x.domain === "example.test").map((x) => x.name).sort().join(","); };
const procs = () => execSync(`ps -eo pid,args | grep -F "${D}/" | grep -v -e grep -e e2e.mjs -e aperture-executor | cut -c1-160 || true`).toString().trim();
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

const a = (await rpc("CreateSession")).session;
let c = cdp(a.id);
console.log("browser:", (await c.send("Browser.getVersion")).product);
await c.send("Storage.setCookies", { cookies: [cookie("from_a")] });
c.close();

const snap = (await rpc("CreateSnapshot", { sessionId: a.id, name: "base" })).snapshot;
check("A running again after snapshot", (await rpc("GetSession", { id: a.id })).session.state === "SESSION_STATE_RUNNING");
check("A keeps its cookie over the snapshot", (await cookies(a.id)) === "from_a");

const b = (await rpc("CreateSession", { snapshotId: snap.id })).session;
check("B starts with the snapshot's cookie", (await cookies(b.id)) === "from_a");
c = cdp(b.id); await c.send("Storage.setCookies", { cookies: [cookie("from_b")] }); c.close();
check("B has both", (await cookies(b.id)) === "from_a,from_b");
check("A does not see B's cookie", (await cookies(a.id)) === "from_a");

executor.kill("SIGINT"); await sleep(500);
await startExecutor();
const listed = (await rpc("ListSessions")).sessions;
check("both sessions survive an executor restart", listed.length === 2 && listed.every((s) => s.state === "SESSION_STATE_RUNNING"));

// B's window, watched and controlled from A's browser through the viewer page.
const live = `${base}/sessions/${b.id}/live`;
c = cdp(b.id);
const page = `<body style='margin:0;background:%23246;color:white;font:48px sans-serif'><h1>Session B</h1><button style='position:absolute;left:100px;top:300px;width:300px;height:100px;font-size:32px' onclick="document.title='clicked'">click me</button><input id=i style='position:absolute;left:100px;top:450px;width:400px;font-size:32px' oninput="document.title='typed:'+this.value"><div style='height:3000px'></div>`;
const created = await c.send("Target.createTarget", { url: `data:text/html,${page}` });
const bPage = (await c.send("Target.attachToTarget", { targetId: created.targetId, flatten: true })).sessionId;
const bTitle = async () => (await c.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, bPage)).result.value;
const liveTargets = async () => (await fetch(`${live}/targets`, { headers: auth })).json();
const until = async (done) => { let value; for (let i = 0; i < 100; i++) { value = await liveTargets(); if (done(value)) break; await sleep(100); } return value; };
let listed2 = await until((targets) => targets.some((t) => t.id === created.targetId));
console.log("targets:", JSON.stringify(listed2).slice(0, 400));
check("B's pages are targets, the first tab and the new one", listed2.length === 2 && listed2.at(-1).id === created.targetId);
check("the new target is at the viewport size", listed2.at(-1).width === 1280 && listed2.at(-1).height === 720);
const png = Buffer.from(await (await fetch(`${live}/targets/${created.targetId}/screenshot.png`, { headers: auth })).arrayBuffer());
writeFileSync(`${D}/window.png`, png);
check("screenshot is a PNG", png.subarray(1, 4).toString() === "PNG");
const first = Buffer.from(await (await fetch(`${live}/targets/${listed2[0].id}/screenshot.png`, { headers: auth })).arrayBuffer());
check("each target has a window of its own", first.subarray(1, 4).toString() === "PNG" && !first.equals(png));

// A target has a viewport of its own: its page's size and how many pixels it draws to one.
{
  const setViewport = (id, viewport) => fetch(`${live}/targets/${id}/viewport`, { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(viewport) });
  const page = async (expression) => (await c.send("Runtime.evaluate", { expression, returnByValue: true }, bPage)).result.value;
  await setViewport(created.targetId, { width: 800, height: 600, scale: 2 });
  const sized = await until((targets) => { const t = targets.find((t) => t.id === created.targetId); return t.width === 800 && t.height === 600 && t.scale === 2; });
  console.log("viewport:", JSON.stringify(sized.map((t) => [t.width, t.height, t.scale])), await page("[innerWidth, innerHeight, devicePixelRatio].join()"));
  check("a target takes a viewport and scale of its own", sized.at(-1).width === 800 && sized.at(-1).scale === 2 && sized[0].width === 1280 && sized[0].scale === 1);
  check("its page has the size and the pixel ratio", (await page("[innerWidth, innerHeight, devicePixelRatio].join()")) === "800,600,2");
  const large = Buffer.from(await (await fetch(`${live}/targets/${created.targetId}/screenshot.png`, { headers: auth })).arrayBuffer());
  check("its picture has the pixels", large.readUInt32BE(16) === 1600 && large.readUInt32BE(20) === 1200);
  await setViewport(created.targetId, { width: 9000, height: 100, scale: 9 });
  const bounded = (await until((targets) => targets.find((t) => t.id === created.targetId).width === 4096)).at(-1);
  check("a viewport is bounded to what can be drawn", bounded.width === 4096 && bounded.height === 100 && bounded.scale === 1);
  await setViewport(created.targetId, { width: 1280, height: 720, scale: 1 });
  check("and goes back", (await until((targets) => { const t = targets.find((t) => t.id === created.targetId); return t.width === 1280 && t.height === 720 && t.scale === 1; })).at(-1).scale === 1);
}

// A page a page opens becomes a target too, and a closed page stops being one.
const before = new Set(listed2.map((t) => t.id));
await c.send("Runtime.evaluate", { expression: "window.open('about:blank')", userGesture: true }, bPage);
listed2 = await until((targets) => targets.length === 3);
const popup = listed2.find((t) => !before.has(t.id));
check("a popup is a target", listed2.length === 3 && popup !== undefined);
if (popup) await c.send("Target.closeTarget", { targetId: popup.id });
listed2 = await until((targets) => targets.length === 2);
check("a closed page is no target", listed2.length === 2 && listed2.every((t) => before.has(t.id)));
await c.send("Target.activateTarget", { targetId: created.targetId });

// What a session's browser can reach: nothing local, not even the executor that runs it or
// its own DevTools endpoint, but what the node allows.
const reaches = async (url) => (await c.send("Runtime.evaluate", { expression: `fetch(${JSON.stringify(url)}, { mode: "no-cors" }).then(() => true, () => false)`, awaitPromise: true, returnByValue: true }, bPage)).result.value;
check("a page cannot reach the executor on loopback", (await reaches("http://127.0.0.1:7911/")) === false);
check("a page cannot reach its own DevTools endpoint", (await reaches("http://127.0.0.1:9222/json/version")) === false);
check("a page cannot reach the node's own address by a name", (await reaches("http://localhost:7911/")) === false);
check("a page reaches what the node allows", (await reaches("http://127.0.0.2:7921/")) === true);

// Rules route a session's connections: refused, through proxies, through tunnels.
const setProxy = async (proxy) => (await rpc("UpdateSessionProxy", { id: b.id, proxy })).code;
check("a rule refuses what the node allows", (await setProxy({ rules: [{ match: "127.0.0.2:7921", via: "refuse" }] })) === undefined && (await reaches("http://127.0.0.2:7921/")) === false);
check("without the rule it is reached again", (await setProxy(undefined)) === undefined && (await reaches("http://127.0.0.2:7921/")) === true);
check("a rule that names no upstream is refused", (await setProxy({ rules: [{ match: "*", via: "nowhere" }] })) === "invalid_argument");

// Two proxies that make every connection to the page served above, and note what they were asked for.
const asked = [];
const relayTo = (socket) => { const upstream = netConnect(7921, "127.0.0.2"); socket.pipe(upstream).pipe(socket); upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); };
const socksProxy = createTcpServer((socket) => {
  socket.once("data", () => { socket.write(Buffer.from([5, 0])); socket.once("data", (request) => { asked.push(`socks ${request.subarray(5, 5 + request[4])}`); socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); relayTo(socket); }); });
}).listen(7922, "127.0.0.2");
const httpProxy = createServer().on("connect", (request, socket) => { asked.push(`http ${request.url}`); socket.write("HTTP/1.1 200 OK\r\n\r\n"); relayTo(socket); }).listen(7923, "127.0.0.2");
await setProxy({ upstreams: { corp: { url: "socks5://127.0.0.2:7922" } }, rules: [{ match: "*.via-socks.example", via: "corp" }, { match: "via-http.example", via: "http://127.0.0.2:7923" }, { match: "via-forbidden.example", via: "socks5://127.0.0.1:7922" }] });
check("a rule routes through a SOCKS5 upstream, by name", (await reaches("http://www.via-socks.example/")) === true && asked.includes("socks www.via-socks.example"));
check("a rule routes through an HTTP proxy", (await reaches("http://via-http.example/")) === true && asked.includes("http via-http.example:80"));
check("an upstream on an address the node forbids is not reached", (await reaches("http://via-forbidden.example/")) === false);

// A tunnel the session dials: yamux over a WebSocket, to an operator's end.
const operator = spawn(`${bin}/aperture-tunnel`, ["listen", "127.0.0.2:7924", "--auth", "s3cret"], { stdio: "ignore" });
process.on("exit", () => operator.kill("SIGKILL"));
await sleep(500);
await setProxy({ upstreams: { operator: { url: "ws+yamux+socks5://127.0.0.2:7924/x", auth: "wrong" } }, rules: [{ match: "localhost:7911", via: "operator" }] });
check("a tunnel with the wrong secret carries nothing", (await reaches("http://localhost:7911/")) === false);
await setProxy({ upstreams: { operator: { url: "ws+yamux+socks5://127.0.0.2:7924/x", auth: "s3cret" } }, rules: [{ match: "localhost:7911", via: "operator" }] });
check("a rule routes through a tunnel, to what the far end reaches", (await reaches("http://localhost:7911/")) === true);
check("what no rule names still goes by the node's own", (await reaches("http://127.0.0.1:7911/")) === false);

// A tunnel a client attaches: connections are made on the client's machine.
const devServer = createServer((_, res) => res.end("dev")).listen(7925, "127.0.0.1");
await setProxy({ rules: [{ match: "localhost:7925", via: "local" }] });
check("a local route fails while no client is attached", (await reaches("http://localhost:7925/")) === false);
const tunnelClient = spawn(`${bin}/aperture-tunnel`, ["attach", `ws://127.0.0.1:7911${listed.find((s) => s.id === b.id).endpoints.tunnelPath}`, "--token", token], { stdio: "ignore" });
process.on("exit", () => tunnelClient.kill("SIGKILL"));
await sleep(700);
check("a local route reaches the client's own localhost", (await reaches("http://localhost:7925/")) === true);
tunnelClient.kill("SIGKILL");
await sleep(500);
check("the local route fails again once the client is gone", (await reaches("http://localhost:7925/")) === false);
await setProxy(undefined);
for (const server of [socksProxy, httpProxy, devServer]) server.close();
operator.kill("SIGKILL");

// The viewer is a person's browser: one outside any session, with a network of its own.
const viewerBrowser = spawn(process.env.APERTURE_CHROMIUM, ["--headless=new", "--no-sandbox", `--user-data-dir=${D}/viewer`, "--remote-debugging-port=0", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => viewerBrowser.kill("SIGKILL"));
const viewerUrl = await new Promise((found) => { let log = ""; viewerBrowser.stderr.on("data", (chunk) => { log += chunk; const url = /DevTools listening on (ws:\/\/\S+)/u.exec(log)?.[1]; if (url) found(url); }); });
const viewer = cdpAt(viewerUrl);
const { targetId } = await viewer.send("Target.createTarget", { url: `${live}?token=${token}` });
const { sessionId } = await viewer.send("Target.attachToTarget", { targetId, flatten: true });
const evaluate = async (expression) => (await viewer.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
let seen = "";
for (let i = 0; i < 60; i++) { await sleep(250); seen = await evaluate(`JSON.stringify({state: peer.connectionState, status, video: size(), time: view.currentTime, targets: targets.length, selected})`); if (JSON.parse(seen).video[0] > 0 && JSON.parse(seen).selected) break; }
console.log("viewer:", seen);
check("the viewer plays B's newest target over WebRTC", JSON.parse(seen).video[0] === 1280 && JSON.parse(seen).video[1] === 720 && JSON.parse(seen).selected === created.targetId);

const gpu = await c.send("SystemInfo.getInfo");
console.log("gpu:", JSON.stringify({ devices: gpu.gpu.devices.map((device) => `${device.vendorString} ${device.deviceString} ${device.driverVersion}`), features: gpu.gpu.featureStatus }));

// Input goes the whole way: a click and keys in the viewer reach B's page.
const box = JSON.parse(await evaluate(`JSON.stringify(view.getBoundingClientRect())`));
const inner = (await c.send("Runtime.evaluate", { expression: "innerWidth + 'x' + innerHeight", returnByValue: true }, bPage)).result.value;
check(`the page fills the viewport (${inner})`, inner === "1280x720");
const browserUi = 0;
const at = (x, y) => ({ x: box.x + x * (box.width / 1280), y: box.y + (y + browserUi) * (box.height / 720) });
const click = async (x, y) => { Object.assign(box, JSON.parse(await evaluate(`JSON.stringify(view.getBoundingClientRect())`))); for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await viewer.send("Input.dispatchMouseEvent", { type, ...at(x, y), button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }, sessionId); };
await click(250, 350);
await sleep(500);
check("a click in the viewer reaches B's page", (await bTitle()) === "clicked");
await click(300, 470);
await sleep(300);
for (const [key, code, vk] of [["h", "KeyH", 72], ["i", "KeyI", 73]]) for (const type of ["keyDown", "keyUp"]) await viewer.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk }, sessionId);
await sleep(500);
check("keys in the viewer reach B's page", (await bTitle()) === "typed:hi");

// Automation: an agent's tools over MCP, on the same page, while the viewer watches.
const mcpUrl = `${base}${listed.find((s) => s.id === b.id).endpoints.mcpPath}`;
let mcpSession; let mcpId = 0;
const mcp = async (method, params, notify = false) => {
  const res = await fetch(mcpUrl, { method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id: ++mcpId }), method, params }) });
  mcpSession ??= res.headers.get("mcp-session-id");
  if (notify) return;
  const text = await res.text();
  const data = text.startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data: {")).at(-1)?.slice(6);
  if (!data) throw new Error(`mcp ${method}: ${res.status} ${text.slice(0, 200)}`);
  const message = JSON.parse(data);
  if (message.error) throw new Error(`mcp ${method}: ${JSON.stringify(message.error)}`);
  return message.result;
};
const tool = async (name, args = {}) => { const started = Date.now(); const result = await mcp("tools/call", { name, arguments: args }); const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"); console.log(`tool ${name} ${Date.now() - started}ms${result.isError ? " ERROR" : ""}:`, text.replace(/\s+/gu, " ").slice(0, 220)); return { ...result, text }; };
const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
await mcp("notifications/initialized", {}, true);
const toolNames = (await mcp("tools/list", {})).tools.map((t) => t.name);
console.log("mcp:", init.serverInfo?.name, "tools:", toolNames.join(","));
check("the session serves its tools over MCP", toolNames.includes("navigate") && toolNames.includes("click") && toolNames.includes("tabs") && toolNames.includes("execute") && toolNames.includes("recording"));
const listedTabs = JSON.parse((await tool("tabs")).text);
check("tabs lists the session's targets", listedTabs.length === 2 && listedTabs.some((t) => t.target === created.targetId));
await c.send("Runtime.evaluate", { expression: "document.title = 'reset'; document.querySelector('button').style.cursor = 'pointer'; i.value = ''" }, bPage);
const snapshot = await tool("snapshot", { tab: created.targetId });
check("snapshot reads the page", /click me/u.test(snapshot.text));
const hovered = await tool("hover", { tab: created.targetId, selector: "button" });
await sleep(300);
check("the viewer sees automation move the pointer", !hovered.isError && (await evaluate("video.style.cursor")) === "pointer");
const clicked = await tool("click", { tab: created.targetId, selector: "button" });
check("click reaches the page", !clicked.isError && (await bTitle()) === "clicked");
const filled = await tool("fill", { tab: created.targetId, selector: "#i", value: "by agent" });
check("fill reaches the page", !filled.isError && (await bTitle()) === "typed:by agent");
await tool("click", { tab: created.targetId, selector: "#i" });
const pressed = await tool("press", { tab: created.targetId, key: "x" });
check("press types through the keyboard", !pressed.isError && (await bTitle()) === "typed:by agentx");
const pictured = await mcp("tools/call", { name: "screenshot", arguments: { tab: created.targetId } });
check("screenshot returns an image", pictured.content.some((c) => c.type === "image" && c.data.length > 1000));
// Recording: the target's own stream into a file, with the pointer in the picture.
const recordingStarted = JSON.parse((await tool("recording", { action: "start", tab: created.targetId, idle: "cut", ripple: true })).text);
await sleep(300);
check("the viewer's cursor is hidden while the pointer is recorded", (await evaluate("video.style.cursor")) === "none");
for (const [x, y] of [[200, 200], [600, 300], [250, 350]]) { await tool("hover", { tab: created.targetId, x, y }); await sleep(250); }
await tool("recording", { action: "caption", text: "clicking the button", duration_ms: 2500 });
await tool("recording", { action: "focus", selector: "button", zoom: 2 });
await sleep(700);
await tool("click", { tab: created.targetId, selector: "button" });
await sleep(700);
await tool("recording", { action: "reset_focus" });
await tool("recording", { action: "attention", selector: "#i", duration_ms: 600 });
// Scrolling and filling a field show as they would by hand.
const typingStarted = Date.now();
await tool("fill", { tab: created.targetId, selector: "#i", value: "typed by the agent, letter by letter" });
const typingTook = Date.now() - typingStarted;
check("a field is filled as if typed while recorded", typingTook > 900 && (await bTitle()) === "typed:typed by the agent, letter by letter");
await tool("scroll", { tab: created.targetId, deltaY: 900 });
await tool("scroll", { tab: created.targetId, deltaY: -900 });
const wheels = () => readFileSync(`${D}/data/sessions/${b.id}/files/${recordingStarted.journal}`, "utf8").trim().split("\n").filter((line) => JSON.parse(line).kind === "wheel").length;
const wheelsBefore = wheels();
const toBottom = await tool("scroll", { tab: created.targetId, to: "bottom" });
await tool("scroll", { tab: created.targetId, to: "top" });
const wheelsAfter = wheels();
check("a scroll to an edge travels there while recorded", /"atBottom": true/u.test(toBottom.text) && wheelsAfter - wheelsBefore > 20);
// Nothing happens for a while, which the edit cuts.
await sleep(2500);
const recordingStopped = JSON.parse((await tool("recording", { action: "stop", id: recordingStarted.id })).text);
console.log("recording:", JSON.stringify(recordingStopped));
check("the recording finished with a length", recordingStopped.state === "finished" && recordingStopped.duration_ms > 5000 && recordingStopped.bytes > 1000);
check("stop returns while the edit is made", recordingStopped.edit?.state === "editing");
const recordedFile = Buffer.from(await (await fetch(`${live}/files/${recordingStopped.file}`, { headers: auth })).arrayBuffer());
writeFileSync(`${D}/recording.mkv`, recordedFile);
check("the recording is served as a Matroska file", recordedFile.length === recordingStopped.bytes && recordedFile.subarray(0, 4).toString("hex") === "1a45dfa3");
const journal = (await (await fetch(`${live}/files/${recordingStopped.journal}`, { headers: auth })).text()).trim().split("\n").map((line) => JSON.parse(line));
console.log("journal:", journal.map((e) => `${e.kind}@${e.at_ms}`).join(" "));
const kinds = new Set(journal.map((e) => e.kind));
check("the journal has what the automation did", ["move", "press", "call", "caption", "focus", "attention"].every((kind) => kinds.has(kind)) && journal.find((e) => e.kind === "caption").text === "clicking the button");
const focusEntry = journal.find((e) => e.kind === "focus");
check("the focus is on the button, until it was reset", focusEntry.follow === "element" && focusEntry.ended === "reset" && Math.abs(focusEntry.rect.x - 100) < 2 && focusEntry.end_ms - focusEntry.at_ms > 1000);
let edited;
for (let i = 0; i < 120; i++) { edited = JSON.parse((await tool("recording", { action: "status", id: recordingStarted.id })).text).edit; if (edited.state !== "editing") break; await sleep(500); }
console.log("edit:", JSON.stringify(edited));
check("the edit finished", edited.state === "finished");
const editedFile = Buffer.from(await (await fetch(`${live}/files/${edited.file}`, { headers: auth })).arrayBuffer());
writeFileSync(`${D}/edited.mp4`, editedFile);
check("the edited video is an MP4", editedFile.subarray(4, 8).toString() === "ftyp" && editedFile.length > 1000);
const timeline = await (await fetch(`${live}/files/${edited.timeline}`, { headers: auth })).json();
console.log("timeline:", JSON.stringify({ duration_ms: timeline.duration_ms, edited_duration_ms: timeline.edited_duration_ms, map: timeline.map }));
check("the edit cut the idle stretch", timeline.edited_duration_ms < timeline.duration_ms - 1000 && timeline.map.length >= 1 && timeline.events.every((e) => e.edited_at_ms <= e.at_ms));
check("journal times are in the video's time", journal.every((e) => e.at_ms >= 0 && e.at_ms <= e.end_ms && e.end_ms <= recordingStopped.duration_ms + 100) && journal.some((e) => e.at_ms > 500));
check("the wheel turns in many small steps while recorded", journal.filter((e) => e.kind === "wheel").length > 20);
check("the pointer travels to where it acts while recorded", journal.filter((e) => e.kind === "move").length > 30);
check("the journal's press is where the click went", journal.some((e) => e.kind === "press" && e.button === "left" && Math.abs(e.x - 250) < 150 && Math.abs(e.y - 350) < 50));
// A caret blinks in the field all the while. With every change of a pixel counting, only
// its steady beat tells it from something happening.
await tool("click", { tab: created.targetId, selector: "#i" });
const blinking = JSON.parse((await tool("recording", { action: "start", tab: created.targetId, idle: "cut", motion_threshold: 0 })).text);
await tool("hover", { tab: created.targetId, x: 700, y: 200 });
await sleep(4500);
await tool("recording", { action: "stop", id: blinking.id });
let blinkingEdit;
for (let i = 0; i < 120; i++) { blinkingEdit = JSON.parse((await tool("recording", { action: "status", id: blinking.id })).text).edit; if (blinkingEdit.state !== "editing") break; await sleep(500); }
const blinkingTimeline = await (await fetch(`${live}/files/${blinkingEdit.timeline}`, { headers: auth })).json();
console.log("blinking:", JSON.stringify({ duration_ms: blinkingTimeline.duration_ms, edited_duration_ms: blinkingTimeline.edited_duration_ms }));
check("a blinking caret does not keep a page from being idle", blinkingTimeline.edited_duration_ms < blinkingTimeline.duration_ms - 1500);
check("the viewer's cursor is back", (await evaluate("video.style.cursor")) !== "none");
check("the viewer still plays after the recording", JSON.parse(await evaluate("JSON.stringify({ state: peer.connectionState })")).state === "connected");
check("a link that keeps up gets WebRTC video at the best quality", (await evaluate("status.quality")) === "VIDEO_QUALITY_FULL");

const opened = await tool("navigate", { url: "data:text/html,<title>agent tab</title><h1>opened by the agent</h1><input id=q autofocus>" });
// Keys reach a tab nobody clicked in.
await tool("press", { tab: opened.text.match(/"tab": (\d+)/u)?.[1] | 0, selector: "#q", key: "k" });
check("keys reach a tab no pointer touched", /"k"/u.test((await tool("eval", { tab: opened.text.match(/"tab": (\d+)/u)?.[1] | 0, expression: "q.value" })).text));
const afterOpen = await liveTargets();
check("navigate without a tab opens a target", !opened.isError && afterOpen.length === 3 && afterOpen.some((t) => t.title === "agent tab"));
const ran = await tool("execute", { code: "return await page.title()", tab: afterOpen.find((t) => t.title === "agent tab")?.id });
check("execute runs a script against a tab", !ran.isError && /agent tab/u.test(ran.text));
await tool("tabs", { action: "close", tab: afterOpen.find((t) => t.title === "agent tab")?.id });
check("tabs close closes the target", (await until((targets) => targets.length === 2)).length === 2);

// Clients with no WebRTC: the same video as frames on the session socket, or tiles.
for (const way of ["frames", "tiles"]) {
  const other = await viewer.send("Target.createTarget", { url: `${live}?token=${token}&pixels=${way}` });
  const otherSession = (await viewer.send("Target.attachToTarget", { targetId: other.targetId, flatten: true })).sessionId;
  const otherEvaluate = async (expression) => (await viewer.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, otherSession)).result.value;
  let got = "";
  for (let i = 0; i < 60; i++) { await sleep(250); got = await otherEvaluate(`drawn.then(() => JSON.stringify({ way, status, size: size(), selected, peer: typeof peer, lit: [...canvas.getContext("2d").getImageData(0, 0, canvas.width || 1, canvas.height || 1).data].some((value, index) => index % 4 !== 3 && value > 0) }))`); if (JSON.parse(got).lit) break; }
  console.log(`${way}:`, got);
  check(`a viewer without WebRTC gets the target's picture as ${way}`, JSON.parse(got).lit && JSON.parse(got).way === way && JSON.parse(got).size.join("x") === "1280x720" && JSON.parse(got).peer === "undefined" && JSON.parse(got).selected === created.targetId);
  await c.send("Runtime.evaluate", { expression: "document.title = 'waiting'" }, bPage);
  const otherBox = JSON.parse(await otherEvaluate(`JSON.stringify(canvas.getBoundingClientRect())`));
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await viewer.send("Input.dispatchMouseEvent", { type, x: otherBox.x + 250 * (otherBox.width / 1280), y: otherBox.y + 350 * (otherBox.height / 720), button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }, otherSession);
  await sleep(500);
  check(`a click in the ${way} viewer reaches B's page`, (await bTitle()) === "clicked");
  await viewer.send("Target.closeTarget", { targetId: other.targetId });
}

// A link that does not keep up: a client that shows frames late gets a lower quality, and
// one that shows them in time a better one.
{
  await c.send("Runtime.evaluate", { expression: "(() => { const box = document.body.appendChild(document.createElement('div')); box.style.cssText = 'position:fixed;right:0;bottom:0;width:400px;height:300px'; window.moving = setInterval(() => { box.style.background = `hsl(${Date.now() / 5 % 360} 80% 50%)`; }, 16); })()" }, bPage);
  const socket = new WebSocket(`${live.replace(/^http/u, "ws")}/ws?token=${token}`);
  const qualities = [];
  let lateBy = 0;
  let afterChange = null;
  let held = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.videoStatus) { qualities.push(message.videoStatus.quality.split("_").at(-1)); afterChange = null; }
    if (message.videoFrame) {
      afterChange ??= message.videoFrame.keyframe === true;
      held += 1;
      setTimeout(() => { held -= 1; socket.send(JSON.stringify({ videoShown: { timeUs: message.videoFrame.timeUs } })); }, lateBy);
    }
  };
  await new Promise((opened) => { socket.onopen = opened; });
  socket.send(JSON.stringify({ hello: { pixels: "PIXELS_FRAMES" } }));
  const reaches = async (quality, seconds) => { for (let i = 0; i < seconds * 10 && (qualities.at(-1) !== quality || afterChange === null); i++) await sleep(100); return qualities.at(-1) === quality; };
  check("frames start at the middle quality", await reaches("MEDIUM", 5));
  check("a client that shows frames in time gets the best quality", await reaches("FULL", 12) && afterChange === true);
  lateBy = 700;
  check("a client that shows frames late gets a lower quality", await reaches("MEDIUM", 8));
  check("and a lower one still while it stays late", await reaches("LOW", 8) && afterChange === true);
  lateBy = 0;
  check("it gets a better quality again once it keeps up", await reaches("MEDIUM", 25));
  socket.send(JSON.stringify({ hello: { pixels: "PIXELS_FRAMES", quality: "VIDEO_QUALITY_LOW" } }));
  check("a client gets the quality it asks for", await reaches("LOW", 5));
  await sleep(4000);
  check("and keeps it whatever its link carries", qualities.at(-1) === "LOW");
  let fps = 0;
  socket.addEventListener("message", (event) => { fps = JSON.parse(event.data).videoStatus?.fps ?? fps; });
  socket.send(JSON.stringify({ hello: { pixels: "PIXELS_FRAMES", quality: "VIDEO_QUALITY_FULL", fps: 5 } }));
  await reaches("FULL", 5);
  await sleep(500);
  const before = held; let frames = 0;
  socket.addEventListener("message", (event) => { if (JSON.parse(event.data).videoFrame) frames += 1; });
  await sleep(3000);
  console.log("fps:", fps, "frames in 3 s:", frames, before);
  check("a client gets no more frames a second than it asks for", fps === 5 && frames >= 10 && frames <= 17);
  console.log("qualities:", qualities.join(" > "));
  socket.close();
  await c.send("Runtime.evaluate", { expression: "clearInterval(window.moving)" }, bPage);
}

// Other codecs: as frames to whoever asks, and over WebRTC where the browser takes them.
{
  await c.send("Runtime.evaluate", { expression: "window.moving = setInterval(() => { document.body.lastChild.style.background = `hsl(${Date.now() / 5 % 360} 80% 50%)`; }, 16)" }, bPage);
  const made = {};
  for (const format of ["VIDEO_FORMAT_H265", "VIDEO_FORMAT_VP9", "VIDEO_FORMAT_VP9_FULL_CHROMA", "VIDEO_FORMAT_AV1"]) {
    const socket = new WebSocket(`${live.replace(/^http/u, "ws")}/ws?token=${token}`);
    let status; let first;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      status = message.videoStatus?.format ?? status;
      if (message.videoFrame) { first ??= message.videoFrame; socket.send(JSON.stringify({ videoShown: { timeUs: message.videoFrame.timeUs } })); }
    };
    await new Promise((opened) => { socket.onopen = opened; });
    socket.send(JSON.stringify({ hello: { pixels: "PIXELS_FRAMES", formats: [format] } }));
    for (let i = 0; i < 100 && !first; i++) await sleep(100);
    made[format] = status === format && first?.format === format && first.keyframe === true && first.data.length > 100;
    socket.close();
  }
  console.log("formats as frames:", JSON.stringify(made));
  check("frames come in H.265, VP9, VP9 4:4:4 and AV1", Object.values(made).every(Boolean));

  const over = {};
  const takes = JSON.parse(await evaluate(`decodable().then(JSON.stringify)`));
  for (const format of ["VIDEO_FORMAT_VP9", "VIDEO_FORMAT_VP9_FULL_CHROMA", "VIDEO_FORMAT_AV1", "VIDEO_FORMAT_H265", "VIDEO_FORMAT_H264"]) {
    if (!takes.includes(format)) continue;
    await evaluate(`controls.codec.value = "${format}"; hello()`);
    let plays = false;
    for (let i = 0; i < 60 && !plays; i++) {
      await sleep(250);
      const [said, decoded] = JSON.parse(await evaluate(`peer.getStats().then((stats) => JSON.stringify([status.format, [...stats.values()].filter((s) => s.type === "inbound-rtp").map((s) => [stats.get(s.codecId)?.mimeType, s.framesDecoded])[0]]))`));
      const before = decoded?.[1] ?? 0;
      await sleep(500);
      const after = JSON.parse(await evaluate(`peer.getStats().then((stats) => JSON.stringify([...stats.values()].filter((s) => s.type === "inbound-rtp").map((s) => [stats.get(s.codecId)?.mimeType, s.framesDecoded])[0]))`));
      plays = said === format && after[1] > before && RegExp(format.split("_")[2], "iu").test(after[0]);
      over[format] = [said, after[0], after[1] - before];
    }
  }
  console.log("formats over WebRTC:", JSON.stringify(takes), JSON.stringify(over));
  check("WebRTC video changes codec while it plays", takes.length >= 3 && Object.entries(over).every(([format, [said, mime, decoded]]) => said === format && decoded > 0));
  await evaluate(`controls.codec.value = ""; hello()`);
  await c.send("Runtime.evaluate", { expression: "clearInterval(window.moving)" }, bPage);
}

await sleep(500);
const shot = await viewer.send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync(`${D}/viewer.png`, Buffer.from(shot.data, "base64"));
viewer.close(); c.close(); viewerBrowser.kill("SIGKILL");
execSync(`grep -h "drawing on\\|no usable GPU\\|changes quality\\|target ready\\|target closed\\|refused the extension\\|video encoders\\|encoder failed\\|no video\\|failed to encode" ${D}/data/sessions/${b.id}/logs/runner.log | sed 's/\\x1b\\[[0-9;]*m//g' > ${D}/encoders.log || true`);
console.log("encoders:", readFileSync(`${D}/encoders.log`, "utf8").trim());

await rpc("SuspendSession", { id: a.id });
check("A suspended", (await rpc("GetSession", { id: a.id })).session.state === "SESSION_STATE_SUSPENDED");
await rpc("ResumeSession", { id: a.id });
check("A resumes with its cookie", (await cookies(a.id)) === "from_a");

// A browser that dies takes the session down, and says so.
const bRuntime = `${D}/run/${b.id}`;
const browserPid = execSync(`pgrep -f "bwrap .*${D}/data/sessions/${b.id}/" | head -1`).toString().trim();
process.kill(Number(browserPid), "SIGKILL");
await sleep(3000);
const failed = (await rpc("GetSession", { id: b.id })).session;
check("B failed after its browser was killed", failed.state === "SESSION_STATE_FAILED" && /browser exited/u.test(failed.failure ?? ""));
check("B's processes are gone", !procs().includes(b.id));
await rpc("ResumeSession", { id: b.id });
const afterCrash = await cookies(b.id); console.log("B cookies after crash:", afterCrash);
check("B resumes after the failure with its profile", afterCrash.startsWith("from_a"));

// A runner that is killed takes its browser and desktop with it.
const runnerPid = JSON.parse(readFileSync(`${bRuntime}/status.json`, "utf8")).pid;
process.kill(runnerPid, "SIGKILL");
await sleep(8000);
const orphaned = (await rpc("GetSession", { id: b.id })).session;
check("B failed after its runner was killed", orphaned.state === "SESSION_STATE_FAILED");
check("B's processes are gone again", !procs().includes(b.id));
console.log(procs());

await rpc("DeleteSnapshot", { id: snap.id });
check("the layer outlives its snapshot while sessions use it", readdirSync(`${D}/data/layers`).length === 1);
await rpc("ResumeSession", { id: b.id });
check("B still runs on it", (await cookies(b.id)).startsWith("from_a"));
for (const id of [a.id, b.id]) execSync(`cp ${D}/data/sessions/${id}/logs/runner.log ${D}/runner-${id}.log; cp ${D}/run/${id}/status.json ${D}/status-${id}.json 2>/dev/null || true`);
await rpc("DeleteSession", { id: a.id });
await rpc("DeleteSession", { id: b.id });
check("layers collected", readdirSync(`${D}/data/layers`).length === 0);
check("sessions gone", readdirSync(`${D}/data/sessions`).length === 0);
check("no session processes left", procs() === "");
console.log(procs());
executor.kill("SIGINT");
reachable.close();
