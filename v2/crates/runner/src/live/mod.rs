//! A running session for those who watch and control it: window video over WebRTC, input
//! back (see `proto/aperture/live/v1/live.proto`), and screenshots.

mod encode;
mod http;
mod net;
mod peer;

pub use http::serve;
