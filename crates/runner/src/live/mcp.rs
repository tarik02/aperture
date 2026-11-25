//! The session's automation as an MCP server, for agents, over Streamable HTTP.
//!
//! Who calls a tool is told with each request, by whoever let it in: one connection may
//! carry the calls of many, as the control plane's does.

use std::sync::Arc;

use axum::http::request::Parts;
use browse_core::Content;
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::Value;

use super::http::vouched;
use crate::automation::Automation;

#[derive(Clone)]
pub struct Agent(Arc<Automation>);

pub fn service(automation: Arc<Automation>) -> StreamableHttpService<Agent, LocalSessionManager> {
    // The executor decides who may call; the session is reached by any name.
    let config = StreamableHttpServerConfig::default().disable_allowed_hosts();
    StreamableHttpService::new(
        move || Ok(Agent(automation.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    )
}

impl ServerHandler for Agent {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "aperture",
                aperture_runner::VERSION.as_str(),
            ))
            .with_instructions(self.0.instructions())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = self
            .0
            .specs()
            .into_iter()
            .map(|spec| {
                let schema = match spec.input_schema {
                    Value::Object(schema) => schema,
                    _ => Default::default(),
                };
                Tool::new(spec.name, spec.description, schema)
            })
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let caller = match context.extensions.get::<Parts>() {
            Some(parts) => {
                vouched(&parts.headers).map_err(|why| ErrorData::invalid_request(why, None))?
            }
            None => None,
        };
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        let output = self.0.call(caller.as_ref(), &request.name, arguments).await;
        let content = output
            .content
            .into_iter()
            .map(|content| match content {
                Content::Text { text } => ContentBlock::text(text),
                Content::Image { data, mime_type } => ContentBlock::image(data, mime_type),
            })
            .collect();
        let result = if output.is_error {
            CallToolResult::error(content)
        } else {
            CallToolResult::success(content)
        };
        Ok(result.into())
    }
}
