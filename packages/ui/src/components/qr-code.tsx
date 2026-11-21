import { encode } from "uqr";

import { cn } from "../utils.ts";

type QrCodeProps = Omit<React.ComponentProps<"svg">, "children"> & {
  /** What a camera reads from it. */
  value: string;
  /** What it is, for whoever does not see it. */
  label: string;
};

/** Modules of quiet around the code, which a reader needs to find it. */
const QUIET = 2;

/**
 * A QR code of a text. Always dark on white, whatever the theme: that is what readers
 * are sure to take.
 */
function QrCode({ value, label, className, ...props }: QrCodeProps) {
  const { data, size } = encode(value, { border: QUIET });
  const path = data
    .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : "")))
    .join("");

  return (
    <svg
      data-slot="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn("aperture:size-44 aperture:rounded-lg aperture:bg-white", className)}
      {...props}
    >
      <path d={path} fill="black" />
    </svg>
  );
}

export { QrCode };
