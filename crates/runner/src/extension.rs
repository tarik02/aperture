//! The session's extension, which the browser loads: it keeps every page in a window of
//! its own (see `targets`) and takes each tab's sound (see `live::sound`). It is part of
//! this program, and written out for each session.
//!
//! It reaches the runner through a native messaging host, `aperture-native-host`, which
//! Chromium starts inside the sandbox and which passes on what it is given.

use std::path::Path;

use serde_json::{Value, json};

/// The extension's id, which follows from the key in its manifest.
pub const ID: &str = "imdifnnggmlpoochobfcpghdppldpmjl";
/// The name the extension asks Chromium for its native messaging host by.
pub const NATIVE_HOST: &str = "me.tarik02.aperture.session";

const FILES: [(&str, &str); 5] = [
    ("manifest.json", include_str!("../extension/manifest.json")),
    ("worker.js", include_str!("../extension/worker.js")),
    ("marker.html", include_str!("../extension/marker.html")),
    ("taps.html", include_str!("../extension/taps.html")),
    ("taps.js", include_str!("../extension/taps.js")),
];

/// Writes the extension to `dir`, for the browser to load. It taps the tabs' sound only
/// where the session is to be heard.
pub fn unpack(dir: &Path, sound: bool) -> std::io::Result<()> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir)?;
    for (name, content) in FILES {
        std::fs::write(dir.join(name), content)?;
    }
    std::fs::write(
        dir.join("options.json"),
        json!({ "sound": sound }).to_string(),
    )?;
    Ok(())
}

/// The manifest that tells Chromium where the extension's native messaging host is.
pub fn native_host_manifest(host: &Path) -> Value {
    json!({
        "name": NATIVE_HOST,
        "description": "Aperture's bridge to the session's extension",
        "path": host,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{ID}/")],
    })
}
