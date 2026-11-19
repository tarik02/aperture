import { useId, useState } from "react";
import { Maximize2 } from "lucide-react";
import type {
  Picture,
  PictureWay,
  Target,
  VideoFormat,
  VideoQuality,
} from "@aperture-browser/session-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
} from "@aperture-browser/ui/components/dropdown-menu";
import { Input } from "@aperture-browser/ui/components/input";
import { useLease, useSession, useSessionSnapshot } from "../session.tsx";
import { Described, SettingSubTrigger } from "./menu-parts.tsx";

const AUTO = "auto";

const WAYS: readonly { way: PictureWay; label: string; detail: string }[] = [
  { way: "video", label: "WebRTC", detail: "Video on a connection of its own." },
  { way: "frames", label: "Frames", detail: "The same video on the session socket." },
  { way: "tiles", label: "Tiles", detail: "Lossless parts of the picture as they change." },
];

const FORMATS: Readonly<Record<VideoFormat, string>> = {
  h264: "H.264",
  "full-chroma": "H.264 4:4:4",
  h265: "H.265",
  vp9: "VP9",
  "vp9-full-chroma": "VP9 4:4:4",
  av1: "AV1",
};

const QUALITIES: Readonly<Record<VideoQuality, string>> = {
  low: "Low",
  medium: "Medium",
  full: "Full",
};

const FRAME_RATES = [15, 30, 60];

const VIEWPORTS = [
  { width: 1280, height: 720, label: "1280 × 720" },
  { width: 1920, height: 1080, label: "1920 × 1080" },
  { width: 1440, height: 900, label: "1440 × 900" },
  { width: 1024, height: 768, label: "1024 × 768" },
  { width: 768, height: 1024, label: "768 × 1024", detail: "Tablet" },
  { width: 390, height: 844, label: "390 × 844", detail: "Phone" },
];

const SCALES = [1, 1.25, 1.5, 2, 3];

const VIEWPORT_LIMITS = { min: 100, max: 8192 };

const isWay = (value: unknown): value is PictureWay => WAYS.some((one) => one.way === value);

const isFormat = (value: unknown): value is VideoFormat =>
  typeof value === "string" && value in FORMATS;

const isQuality = (value: unknown): value is VideoQuality =>
  typeof value === "string" && value in QUALITIES;

/** What the session says it sends, in a line. */
export function pictureStatus(picture: Picture): string {
  const way = WAYS.find((one) => one.way === picture.way)?.label ?? picture.way;
  if (picture.way === "tiles") {
    return way;
  }
  if (picture.way === "video" && picture.rtc !== undefined && picture.rtc !== "connected") {
    return `${way} · ${picture.rtc}`;
  }
  const { status } = picture;
  if (status === undefined) {
    return way;
  }
  const parts = [
    way,
    status.format === undefined ? undefined : FORMATS[status.format],
    status.quality === undefined ? undefined : QUALITIES[status.quality].toLowerCase(),
    `${status.fps} fps`,
  ];
  return parts.filter((part) => part !== undefined).join(" · ");
}

/** How the picture comes, and the size and scale of the watched target's viewport. */
/** How the picture comes: its transport, codec, quality and frame rate. */
export function PictureItems() {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { picture } = snapshot;
  const open = snapshot.connection.state === "open";
  const encoded = picture.way !== "tiles";
  const { status, settings } = picture;

  // A choice left to the session shows what the session chose.
  const chosen = (set: string | undefined, told: string | undefined) => {
    if (set !== undefined) {
      return set;
    }
    return told === undefined ? "Auto" : `Auto · ${told}`;
  };

  return (
    <>
      <DropdownMenuLabel>
        <span className="aperture:flex aperture:flex-col aperture:gap-0.5">
          <span>Picture</span>
          <span
            data-picture-status=""
            className="aperture:font-normal aperture:text-foreground aperture:tabular-nums"
          >
            {open ? pictureStatus(picture) : "Not connected"}
          </span>
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSub>
        <SettingSubTrigger
          name="Transport"
          value={WAYS.find((one) => one.way === picture.way)?.label}
        />
        <DropdownMenuSubContent className="aperture:w-64">
          <DropdownMenuRadioGroup
            aria-label="How the picture comes"
            value={picture.way}
            onValueChange={(value) => {
              if (isWay(value)) {
                session.setPicture({ way: value });
              }
            }}
          >
            {WAYS.map(({ way, label, detail }) => (
              <DropdownMenuRadioItem
                key={way}
                value={way}
                disabled={!picture.ways.includes(way)}
                closeOnClick={false}
              >
                <Described title={label}>
                  {picture.ways.includes(way) ? detail : "This browser cannot show it."}
                </Described>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <SettingSubTrigger
          name="Codec"
          disabled={!encoded}
          value={
            encoded
              ? chosen(
                  settings.format === undefined ? undefined : FORMATS[settings.format],
                  status?.format === undefined ? undefined : FORMATS[status.format],
                )
              : "None"
          }
        />
        <DropdownMenuSubContent className="aperture:w-48">
          <DropdownMenuRadioGroup
            aria-label="Codec"
            value={settings.format ?? AUTO}
            onValueChange={(value) =>
              session.setPicture({ format: isFormat(value) ? value : undefined })
            }
          >
            <DropdownMenuRadioItem value={AUTO} closeOnClick={false}>
              Auto
            </DropdownMenuRadioItem>
            {Object.entries(FORMATS).map(([format, label]) => (
              <DropdownMenuRadioItem
                key={format}
                value={format}
                disabled={!isFormat(format) || !picture.formats.includes(format)}
                closeOnClick={false}
              >
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <SettingSubTrigger
          name="Quality"
          disabled={!encoded}
          value={
            encoded
              ? chosen(
                  settings.quality === undefined ? undefined : QUALITIES[settings.quality],
                  status?.quality === undefined ? undefined : QUALITIES[status.quality],
                )
              : "Lossless"
          }
        />
        <DropdownMenuSubContent className="aperture:w-64">
          <DropdownMenuRadioGroup
            aria-label="Quality"
            value={settings.quality ?? AUTO}
            onValueChange={(value) =>
              session.setPicture({ quality: isQuality(value) ? value : undefined })
            }
          >
            <DropdownMenuRadioItem value={AUTO} closeOnClick={false}>
              <Described title="Auto">As much as the link carries.</Described>
            </DropdownMenuRadioItem>
            {Object.entries(QUALITIES).map(([quality, label]) => (
              <DropdownMenuRadioItem key={quality} value={quality} closeOnClick={false}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <SettingSubTrigger
          name="Frame rate"
          disabled={!encoded}
          value={
            encoded
              ? chosen(
                  settings.fps === undefined ? undefined : `${settings.fps} fps`,
                  status === undefined ? undefined : `${status.fps} fps`,
                )
              : "As it changes"
          }
        />
        <DropdownMenuSubContent className="aperture:w-40">
          <DropdownMenuRadioGroup
            aria-label="Frames a second at most"
            value={settings.fps === undefined ? AUTO : String(settings.fps)}
            onValueChange={(value) =>
              session.setPicture({ fps: value === AUTO ? undefined : Number(value) })
            }
          >
            <DropdownMenuRadioItem value={AUTO} closeOnClick={false}>
              Auto
            </DropdownMenuRadioItem>
            {FRAME_RATES.map((fps) => (
              <DropdownMenuRadioItem key={fps} value={String(fps)} closeOnClick={false}>
                {fps} fps
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

/** The watched tab's viewport: whether it fits this window, its size and its scale. */
export function ViewportItems() {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const lease = useLease();
  const watched = snapshot.targets.find((target) => target.id === snapshot.selected);
  const open = snapshot.connection.state === "open";
  const resizes = open && lease.givesInput && watched !== undefined;

  return (
    <>
      <DropdownMenuLabel>Viewport</DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        checked={snapshot.fit}
        disabled={!resizes}
        closeOnClick={false}
        onCheckedChange={(fit) => {
          if (fit) {
            session.setViewport("fit");
          } else if (watched !== undefined) {
            // Says the size the target has, which ends the fitting and changes nothing else.
            session.setViewport({ width: watched.width, height: watched.height });
          }
        }}
      >
        <Maximize2 />
        Fit to this window
      </DropdownMenuCheckboxItem>
      <DropdownMenuSub>
        <SettingSubTrigger
          name="Size"
          disabled={!resizes}
          value={watched === undefined ? "" : `${watched.width} × ${watched.height}`}
        />
        <DropdownMenuSubContent className="aperture:w-60">
          <DropdownMenuRadioGroup
            aria-label="Size of the viewport"
            value={watched === undefined || snapshot.fit ? "" : sizeId(watched)}
            onValueChange={(value) => {
              const preset = VIEWPORTS.find((one) => sizeId(one) === value);
              if (preset !== undefined) {
                session.setViewport({ width: preset.width, height: preset.height });
              }
            }}
          >
            {VIEWPORTS.map((preset) => (
              <DropdownMenuRadioItem
                key={sizeId(preset)}
                value={sizeId(preset)}
                closeOnClick={false}
              >
                <span className="aperture:tabular-nums">{preset.label}</span>
                {preset.detail === undefined ? null : (
                  <span className="aperture:text-xs aperture:text-muted-foreground">
                    {preset.detail}
                  </span>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {watched === undefined ? null : (
            <CustomViewport
              key={sizeId(watched)}
              target={watched}
              onApply={(width, height) => session.setViewport({ width, height })}
            />
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <SettingSubTrigger
          name="Scale"
          disabled={!resizes}
          value={watched === undefined ? "" : `${formatScale(watched.scale)}x`}
        />
        <DropdownMenuSubContent className="aperture:w-40">
          <DropdownMenuRadioGroup
            aria-label="Pixels to a logical pixel"
            value={watched === undefined ? "" : formatScale(watched.scale)}
            onValueChange={(value) => session.setScale(Number(value))}
          >
            {SCALES.map((scale) => (
              <DropdownMenuRadioItem key={scale} value={formatScale(scale)} closeOnClick={false}>
                {formatScale(scale)}x
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

function CustomViewport({
  target,
  onApply,
}: {
  target: Target;
  onApply: (width: number, height: number) => void;
}) {
  const [width, setWidth] = useState(String(target.width));
  const [height, setHeight] = useState(String(target.height));
  const size = parseSize(width, height);
  const unchanged = size?.width === target.width && size.height === target.height;

  return (
    <div
      className="aperture:grid aperture:gap-2 aperture:px-1.5 aperture:py-1.5"
      // Typing a size is not the menu's typeahead, and a click in a field closes nothing.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenuLabel className="aperture:px-0">Custom</DropdownMenuLabel>
      <div className="aperture:grid aperture:grid-cols-2 aperture:gap-2">
        <SizeField label="Width" value={width} onChange={setWidth} />
        <SizeField label="Height" value={height} onChange={setHeight} />
      </div>
      <Button
        type="button"
        size="sm"
        className="aperture:h-7"
        disabled={size === undefined || unchanged}
        onClick={() => {
          if (size !== undefined) {
            onApply(size.width, size.height);
          }
        }}
      >
        Apply
      </Button>
    </div>
  );
}

function SizeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="aperture:grid aperture:gap-1">
      <label htmlFor={id} className="aperture:text-xs aperture:text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value.replaceAll(/\D/gu, ""))}
        onFocus={(event) => event.currentTarget.select()}
        className="aperture:h-7 aperture:tabular-nums"
      />
    </div>
  );
}

function parseSize(width: string, height: string) {
  if (width === "" || height === "") {
    return undefined;
  }
  const clamp = (side: number) =>
    Math.min(Math.max(Math.round(side), VIEWPORT_LIMITS.min), VIEWPORT_LIMITS.max);
  return { width: clamp(Number(width)), height: clamp(Number(height)) };
}

function sizeId(size: { width: number; height: number }): string {
  return `${size.width}x${size.height}`;
}

function formatScale(scale: number): string {
  return String(Math.round(scale * 100) / 100);
}
