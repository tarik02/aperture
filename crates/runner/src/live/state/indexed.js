// Reads and writes an origin's IndexedDB databases from a page of the origin. A key or a
// value that JSON holds as it is goes as `key` and `value`; any other goes encoded, as
// `keyEncoded` and `valueEncoded`:
//
//   { v: "undefined" | "null" | "NaN" | "Infinity" | "-Infinity" | "-0" }
//   { bi: "<bigint>" }  { d: "<date>" }  { r: { p, f } }  { ab: "<base64>" }
//   { ta: { b: "<base64>", k: "ui8" | … } }
//   { a: [...], id }  { o: [{ k, v }], id }  { ref: id }
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

  const encode = (value, seen) => {
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
    for (const [kind, Typed] of Object.entries(typed)) {
      if (value instanceof Typed) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return { ta: { b: toBase64(bytes), k: kind } };
      }
    }
    if (seen.has(value)) return { ref: seen.get(value) };
    const id = seen.size + 1;
    if (Array.isArray(value)) {
      seen.set(value, id);
      return { a: Array.from(value, (one) => encode(one, seen)), id };
    }
    if (Object.getPrototypeOf(value) === Object.prototype) {
      seen.set(value, id);
      return { o: Object.keys(value).map((k) => ({ k, v: encode(value[k], seen) })), id };
    }
    throw new Error(`a ${value.constructor?.name ?? typeof value} is not carried`);
  };

  const named = { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0, null: null };
  const decode = (value, refs) => {
    if (value === null || typeof value !== "object") return value;
    if ("v" in value) return named[value.v];
    if ("bi" in value) return BigInt(value.bi);
    if ("d" in value) return new Date(value.d);
    if ("r" in value) return new RegExp(value.r.p, value.r.f);
    if ("ab" in value) return fromBase64(value.ab).buffer;
    if ("ta" in value) {
      const Typed = typed[value.ta.k];
      if (Typed === undefined) throw new Error(`${value.ta.k} is no kind of array`);
      const bytes = fromBase64(value.ta.b);
      return new Typed(bytes.buffer, 0, bytes.byteLength / Typed.BYTES_PER_ELEMENT);
    }
    if ("ref" in value) return refs.get(value.ref);
    if ("a" in value) {
      const array = [];
      refs.set(value.id, array);
      for (const one of value.a) array.push(decode(one, refs));
      return array;
    }
    if ("o" in value) {
      const object = {};
      refs.set(value.id, object);
      for (const { k, v } of value.o) object[k] = decode(v, refs);
      return object;
    }
    throw new Error("a value is not one that is carried");
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
  const record = (key, value) => ({
    ...(plain(key) ? { key } : { keyEncoded: encode(key, new Map()) }),
    ...(plain(value) ? { value } : { valueEncoded: encode(value, new Map()) }),
  });

  const read = async (limit) => {
    const databases = [];
    for (const { name } of await indexedDB.databases()) {
      const database = await answered(indexedDB.open(name), name);
      try {
        const stores = [];
        const names = [...database.objectStoreNames];
        const reading = names.length === 0 ? undefined : database.transaction(names, "readonly");
        for (const storeName of names) {
          const store = reading.objectStore(storeName);
          const keys = await answered(store.getAllKeys(), name);
          const values = await answered(store.getAll(), name);
          let records;
          try {
            records = keys.map((key, index) => record(key, values[index]));
          } catch (error) {
            throw new Error(`${name}, ${storeName}: ${error.message}`);
          }
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
            records,
          });
        }
        databases.push({ name, version: database.version, stores });
      } finally {
        database.close();
      }
    }
    const told = JSON.stringify(databases);
    if (told.length > limit) {
      throw new Error(`its databases are more than ${limit} bytes`);
    }
    return told;
  };

  const write = async (databases) => {
    for (const given of databases) {
      await answered(indexedDB.deleteDatabase(given.name), given.name);
      const opening = indexedDB.open(given.name, given.version);
      opening.onupgradeneeded = () => {
        for (const store of given.stores) {
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
      const database = await answered(opening, given.name);
      try {
        const stores = given.stores.filter((store) => (store.records ?? []).length > 0);
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
            failed(writing.error ?? new Error(`${given.name} was not written`));
        });
        // What fails below is what is told.
        written.catch(() => {});
        for (const store of stores) {
          const into = writing.objectStore(store.name);
          for (const one of store.records) {
            const value = "valueEncoded" in one ? decode(one.valueEncoded, new Map()) : one.value;
            const key = "keyEncoded" in one ? decode(one.keyEncoded, new Map()) : one.key;
            // A store that finds the key in the value takes none beside it.
            into.put(value, into.keyPath === null ? key : undefined);
          }
        }
        await written;
      } finally {
        database.close();
      }
    }
  };

  return { read, write };
})()
