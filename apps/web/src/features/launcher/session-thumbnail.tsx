import { GlobeIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@aperture-browser/ui/utils";

/** A page preview that falls back to a globe; a new `src` retries after a failed one. */
export function SessionThumbnail({ src, className }: { src: string | null; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (src === null || failedSrc === src) {
    return (
      <div className="aperture:absolute aperture:inset-0 aperture:flex aperture:items-center aperture:justify-center aperture:bg-muted aperture:text-muted-foreground">
        <GlobeIcon className="aperture:size-6 aperture:opacity-60" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      onError={() => setFailedSrc(src)}
      className={cn(
        "aperture:absolute aperture:inset-0 aperture:size-full aperture:bg-muted aperture:object-cover aperture:object-top aperture:transition-transform aperture:duration-300 aperture:group-hover:scale-[1.03]",
        className,
      )}
    />
  );
}
