//! Runs the browser inside its sandbox, where there is no network but a loopback of its
//! own, and stands between it and the two sockets that lead out:
//!
//! - what the browser sends to its proxy, on a loopback port, goes on to the session's
//!   egress socket, a Unix socket bound into the sandbox;
//! - what comes to the DevTools socket, a Unix socket the shim makes in a directory shared
//!   with the outside, goes on to the browser's DevTools port on that loopback.
//!
//! The browser knows nothing of Unix sockets for either; the shim is the adapter.

use std::{
    io,
    net::{Shutdown, TcpListener, TcpStream},
    os::unix::{
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::PathBuf,
    process::{Command, ExitCode},
};

const USAGE: &str = "usage: aperture-browser-shim PROXY_PORT EGRESS_SOCKET DEVTOOLS_SOCKET \
                     DEVTOOLS_PORT -- BROWSER [ARGUMENT...]";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let [
        proxy_port,
        egress,
        devtools,
        devtools_port,
        separator,
        browser @ ..,
    ] = &arguments[..]
    else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let (Ok(proxy_port), Ok(devtools_port), "--", [program, browser_arguments @ ..]) = (
        proxy_port.parse::<u16>(),
        devtools_port.parse::<u16>(),
        separator.as_str(),
        browser,
    ) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };

    if let Err(err) = relay(proxy_port, egress.into(), devtools.into(), devtools_port) {
        eprintln!("failed to open the browser's ways out: {err}");
        return ExitCode::FAILURE;
    }

    let mut command = Command::new(program);
    command.args(browser_arguments);
    // Safety: `prctl` is async-signal-safe, and nothing else runs between fork and exec.
    unsafe {
        command.pre_exec(|| {
            // The browser is nothing without its shim.
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    match command.status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(err) => {
            eprintln!("failed to start the browser: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Starts both relays; they run for as long as the shim does.
fn relay(
    proxy_port: u16,
    egress: PathBuf,
    devtools: PathBuf,
    devtools_port: u16,
) -> io::Result<()> {
    let outbound = TcpListener::bind(("127.0.0.1", proxy_port))?;
    std::thread::spawn(move || {
        for connection in outbound.incoming() {
            let Some(connection) = accepted(connection) else {
                continue;
            };
            let egress = egress.clone();
            std::thread::spawn(move || match UnixStream::connect(egress) {
                Ok(out) => {
                    // Without it the connection is only slower.
                    let _ = connection.set_nodelay(true);
                    join(connection, out);
                }
                Err(err) => eprintln!("the browser has no way out: {err}"),
            });
        }
    });

    // The socket an earlier run left; binding says what else is in the way.
    let _ = std::fs::remove_file(&devtools);
    let inbound = UnixListener::bind(devtools)?;
    std::thread::spawn(move || {
        for connection in inbound.incoming() {
            let Some(connection) = accepted(connection) else {
                continue;
            };
            std::thread::spawn(move || {
                // Refused until the browser listens; whoever connects tries again.
                if let Ok(browser) = TcpStream::connect(("127.0.0.1", devtools_port)) {
                    let _ = browser.set_nodelay(true);
                    join(browser, connection);
                }
            });
        }
    });
    Ok(())
}

/// A connection a listener took; none, and a word of why, for one it failed to take. The
/// wait keeps a listener that fails over and over from spinning.
fn accepted<T>(connection: io::Result<T>) -> Option<T> {
    match connection {
        Ok(connection) => Some(connection),
        Err(err) => {
            eprintln!("a connection was not taken: {err}");
            std::thread::sleep(std::time::Duration::from_millis(100));
            None
        }
    }
}

/// Passes bytes both ways until both sides are done; one side being done is passed on as
/// such, so that the other may still finish what it sends.
fn join(tcp: TcpStream, unix: UnixStream) {
    let (mut tcp_read, mut unix_read) = match (tcp.try_clone(), unix.try_clone()) {
        (Ok(tcp_read), Ok(unix_read)) => (tcp_read, unix_read),
        (Err(err), _) | (_, Err(err)) => {
            eprintln!("a connection was not passed on: {err}");
            return;
        }
    };
    let (mut tcp_write, mut unix_write) = (tcp, unix);
    // A side that fails is done: the other is told so, as when it ends.
    let up = std::thread::spawn(move || {
        let _ = io::copy(&mut tcp_read, &mut unix_write);
        let _ = unix_write.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut unix_read, &mut tcp_write);
    let _ = tcp_write.shutdown(Shutdown::Write);
    let _ = up.join();
}
