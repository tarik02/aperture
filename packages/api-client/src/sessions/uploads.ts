import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/unstable/http/HttpBody";
import type { SessionUploadFile } from "./service.ts";

const encoder = new TextEncoder();

// Percent-encodes the characters that would end the quoted filename or the header line,
// as browsers do for FormData.
const quotedFilename = (name: string) =>
  name.replaceAll('"', "%22").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const contentStream = (
  content: SessionUploadFile["content"],
): Stream.Stream<Uint8Array, unknown> => {
  if (content instanceof Blob) {
    return Stream.fromReadableStream({
      evaluate: () => content.stream(),
      onError: (cause) => cause,
    });
  }
  if (content instanceof Uint8Array) {
    return Stream.succeed(content);
  }
  return content;
};

const streamedMultipart = Effect.fn("SessionsApi.streamedMultipart")(function* (
  files: ReadonlyArray<SessionUploadFile>,
) {
  const token = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER);
  const boundary = `aperture-upload-${token.toString(36)}`;
  const parts = files.map((file) => {
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${quotedFilename(file.name)}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n";
    return Stream.succeed(encoder.encode(header)).pipe(
      Stream.concat(contentStream(file.content)),
      Stream.concat(Stream.succeed(encoder.encode("\r\n"))),
    );
  });
  const body = Stream.fromIterable(parts).pipe(
    Stream.flatten(),
    Stream.concat(Stream.succeed(encoder.encode(`--${boundary}--\r\n`))),
  );
  return HttpBody.stream(body, `multipart/form-data; boundary=${boundary}`);
});

/**
 * The multipart body of an upload. FormData works with every fetch, so it is used unless a
 * content is a stream, which needs the body itself to be streamed.
 */
export const uploadBody = Effect.fn("SessionsApi.uploadBody")(function* (
  files: ReadonlyArray<SessionUploadFile>,
) {
  const form = new FormData();
  for (const file of files) {
    if (file.content instanceof Blob) {
      form.append("files", file.content, file.name);
    } else if (file.content instanceof Uint8Array) {
      // Blob takes only views of an ArrayBuffer, not of a SharedArrayBuffer, so copy.
      form.append("files", new Blob([new Uint8Array(file.content)]), file.name);
    } else {
      return yield* streamedMultipart(files);
    }
  }
  return HttpBody.formData(form);
});
