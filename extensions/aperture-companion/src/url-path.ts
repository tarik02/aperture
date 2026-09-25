/**
 * Request paths and web urls built from values that may hold what a url treats specially
 * (`/`, `?`, `#`, `%`, spaces): a label, a branch, a user's login. Every interpolation is
 * encoded unless it says otherwise, so a value cannot leave its segment because one call
 * site forgot to encode it.
 *
 * Effect has no such builder: `HttpApiClient` encodes `:param` paths only for endpoints
 * declared through `HttpApi`, and `Url.setPathname` leaves `/`, `?`, and `#` as they are.
 */

class Raw {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

class Segments {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }
}

export type Part = string | number | Raw | Segments;

/** Inserted as it is: a base url, a host, or a path this module already built. */
export const raw = (text: string): Raw => new Raw(text);

/**
 * A value that is itself several segments, `group/sub/project` or `feature/x`: each
 * `/`-separated segment is encoded and the slashes stay. A value an API wants as one
 * segment, like GitLab's `/projects/group%2Fproject`, is a plain interpolation instead.
 */
export const segments = (path: string): Segments => new Segments(path);

const encode = (part: Part): string => {
  if (part instanceof Raw) {
    return part.text;
  }
  if (part instanceof Segments) {
    return part.path.split("/").map(encodeURIComponent).join("/");
  }
  return encodeURIComponent(part);
};

/** `` make`/repos/${owner}/${repo}/pulls/${number}` ``: every interpolation encoded as one segment. */
export const make = (literals: TemplateStringsArray, ...parts: ReadonlyArray<Part>): string => {
  let url = literals[0] ?? "";
  parts.forEach((part, index) => {
    url += encode(part) + (literals[index + 1] ?? "");
  });
  return url;
};
