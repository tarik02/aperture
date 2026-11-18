//! A running session for those who watch and control it: target video over WebRTC, input
//! back (see `proto/aperture/live/v1/live.proto`), screenshots, and, for agents, the
//! session's automation as an MCP server.

mod encode;
mod http;
mod mcp;
mod net;
mod peer;
pub mod record;
pub mod stream;

pub use http::{Live, serve};
