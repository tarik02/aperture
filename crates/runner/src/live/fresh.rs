//! What is made for each target once in a while, by one asker at a time.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};

/// What was last made for each target. Whoever asks for a target's while it is made
/// waits for that one.
pub struct Fresh<V> {
    /// By target.
    made: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<V>>>>>,
}

impl<V> Default for Fresh<V> {
    fn default() -> Self {
        Self {
            made: Mutex::default(),
        }
    }
}

impl<V: Clone> Fresh<V> {
    /// What there is for the target while `fresh` says it still stands; what `make` makes
    /// after, which is kept unless it fails. `known` are the targets there are, whose
    /// own are kept.
    pub async fn of<E>(
        &self,
        target: &str,
        known: &[String],
        fresh: impl FnOnce(&V) -> bool,
        make: impl Future<Output = Result<V, E>>,
    ) -> Result<V, E> {
        let slot = {
            let mut made = self.made.lock().expect("not poisoned");
            made.retain(|id, _| known.contains(id));
            made.entry(target.to_owned()).or_default().clone()
        };
        let mut slot = slot.lock().await;
        if let Some(kept) = slot.as_ref().filter(|kept| fresh(kept)) {
            return Ok(kept.clone());
        }
        let made = make.await?;
        *slot = Some(made.clone());
        Ok(made)
    }
}
