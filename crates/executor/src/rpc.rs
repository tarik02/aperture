//! The executor's service over ConnectRPC, on [`Sessions`].

use std::sync::Arc;

use aperture_runner::proxy;
use aperture_store::{SnapshotRecord, StoreError};
use buffa::{EnumValue, MessageField};
use buffa_types::google::protobuf::{Duration, Timestamp};
use connectrpc::{
    ConnectError, ErrorCode, RequestContext, Response, ServiceRequest, ServiceResult,
};

use crate::{
    limits::Limits,
    proto::aperture::executor::v1::{self as pb, ExecutorService},
    sessions::{self, Error, Session, Sessions, State},
};

pub struct Executor(pub Arc<Sessions>);

impl ExecutorService for Executor {
    async fn create_session(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::CreateSessionRequest>,
    ) -> ServiceResult<pb::CreateSessionResponse> {
        let request = request.to_owned_message();
        let proxy = request.proxy.as_option().map(proxy_config);
        let limits = request.limits.as_option().map(limits).unwrap_or_default();
        let session = self
            .0
            .create(
                request.snapshot_id.as_deref(),
                request.suspended,
                proxy,
                limits,
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
            session: MessageField::some(self.0.resume(request.id).await?.into()),
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
            snapshot: MessageField::some(snapshot_message(self.0.get_snapshot(request.id)?)),
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
                .snapshots()?
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
        self.0.delete_snapshot(request.id)?;
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
            limits: MessageField::some(pb::Limits {
                memory_bytes: session.limits.memory,
                swap_bytes: session.limits.swap,
                cpus: session.limits.cpus,
                tasks: session.limits.tasks,
                suspend_idle_after: session.limits.idle().map(duration).into(),
                ..Default::default()
            }),
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
            asleep: session.record.asleep && session.state == State::Suspended,
            id: session.record.id,
            ..Default::default()
        }
    }
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
            })
            .collect(),
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
            Error::Store(StoreError::InvalidId(_)) | Error::Proxy(_) | Error::Limits(_) => {
                ErrorCode::InvalidArgument
            }
            Error::NotRunning(_) | Error::NoCgroups => ErrorCode::FailedPrecondition,
            Error::Store(_) | Error::Start { .. } | Error::Stop(_) | Error::Io(..) => {
                ErrorCode::Internal
            }
        };
        ConnectError::new(code, err.to_string())
    }
}
