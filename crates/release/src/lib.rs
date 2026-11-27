//! The files a release of Aperture publishes beside its images, and fetching them: each is
//! checked against the release's `SHA256SUMS` before it is used, and a `.tar.zst` is
//! unpacked where it is kept from then on.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{Context, bail};
use reqwest::Client;
use sha2::{Digest, Sha256};
use tracing::info;

pub const REPOSITORY: &str = "tarik02/aperture";

/// The version this was built as, which is the release the other files of it are in.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The machine's architecture as the release's files name it.
pub fn arch() -> anyhow::Result<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("amd64"),
        "aarch64" => Ok("arm64"),
        other => bail!("no release is built for {other}"),
    }
}

/// Where what is fetched is kept: `$XDG_CACHE_HOME/aperture`, or `~/.cache/aperture`.
pub fn cache_dir() -> anyhow::Result<PathBuf> {
    let home = || std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache"));
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(home)
        .context("neither XDG_CACHE_HOME nor HOME is set")?;
    Ok(cache.join("aperture"))
}

/// A client GitHub answers: its API refuses a request that names no agent.
pub fn client() -> reqwest::Result<Client> {
    Client::builder()
        .user_agent(concat!("aperture/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// The version `asked` stands for: `nightly` is the newest nightly's, any other is itself.
pub async fn resolve(client: &Client, asked: &str) -> anyhow::Result<String> {
    if asked != "nightly" {
        return Ok(asked.trim_start_matches('v').to_owned());
    }
    let releases: serde_json::Value = client
        .get(format!(
            "https://api.github.com/repos/{REPOSITORY}/releases?per_page=30"
        ))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let newest = releases.as_array().and_then(|releases| {
        releases.iter().find_map(|release| {
            let tag = release.get("tag_name")?.as_str()?;
            tag.starts_with("v0.0.0-nightly.")
                .then(|| tag[1..].to_owned())
        })
    });
    newest.context("no nightly release found")
}

/// Fetches the file `name` of release `version`, and unpacks the `.tar.zst` it is into
/// `into`, unless something is there already. What is there is whole: it is unpacked
/// beside `into` and given its name once it is.
pub async fn unpack(client: &Client, version: &str, name: &str, into: &Path) -> anyhow::Result<()> {
    if into.exists() {
        return Ok(());
    }
    let parent = into.parent().context("no directory to unpack into")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("failed to make {}", parent.display()))?;
    let base = format!("https://github.com/{REPOSITORY}/releases/download/v{version}");
    let sums = client
        .get(format!("{base}/SHA256SUMS"))
        .send()
        .await?
        .error_for_status()
        .with_context(|| format!("release {version} has no SHA256SUMS"))?
        .text()
        .await?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let (sum, file) = line.split_once(char::is_whitespace)?;
            (file.trim_start().trim_start_matches('*') == name).then(|| sum.to_lowercase())
        })
        .with_context(|| format!("release {version} has no {name}"))?;

    let mut response = client
        .get(format!("{base}/{name}"))
        .send()
        .await?
        .error_for_status()
        .with_context(|| format!("failed to download {name}"))?;
    info!(
        "downloading {name} ({} MB)",
        response.content_length().unwrap_or(0) / 1_000_000
    );
    let download = PathBuf::from(format!(
        "{}.{}.download",
        into.display(),
        std::process::id()
    ));
    let mut file = std::fs::File::create(&download)
        .with_context(|| format!("failed to write {}", download.display()))?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await? {
        hasher.update(&chunk);
        file.write_all(&chunk)?;
    }
    drop(file);
    let got = format!("{:x}", hasher.finalize());
    if got != expected {
        let _ = std::fs::remove_file(&download);
        bail!("{name} is not what SHA256SUMS says: {got} instead of {expected}");
    }

    let unpacking = PathBuf::from(format!("{}.{}.partial", into.display(), std::process::id()));
    let unpacked = {
        let (download, unpacking) = (download.clone(), unpacking.clone());
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let file = std::fs::File::open(&download)?;
            let mut archive = tar::Archive::new(zstd::Decoder::new(file)?);
            archive.set_preserve_permissions(true);
            archive.unpack(&unpacking)?;
            Ok(())
        })
        .await?
    };
    let _ = std::fs::remove_file(&download);
    if let Err(err) = unpacked {
        let _ = std::fs::remove_dir_all(&unpacking);
        return Err(err.context(format!("failed to unpack {name}")));
    }
    match std::fs::rename(&unpacking, into) {
        Ok(()) => Ok(()),
        // Another unpacked it in the meantime.
        Err(_) if into.exists() => {
            let _ = std::fs::remove_dir_all(&unpacking);
            Ok(())
        }
        Err(err) => Err(err).with_context(|| format!("failed to move to {}", into.display())),
    }
}
