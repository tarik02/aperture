//! The browser a runner downloads for itself where it is named none: the release's own
//! Chromium, with everything it loads, as a closure of the Nix store. It is kept as
//! `nix/store` in a directory of the cache for each release, and its sandbox is shown that
//! as `/nix/store`, over the machine's own.

use std::path::{Path, PathBuf};

use anyhow::Context;

/// Where the browser of release `version` is kept.
pub fn dir(version: &str) -> anyhow::Result<PathBuf> {
    Ok(aperture_release::cache_dir()?
        .join("chromium")
        .join(version))
}

/// Downloads the browser of release `version`, this runner's own by default, unless it is
/// there already. Gives where it is.
pub async fn install(version: Option<&str>) -> anyhow::Result<PathBuf> {
    let client = aperture_release::client()?;
    let version =
        aperture_release::resolve(&client, version.unwrap_or(aperture_release::VERSION)).await?;
    let dir = dir(&version)?;
    let name = format!(
        "aperture-chromium-{version}-linux-{}.tar.zst",
        aperture_release::arch()?
    );
    aperture_release::unpack(&client, &version, &name, &dir).await?;
    Ok(dir)
}

/// The browser kept in `dir`: the program as its sandbox sees it, and the store it is in.
pub fn chromium(dir: &Path) -> anyhow::Result<(PathBuf, PathBuf)> {
    let named = dir.join("chromium");
    let program = std::fs::read_to_string(&named)
        .with_context(|| format!("failed to read {}", named.display()))?;
    let store = dir.join("nix/store");
    let program = PathBuf::from(program.trim());
    let within = program
        .strip_prefix("/nix/store")
        .with_context(|| format!("{} names no program of the store", named.display()))?;
    anyhow::ensure!(
        store.join(within).is_file(),
        "{} is not in {}",
        program.display(),
        store.display()
    );
    Ok((program, store))
}
