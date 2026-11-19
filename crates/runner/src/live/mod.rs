//! A running session for those who watch and control it: the session socket clients speak
//! the live protocol on (see `proto/aperture/live/v1/live.proto`), with a target's pixels
//! as WebRTC video or as tiles; screenshots; and, for agents, the session's automation as
//! an MCP server.

mod adapt;
mod client;
pub mod edit;
mod encode;
mod encoders;
mod http;
mod mcp;
mod net;
pub mod record;
mod shots;
mod rtc;
pub mod sound;
pub mod stream;
mod tiles;

pub use encoders::frame_layouts;
pub use http::{Live, serve};
