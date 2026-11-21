import * as UrlPath from "@aperture-browser/shared/url-path";

/** Where the proxy has what it sends on to nodes: `/n/<node>/…`. */
const NODES = "n";

/** Where the proxy has a node: what comes after it is the node's own path. */
export const nodePath = (nodeId: string) => UrlPath.make`/${NODES}/${nodeId}`;

/** Where the proxy has a session of a node. */
export const sessionPath = (nodeId: string, sessionId: string) =>
  UrlPath.make`${UrlPath.raw(nodePath(nodeId))}/sessions/${sessionId}`;

const SESSION = new RegExp(`^/${NODES}/([^/?#]+)/sessions/([^/?#]+)(?:[/?#]|$)`, "u");

/** The node and the session a request to the proxy names; none for any other request. */
export const sessionAt = (uri: string) => {
  const [, node, session] = SESSION.exec(uri) ?? [];
  if (node === undefined || session === undefined) {
    return undefined;
  }
  // What is not written as a path is not one.
  try {
    return { nodeId: decodeURIComponent(node), sessionId: decodeURIComponent(session) };
  } catch {
    return undefined;
  }
};
