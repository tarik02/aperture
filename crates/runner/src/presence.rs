//! Who is in the session and who drives which tab.
//!
//! The session has one keyboard and one pointer, whoever uses it. Input is a tab's: who
//! gives a tab input holds the tab for as long as they keep at it, and others ask for it.
//! Those who hold different tabs take turns at the keyboard and the pointer: the keys
//! one holds down are let go while another types, and pressed again at their turn.

use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};

use aperture_compositor::{Button, Handle, Input, WindowId};
use aperture_runner::{Access, Area};
use tokio::{
    sync::{broadcast, watch},
    time::Instant,
};

/// A tab is its holder's until they gave it no input for this long.
const HELD_FOR: Duration = Duration::from_secs(5);
/// One who is asked for a tab has this long to answer; the tab goes to whoever asked
/// when they do not.
const ANSWER_WITHIN: Duration = Duration::from_secs(10);
const SETTLE_EVERY: Duration = Duration::from_secs(1);

pub type MemberId = u64;

/// What one may do in the session, each role with what the ones before it may.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    /// Watch.
    View,
    /// Give input.
    Control,
    /// Take a tab from whoever holds it.
    Admin,
}

/// Who someone is, as whoever let them into the session says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub subject: String,
    pub name: String,
    pub access: Access,
}

/// The subject of whoever holds the executor's own token.
const OPERATOR: &str = "operator";

impl Identity {
    /// Whoever holds the executor's own token.
    pub fn operator() -> Self {
        Self {
            subject: OPERATOR.to_owned(),
            name: "Operator".to_owned(),
            access: Access::ALL,
        }
    }

    pub fn is_operator(&self) -> bool {
        self.subject == OPERATOR
    }

    /// What the access comes to among the session's members.
    pub fn role(&self) -> Role {
        if !self.access.writes(Area::Input) {
            Role::View
        } else if self.access.writes(Area::Lease) {
            Role::Admin
        } else {
            Role::Control
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub id: MemberId,
    pub identity: Identity,
    /// The session's automation rather than a person: under its own name, or under that
    /// of whoever it acts for.
    pub agent: bool,
    /// The tab the member watches.
    pub tab: Option<u32>,
    /// The member this one follows.
    pub follows: Option<MemberId>,
}

/// Something a member shows the others who watch its tab: nothing of it is kept.
#[derive(Debug, Clone, Copy)]
pub struct Mark {
    pub member: MemberId,
    pub tab: u32,
    pub what: Shown,
}

#[derive(Debug, Clone, Copy)]
pub enum Shown {
    /// Where the member's pointer is; none once it left.
    Pointer(Option<(f64, f64)>),
    /// A point of the stroke of that number the member draws.
    Stroke {
        stroke: u32,
        phase: Phase,
        x: f64,
        y: f64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Start,
    Move,
    End,
}

/// Marks waiting for a client that falls behind; it then misses the oldest.
const MARKS: usize = 512;

/// A tab that is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lease {
    pub tab: u32,
    pub holder: MemberId,
    /// Who asks the holder for the tab.
    pub asked_by: Option<MemberId>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Present {
    pub members: Vec<Member>,
    pub leases: Vec<Lease>,
}

struct Held {
    holder: MemberId,
    used: Instant,
    asked: Option<(MemberId, Instant)>,
}

impl Held {
    fn lasts(&self, now: Instant) -> bool {
        now - self.used < HELD_FOR
    }
}

/// What a member holds down, and where their pointer was last.
#[derive(Default)]
struct Hands {
    keys: BTreeSet<u32>,
    buttons: Vec<Button>,
    at: Option<(WindowId, f64, f64)>,
}

#[derive(Default)]
struct State {
    last: MemberId,
    members: Vec<Member>,
    leases: HashMap<u32, Held>,
    hands: HashMap<MemberId, Hands>,
    /// Whose turn at the keyboard and the pointer it is.
    turn: Option<MemberId>,
}

pub struct Presence {
    compositor: Handle,
    state: Mutex<State>,
    told: watch::Sender<Present>,
    marks: broadcast::Sender<Mark>,
}

/// A member, for as long as it is held.
pub struct Membership {
    pub id: MemberId,
    presence: Arc<Presence>,
}

impl Drop for Membership {
    fn drop(&mut self) {
        self.presence.leave(self.id);
    }
}

impl Presence {
    pub fn new(compositor: Handle) -> Arc<Self> {
        let presence = Arc::new(Self {
            compositor,
            state: Mutex::default(),
            told: watch::Sender::new(Present::default()),
            marks: broadcast::Sender::new(MARKS),
        });
        let settled = Arc::downgrade(&presence);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(SETTLE_EVERY).await;
                let Some(presence) = settled.upgrade() else {
                    return;
                };
                presence.settle();
            }
        });
        presence
    }

    pub fn present(&self) -> watch::Receiver<Present> {
        self.told.subscribe()
    }

    pub fn join(self: &Arc<Self>, identity: Identity, agent: bool) -> Membership {
        let mut state = self.state.lock().expect("not poisoned");
        state.last += 1;
        let id = state.last;
        state.members.push(Member {
            id,
            identity,
            agent,
            tab: None,
            follows: None,
        });
        self.tell(&state);
        Membership {
            id,
            presence: self.clone(),
        }
    }

    fn leave(&self, id: MemberId) {
        let mut state = self.state.lock().expect("not poisoned");
        self.let_go(&mut state, id);
        state.hands.remove(&id);
        if state.turn == Some(id) {
            state.turn = None;
        }
        state.members.retain(|member| member.id != id);
        for member in &mut state.members {
            member.follows = member.follows.filter(|followed| *followed != id);
        }
        state.leases.retain(|_, held| held.holder != id);
        for held in state.leases.values_mut() {
            held.asked = held.asked.filter(|(asker, _)| *asker != id);
        }
        self.tell(&state);
    }

    /// The member watches `tab` from now on.
    pub fn watch(&self, id: MemberId, tab: Option<u32>) {
        let mut state = self.state.lock().expect("not poisoned");
        if let Some(member) = state.members.iter_mut().find(|member| member.id == id) {
            member.tab = tab;
        }
        self.tell(&state);
    }

    /// The member follows `whom` from now on, or nobody.
    pub fn follow(&self, id: MemberId, whom: Option<MemberId>) -> Result<(), &'static str> {
        let mut state = self.state.lock().expect("not poisoned");
        if let Some(whom) = whom {
            let follows = |member: MemberId| {
                let found = state.members.iter().find(|other| other.id == member);
                found.and_then(|other| other.follows)
            };
            if !state.members.iter().any(|member| member.id == whom) {
                return Err("no such member is in the session");
            }
            // Whoever `whom` follows, and so on, must not come back to this member.
            let mut ahead = Some(whom);
            while let Some(member) = ahead {
                if member == id {
                    return Err("a member is not followed around a circle");
                }
                ahead = follows(member);
            }
        }
        if let Some(member) = state.members.iter_mut().find(|member| member.id == id) {
            member.follows = whom;
        }
        self.tell(&state);
        Ok(())
    }

    /// What members show each other from now on.
    pub fn marks(&self) -> broadcast::Receiver<Mark> {
        self.marks.subscribe()
    }

    /// Shows the others who watch the tab something of the member's.
    pub fn show(&self, mark: Mark) {
        // Nobody else may be there to see it.
        let _ = self.marks.send(mark);
    }

    /// Whose turn at the keyboard and the pointer it is: who gave input last.
    pub fn turn(&self) -> Option<MemberId> {
        self.state.lock().expect("not poisoned").turn
    }

    /// Who holds `tab`, by name, when it is not `id`.
    pub fn held_by_another(&self, id: MemberId, tab: u32) -> Option<String> {
        let state = self.state.lock().expect("not poisoned");
        let held = state.leases.get(&tab)?;
        if held.holder == id || !held.lasts(Instant::now()) {
            return None;
        }
        let holder = state.members.iter().find(|member| member.id == held.holder);
        holder.map(|holder| holder.identity.name.clone())
    }

    /// Whether the member holds `tab` now: it does when it held it, and when the tab was
    /// free and the member `takes` it.
    pub fn hold(&self, id: MemberId, tab: u32, takes: bool) -> bool {
        let mut state = self.state.lock().expect("not poisoned");
        let held = self.hold_in(&mut state, id, tab, takes);
        self.tell(&state);
        held
    }

    fn hold_in(&self, state: &mut State, id: MemberId, tab: u32, takes: bool) -> bool {
        let may = state
            .members
            .iter()
            .any(|member| member.id == id && member.identity.role() >= Role::Control);
        if !may {
            return false;
        }
        let now = Instant::now();
        // A person's input comes before the automation's: they need not ask it.
        let agent = |id: MemberId| {
            state
                .members
                .iter()
                .any(|member| member.id == id && member.agent)
        };
        let from_agent = state
            .leases
            .get(&tab)
            .is_some_and(|held| agent(held.holder) && !agent(id));
        match state.leases.get_mut(&tab) {
            Some(held) if held.holder == id => {
                held.used = now;
                true
            }
            Some(held) if held.lasts(now) && !from_agent => false,
            _ if takes => {
                let held = Held {
                    holder: id,
                    used: now,
                    asked: None,
                };
                state.leases.insert(tab, held);
                true
            }
            _ => false,
        }
    }

    /// Input from a member to a tab. It goes to the tab when the member holds it; a tab
    /// nobody holds is taken by anything but the pointer passing over it. Tells whether
    /// it went.
    pub fn input(&self, id: MemberId, tab: u32, input: Input) -> bool {
        let mut state = self.state.lock().expect("not poisoned");
        let passing = matches!(
            input,
            Input::PointerMotion { .. } | Input::PointerLeave | Input::Key { pressed: false, .. }
        );
        let held = self.hold_in(&mut state, id, tab, !passing);
        self.tell(&state);
        let turn = state.turn == Some(id);
        // A key let go when it is not the member's turn is up already: see below.
        if let Input::Key {
            code,
            pressed: false,
            ..
        } = input
            && !turn
        {
            if let Some(hands) = state.hands.get_mut(&id) {
                hands.keys.remove(&code);
            }
            return held;
        }
        if !held || (!turn && matches!(input, Input::PointerLeave)) {
            return false;
        }
        if !turn {
            let pointer = matches!(
                input,
                Input::PointerMotion { .. }
                    | Input::PointerButton { .. }
                    | Input::PointerScroll { .. }
                    | Input::Drop { .. }
            );
            // Another's drag goes on until they let go: the pointer is theirs meanwhile.
            let dragging = state
                .hands
                .iter()
                .any(|(other, hands)| *other != id && !hands.buttons.is_empty());
            if pointer && dragging {
                return false;
            }
            // The keys of whoever had the turn come up, and this member's go down again
            // where they held some.
            if let Some(before) = state.turn {
                self.keys(&state, before, false, None);
            }
            self.keys(&state, id, true, window_of(&input));
            state.turn = Some(id);
        }
        let hands = state.hands.entry(id).or_default();
        match &input {
            Input::Key { code, pressed, .. } => {
                if *pressed {
                    hands.keys.insert(*code);
                } else {
                    hands.keys.remove(code);
                }
            }
            Input::PointerButton {
                window,
                x,
                y,
                button,
                pressed,
            } => {
                hands.buttons.retain(|held| held != button);
                if *pressed {
                    hands.buttons.push(*button);
                }
                hands.at = Some((*window, *x, *y));
            }
            _ => {}
        }
        self.compositor.input(input);
        true
    }

    /// Presses or lets go of the keys a member holds down, in `window` or wherever the
    /// keyboard is.
    fn keys(&self, state: &State, id: MemberId, pressed: bool, window: Option<WindowId>) {
        let Some(hands) = state.hands.get(&id) else {
            return;
        };
        let window = window.or(hands.at.map(|(window, ..)| window));
        let Some(window) = window else {
            return;
        };
        for code in &hands.keys {
            self.compositor.input(Input::Key {
                window,
                code: *code,
                pressed,
            });
        }
    }

    /// Lets go of all a member holds down, when it is their turn: it is down nowhere
    /// otherwise.
    fn let_go(&self, state: &mut State, id: MemberId) {
        if state.turn != Some(id) {
            return;
        }
        self.keys(state, id, false, None);
        let Some(hands) = state.hands.get_mut(&id) else {
            return;
        };
        if let Some((window, x, y)) = hands.at {
            for button in hands.buttons.drain(..) {
                self.compositor.input(Input::PointerButton {
                    window,
                    x,
                    y,
                    button,
                    pressed: false,
                });
            }
        }
        hands.keys.clear();
    }

    /// The member asks for `tab`. A tab nobody holds is theirs, as is one the automation
    /// holds when a person asks, and so is any an admin asks for; anyone else's holder is
    /// asked.
    pub fn ask(&self, id: MemberId, tab: u32) {
        let mut state = self.state.lock().expect("not poisoned");
        if self.hold_in(&mut state, id, tab, true) {
            return self.tell(&state);
        }
        let asker = state.members.iter().find(|member| member.id == id);
        let Some(role) = asker.map(|asker| asker.identity.role()) else {
            return;
        };
        if role < Role::Control {
            return;
        }
        if role == Role::Admin {
            self.hand_over(&mut state, tab, id);
        } else if let Some(held) = state.leases.get_mut(&tab) {
            held.asked.get_or_insert((id, Instant::now()));
        }
        self.tell(&state);
    }

    /// The holder of `tab` answers whoever asked for it.
    pub fn answer(&self, id: MemberId, tab: u32, allow: bool) {
        let mut state = self.state.lock().expect("not poisoned");
        let asked = state
            .leases
            .get_mut(&tab)
            .filter(|held| held.holder == id)
            .and_then(|held| held.asked.take());
        if let (Some((asker, _)), true) = (asked, allow) {
            self.hand_over(&mut state, tab, asker);
        }
        self.tell(&state);
    }

    /// The holder of `tab` lets it go.
    pub fn release(&self, id: MemberId, tab: u32) {
        let mut state = self.state.lock().expect("not poisoned");
        if state.leases.get(&tab).is_some_and(|held| held.holder == id) {
            self.let_go(&mut state, id);
            state.leases.remove(&tab);
        }
        self.tell(&state);
    }

    fn hand_over(&self, state: &mut State, tab: u32, to: MemberId) {
        if let Some(held) = state.leases.get(&tab) {
            let holder = held.holder;
            self.let_go(state, holder);
        }
        let held = Held {
            holder: to,
            used: Instant::now(),
            asked: None,
        };
        state.leases.insert(tab, held);
    }

    /// Gives the tabs whose holders did not answer in time to those who asked.
    fn settle(&self) {
        let mut state = self.state.lock().expect("not poisoned");
        let now = Instant::now();
        let due: Vec<(u32, MemberId)> = state
            .leases
            .iter()
            .filter_map(|(tab, held)| {
                let (asker, since) = held.asked?;
                (now - since >= ANSWER_WITHIN).then_some((*tab, asker))
            })
            .collect();
        for (tab, asker) in due {
            self.hand_over(&mut state, tab, asker);
        }
        self.tell(&state);
    }

    /// Tells who is here and who holds what, when that changed.
    fn tell(&self, state: &State) {
        let now = Instant::now();
        let mut leases: Vec<Lease> = state
            .leases
            .iter()
            .filter(|(_, held)| held.lasts(now))
            .map(|(tab, held)| Lease {
                tab: *tab,
                holder: held.holder,
                asked_by: held.asked.map(|(asker, _)| asker),
            })
            .collect();
        leases.sort_by_key(|lease| lease.tab);
        let present = Present {
            members: state.members.clone(),
            leases,
        };
        self.told.send_if_modified(|told| {
            let changed = *told != present;
            if changed {
                *told = present;
            }
            changed
        });
    }
}

fn window_of(input: &Input) -> Option<WindowId> {
    match input {
        Input::PointerMotion { window, .. }
        | Input::PointerButton { window, .. }
        | Input::PointerScroll { window, .. }
        | Input::Key { window, .. }
        | Input::Drop { window, .. }
        | Input::Text { window, .. } => Some(*window),
        Input::PointerLeave => None,
    }
}
