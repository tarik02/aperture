//! The executor's service over ConnectRPC, on [`Sessions`].

use std::sync::Arc;

use aperture_store::{SnapshotRecord, StoreError};
use buffa::{EnumValue, MessageField};
use buffa_types::google::protobuf::Timestamp;
use connectrpc::{
    ConnectError, ErrorCode, RequestContext, Response, ServiceRequest, ServiceResult,
};

use crate::{
    cdp, live,
    proto::aperture::executor::v1::{self as pb, ExecutorService},
    sessions::{Error, Session, Sessions, State},
};

pub struct Executor(pub Arc<Sessions>);

impl ExecutorService for Executor {
    async fn create_session(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, pb::CreateSessionRequest>,
    ) -> ServiceResult<pb::CreateSessionResponse> {
        let session = self
            .0
            .create(request.snapshot_id, request.suspended)
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
            State::Running => MessageField::some(pb::Endpoints {
                cdp_path: cdp::path(&session.record.id),
                live_path: live::path(&session.record.id),
                ..Default::default()
            }),
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
            id: session.record.id,
            ..Default::default()
        }
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
            Error::Store(StoreError::InvalidId(_)) => ErrorCode::InvalidArgument,
            Error::NotRunning(_) => ErrorCode::FailedPrecondition,
            Error::Store(_) | Error::Start { .. } | Error::Stop(_) | Error::Io(..) => {
                ErrorCode::Internal
            }
        };
        ConnectError::new(code, err.to_string())
    }
}
