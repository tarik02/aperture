import { parse, stringifyAsync } from "devalue";

interface PortableCryptoKeyAlgorithm {
  name: string;
  hash?: string;
  length?: number;
  namedCurve?: string;
}

interface PortableCryptoKey {
  algorithm: PortableCryptoKeyAlgorithm;
  format: "pkcs8" | "raw" | "spki";
  material: ArrayBuffer;
  usages: KeyUsage[];
}

class PendingCryptoKey {
  constructor(readonly value: PortableCryptoKey) {}
}

const baseRevivers = {
  Blob: ([body, type]: [ArrayBuffer, string]) => new Blob([body], { type }),
  Error: ([name, message, stack, cause]: [string, string, string | undefined, unknown]) => {
    let error: Error;
    switch (name) {
      case "EvalError":
        error = new EvalError(message, { cause });
        break;
      case "RangeError":
        error = new RangeError(message, { cause });
        break;
      case "ReferenceError":
        error = new ReferenceError(message, { cause });
        break;
      case "SyntaxError":
        error = new SyntaxError(message, { cause });
        break;
      case "TypeError":
        error = new TypeError(message, { cause });
        break;
      case "URIError":
        error = new URIError(message, { cause });
        break;
      default:
        error = new Error(message, { cause });
        error.name = name;
    }
    if (stack !== undefined) {
      error.stack = stack;
    }
    return error;
  },
  File: ([body, name, type, lastModified]: [ArrayBuffer, string, string, number]) =>
    new File([body], name, { type, lastModified }),
};

export async function encodeStructuredClone(
  value: unknown,
  allowCryptoKeys: boolean,
): Promise<string> {
  return stringifyAsync(value, {
    CryptoKey: (candidate: unknown) => {
      if (typeof CryptoKey === "undefined" || !(candidate instanceof CryptoKey)) {
        return false;
      }
      if (!allowCryptoKeys) {
        throw new Error("CryptoKey history state cannot be restored before page scripts");
      }
      return exportCryptoKey(candidate);
    },
    Error: (candidate: unknown) =>
      candidate instanceof Error
        ? [candidate.name, candidate.message, candidate.stack, candidate.cause]
        : false,
    File: (candidate: unknown) =>
      typeof File !== "undefined" && candidate instanceof File
        ? candidate
            .arrayBuffer()
            .then((body) => [body, candidate.name, candidate.type, candidate.lastModified])
        : false,
    Blob: (candidate: unknown) =>
      typeof Blob !== "undefined" && candidate instanceof Blob
        ? candidate.arrayBuffer().then((body) => [body, candidate.type])
        : false,
  });
}

export function decodeStructuredClone(encoded: string): unknown {
  return parse(encoded, {
    ...baseRevivers,
    CryptoKey: () => {
      throw new Error("CryptoKey is not supported in synchronous browser state");
    },
  });
}

export async function decodeStructuredCloneAsync(encoded: string): Promise<unknown> {
  const value: unknown = parse(encoded, {
    ...baseRevivers,
    CryptoKey: (key: PortableCryptoKey) => new PendingCryptoKey(key),
  });
  return resolveCryptoKeys(value);
}

async function exportCryptoKey(key: CryptoKey): Promise<PortableCryptoKey> {
  if (!key.extractable) {
    throw new Error("non-extractable CryptoKey values are not portable");
  }
  const format = key.type === "secret" ? "raw" : key.type === "public" ? "spki" : "pkcs8";
  return {
    algorithm: portableCryptoKeyAlgorithm(key.algorithm),
    format,
    material: await crypto.subtle.exportKey(format, key),
    usages: [...key.usages],
  };
}

function portableCryptoKeyAlgorithm(algorithm: KeyAlgorithm): PortableCryptoKeyAlgorithm {
  const result: PortableCryptoKeyAlgorithm = { name: algorithm.name };
  if (["HMAC", "RSA-OAEP", "RSA-PSS", "RSASSA-PKCS1-v1_5"].includes(algorithm.name)) {
    const hashed = algorithm as HmacKeyAlgorithm | RsaHashedKeyAlgorithm;
    result.hash = hashed.hash.name;
    if ("length" in hashed) {
      result.length = hashed.length;
    }
  }
  if (["AES-CBC", "AES-CTR", "AES-GCM", "AES-KW"].includes(algorithm.name)) {
    result.length = (algorithm as AesKeyAlgorithm).length;
  }
  if (["ECDH", "ECDSA"].includes(algorithm.name)) {
    result.namedCurve = (algorithm as EcKeyAlgorithm).namedCurve;
  }
  return result;
}

function cryptoKeyImportAlgorithm(algorithm: PortableCryptoKeyAlgorithm): AlgorithmIdentifier {
  if (algorithm.hash !== undefined) {
    return {
      name: algorithm.name,
      hash: { name: algorithm.hash },
      ...(algorithm.length === undefined ? {} : { length: algorithm.length }),
    } as HmacImportParams | RsaHashedImportParams;
  }
  if (algorithm.namedCurve !== undefined) {
    return { name: algorithm.name, namedCurve: algorithm.namedCurve } as EcKeyImportParams;
  }
  return {
    name: algorithm.name,
    ...(algorithm.length === undefined ? {} : { length: algorithm.length }),
  } as AesKeyAlgorithm;
}

async function resolveCryptoKeys(root: unknown): Promise<unknown> {
  const visited = new Set<object>();
  const imported = new Map<PendingCryptoKey, Promise<CryptoKey>>();

  const visit = async (value: unknown): Promise<unknown> => {
    if (value instanceof PendingCryptoKey) {
      let pending = imported.get(value);
      if (pending === undefined) {
        pending = crypto.subtle.importKey(
          value.value.format,
          value.value.material,
          cryptoKeyImportAlgorithm(value.value.algorithm),
          true,
          value.value.usages,
        );
        imported.set(value, pending);
      }
      return pending;
    }
    if (value === null || typeof value !== "object" || visited.has(value)) {
      return value;
    }
    visited.add(value);

    if (value instanceof Map) {
      const entries = [...value.entries()];
      value.clear();
      for (const [key, item] of entries) {
        value.set(await visit(key), await visit(item));
      }
      return value;
    }
    if (value instanceof Set) {
      const items = [...value.values()];
      value.clear();
      for (const item of items) {
        value.add(await visit(item));
      }
      return value;
    }
    if (value instanceof Error) {
      const cause = Object.getOwnPropertyDescriptor(value, "cause");
      if (cause !== undefined && "value" in cause) {
        Object.defineProperty(value, "cause", { ...cause, value: await visit(cause.value) });
      }
      return value;
    }
    if (
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value) ||
      value instanceof Blob ||
      (typeof CryptoKey !== "undefined" && value instanceof CryptoKey) ||
      value instanceof Date ||
      value instanceof RegExp
    ) {
      return value;
    }
    for (const key of Object.keys(value)) {
      Reflect.set(value, key, await visit(Reflect.get(value, key)));
    }
    return value;
  };

  return visit(root);
}
