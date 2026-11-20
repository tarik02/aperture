//! Runs the browser inside its sandbox, where the loopback is its own, and stands between
//! it and the sockets that lead out:
//!
//! - what the browser sends to its proxy, on a loopback port, goes on to the session's
//!   egress socket, a Unix socket bound into the sandbox;
//! - what comes to the DevTools socket, a Unix socket the shim makes in a directory shared
//!   with the outside, goes on to the browser's DevTools port on that loopback;
//! - the names a browser with a network of its own asks for, on the loopback's DNS port,
//!   go on to the session's socket for them.
//!
//! The browser knows nothing of Unix sockets for any of them; the shim is the adapter.

use hickory_resolver::proto::op::Message;
use std::{
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream, UdpSocket},
    os::unix::{
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    sync::Arc,
};

const USAGE: &str = "usage: aperture-browser-shim PROXY_PORT EGRESS_SOCKET DEVTOOLS_SOCKET \
                     DEVTOOLS_PORT [NAMES_SOCKET] -- BROWSER [ARGUMENT...]";

const DNS_PORT: u16 = 53;
/// What a DNS message over UDP may be long when whoever asks says nothing of it.
const DATAGRAM: usize = 512;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let mut halves = arguments.splitn(2, |argument| argument == "--");
    let (own, browser) = (halves.next().unwrap_or_default(), halves.next());
    let (
        [proxy_port, egress, devtools, devtools_port, names @ ..],
        Some([program, browser_arguments @ ..]),
    ) = (own, browser)
    else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let (Ok(proxy_port), Ok(devtools_port), [] | [_]) = (
        proxy_port.parse::<u16>(),
        devtools_port.parse::<u16>(),
        names,
    ) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };

    let opened = relay(proxy_port, egress.into(), devtools.into(), devtools_port)
        .and_then(|()| names.first().map_or(Ok(()), |names| resolve(names.into())));
    if let Err(err) = opened {
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

/// Takes the names asked for on the loopback to the session's socket for them, which
/// speaks DNS as it is over a stream: each message after its length. A stream is passed
/// on as it is, and a datagram becomes a stream of one question.
fn resolve(names: PathBuf) -> io::Result<()> {
    let streams = TcpListener::bind(("127.0.0.1", DNS_PORT))?;
    let datagrams = Arc::new(UdpSocket::bind(("127.0.0.1", DNS_PORT))?);
    let asked_of = names.clone();
    std::thread::spawn(move || {
        for connection in streams.incoming() {
            let Some(connection) = accepted(connection) else {
                continue;
            };
            let names = asked_of.clone();
            std::thread::spawn(move || match UnixStream::connect(names) {
                Ok(session) => join(connection, session),
                Err(err) => eprintln!("the browser's names have nowhere to go: {err}"),
            });
        }
    });
    std::thread::spawn(move || {
        // As long as a DNS message gets.
        let mut question = [0; u16::MAX as usize];
        loop {
            let Some((length, asker)) = accepted(datagrams.recv_from(&mut question)) else {
                continue;
            };
            let question = question[..length].to_vec();
            let (names, datagrams) = (names.clone(), datagrams.clone());
            std::thread::spawn(move || match answer(&names, &question) {
                // Whoever asked may be gone by now, and asks again when not.
                Ok(answer) => drop(datagrams.send_to(&answer, asker)),
                Err(err) => eprintln!("a name was not asked for: {err}"),
            });
        }
    });
    Ok(())
}

/// The session's answer to one question, as fits a datagram: one that does not is cut
/// down to its question and says so, and whoever asked asks again over a stream.
fn answer(names: &Path, question: &[u8]) -> io::Result<Vec<u8>> {
    let mut session = UnixStream::connect(names)?;
    let length = u16::try_from(question.len()).map_err(io::Error::other)?;
    session.write_all(&length.to_be_bytes())?;
    session.write_all(question)?;
    let mut length = [0; 2];
    session.read_exact(&mut length)?;
    let mut answer = vec![0; u16::from_be_bytes(length).into()];
    session.read_exact(&mut answer)?;
    if answer.len() > DATAGRAM {
        let whole = Message::from_vec(&answer).map_err(io::Error::other)?;
        answer = whole.truncate().to_vec().map_err(io::Error::other)?;
    }
    Ok(answer)
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
