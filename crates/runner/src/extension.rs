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
    // Nothing of an earlier run's extension is left for the browser to load.
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    std::fs::create_dir_all(dir)?;
    // The browser keeps a worker's script with the profile, by the extension's version
    // and the script's name, and runs what it kept whatever is written here since: a
    // session resumed by a later runner would have the worker of an earlier one beside
    // everything else of this one. So a worker that is written differently has another
    // name, under another version.
    let written = FILES
        .iter()
        .flat_map(|(_, content)| content.bytes())
        .fold(17_u32, |sum, byte| {
            sum.wrapping_mul(31).wrapping_add(byte.into())
        });
    let worker = format!("worker.{written:08x}.js");
    for (name, content) in FILES {
        match name {
            "manifest.json" => {
                let manifest = content
                    .replace("\"worker.js\"", &format!("\"{worker}\""))
                    .replace(
                        "\"version\": \"1.0.0\"",
                        // Each part of a version is at most 65535.
                        &format!("\"version\": \"1.{}.{}\"", written >> 16, written & 0xffff),
                    );
                std::fs::write(dir.join(name), manifest)?;
            }
            "worker.js" => std::fs::write(dir.join(&worker), content)?,
            _ => std::fs::write(dir.join(name), content)?,
        }
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
