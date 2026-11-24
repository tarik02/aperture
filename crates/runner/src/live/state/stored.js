// Reads and writes what an origin stores, from a page of the origin: its IndexedDB
// databases, its caches and its private files. A key or a value of a database that JSON
// holds as it is goes as `key` and `value`; any other goes encoded, as `keyEncoded` and
// `valueEncoded`:
//
//   { v: "undefined" | "null" | "NaN" | "Infinity" | "-Infinity" | "-0" }
//   { bi: "<bigint>" }  { d: "<date>" }  { r: { p, f } }  { ab: "<base64>" }
//   { ta: { b: "<base64>", k: "ui8" | … } }  { dv: "<base64>" }
//   { bl: { b: "<base64>", t } }  { fl: { b: "<base64>", t, n, m } }
//   { ck: { a, f: "raw" | "spki" | "pkcs8", m: "<base64>", u } }
//   { er: { n, m, s, c }, id }
//   { a: [...], id }  { o: [{ k, v }], id }  { m: [[k, v]], id }  { s: [...], id }
//   { ref: id }
//
// The bytes of a cache's answer and of a file go as base64.
(() => {
  const typed = {
    i8: Int8Array,
    ui8: Uint8Array,
    ui8c: Uint8ClampedArray,
    i16: Int16Array,
    ui16: Uint16Array,
    i32: Int32Array,
    ui32: Uint32Array,
    f32: Float32Array,
    f64: Float64Array,
    bi64: BigInt64Array,
    bui64: BigUint64Array,
  };
  const toBase64 = (bytes) => {
    let text = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
    }
    return btoa(text);
  };
  const fromBase64 = (text) => Uint8Array.from(atob(text), (letter) => letter.charCodeAt(0));

  // Whether JSON holds the value as it is. One that holds something twice does not.
  const plain = (value, seen = new Set()) => {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      return true;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) && !Object.is(value, -0);
    }
    if (typeof value !== "object" || seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return Object.keys(value).length === value.length && value.every((one) => plain(one, seen));
    }
    return (
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((one) => plain(one, seen))
    );
  };

  // What a key is made again from: its algorithm as importing takes it.
  const algorithmOf = ({ name, hash, length, namedCurve }) => ({
    name,
    ...(hash === undefined ? {} : { hash: hash.name }),
    ...(length === undefined ? {} : { length }),
    ...(namedCurve === undefined ? {} : { namedCurve }),
  });

  const encode = async (value, seen = new Map()) => {
    if (value === undefined) return { v: "undefined" };
    if (value === null) return { v: "null" };
    if (typeof value === "number") {
      if (Number.isNaN(value)) return { v: "NaN" };
      if (Object.is(value, -0)) return { v: "-0" };
      return Number.isFinite(value) ? value : { v: String(value) };
    }
    if (typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "bigint") return { bi: value.toString() };
    if (value instanceof Date) return { d: value.toJSON() };
    if (value instanceof RegExp) return { r: { p: value.source, f: value.flags } };
    if (value instanceof ArrayBuffer) return { ab: toBase64(new Uint8Array(value)) };
    if (value instanceof DataView) {
      return { dv: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    for (const [kind, Typed] of Object.entries(typed)) {
      if (value instanceof Typed) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return { ta: { b: toBase64(bytes), k: kind } };
      }
    }
    if (typeof File !== "undefined" && value instanceof File) {
      const bytes = toBase64(new Uint8Array(await value.arrayBuffer()));
      return { fl: { b: bytes, t: value.type, n: value.name, m: value.lastModified } };
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return { bl: { b: toBase64(new Uint8Array(await value.arrayBuffer())), t: value.type } };
    }
    if (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) {
      if (!value.extractable) {
        throw new Error("a key that may not leave the browser is not carried");
      }
      const format = value.type === "secret" ? "raw" : value.type === "public" ? "spki" : "pkcs8";
      const material = await crypto.subtle.exportKey(format, value);
      return {
        ck: {
          a: algorithmOf(value.algorithm),
          f: format,
          m: toBase64(new Uint8Array(material)),
          u: [...value.usages],
        },
      };
    }
    if (seen.has(value)) return { ref: seen.get(value) };
    const id = seen.size + 1;
    if (Array.isArray(value)) {
      seen.set(value, id);
      const a = [];
      for (const one of Array.from(value)) a.push(await encode(one, seen));
      return { a, id };
    }
    if (value instanceof Map) {
      seen.set(value, id);
      const m = [];
      for (const [k, v] of value) m.push([await encode(k, seen), await encode(v, seen)]);
      return { m, id };
    }
    if (value instanceof Set) {
      seen.set(value, id);
      const s = [];
      for (const one of value) s.push(await encode(one, seen));
      return { s, id };
    }
    if (value instanceof Error) {
      seen.set(value, id);
      const er = { n: value.name, m: value.message, s: value.stack };
      if ("cause" in value) er.c = await encode(value.cause, seen);
      return { er, id };
    }
    if (Object.getPrototypeOf(value) === Object.prototype) {
      seen.set(value, id);
      const o = [];
      for (const k of Object.keys(value)) o.push({ k, v: await encode(value[k], seen) });
      return { o, id };
    }
    throw new Error(`a ${value.constructor?.name ?? typeof value} is not carried`);
  };

  const named = { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0, null: null };
  const errors = { EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
  const decode = async (value, refs = new Map()) => {
    if (value === null || typeof value !== "object") return value;
    if ("v" in value) return named[value.v];
    if ("bi" in value) return BigInt(value.bi);
    if ("d" in value) return new Date(value.d);
    if ("r" in value) return new RegExp(value.r.p, value.r.f);
    if ("ab" in value) return fromBase64(value.ab).buffer;
    if ("dv" in value) return new DataView(fromBase64(value.dv).buffer);
    if ("ta" in value) {
      const Typed = typed[value.ta.k];
      if (Typed === undefined) throw new Error(`${value.ta.k} is no kind of array`);
      const bytes = fromBase64(value.ta.b);
      return new Typed(bytes.buffer, 0, bytes.byteLength / Typed.BYTES_PER_ELEMENT);
    }
    if ("bl" in value) return new Blob([fromBase64(value.bl.b)], { type: value.bl.t });
    if ("fl" in value) {
      const { b, t, n, m } = value.fl;
      return new File([fromBase64(b)], n, { type: t, lastModified: m });
    }
    if ("ck" in value) {
      const { a, f, m, u } = value.ck;
      const algorithm = a.hash === undefined ? a : { ...a, hash: { name: a.hash } };
      return crypto.subtle.importKey(f, fromBase64(m), algorithm, true, u);
    }
    if ("ref" in value) return refs.get(value.ref);
    if ("a" in value) {
      const array = [];
      refs.set(value.id, array);
      for (const one of value.a) array.push(await decode(one, refs));
      return array;
    }
    if ("m" in value) {
      const map = new Map();
      refs.set(value.id, map);
      for (const [k, v] of value.m) map.set(await decode(k, refs), await decode(v, refs));
      return map;
    }
    if ("s" in value) {
      const set = new Set();
      refs.set(value.id, set);
      for (const one of value.s) set.add(await decode(one, refs));
      return set;
    }
    if ("er" in value) {
      const error = new (errors[value.er.n] ?? Error)(value.er.m);
      refs.set(value.id, error);
      error.name = value.er.n;
      if (value.er.s !== undefined) error.stack = value.er.s;
      if ("c" in value.er) error.cause = await decode(value.er.c, refs);
      return error;
    }
    if ("o" in value) {
      const object = {};
      refs.set(value.id, object);
      for (const { k, v } of value.o) object[k] = await decode(v, refs);
      return object;
    }
    throw new Error("a value is not one that is carried");
  };

  // What is told is JSON of no more than `limit` letters.
  const told = (what, held, limit) => {
    const json = JSON.stringify(held);
    if (json.length > limit) {
      throw new Error(`its ${what} are more than ${limit} bytes`);
    }
    return json;
  };

  const answered = (request, name) =>
    new Promise((done, failed) => {
      request.onsuccess = () => done(request.result);
      request.onerror = () => failed(request.error);
      // Another page of the origin has it open and does not let go.
      request.onblocked = () => failed(new Error(`${name} is open in a tab of the session`));
    });
  const path = (keyPath) =>
    keyPath === null ? {} : Array.isArray(keyPath) ? { keyPathArray: keyPath } : { keyPath };
  const record = async (key, value) => ({
    ...(plain(key) ? { key } : { keyEncoded: await encode(key) }),
    ...(plain(value) ? { value } : { valueEncoded: await encode(value) }),
  });

  const databases = {
    read: async (limit) => {
      const found = [];
      for (const { name } of await indexedDB.databases()) {
        const database = await answered(indexedDB.open(name), name);
        try {
          const stores = [];
          const names = [...database.objectStoreNames];
          const reading = names.length === 0 ? undefined : database.transaction(names, "readonly");
          // All of it is read before any of it is written down: a transaction ends once
          // something other than itself is waited for.
          for (const storeName of names) {
            const store = reading.objectStore(storeName);
            const keys = await answered(store.getAllKeys(), name);
            const values = await answered(store.getAll(), name);
            stores.push({
              name: storeName,
              ...path(store.keyPath),
              autoIncrement: store.autoIncrement,
              indexes: [...store.indexNames].map((indexName) => {
                const index = store.index(indexName);
                return {
                  name: indexName,
                  ...path(index.keyPath),
                  multiEntry: index.multiEntry,
                  unique: index.unique,
                };
              }),
              records: keys.map((key, index) => [key, values[index]]),
            });
          }
          for (const store of stores) {
            try {
              const records = [];
              for (const [key, value] of store.records) records.push(await record(key, value));
              store.records = records;
            } catch (error) {
              throw new Error(`${name}, ${store.name}: ${error.message}`);
            }
          }
          found.push({ name, version: database.version, stores });
        } finally {
          database.close();
        }
      }
      return told("databases", found, limit);
    },

    write: async (given) => {
      for (const one of given) {
        // Made before the database is opened, for the same reason they are read whole.
        const stores = [];
        for (const store of one.stores) {
          const records = [];
          for (const kept of store.records ?? []) {
            records.push([
              "keyEncoded" in kept ? await decode(kept.keyEncoded) : kept.key,
              "valueEncoded" in kept ? await decode(kept.valueEncoded) : kept.value,
            ]);
          }
          if (records.length > 0) stores.push({ name: store.name, records });
        }
        await answered(indexedDB.deleteDatabase(one.name), one.name);
        const opening = indexedDB.open(one.name, one.version);
        opening.onupgradeneeded = () => {
          for (const store of one.stores) {
            const made = opening.result.createObjectStore(store.name, {
              keyPath: store.keyPathArray ?? store.keyPath ?? null,
              autoIncrement: store.autoIncrement === true,
            });
            for (const index of store.indexes ?? []) {
              made.createIndex(index.name, index.keyPathArray ?? index.keyPath, {
                unique: index.unique === true,
                multiEntry: index.multiEntry === true,
              });
            }
          }
        };
        const database = await answered(opening, one.name);
        try {
          if (stores.length === 0) {
            continue;
          }
          const writing = database.transaction(
            stores.map((store) => store.name),
            "readwrite",
          );
          const written = new Promise((done, failed) => {
            writing.oncomplete = () => done();
            writing.onabort = () =>
              failed(writing.error ?? new Error(`${one.name} was not written`));
          });
          // What fails below is what is told.
          written.catch(() => {});
          for (const store of stores) {
            const into = writing.objectStore(store.name);
            for (const [key, value] of store.records) {
              // A store that finds the key in the value takes none beside it.
              into.put(value, into.keyPath === null ? key : undefined);
            }
          }
          await written;
        } finally {
          database.close();
        }
      }
    },
  };

  // An answer a cache does not let be read, as one from another site that did not say it
  // may be, is not carried.
  const caches_ = {
    read: async (limit) => {
      const found = [];
      for (const name of typeof caches === "undefined" ? [] : await caches.keys()) {
        const cache = await caches.open(name);
        const entries = [];
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          if (response === undefined) continue;
          if (response.status === 0) {
            throw new Error(`${name}: the answer kept for ${request.url} is not one that is read`);
          }
          const headers = Object.fromEntries(response.headers.entries());
          // The bytes are told as they are, whatever they came as.
          delete headers["content-encoding"];
          delete headers["content-length"];
          entries.push({
            url: request.url,
            requestHeaders: Object.fromEntries(request.headers.entries()),
            status: response.status,
            statusText: response.statusText,
            headers,
            body: toBase64(new Uint8Array(await response.arrayBuffer())),
          });
        }
        found.push({ name, entries });
      }
      return told("caches", found, limit);
    },

    write: async (given) => {
      if (typeof caches === "undefined") {
        throw new Error("a page that is not served securely has no caches");
      }
      for (const one of given) {
        await caches.delete(one.name);
        const cache = await caches.open(one.name);
        for (const entry of one.entries ?? []) {
          const empty = [204, 205, 304].includes(entry.status);
          await cache.put(
            new Request(entry.url, { headers: entry.requestHeaders ?? {} }),
            new Response(empty ? null : fromBase64(entry.body ?? ""), {
              status: entry.status ?? 200,
              statusText: entry.statusText ?? "",
              headers: entry.headers ?? {},
            }),
          );
        }
      }
    },
  };

  const root = () => {
    if (typeof navigator.storage?.getDirectory !== "function") {
      throw new Error("a page that is not served securely has no files of its own");
    }
    return navigator.storage.getDirectory();
  };

  // A directory goes as its path alone, which says something of one that is empty.
  const files = {
    read: async (limit) => {
      const found = [];
      const walk = async (directory, prefix) => {
        let any = false;
        for await (const [name, handle] of directory.entries()) {
          any = true;
          const at = prefix === "" ? name : `${prefix}/${name}`;
          if (handle.kind === "directory") {
            await walk(handle, at);
          } else {
            const file = await handle.getFile();
            found.push({ path: at, body: toBase64(new Uint8Array(await file.arrayBuffer())) });
          }
        }
        if (!any && prefix !== "") found.push({ path: prefix });
      };
      if (typeof navigator.storage?.getDirectory === "function") {
        await walk(await navigator.storage.getDirectory(), "");
      }
      return told("files", found, limit);
    },

    write: async (given) => {
      const top = await root();
      for (const one of given) {
        const parts = String(one.path).split("/");
        if (parts.some((part) => part === "" || part === "." || part === "..")) {
          throw new Error(`${one.path} is no path of a file`);
        }
        const name = one.body === undefined ? undefined : parts.pop();
        let directory = top;
        for (const part of parts) {
          directory = await directory.getDirectoryHandle(part, { create: true });
        }
        if (name === undefined) continue;
        const file = await directory.getFileHandle(name, { create: true });
        const writing = await file.createWritable();
        await writing.write(fromBase64(one.body));
        await writing.close();
      }
    },
  };

  // What the origin stores, as a state has it for an origin: its local storage, and of
  // the rest what is asked for, each kind in no more than `limit` letters.
  const take = async (asked, limit) =>
    JSON.stringify({
      localStorage: Object.keys(localStorage).map((name) => ({
        name,
        value: localStorage.getItem(name),
      })),
      indexedDB: asked.indexedDB ? JSON.parse(await databases.read(limit)) : [],
      cacheStorage: asked.cacheStorage ? JSON.parse(await caches_.read(limit)) : [],
      opfs: asked.opfs ? JSON.parse(await files.read(limit)) : [],
    });

  // Local storage in place of what the origin had; a database, a cache and a file each in
  // place of the origin's one of that name.
  const put = async (given) => {
    localStorage.clear();
    for (const { name, value } of given.localStorage ?? []) localStorage.setItem(name, value);
    if (given.indexedDB?.length > 0) await databases.write(given.indexedDB);
    if (given.cacheStorage?.length > 0) await caches_.write(given.cacheStorage);
    if (given.opfs?.length > 0) await files.write(given.opfs);
  };

  return { encode, decode, databases, caches: caches_, files, take, put };
})()
