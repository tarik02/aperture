import { useEffect, useState } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { RecordingSettings } from "@aperture-browser/api-client";

const STORAGE_KEY = "aperture.workbench.recordingSettings";
const storedSettings = Schema.fromJsonString(RecordingSettings);
const decodeSettings = Schema.decodeUnknownOption(storedSettings);
const encodeSettings = Schema.encodeSync(storedSettings);

export function useRecordingSettings() {
  const [settings, setSettings] = useState<RecordingSettings>({ capture: "continuous" });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        const decoded = decodeSettings(stored);
        if (Option.isSome(decoded)) {
          setSettings(decoded.value);
        }
      }
    } catch {
      // Browser storage can be disabled; the current page still keeps its preferences.
    }
  }, []);

  function updateSettings(next: RecordingSettings) {
    const encoded = encodeSettings(next);
    setSettings(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, encoded);
    } catch {
      // Keep the preference for this page when storage is unavailable.
    }
  }

  return { settings, updateSettings };
}
