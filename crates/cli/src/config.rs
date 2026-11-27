//! What `aperture login` keeps: the control plane's address and an API token of it.

use std::{fs, io::Write, path::PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub url: String,
    pub token: String,
}

fn path() -> anyhow::Result<PathBuf> {
    let dir = dirs::config_dir().context("this system has no configuration directory")?;
    Ok(dir.join("aperture").join("config.json"))
}

/// What is kept, with `APERTURE_URL` and `APERTURE_TOKEN` over it.
pub fn read() -> anyhow::Result<Config> {
    let path = path()?;
    let kept: Option<Config> = match fs::read(&path) {
        Ok(read) => Some(
            serde_json::from_slice(&read)
                .with_context(|| format!("failed to read {}", path.display()))?,
        ),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err).with_context(|| format!("failed to read {}", path.display())),
    };
    let told = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let url = told("APERTURE_URL").or_else(|| kept.as_ref().map(|kept| kept.url.clone()));
    let token = told("APERTURE_TOKEN").or_else(|| kept.as_ref().map(|kept| kept.token.clone()));
    match (url, token) {
        (Some(url), Some(token)) => Ok(Config {
            url: url.trim_end_matches('/').to_owned(),
            token,
        }),
        _ => anyhow::bail!("not logged in: run `aperture login <url>`"),
    }
}

/// Keeps `config`, readable by this user alone. Gives where.
pub fn write(config: &Config) -> anyhow::Result<PathBuf> {
    let path = path()?;
    let dir = path.parent().expect("the file is in a directory");
    fs::create_dir_all(dir).with_context(|| format!("failed to make {}", dir.display()))?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(&path)
        .and_then(|mut file| file.write_all(&serde_json::to_vec_pretty(config)?))
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(path)
}
