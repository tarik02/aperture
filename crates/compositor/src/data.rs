//! What clients hand each other through the compositor, on the clipboard or by dragging:
//! the same content in several forms, each named by a MIME type.

use std::sync::Arc;

/// Content in one form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Form {
    /// One of [`KINDS`].
    pub kind: String,
    pub data: Vec<u8>,
}

/// Content in every form it is had in.
pub type Forms = Arc<[Form]>;

/// Text, as UTF-8.
pub const TEXT: &str = "text/plain";

/// The forms that are carried: text, marked-up text, a picture, and files, as the list of
/// their `file://` URIs.
pub const KINDS: [&str; 4] = [TEXT, "text/html", "image/png", "text/uri-list"];

/// What clients call text, the one they prefer first.
const TEXT_NAMES: [&str; 3] = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain"];

/// The most all forms of a content are together, in bytes.
pub const MOST: usize = 8 * 1024 * 1024;

/// The names clients know a form by.
fn names(kind: &str) -> &[&str] {
    match kind {
        TEXT => &TEXT_NAMES,
        _ => KINDS
            .iter()
            .position(|known| *known == kind)
            .map_or(&[], |at| std::slice::from_ref(&KINDS[at])),
    }
}

/// What to tell clients the content is offered as.
pub fn offered(forms: &[Form]) -> Vec<String> {
    forms
        .iter()
        .flat_map(|form| names(&form.kind))
        .map(|name| (*name).to_owned())
        .collect()
}

/// The content in the form a client asked for by `name`.
pub fn asked<'a>(forms: &'a [Form], name: &str) -> Option<&'a [u8]> {
    forms
        .iter()
        .find(|form| names(&form.kind).contains(&name))
        .map(|form| form.data.as_slice())
}

/// The forms to take of what a client offers under `names`: each kind with the name to ask
/// the client for it by.
pub fn taken(offered: &[String]) -> Vec<(&'static str, String)> {
    KINDS
        .iter()
        .filter_map(|kind| {
            let name = names(kind)
                .iter()
                .find(|name| offered.iter().any(|offered| offered == *name))?;
            Some((*kind, (*name).to_owned()))
        })
        .collect()
}
