//! The icons of the targets' pages, each asked of its page once in a while.

use std::{
    convert::Infallible,
    sync::Arc,
    time::{Duration, Instant},
};

use super::fresh::Fresh;
use crate::{pages::Pages, targets::Target};

/// How long a page's icon stands for the pages of its site before it is asked for again.
const FRESH_FOR: Duration = Duration::from_secs(600);

/// A page's icon.
pub struct Icon {
    pub kind: &'static str,
    pub bytes: Vec<u8>,
}

/// What was last found for a target: the site its page was of, and the icon, or none.
#[derive(Clone)]
struct Found {
    site: String,
    icon: Option<Arc<Icon>>,
    at: Instant,
}

/// The icons of the targets' pages. Whoever asks for one while it is fetched waits for
/// that one.
#[derive(Default)]
pub struct Icons {
    found: Fresh<Found>,
}

impl Icons {
    /// The icon of the target's page; none where the page has none. `known` are the
    /// targets there are, whose icons are kept.
    pub async fn of(&self, pages: &Pages, target: &Target, known: &[String]) -> Option<Arc<Icon>> {
        let site = site(&target.url);
        let fresh = |found: &Found| found.site == site && found.at.elapsed() < FRESH_FOR;
        // A page that has none, or whose icon does not come, is not asked each time.
        let asked = async {
            let icon = match pages.icon(&target.id).await {
                Ok((kind, bytes)) => Some(Arc::new(Icon { kind, bytes })),
                Err(_) => None,
            };
            Ok::<_, Infallible>(Found {
                site: site.clone(),
                icon,
                at: Instant::now(),
            })
        };
        let Ok(found) = self.found.of(&target.id, known, fresh, asked).await;
        found.icon
    }
}

/// The site an address is of: what its pages share an icon by.
fn site(address: &str) -> String {
    match url::Url::parse(address) {
        Ok(url) => url.origin().ascii_serialization(),
        Err(_) => address.to_owned(),
    }
}
