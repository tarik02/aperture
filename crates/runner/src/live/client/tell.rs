//! What a client is told of the session, in the words of the live protocol.

use aperture_compositor::Cursor;
use aperture_runner::Area;

use super::{Client, Grant};
use crate::{
    files::Progress,
    live::sound,
    pages,
    presence::{Mark, Phase, Role, Shown},
    proto::aperture::live::v1::{self as pb, server_message},
};

impl Client {
    pub(super) async fn send_sound(&mut self, packet: &sound::Packet) -> Result<(), axum::Error> {
        let frame = pb::AudioFrame {
            time_us: packet.at * 1_000_000 / u64::from(sound::RATE),
            data: packet.data.clone(),
            ..Default::default()
        };
        self.send(server_message::Message::Audio(Box::new(frame)))
            .await
    }

    /// A menu is for whoever asked for it: who drives the page's tab.
    pub(super) async fn send_menu(&mut self, menu: pages::Menu) -> Result<(), axum::Error> {
        let own = self.watches(&menu.target)
            && self
                .tab()
                .is_some_and(|tab| self.live.presence.hold(self.member.id, tab, false));
        if !own {
            return Ok(());
        }
        let menu = pb::Menu {
            link: menu.link,
            image: menu.image,
            text: menu.text,
            editable: menu.editable,
            ..Default::default()
        };
        self.send(server_message::Message::Menu(Box::new(menu)))
            .await
    }

    /// What is copied is whoever's copied it: who gave input last.
    pub(super) async fn send_copied(&mut self) -> Result<(), axum::Error> {
        let copied = self.clipboard.borrow_and_update().clone();
        let own = self.live.presence.turn() == Some(self.member.id);
        let Some(copied) = copied.filter(|_| own && self.grant(Area::Clipboard).read) else {
            return Ok(());
        };
        let forms = copied.iter().map(|form| pb::clipboard::Form {
            r#type: form.kind.clone(),
            data: form.data.clone(),
            ..Default::default()
        });
        let clipboard = pb::Clipboard {
            forms: forms.collect(),
            ..Default::default()
        };
        self.send(server_message::Message::Clipboard(Box::new(clipboard)))
            .await
    }

    pub(super) async fn send_features(&mut self) -> Result<(), axum::Error> {
        let features = pb::Features {
            input: buffa::MessageField::some(self.told(Area::Input)),
            tabs: buffa::MessageField::some(self.told(Area::Tabs)),
            lease: buffa::MessageField::some(self.told(Area::Lease)),
            sound: buffa::MessageField::some(self.told(Area::Sound)),
            clipboard: buffa::MessageField::some(self.told(Area::Clipboard)),
            uploads: buffa::MessageField::some(self.told(Area::Uploads)),
            downloads: buffa::MessageField::some(self.told(Area::Downloads)),
            recordings: buffa::MessageField::some(self.told(Area::Recordings)),
            mcp: buffa::MessageField::some(self.told(Area::Mcp)),
            cdp: buffa::MessageField::some(self.told(Area::Cdp)),
            tunnel: buffa::MessageField::some(self.told(Area::Tunnel)),
            ..Default::default()
        };
        self.send(server_message::Message::Features(Box::new(features)))
            .await
    }

    pub(super) fn told(&self, area: Area) -> pb::Grant {
        let Grant { read, write } = self.grant(area);
        pb::Grant {
            read,
            write,
            ..Default::default()
        }
    }

    pub(super) async fn send_targets(&mut self) -> Result<(), axum::Error> {
        let sounding = self.sounding.borrow_and_update().clone();
        let targets = self
            .live
            .targets
            .borrow_and_update()
            .iter()
            .map(|target| pb::Target {
                id: target.id.clone(),
                tab: target.tab,
                title: target.title.clone(),
                url: target.url.clone(),
                width: target.width,
                height: target.height,
                scale: target.scale,
                sounds: sounding.contains(&target.browser_tab),
                ..Default::default()
            })
            .collect();
        self.send(server_message::Message::Targets(Box::new(pb::Targets {
            targets,
            ..Default::default()
        })))
        .await
    }

    /// Tells the client what another member shows on the tab the client watches.
    pub(super) async fn send_mark(&mut self, mark: Mark) -> Result<(), axum::Error> {
        if mark.member == self.member.id || self.tab() != Some(mark.tab) {
            return Ok(());
        }
        let message = match mark.what {
            Shown::Pointer(at) => server_message::Message::Pointer(Box::new(pb::Pointer {
                member: mark.member,
                at: at
                    .map(|(x, y)| pb::Point {
                        x,
                        y,
                        ..Default::default()
                    })
                    .into(),
                ..Default::default()
            })),
            Shown::Stroke {
                stroke,
                phase,
                x,
                y,
            } => server_message::Message::Stroke(Box::new(pb::Stroke {
                member: mark.member,
                stroke,
                phase: match phase {
                    Phase::Start => pb::StrokePhase::STROKE_PHASE_START,
                    Phase::Move => pb::StrokePhase::STROKE_PHASE_MOVE,
                    Phase::End => pb::StrokePhase::STROKE_PHASE_END,
                }
                .into(),
                x,
                y,
                ..Default::default()
            })),
        };
        self.send(message).await
    }

    pub(super) async fn send_presence(&mut self) -> Result<(), axum::Error> {
        let present = self.present.borrow_and_update().clone();
        let members = present.members.iter().map(|member| pb::Member {
            id: member.id,
            name: member.identity.name.clone(),
            role: match member.identity.role() {
                Role::View => pb::Role::ROLE_VIEW,
                Role::Control => pb::Role::ROLE_CONTROL,
                Role::Admin => pb::Role::ROLE_ADMIN,
            }
            .into(),
            tab: member.tab,
            agent: member.agent,
            follows: member.follows,
            ..Default::default()
        });
        let held = present.leases.iter().map(|lease| pb::HeldTab {
            tab: lease.tab,
            holder: lease.holder,
            asked_by: lease.asked_by,
            ..Default::default()
        });
        let presence = pb::Presence {
            you: self.member.id,
            members: members.collect(),
            held: held.collect(),
            ..Default::default()
        };
        self.send(server_message::Message::Presence(Box::new(presence)))
            .await
    }

    pub(super) async fn send_file_requests(&mut self) -> Result<(), axum::Error> {
        // Told to those who may answer.
        let answers = self.grant(Area::Uploads).write;
        let targets = self.live.targets.borrow().clone();
        let requests = self
            .file_requests
            .borrow_and_update()
            .iter()
            .filter(|_| answers)
            .filter_map(|request| {
                // A page that is no target any more asks for nothing.
                let target = targets.iter().find(|target| target.id == request.target)?;
                Some(pb::FileRequest {
                    id: request.id,
                    tab: target.tab,
                    multiple: request.multiple,
                    ..Default::default()
                })
            })
            .collect();
        let requests = pb::FileRequests {
            requests,
            ..Default::default()
        };
        self.send(server_message::Message::FileRequests(Box::new(requests)))
            .await
    }

    pub(super) async fn send_downloads(&mut self) -> Result<(), axum::Error> {
        let reads = self.grant(Area::Downloads).read;
        let downloads = self
            .downloads
            .borrow_and_update()
            .iter()
            .filter(|_| reads)
            .map(|download| pb::Download {
                id: download.id.clone(),
                name: download.name.clone(),
                url: download.url.clone(),
                received_bytes: download.received,
                total_bytes: download.total,
                state: match download.state {
                    Progress::Running => pb::DownloadState::DOWNLOAD_STATE_RUNNING,
                    Progress::Done => pb::DownloadState::DOWNLOAD_STATE_DONE,
                    Progress::Failed => pb::DownloadState::DOWNLOAD_STATE_FAILED,
                }
                .into(),
                ..Default::default()
            })
            .collect();
        self.send(server_message::Message::Downloads(Box::new(
            pb::Downloads {
                downloads,
                ..Default::default()
            },
        )))
        .await
    }

    pub(super) async fn send_selected(&mut self) -> Result<(), axum::Error> {
        let tab = self.tab();
        self.send(server_message::Message::Selected(Box::new(pb::Selected {
            tab,
            ..Default::default()
        })))
        .await
    }

    pub(super) async fn send_cursor(&mut self) -> Result<(), axum::Error> {
        let cursor = match &*self.cursor.borrow_and_update() {
            Cursor::Hidden => pb::cursor::Cursor::Hidden(Box::default()),
            Cursor::Named(name) => pb::cursor::Cursor::Named((*name).to_owned()),
        };
        self.send(server_message::Message::Cursor(Box::new(pb::Cursor {
            cursor: Some(cursor),
            ..Default::default()
        })))
        .await
    }
}
