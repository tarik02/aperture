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

/** A picture drawn again as a PNG: what it looks like, and nothing else it carried. */
const drawn = async (picture: Blob) => {
  const draw = (source: CanvasImageSource, width: number, height: number) => {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")?.drawImage(source, 0, 0, width, height);
    return canvas.convertToBlob({ type: "image/png" });
  };
  try {
    const bitmap = await createImageBitmap(picture);
    try {
      return await draw(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch {
    // A drawing is decoded by an image element alone, which runs none of its script.
    const url = URL.createObjectURL(picture);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return await draw(image, image.naturalWidth || 300, image.naturalHeight || 150);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
};

/** A picture as the PNG clipboards carry. */
export const png = (picture: Blob) =>
  picture.type === "image/png" ? Promise.resolve(picture) : drawn(picture);

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
 * Copies the old way, which is deprecated and the one way where the clipboard is not a
 * page's to write: the browser is told to copy, and is handed the texts as it does.
 */
const copyOldWay = (texts: ReadonlyMap<string, string>) => {
  // What is copied without being handed is what is selected, where a browser copies
  // nothing otherwise.
  const from = document.createElement("textarea");
  from.value = texts.get("text/plain") ?? "";
  document.body.append(from);
  from.focus();
  from.select();
  let handed = false;
  // Before anything of the page hears of it, whatever has the keyboard by now.
  const hand = (event: ClipboardEvent) => {
    for (const [type, text] of texts) {
      event.clipboardData?.setData(type, text);
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    handed = true;
  };
  window.addEventListener("copy", hand, { capture: true });
  const copied = document.execCommand("copy");
  window.removeEventListener("copy", hand, { capture: true });
  from.remove();
  return copied && (handed || from.value !== "");
};

/**
 * Copies in a click what `write` could not: text is copied the old way, and a picture
 * opens to be copied by hand.
 *
 * What the session copied is what a page there made of it, and nothing of it is opened
 * as it came: a document made of it here would be this page's own, and run as whoever
 * watches. Text stays text, and a picture opens as the PNG it is drawn to.
 */
export const writeByHand = async (forms: readonly ClipboardForm[]) => {
  if (await write(forms)) {
    return true;
  }
  const texts = new Map(
    forms
      .filter((one) => TEXTS.some((type) => type === one.type))
      .map((one) => [one.type, new TextDecoder().decode(one.data)]),
  );
  const marked = texts.get("text/html");
  if (marked !== undefined && !texts.has("text/plain")) {
    // Parsed to be read, in a document that runs and loads nothing.
    const read = new DOMParser().parseFromString(marked, "text/html");
    for (const unread of read.querySelectorAll("script, style, template")) {
      unread.remove();
    }
    texts.set("text/plain", read.body.textContent ?? "");
  }
  if (texts.size > 0) {
    return copyOldWay(texts);
  }
  const picture = forms.find((one) => one.type.startsWith("image/"));
  if (picture === undefined) {
    return false;
  }
  try {
    window.open(URL.createObjectURL(await drawn(blobOf(picture))));
    return true;
  } catch {
    return false;
  }
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
