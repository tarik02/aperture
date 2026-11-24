//! What a caller may do in a session, part by part.
//!
//! Watching is every caller's: the picture, the tabs there are, and who else is there.
//! Everything else is an area, which a caller reads, writes, both or neither. The
//! operator's token gives all of it; a ticket gives what it says.

use std::{collections::HashMap, fmt, str::FromStr};

/// A part of what a session does that access is given to by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    /// Write: the pointer, the keyboard and what is dropped go into the tab one holds.
    Input,
    /// Write: tabs are opened, closed, taken elsewhere and given another size.
    Tabs,
    /// Write: a tab is taken from whoever holds it, without asking.
    Lease,
    /// Read: tabs are heard.
    Sound,
    /// Read: what is copied in the session. Write: what is pasted into it.
    Clipboard,
    /// Read: the files put into the session. Write: putting and removing them, and
    /// answering a page that asks for files.
    Uploads,
    /// Read: what the session's browser downloaded.
    Downloads,
    /// Read: recordings and screenshots. Write: making them.
    Recordings,
    /// Write: how the session's browser reaches the network.
    Proxy,
    /// Write: the session's automation.
    Mcp,
    /// Write: its browser's DevTools endpoint.
    Cdp,
    /// Write: attaching a tunnel.
    Tunnel,
}

const AREAS: [(Area, &str); 12] = [
    (Area::Input, "input"),
    (Area::Tabs, "tabs"),
    (Area::Lease, "lease"),
    (Area::Sound, "sound"),
    (Area::Clipboard, "clipboard"),
    (Area::Uploads, "uploads"),
    (Area::Downloads, "downloads"),
    (Area::Recordings, "recordings"),
    (Area::Proxy, "proxy"),
    (Area::Mcp, "mcp"),
    (Area::Cdp, "cdp"),
    (Area::Tunnel, "tunnel"),
];

/// The areas a caller reads and those it writes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Access {
    read: u16,
    write: u16,
}

impl Access {
    /// What the operator's token gives, and what a request has that nobody vouched for on
    /// a socket only the trusted reach.
    pub const ALL: Self = Self {
        read: u16::MAX,
        write: u16::MAX,
    };

    /// This access, and writing `area` too.
    pub fn writing(mut self, area: Area) -> Self {
        self.write |= 1 << area as u16;
        self
    }

    pub fn reads(self, area: Area) -> bool {
        self.read & (1 << area as u16) != 0
    }

    pub fn writes(self, area: Area) -> bool {
        self.write & (1 << area as u16) != 0
    }

    /// The access a ticket's `access` gives: each area by its name, with `r`, `w` or `rw`.
    /// An area that is not known gives nothing, and so does one that says anything else.
    pub fn of(said: &HashMap<String, String>) -> Self {
        let mut access = Self::default();
        for (area, name) in AREAS {
            let given = said.get(name).map(String::as_str).unwrap_or_default();
            if given == "r" || given == "rw" {
                access.read |= 1 << area as u16;
            }
            if given == "w" || given == "rw" {
                access.write |= 1 << area as u16;
            }
        }
        access
    }
}

/// As it is told to the session's runner with a request: `input:w clipboard:rw`.
impl fmt::Display for Access {
    fn fmt(&self, to: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut first = true;
        for (area, name) in AREAS {
            let given = match (self.reads(area), self.writes(area)) {
                (true, true) => "rw",
                (true, false) => "r",
                (false, true) => "w",
                (false, false) => continue,
            };
            if !first {
                to.write_str(" ")?;
            }
            first = false;
            write!(to, "{name}:{given}")?;
        }
        Ok(())
    }
}

impl FromStr for Access {
    type Err = std::convert::Infallible;

    fn from_str(said: &str) -> Result<Self, Self::Err> {
        let grants = said
            .split_whitespace()
            .filter_map(|grant| grant.split_once(':'))
            .map(|(area, given)| (area.to_owned(), given.to_owned()))
            .collect();
        Ok(Self::of(&grants))
    }
}
