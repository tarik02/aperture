//! How the session resolves names: by its records first, then by asking its resolvers,
//! which are the node's own unless the session names others. Both the connections made
//! from the node and the browser, when it has a network of its own to resolve for, get
//! their answers here, so that a name is the same to both.

use std::net::IpAddr;

use anyhow::Context;
use aperture_runner::proxy;
use hickory_resolver::{
    TokioResolver,
    config::{NameServerConfig, ResolverConfig},
    net::runtime::TokioRuntimeProvider,
    proto::{
        op::{Message, ResponseCode},
        rr::{RData, Record, RecordType},
    },
};

/// How long whoever asked may keep what a record says: records change with the session's
/// configuration.
const RECORD_KEPT_SECONDS: u32 = 30;

pub struct Names {
    recorded: proxy::Names,
    resolver: TokioResolver,
}

impl Names {
    pub fn new(names: &proxy::Names) -> anyhow::Result<Self> {
        let resolver = if names.servers.is_empty() {
            TokioResolver::builder_tokio().context("the node's resolvers are not known")?
        } else {
            let servers = names
                .servers
                .iter()
                .map(|server| NameServerConfig::udp_and_tcp(*server))
                .collect();
            TokioResolver::builder_with_config(
                ResolverConfig::from_name_servers(servers),
                TokioRuntimeProvider::default(),
            )
        };
        Ok(Self {
            recorded: names.clone(),
            resolver: resolver.build().context("the resolver was not made")?,
        })
    }

    /// The addresses of `host`, which is itself when it is an address.
    pub async fn addresses(&self, host: &str) -> anyhow::Result<Vec<IpAddr>> {
        if let Ok(address) = host.parse() {
            return Ok(vec![address]);
        }
        if let Some(recorded) = self.recorded.recorded(host) {
            return Ok(recorded.to_vec());
        }
        Ok(self.resolver.lookup_ip(host).await?.iter().collect())
    }

    /// Answers a DNS message with one.
    pub async fn answer(&self, asked: &[u8]) -> anyhow::Result<Vec<u8>> {
        let asked = Message::from_vec(asked).context("not a DNS message")?;
        let mut answer = Message::response(asked.metadata.id, asked.metadata.op_code);
        answer.metadata.recursion_desired = asked.metadata.recursion_desired;
        answer.metadata.recursion_available = true;
        let [question] = &asked.queries[..] else {
            answer.metadata.response_code = ResponseCode::FormErr;
            return Ok(answer.to_vec()?);
        };
        answer.add_query(question.clone());
        let name = question.name();
        let kind = question.query_type();
        let recorded = match kind {
            RecordType::A | RecordType::AAAA => self.recorded.recorded(&name.to_utf8()),
            _ => None,
        };
        match recorded {
            Some(addresses) => {
                let of_kind = addresses
                    .iter()
                    .map(|address| RData::from(*address))
                    .filter(|data| data.record_type() == kind)
                    .map(|data| Record::from_rdata(name.clone(), RECORD_KEPT_SECONDS, data));
                answer.add_answers(of_kind);
            }
            None => match self.resolver.lookup(name.clone(), kind).await {
                Ok(found) => {
                    answer.add_answers(found.answers().iter().cloned());
                }
                Err(err) if err.is_nx_domain() => {
                    answer.metadata.response_code = ResponseCode::NXDomain;
                }
                Err(err) if err.is_no_records_found() => {}
                Err(err) => {
                    tracing::debug!(%name, "a name was not resolved: {err}");
                    answer.metadata.response_code = ResponseCode::ServFail;
                }
            },
        }
        Ok(answer.to_vec()?)
    }
}
