import type { ClipboardForm } from "./model.ts";

/** The forms of text a clipboard carries. */
const TEXTS = ["text/plain", "text/html"] as const;

/** What of the session's clipboard a clipboard here takes. */
const TAKEN = /^(?:text\/(?:plain|html)|image\/.+)$/u;

export const form = async (type: string, blob: Blob): Promise<ClipboardForm> => ({
  type,
  data: new Uint8Array(await blob.arrayBuffer()),
});

export const textForm = (type: string, text: string): ClipboardForm => ({
  type,
  data: new TextEncoder().encode(text),
});

const blobOf = (one: ClipboardForm) => new Blob([new Uint8Array(one.data)], { type: one.type });

/** A picture as the PNG clipboards carry. */
export const png = async (picture: Blob) => {
  if (picture.type === "image/png") {
    return picture;
  }
  const bitmap = await createImageBitmap(picture);
  const drawn = new OffscreenCanvas(bitmap.width, bitmap.height);
  drawn.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return drawn.convertToBlob({ type: "image/png" });
};

const blobs = async (forms: readonly ClipboardForm[]) => {
  const taken = forms.filter((one) => TAKEN.test(one.type));
  const had = await Promise.all(
    taken.map(async (one): Promise<[string, Blob]> => {
      const blob = blobOf(one);
      return one.type.startsWith("image/") ? ["image/png", await png(blob)] : [one.type, blob];
    }),
  );
  return Object.fromEntries(had);
};

/**
 * Puts what the session copied on the clipboard here, which a browser lets a page do at
 * any time or only in a click. Tells whether it did.
 */
export const write = async (forms: readonly ClipboardForm[]) => {
  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write === undefined) {
    return false;
  }
  try {
    const had = await blobs(forms);
    if (Object.keys(had).length === 0) {
      return false;
    }
    await navigator.clipboard.write([new ClipboardItem(had)]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Copies in a click what `write` could not: text is copied the old way, and a picture
 * opens to be copied by hand.
 */
export const writeByHand = async (forms: readonly ClipboardForm[]) => {
  if (await write(forms)) {
    return true;
  }
  const text = forms.find((one) => one.type === "text/plain");
  if (text !== undefined) {
    const from = document.createElement("textarea");
    from.value = new TextDecoder().decode(text.data);
    document.body.append(from);
    from.select();
    // Deprecated, and the one way to copy where the clipboard is not a page's to write.
    const copied = document.execCommand("copy");
    from.remove();
    return copied;
  }
  const shown = forms.find((one) => one.type.startsWith("image/") || one.type === "text/html");
  if (shown === undefined) {
    return false;
  }
  window.open(URL.createObjectURL(blobOf(shown)));
  return true;
};

/** What the clipboard here has, where the browser lets a page read it. */
export const read = async (): Promise<ClipboardForm[]> => {
  const items = await navigator.clipboard.read();
  const forms: ClipboardForm[] = [];
  for (const type of [...TEXTS, "image/png"]) {
    const item = items.find((one) => one.types.includes(type));
    if (item !== undefined) {
      forms.push(await form(type, await item.getType(type)));
    }
  }
  return forms;
};

/** The text a paste or a drag carries, in each form it has it. */
export const texts = (carried: DataTransfer): ClipboardForm[] =>
  TEXTS.map((type) => [type, carried.getData(type)] as const)
    .filter(([, text]) => text !== "")
    .map(([type, text]) => textForm(type, text));
