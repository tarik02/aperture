//! The native messaging host of the session's extension: Chromium starts it inside the
//! sandbox and talks to it on stdin and stdout, and it passes both on, as they are, to the
//! runner's socket.

use std::{
    io::{self, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    process::ExitCode,
};

fn main() -> ExitCode {
    let Some(socket) = std::env::var_os("APERTURE_EXTENSION_SOCKET") else {
        eprintln!("APERTURE_EXTENSION_SOCKET is not set");
        return ExitCode::FAILURE;
    };
    let stream = match UnixStream::connect(&socket) {
        Ok(stream) => stream,
        Err(err) => {
            eprintln!("failed to connect to the session: {err}");
            return ExitCode::FAILURE;
        }
    };

    let mut to_session = match stream.try_clone() {
        Ok(stream) => stream,
        Err(err) => {
            eprintln!("failed to connect to the session: {err}");
            return ExitCode::FAILURE;
        }
    };
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut to_session);
        // The extension is gone.
        let _ = to_session.shutdown(Shutdown::Both);
    });

    let mut from_session = stream;
    let mut stdout = io::stdout().lock();
    let mut buffer = [0; 64 * 1024];
    loop {
        match from_session.read(&mut buffer) {
            Ok(0) | Err(_) => return ExitCode::SUCCESS,
            // Standard output buffers lines, and messages have none.
            Ok(read) => {
                if stdout
                    .write_all(&buffer[..read])
                    .and_then(|()| stdout.flush())
                    .is_err()
                {
                    return ExitCode::SUCCESS;
                }
            }
        }
    }
}
