//! The executor's service over ConnectRPC, on [`Sessions`].

use std::sync::Arc;

use aperture_runner::{Feature, Features, Network, Tcp, Udp, proxy};
use aperture_store::{SnapshotRecord, StoreError};
use buffa::{EnumValue, MessageField};
use buffa_types::google::protobuf::{Duration, Timestamp};
use connectrpc::{
    ConnectError, ErrorCode, RequestContext, Response, ServiceRequest, ServiceResult,
};

use crate::{
    asked::Asked,
    limits::Limits,
    proto::aperture::executor::v1::{self as pb, ExecutorService},
    sessions::{self, Error, Session, Sessions, State},
};

pub struct Executor(pub Arc<Sessions>);

impl ExecutorService for Executor {
    async fn get_executor(
        &self,
        _ctx: RequestContext,
        _request: ServiceRequest<'_, pb::GetExecutorRequest>,
    ) -> ServiceResult<pb::GetExecutorResponse> {
        let config = self.0.config();
        Response::ok(pb::GetExecutorResponse {
            executor: MessageField::some(pb::Executor {
                version: env!("CARGO_PKG_VERSION").to_owned(),
                features: features_message(config.setup.features()),
                network: MessageField::some(network_message(config.setup.network())),
                limits: MessageField::some(limits_message(config.limits)),
                holds_resources: config.scopes.is_some(),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    async fn create_session(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::CreateSessionRequest>,
    ) -> ServiceResult<pb::CreateSessionResponse> {
        let request = request.to_owned_message();
        let proxy = request.proxy.as_option().map(proxy_config);
        let limits = request.limits.as_option().map(limits).unwrap_or_default();
        let options = options(&request)?;
        let session = self
            .0
            .create(
                request.snapshot_id.as_deref(),
                request.suspended,
                proxy,
                limits,
                options,
                request.storage_state.as_deref(),
            )
            .await?;
        Response::ok(pb::CreateSessionResponse {
            session: MessageField::some(session.into()),
            ..Default::default()
        })
    }

    async fn get_session(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::GetSessionRequest>,
    ) -> ServiceResult<pb::GetSessionResponse> {
        Response::ok(pb::GetSessionResponse {
            session: MessageField::some(self.0.get(request.id)?.into()),
            ..Default::default()
        })
    }

    async fn list_sessions(
        &self,
        _ctx: RequestContext,
        _request: ServiceRequest<'_, pb::ListSessionsRequest>,
    ) -> ServiceResult<pb::ListSessionsResponse> {
        Response::ok(pb::ListSessionsResponse {
            sessions: self.0.list()?.into_iter().map(Into::into).collect(),
            ..Default::default()
        })
    }

    async fn suspend_session(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::SuspendSessionRequest>,
    ) -> ServiceResult<pb::SuspendSessionResponse> {
        Response::ok(pb::SuspendSessionResponse {
            session: MessageField::some(self.0.suspend(request.id).await?.into()),
            ..Default::default()
        })
    }

    async fn resume_session(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::ResumeSessionRequest>,
    ) -> ServiceResult<pb::ResumeSessionResponse> {
        Response::ok(pb::ResumeSessionResponse {
            session: MessageField::some(self.0.resume(request.id, request.takeover).await?.into()),
            ..Default::default()
        })
    }

    async fn update_session_proxy(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::UpdateSessionProxyRequest>,
    ) -> ServiceResult<pb::UpdateSessionProxyResponse> {
        let request = request.to_owned_message();
        let proxy = request.proxy.as_option().map(proxy_config);
        self.0.set_proxy(&request.id, proxy).await?;
        Response::ok(pb::UpdateSessionProxyResponse::default())
    }

    async fn delete_session(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::DeleteSessionRequest>,
    ) -> ServiceResult<pb::DeleteSessionResponse> {
        self.0.delete(request.id).await?;
        Response::ok(pb::DeleteSessionResponse::default())
    }

    async fn create_snapshot(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::CreateSnapshotRequest>,
    ) -> ServiceResult<pb::CreateSnapshotResponse> {
        let snapshot = self.0.snapshot(request.session_id, request.name).await?;
        Response::ok(pb::CreateSnapshotResponse {
            snapshot: MessageField::some(snapshot_message(snapshot)),
            ..Default::default()
        })
    }

    async fn get_snapshot(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::GetSnapshotRequest>,
    ) -> ServiceResult<pb::GetSnapshotResponse> {
        Response::ok(pb::GetSnapshotResponse {
            snapshot: MessageField::some(snapshot_message(self.0.get_snapshot(request.id).await?)),
            ..Default::default()
        })
    }

    async fn list_snapshots(
        &self,
        _ctx: RequestContext,
        _request: ServiceRequest<'_, pb::ListSnapshotsRequest>,
    ) -> ServiceResult<pb::ListSnapshotsResponse> {
        Response::ok(pb::ListSnapshotsResponse {
            snapshots: self
                .0
                .snapshots()
                .await?
                .into_iter()
                .map(snapshot_message)
                .collect(),
            ..Default::default()
        })
    }

    async fn delete_snapshot(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::DeleteSnapshotRequest>,
    ) -> ServiceResult<pb::DeleteSnapshotResponse> {
        self.0.delete_snapshot(request.id).await?;
        Response::ok(pb::DeleteSnapshotResponse::default())
    }
}

impl From<Session> for pb::Session {
    fn from(session: Session) -> Self {
        let state = match session.state {
            State::Suspended => pb::SessionState::SESSION_STATE_SUSPENDED,
            State::Starting => pb::SessionState::SESSION_STATE_STARTING,
            State::Running => pb::SessionState::SESSION_STATE_RUNNING,
            State::Suspending => pb::SessionState::SESSION_STATE_SUSPENDING,
            State::Failed => pb::SessionState::SESSION_STATE_FAILED,
        };
        let status = session.status;
        let endpoints = match session.state {
            State::Running => {
                let path = sessions::path(&session.record.id);
                MessageField::some(pb::Endpoints {
                    cdp_path: format!("{path}/cdp"),
                    mcp_path: format!("{path}/mcp"),
                    tunnel_path: format!("{path}/tunnel"),
                    path,
                    ..Default::default()
                })
            }
            _ => MessageField::none(),
        };
        pb::Session {
            state: EnumValue::from(state),
            snapshot_id: session.record.snapshot_id,
            created_at: MessageField::some(timestamp(session.record.created_at_ms)),
            endpoints,
            failure: match session.state {
                State::Failed => status.and_then(|status| status.failure),
                _ => None,
            },
            limits: MessageField::some(limits_message(session.limits)),
            usage: session
                .usage
                .map(|usage| pb::Usage {
                    memory_bytes: usage.memory,
                    memory_peak_bytes: usage.memory_peak,
                    cpu_time: MessageField::some(duration(usage.cpu)),
                    tasks: usage.tasks,
                    oom_kills: usage.oom_kills,
                    ..Default::default()
                })
                .into(),
            idle_since: session.idle_since_ms.map(timestamp).into(),
            features: features_message(session.features),
            network: MessageField::some(network_message(session.network)),
            asleep: session.record.asleep && session.state == State::Suspended,
            id: session.record.id,
            ..Default::default()
        }
    }
}

const FEATURES: [(pb::Feature, Feature); 8] = [
    (pb::Feature::FEATURE_SOUND, Feature::Sound),
    (pb::Feature::FEATURE_UPLOADS, Feature::Uploads),
    (pb::Feature::FEATURE_DOWNLOADS, Feature::Downloads),
    (pb::Feature::FEATURE_RECORDINGS, Feature::Recordings),
    (pb::Feature::FEATURE_CLIPBOARD, Feature::Clipboard),
    (pb::Feature::FEATURE_MCP, Feature::Mcp),
    (pb::Feature::FEATURE_CDP, Feature::Cdp),
    (pb::Feature::FEATURE_TUNNEL, Feature::Tunnel),
];

fn features_message(features: Features) -> Vec<EnumValue<pb::Feature>> {
    FEATURES
        .into_iter()
        .filter(|(_, feature)| features.has(*feature))
        .map(|(feature, _)| EnumValue::from(feature))
        .collect()
}

fn network_message(network: Network) -> pb::Network {
    pb::Network {
        tcp: EnumValue::from(match network.tcp {
            Tcp::Proxied => pb::NetworkTcp::NETWORK_TCP_PROXIED,
            Tcp::Direct => pb::NetworkTcp::NETWORK_TCP_DIRECT,
        }),
        udp: EnumValue::from(match network.udp {
            Udp::None => pb::NetworkUdp::NETWORK_UDP_NONE,
            Udp::Direct => pb::NetworkUdp::NETWORK_UDP_DIRECT,
        }),
        ..Default::default()
    }
}

fn limits_message(limits: Limits) -> pb::Limits {
    pb::Limits {
        memory_bytes: limits.memory,
        swap_bytes: limits.swap,
        cpus: limits.cpus,
        tasks: limits.tasks,
        suspend_idle_after: limits.idle().map(duration).into(),
        ..Default::default()
    }
}

/// What a request says of the session's own options.
fn options(request: &pb::CreateSessionRequest) -> Result<Asked, ConnectError> {
    let unknown = |what: &str| ConnectError::new(ErrorCode::InvalidArgument, what.to_owned());
    let features = match request.features.as_option() {
        Some(features) => {
            let known = features.on.iter().map(|asked| {
                let named = FEATURES
                    .into_iter()
                    .find(|(feature, _)| asked.as_known() == Some(*feature));
                named.map(|(_, feature)| feature)
            });
            let known: Option<Vec<Feature>> = known.collect();
            Some(known.ok_or_else(|| unknown("a feature that is none"))?)
        }
        None => None,
    };
    let network = request.network.as_option();
    let tcp = match network.map(|network| network.tcp.as_known()) {
        None | Some(Some(pb::NetworkTcp::NETWORK_TCP_UNSPECIFIED)) => None,
        Some(Some(pb::NetworkTcp::NETWORK_TCP_PROXIED)) => Some(Tcp::Proxied),
        Some(Some(pb::NetworkTcp::NETWORK_TCP_DIRECT)) => Some(Tcp::Direct),
        Some(None) => return Err(unknown("a network for TCP that is none")),
    };
    let udp = match network.map(|network| network.udp.as_known()) {
        None | Some(Some(pb::NetworkUdp::NETWORK_UDP_UNSPECIFIED)) => None,
        Some(Some(pb::NetworkUdp::NETWORK_UDP_NONE)) => Some(Udp::None),
        Some(Some(pb::NetworkUdp::NETWORK_UDP_DIRECT)) => Some(Udp::Direct),
        Some(None) => return Err(unknown("a network for UDP that is none")),
    };
    Ok(Asked { features, tcp, udp })
}

fn limits(limits: &pb::Limits) -> Limits {
    Limits {
        memory: limits.memory_bytes,
        swap: limits.swap_bytes,
        cpus: limits.cpus,
        tasks: limits.tasks,
        idle_ms: limits.suspend_idle_after.as_option().map(|after| {
            let ms = after.seconds.saturating_mul(1000) + i64::from(after.nanos) / 1_000_000;
            ms.max(0) as u64
        }),
    }
}

fn duration(duration: std::time::Duration) -> Duration {
    Duration {
        seconds: duration.as_secs() as i64,
        nanos: duration.subsec_nanos() as i32,
        ..Default::default()
    }
}

fn proxy_config(proxy: &pb::ProxyConfig) -> proxy::Config {
    proxy::Config {
        upstreams: proxy
            .upstreams
            .iter()
            .map(|(name, upstream)| {
                let upstream = proxy::Upstream {
                    url: upstream.url.clone(),
                    auth: upstream.auth.clone(),
                };
                (name.clone(), upstream)
            })
            .collect(),
        rules: proxy
            .rules
            .iter()
            .map(|rule| proxy::Rule {
                matches: rule.r#match.clone(),
                via: rule.via.clone(),
                to: rule.to.clone(),
                tls: rule.tls,
            })
            .collect(),
        dns: proxy
            .dns
            .as_option()
            .map_or_else(Default::default, |dns| proxy::Dns {
                servers: dns.servers.clone(),
                records: dns
                    .records
                    .iter()
                    .map(|record| proxy::Record {
                        name: record.name.clone(),
                        addresses: record.addresses.clone(),
                    })
                    .collect(),
            }),
    }
}

fn snapshot_message(snapshot: SnapshotRecord) -> pb::Snapshot {
    pb::Snapshot {
        id: snapshot.id,
        name: snapshot.name,
        session_id: snapshot.session_id,
        created_at: MessageField::some(timestamp(snapshot.created_at_ms)),
        ..Default::default()
    }
}

fn timestamp(ms: u64) -> Timestamp {
    Timestamp {
        seconds: (ms / 1000) as i64,
        nanos: (ms % 1000) as i32 * 1_000_000,
        ..Default::default()
    }
}

impl From<Error> for ConnectError {
    fn from(err: Error) -> Self {
        let code = match &err {
            Error::Store(StoreError::SessionNotFound(_) | StoreError::SnapshotNotFound(_)) => {
                ErrorCode::NotFound
            }
            Error::Store(StoreError::InvalidId(_))
            | Error::Proxy(_)
            | Error::Limits(_)
            | Error::State(_) => ErrorCode::InvalidArgument,
            Error::NotRunning(_) | Error::NoCgroups | Error::Options(_) | Error::Held { .. } => {
                ErrorCode::FailedPrecondition
            }
            Error::Store(_) | Error::Start { .. } | Error::Stop(_) | Error::Io(..) => {
                ErrorCode::Internal
            }
        };
        ConnectError::new(code, err.to_string())
    }
}
