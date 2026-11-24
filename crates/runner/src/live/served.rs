//! A file of the session's, as it is answered with. What is in the session's files is what
//! its pages made of them, so a file is answered with as one to keep and never as a
//! document: whoever is sent to its address has it saved, and what shows it in a page of
//! its own, as a picture or a video, is not held from that.

use std::{io::SeekFrom, ops::Range};

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

/// What a file is said to be, by the end of its name: of the kinds a page shows without
/// running anything, and bytes otherwise. A page, a drawing that carries script and
/// whatever else a browser would take for a document are bytes.
fn kind(name: &str) -> &'static str {
    let ending = name.rsplit_once('.').map(|(_, ending)| ending);
    match ending.map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("json") => "application/json",
        Some("txt" | "log" | "csv" | "jsonl") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// What of a name goes as it is where a header tells it with its escapes, as RFC 8187 has it.
const TOLD_PLAIN: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The file's name as a header says it: once in what every client reads, with whatever
/// could end it or is not ASCII left out, and once whole.
fn disposition(name: &str) -> HeaderValue {
    let plain: String = name
        .chars()
        .map(|letter| match letter {
            ' ' | '-' | '.' | '_' => letter,
            letter if letter.is_ascii_alphanumeric() => letter,
            _ => '_',
        })
        .collect();
    let whole = utf8_percent_encode(name, TOLD_PLAIN);
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{plain}\"; filename*=UTF-8''{whole}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

/// The part of a file of `size` bytes that is asked for, where one part is: the whole
/// file otherwise, and nothing where the part asked for is not in the file.
fn part(headers: &HeaderMap, size: u64) -> Result<Option<Range<u64>>, ()> {
    let asked = headers
        .get(header::RANGE)
        .and_then(|range| range.to_str().ok())
        .and_then(|range| range.strip_prefix("bytes="))
        .filter(|range| !range.contains(','))
        .and_then(|range| range.split_once('-'));
    let Some((from, to)) = asked else {
        return Ok(None);
    };
    let range = match (from.trim().parse::<u64>(), to.trim().parse::<u64>()) {
        (Ok(from), Ok(to)) if from <= to => from..to.saturating_add(1).min(size),
        (Ok(from), Err(_)) if to.trim().is_empty() => from..size,
        // The file's last bytes.
        (Err(_), Ok(last)) if from.trim().is_empty() && last > 0 => size.saturating_sub(last)..size,
        _ => return Ok(None),
    };
    if range.start >= size {
        return Err(());
    }
    Ok(Some(range))
}

/// Answers with a file that is open, or with the part of it that is asked for.
pub async fn file(
    headers: &HeaderMap,
    mut file: tokio::fs::File,
    name: &str,
) -> std::io::Result<Response> {
    let size = file.metadata().await?.len();
    let told = [
        (header::CONTENT_TYPE, HeaderValue::from_static(kind(name))),
        (header::CONTENT_DISPOSITION, disposition(name)),
        (header::ACCEPT_RANGES, HeaderValue::from_static("bytes")),
    ];
    let Ok(part) = part(headers, size) else {
        let whole = [(header::CONTENT_RANGE, format!("bytes */{size}"))];
        return Ok((StatusCode::RANGE_NOT_SATISFIABLE, told, whole).into_response());
    };
    let Some(part) = part else {
        let length = [(header::CONTENT_LENGTH, size.to_string())];
        let body = Body::from_stream(ReaderStream::new(file.take(size)));
        return Ok((told, length, body).into_response());
    };
    file.seek(SeekFrom::Start(part.start)).await?;
    let length = part.end - part.start;
    let said = [
        (header::CONTENT_LENGTH, length.to_string()),
        (
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{size}", part.start, part.end - 1),
        ),
    ];
    let body = Body::from_stream(ReaderStream::new(file.take(length)));
    Ok((StatusCode::PARTIAL_CONTENT, told, said, body).into_response())
}
