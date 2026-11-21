//! What a session says itself of how it runs: what it offers, and what network its
//! browser has. The executor's own options are what a session has where it says nothing,
//! and the most a session may have.

use aperture_runner::{Feature, Features, Network, Tcp, Udp, options::Setup};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asked {
    /// What it offers, and nothing else.
    #[serde(default)]
    pub features: Option<Vec<Feature>>,
    #[serde(default)]
    pub tcp: Option<Tcp>,
    #[serde(default)]
    pub udp: Option<Udp>,
}

impl Asked {
    /// Says what of these the executor does not let a session have.
    pub fn check(&self, setup: &Setup) -> Result<(), String> {
        let offered = setup.features();
        let missing = self.features.iter().flatten();
        if let Some(missing) = missing.copied().find(|feature| !offered.has(*feature)) {
            return Err(format!(
                "this executor's sessions do not offer {}",
                missing.name()
            ));
        }
        let network = setup.network();
        if self.tcp == Some(Tcp::Direct) && network.tcp != Tcp::Direct {
            return Err("this executor's sessions have no TCP but through their proxies".into());
        }
        if self.udp == Some(Udp::Direct) && network.udp != Udp::Direct {
            return Err("this executor's sessions have no UDP".into());
        }
        Ok(())
    }

    /// What a session with these options runs with: no more than the executor lets it
    /// have now, whatever it let it have when the session was created.
    pub fn within(&self, setup: &Setup) -> (Features, Network) {
        let offered = setup.features();
        let features = match &self.features {
            Some(own) => own.iter().filter(|feature| offered.has(**feature)).fold(
                Features::default(),
                |mut features, feature| {
                    features.set(*feature, true);
                    features
                },
            ),
            None => offered,
        };
        let allowed = setup.network();
        let network = Network {
            tcp: match (self.tcp, allowed.tcp) {
                (Some(Tcp::Direct) | None, Tcp::Direct) => Tcp::Direct,
                _ => Tcp::Proxied,
            },
            udp: match (self.udp, allowed.udp) {
                (Some(Udp::Direct) | None, Udp::Direct) => Udp::Direct,
                _ => Udp::None,
            },
        };
        (features, network)
    }
}
