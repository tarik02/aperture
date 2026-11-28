//! `aperture`, a client of Aperture: keeps a control plane's address and a token, lists,
//! makes and deletes its sessions, attaches a tunnel to a session, and runs a session on
//! this machine.

mod config;
mod control;
mod run;
mod tunnel;

use std::{io::IsTerminal, process::ExitCode};

use anyhow::Context;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "aperture", version, about)]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Keeps a control plane's address and an API token for the commands that use one.
    Login {
        /// The control plane, such as `https://aperture.example.com`.
        url: String,
        /// An API token of the control plane, `apc_…`. Asked for when not given.
        #[arg(long, env = "APERTURE_TOKEN", hide_env_values = true)]
        token: Option<String>,
    },
    /// The sessions of the control plane logged in to.
    #[command(subcommand)]
    Sessions(control::Sessions),
    Tunnel(tunnel::Tunnel),
    Run(run::Run),
}

#[tokio::main]
async fn main() -> anyhow::Result<ExitCode> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .with_target(false)
        .without_time()
        .init();
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("nothing installed a provider before");

    match Arguments::parse().command {
        Command::Login { url, token } => {
            let token = match token {
                Some(token) => token,
                None if std::io::stdin().is_terminal() => {
                    rpassword::prompt_password("API token: ").context("failed to read the token")?
                }
                None => {
                    let mut token = String::new();
                    std::io::stdin().read_line(&mut token)?;
                    token
                }
            };
            let config = config::Config {
                url: url.trim().trim_end_matches('/').to_owned(),
                token: token.trim().to_owned(),
            };
            anyhow::ensure!(!config.token.is_empty(), "no token given");
            let account = control::Control::new(config.clone())?
                .get("/account")
                .await?;
            let who = ["name", "email", "id"]
                .iter()
                .find_map(|field| account[field].as_str())
                .unwrap_or("an account");
            let kept = config::write(&config)?;
            println!(
                "logged in to {} as {who}; kept in {}",
                config.url,
                kept.display()
            );
        }
        Command::Sessions(command) => control::sessions(command).await?,
        Command::Tunnel(tunnel) => tunnel::run(tunnel).await?,
        Command::Run(run) => return run::run(run).await,
    }
    Ok(ExitCode::SUCCESS)
}
