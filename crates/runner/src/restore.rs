//! Whether the session is being given what its browser starts with: a storage state that
//! is put into it once it runs. Until all of it is in, the session is not what it was
//! asked to be: whoever watches is told so, and nothing is done in it meanwhile.

use tokio::sync::watch;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Restore {
    /// Nothing is put in.
    #[default]
    None,
    /// A state is on its way or being put in: so many tabs, cookies and origins, which is
    /// none of each until the state has come.
    Underway { tabs: u32, cookies: u32, origins: u32 },
    /// The state the session was to start with was not taken.
    Failed(String),
}

/// What the session says of it, for whoever puts a state in and whoever is told.
#[derive(Clone)]
pub struct Restoring(watch::Sender<Restore>);

impl Restoring {
    /// `awaited`: whoever started the session puts a state in next.
    pub fn new(awaited: bool) -> Self {
        Self(watch::Sender::new(if awaited {
            Restore::Underway {
                tabs: 0,
                cookies: 0,
                origins: 0,
            }
        } else {
            Restore::None
        }))
    }

    pub fn get(&self) -> Restore {
        self.0.borrow().clone()
    }

    /// Whether anything is held until a state is in.
    pub fn held(&self) -> bool {
        *self.0.borrow() != Restore::None
    }

    /// Tells of it as it is and whenever it changes.
    pub fn watch(&self) -> watch::Receiver<Restore> {
        self.0.subscribe()
    }

    pub fn set(&self, restore: Restore) {
        self.0.send_replace(restore);
    }
}
