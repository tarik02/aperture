import { fileURLToPath } from "node:url";

const told = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; the Nix dev shell sets it`);
  }
  return value;
};

/** Where the programs under test are; a debug build of this checkout unless told otherwise. */
export const programs =
  process.env["APERTURE_BIN"] ?? fileURLToPath(new URL("../../target/debug", import.meta.url));

/** The browser the checks watch sessions with, which is the one sessions run. */
export const chromium = () => told("APERTURE_CHROMIUM");

export const ffmpeg = () => told("APERTURE_FFMPEG");
