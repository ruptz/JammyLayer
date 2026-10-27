//! Song requests: !sr in chat and a channel points reward, into a queue
//! JammyLayer keeps itself.
//!
//! Spotify's own queue can't be edited — anything added stays — so requests
//! wait here, where mods can remove or reorder them, and each one is handed
//! to Spotify only as the track before it is ending. One that a mod removes
//! after its hand-off is skipped the moment it starts.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::settings::{Settings, Store, Who};
use crate::spotify::{Snapshot, Spotify, Watching, now_ms};
use crate::twitch::{Incoming, Rank, RewardError, Twitch, Viewer};

/// How close to the end of the playing track the next request goes to
/// Spotify. Polls come every 3s during playback, so this leaves several tries.
const HAND_OFF_MS: u64 = 15_000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: u64,
    pub track_id: String,
    pub title: String,
    pub artist: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art_url: Option<String>,
    pub duration_ms: u64,
    pub user_login: String,
    pub user_name: String,
    /// Set for channel points, so a removed request can be refunded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redemption: Option<Redemption>,
    pub added_at: u64,
    /// In Spotify's queue now, where it can't be taken back out.
    #[serde(default)]
    pub handed_off: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Redemption {
    pub id: String,
    pub reward_id: String,
}

#[derive(Default)]
struct Queue {
    items: VecDeque<Request>,
    next_id: u64,
    /// Removed after hand-off: skipped as soon as they start.
    doomed: Vec<String>,
    /// Each viewer's last !sr, for the cooldown.
    last_request: HashMap<String, Instant>,
    /// The last track seen playing, so whether a handed-off request went
    /// missing is asked once per track change rather than every poll.
    seen: Option<String>,
    points_error: Option<String>,
    spotify_error: Option<String>,
}

pub struct Requests {
    spotify: Arc<Spotify>,
    twitch: Arc<Twitch>,
    store: Store,
    settings: Arc<RwLock<Settings>>,
    queue: Mutex<Queue>,
    /// Holds polling on while anything is waiting, with or without an overlay
    /// open, so requests still play when OBS isn't running.
    keep: Mutex<Option<Watching>>,
    /// The setup page's edits and the reward's sync, one at a time.
    turn: tokio::sync::Mutex<()>,
    updates: broadcast::Sender<Value>,
}

impl Requests {
    pub fn new(spotify: Arc<Spotify>, twitch: Arc<Twitch>, store: Store) -> Arc<Self> {
        let items: VecDeque<Request> = store.queue().into();
        let next_id = items.iter().map(|r| r.id).max().unwrap_or(0) + 1;
        let (updates, _) = broadcast::channel(16);
        let requests = Arc::new(Self {
            settings: spotify.settings.clone(),
            spotify,
            twitch,
            store,
            queue: Mutex::new(Queue { items, next_id, ..Default::default() }),
            keep: Mutex::new(None),
            turn: tokio::sync::Mutex::new(()),
            updates,
        });
        requests.keep_polling();
        requests
    }

    pub fn status(&self) -> Value {
        let settings = self.settings.read().unwrap().requests.clone();
        let q = self.queue.lock().unwrap();
        json!({
            "settings": settings,
            "twitch": self.twitch.status(),
            "spotifyConnected": self.spotify.connected(),
            "canQueue": self.spotify.can_queue(),
            "queue": q.items,
            "pointsError": q.points_error,
            "spotifyError": q.spotify_error,
        })
    }

    /// For the tray: whether there's anything to pause, and whether it is.
    pub fn pause_state(&self) -> (bool, bool) {
        let r = &self.settings.read().unwrap().requests;
        (r.enabled, r.paused)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.updates.subscribe()
    }

    fn emit(&self) {
        let _ = self.updates.send(self.status());
    }

    /// Saved, shown, and polling kept on or let go to match.
    fn changed(self: &Arc<Self>) {
        let items: Vec<_> = self.queue.lock().unwrap().items.iter().cloned().collect();
        let _ = self.store.save_queue(&items);
        self.keep_polling();
        self.emit();
    }

    /// Only while song requests are on: switched off, a leftover queue just
    /// waits, and costs no Spotify polling.
    fn keep_polling(self: &Arc<Self>) {
        let waiting = self.settings.read().unwrap().requests.enabled && {
            let q = self.queue.lock().unwrap();
            !q.items.is_empty() || !q.doomed.is_empty()
        };
        let mut keep = self.keep.lock().unwrap();
        match (waiting, keep.is_some()) {
            (true, false) => *keep = Some(self.spotify.watch()),
            (false, true) => *keep = None,
            _ => {}
        }
    }

    /// Chat replies, unless they've been switched off.
    async fn say(&self, text: &str, reply_to: Option<&str>) {
        if self.settings.read().unwrap().requests.chat_replies {
            self.twitch.say(text, reply_to).await;
        }
    }

    fn listening(&self) -> bool {
        let s = self.settings.read().unwrap();
        s.requests.chat() || s.requests.points()
    }

    /// Runs for the life of the app: Twitch's events and Spotify's playback,
    /// handled in the order they come.
    pub async fn run(self: Arc<Self>, mut incoming: mpsc::UnboundedReceiver<Incoming>) {
        let mut playback = self.spotify.listen();
        let mut spotify = (self.spotify.connected(), self.spotify.can_queue());
        loop {
            let now = (self.spotify.connected(), self.spotify.can_queue());
            if now != spotify {
                spotify = now;
                self.emit();
            }
            tokio::select! {
                event = incoming.recv() => match event {
                    Some(event) => self.incoming(event).await,
                    None => return,
                },
                snapshot = playback.recv() => match snapshot {
                    Ok(snapshot) => self.playback(snapshot).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            }
        }
    }

    // ------------------------------------------------------------------ twitch

    async fn incoming(self: &Arc<Self>, event: Incoming) {
        match event {
            Incoming::Changed => self.emit(),
            Incoming::Chat { message_id, viewer, text } => {
                let text = text.trim();
                let (command, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
                let reply = match command.to_lowercase().as_str() {
                    "!sr" | "!songrequest" => {
                        let rules = self.settings.read().unwrap().requests.clone();
                        if !rules.chat() {
                            return;
                        }
                        if rules.paused {
                            self.say("Song requests are paused right now.", Some(&message_id)).await;
                            return;
                        }
                        match self.submit(&viewer, rest, None).await {
                            Ok((r, at)) => format!("Added {} — {} (#{at} in the queue)", r.title, r.artist),
                            Err(e) => format!("Couldn't add that: {e}"),
                        }
                    }
                    "!dsr" | "!wrongsong" if self.settings.read().unwrap().requests.enabled => {
                        self.remove_for(&viewer, rest).await
                    }
                    _ => return,
                };
                self.say(&reply, Some(&message_id)).await;
            }
            Incoming::Redemption { id, reward_id, viewer, input } => {
                let rules = self.settings.read().unwrap().requests.clone();
                if rules.reward_id.as_deref() != Some(reward_id.as_str()) {
                    return;
                }
                let redemption = Redemption { id: id.clone(), reward_id: reward_id.clone() };
                // A paused reward can't be redeemed, but one may have been
                // in flight as the pause landed.
                let outcome = if rules.points() && !rules.paused {
                    self.submit(&viewer, &input, Some(redemption)).await
                } else if rules.paused {
                    Err("song requests are paused right now".into())
                } else {
                    Err("song requests are off right now".into())
                };
                let reply = match outcome {
                    Ok((r, at)) => format!("@{} added {} — {} (#{at} in the queue)", viewer.name, r.title, r.artist),
                    Err(e) => {
                        self.twitch.settle(&reward_id, &id, "CANCELED").await;
                        format!("@{} couldn't add that: {e}. Your points are refunded.", viewer.name)
                    }
                };
                self.say(&reply, None).await;
            }
        }
    }

    /// A new request, checked against the rules. Mods and the broadcaster
    /// skip the limits; nobody skips a duplicate.
    async fn submit(
        self: &Arc<Self>,
        viewer: &Viewer,
        text: &str,
        redemption: Option<Redemption>,
    ) -> Result<(Request, usize), String> {
        let rules = self.settings.read().unwrap().requests.clone();
        let staff = viewer.rank >= Rank::Moderator;
        let chat = redemption.is_none();
        if chat && !allowed(rules.who, viewer.rank) {
            return Err(match rules.who {
                Who::Subscribers => "requests are for subscribers right now",
                Who::Vips => "requests are for VIPs right now",
                _ => "requests are for mods right now",
            }
            .into());
        }
        let Some(track_id) = track_id(text) else {
            return Err("paste a Spotify track link, like open.spotify.com/track/…".into());
        };
        if !self.spotify.connected() {
            return Err("Spotify isn't connected".into());
        }
        {
            let q = self.queue.lock().unwrap();
            if q.items.iter().any(|r| r.track_id == track_id) {
                return Err("that song is already in the queue".into());
            }
            if !staff {
                if chat {
                    let cooldown = Duration::from_secs(rules.cooldown_secs);
                    if let Some(left) = q.last_request.get(&viewer.id).and_then(|at| cooldown.checked_sub(at.elapsed())) {
                        return Err(format!("wait {}s before requesting again", left.as_secs().max(1)));
                    }
                }
                if q.items.len() >= rules.queue_limit as usize {
                    return Err("the queue is full".into());
                }
                let theirs = q.items.iter().filter(|r| r.user_login == viewer.login).count();
                if rules.max_per_user > 0 && theirs >= rules.max_per_user as usize {
                    return Err(format!("you already have {theirs} in the queue"));
                }
            }
        }
        let track = self.spotify.track(&track_id).await?;
        if !staff {
            if track.explicit && !rules.allow_explicit {
                return Err("explicit songs aren't allowed".into());
            }
            if rules.max_minutes > 0 && track.duration_ms > u64::from(rules.max_minutes) * 60_000 {
                return Err(format!("songs can be {} minutes at most", rules.max_minutes));
            }
        }
        let (request, at) = {
            let mut q = self.queue.lock().unwrap();
            // Checked again: another request may have landed during the lookup.
            if q.items.iter().any(|r| r.track_id == track_id) {
                return Err("that song is already in the queue".into());
            }
            let request = Request {
                id: q.next_id,
                track_id: track.id,
                title: track.title,
                artist: track.artist,
                art_url: track.art_url,
                duration_ms: track.duration_ms,
                user_login: viewer.login.clone(),
                user_name: viewer.name.clone(),
                redemption,
                added_at: now_ms(),
                handed_off: false,
            };
            q.next_id += 1;
            q.items.push_back(request.clone());
            if chat {
                q.last_request.insert(viewer.id.clone(), Instant::now());
            }
            (request, q.items.len())
        };
        self.changed();
        Ok((request, at))
    }

    /// !dsr: a mod's removes the newest request, or the linked one; anyone
    /// else's removes their own newest, or their linked one.
    async fn remove_for(self: &Arc<Self>, viewer: &Viewer, text: &str) -> String {
        let staff = viewer.rank >= Rank::Moderator;
        let target = track_id(text);
        let found = {
            let q = self.queue.lock().unwrap();
            let mine = |r: &Request| staff || r.user_login == viewer.login;
            match &target {
                Some(id) => match q.items.iter().rposition(|r| r.track_id == *id) {
                    Some(i) if mine(&q.items[i]) => Ok(q.items[i].id),
                    Some(_) => Err("only mods can remove someone else's request"),
                    None => Err("that song isn't in the queue"),
                },
                None => q
                    .items
                    .iter()
                    .rposition(mine)
                    .map(|i| q.items[i].id)
                    .ok_or(if staff { "the queue is empty" } else { "you have nothing in the queue" }),
            }
        };
        match found {
            Ok(id) => match self.remove(id).await {
                Some(r) => format!("Removed {} — {} (requested by {})", r.title, r.artist, r.user_name),
                None => "that song isn't in the queue".into(),
            },
            Err(e) => format!("Couldn't remove that: {e}"),
        }
    }

    // --------------------------------------------------------------- the queue

    /// Removed, refunded if it was paid for with points, and skipped later if
    /// Spotify already has it.
    pub async fn remove(self: &Arc<Self>, id: u64) -> Option<Request> {
        let request = {
            let mut q = self.queue.lock().unwrap();
            let i = q.items.iter().position(|r| r.id == id)?;
            let request = q.items.remove(i)?;
            if request.handed_off {
                q.doomed.push(request.track_id.clone());
            }
            request
        };
        self.changed();
        if let Some(r) = &request.redemption {
            self.twitch.settle(&r.reward_id, &r.id, "CANCELED").await;
        }
        Some(request)
    }

    /// One place up or down. A handed-off request is already fixed in
    /// Spotify's queue, so nothing moves past it.
    pub fn shift(self: &Arc<Self>, id: u64, up: bool) -> bool {
        let moved = {
            let mut q = self.queue.lock().unwrap();
            let Some(i) = q.items.iter().position(|r| r.id == id) else { return false };
            let j = if up { i.checked_sub(1) } else { Some(i + 1).filter(|j| *j < q.items.len()) };
            match j {
                Some(j) if !q.items[i].handed_off && !q.items[j].handed_off => {
                    q.items.swap(i, j);
                    true
                }
                _ => false,
            }
        };
        if moved {
            self.changed();
        }
        moved
    }

    pub async fn clear(self: &Arc<Self>) {
        let ids: Vec<u64> = self.queue.lock().unwrap().items.iter().map(|r| r.id).collect();
        for id in ids {
            self.remove(id).await;
        }
    }

    // ---------------------------------------------------------------- playback

    async fn playback(self: &Arc<Self>, snapshot: Snapshot) {
        if !self.settings.read().unwrap().requests.enabled {
            return;
        }
        let Some(item) = snapshot.item else { return };
        let current = item.id;

        let doomed = {
            let mut q = self.queue.lock().unwrap();
            q.doomed.iter().position(|t| *t == current).map(|i| q.doomed.remove(i))
        };
        if doomed.is_some() {
            if let Err(e) = self.spotify.skip().await {
                eprintln!("[jammylayer] could not skip a removed request: {e}");
            }
            self.changed();
            return;
        }

        let started = {
            let mut q = self.queue.lock().unwrap();
            let front = q.items.front().is_some_and(|r| r.handed_off && r.track_id == current);
            if front { q.items.pop_front() } else { None }
        };
        if let Some(r) = started {
            self.changed();
            if let Some(redemption) = &r.redemption {
                self.twitch.settle(&redemption.reward_id, &redemption.id, "FULFILLED").await;
            }
            if self.listening() {
                let line = format!("Now playing {} — {}, requested by {}", r.title, r.artist, r.user_name);
                self.say(&line, None).await;
            }
        }

        // A track change that isn't the handed-off request: the streamer may
        // have cleared Spotify's queue or started an album. If it's gone, it
        // goes back to waiting here and is handed off again.
        let missing = {
            let mut q = self.queue.lock().unwrap();
            let changed = q.seen.as_deref() != Some(current.as_str());
            q.seen = Some(current.clone());
            q.items.front().filter(|r| changed && r.handed_off).map(|r| (r.id, r.track_id.clone()))
        };
        if let Some((id, track)) = missing
            && let Ok(false) = self.spotify.queued(&track).await
        {
            if let Some(r) = self.queue.lock().unwrap().items.iter_mut().find(|r| r.id == id) {
                r.handed_off = false;
            }
            self.changed();
        }

        let remaining = item.duration_ms.saturating_sub(snapshot.progress_ms);
        if !snapshot.playing || item.duration_ms == 0 || remaining > HAND_OFF_MS {
            return;
        }
        let next = {
            let q = self.queue.lock().unwrap();
            q.items.front().filter(|r| !r.handed_off).map(|r| (r.id, r.track_id.clone()))
        };
        let Some((id, track)) = next else { return };
        let result = self.spotify.add_to_queue(&track).await;
        {
            let mut q = self.queue.lock().unwrap();
            match &result {
                Ok(()) => {
                    if let Some(r) = q.items.iter_mut().find(|r| r.id == id) {
                        r.handed_off = true;
                    }
                    q.spotify_error = None;
                }
                Err(e) => q.spotify_error = Some(e.clone()),
            }
        }
        self.changed();
    }

    // ------------------------------------------------------------- the setup page

    /// The switches and limits, any subset of them. Turning channel points on
    /// creates the reward, and off hides it from viewers.
    pub async fn configure(self: &Arc<Self>, body: &Value) -> Result<(), String> {
        let _one_at_a_time = self.turn.lock().await;
        let before = self.settings.read().unwrap().requests.clone();
        {
            let mut s = self.settings.write().unwrap();
            let r = &mut s.requests;
            let flag = |k: &str, v: &mut bool| {
                if let Some(b) = body[k].as_bool() {
                    *v = b;
                }
            };
            let number = |k: &str, v: &mut u32, max: u32| {
                if let Some(n) = body[k].as_u64() {
                    *v = n.min(u64::from(max)) as u32;
                }
            };
            flag("enabled", &mut r.enabled);
            flag("paused", &mut r.paused);
            flag("chatEnabled", &mut r.chat_enabled);
            flag("pointsEnabled", &mut r.points_enabled);
            flag("allowExplicit", &mut r.allow_explicit);
            flag("chatReplies", &mut r.chat_replies);
            number("maxPerUser", &mut r.max_per_user, 50);
            number("maxMinutes", &mut r.max_minutes, 60);
            number("queueLimit", &mut r.queue_limit, 200);
            number("rewardCost", &mut r.reward_cost, 1_000_000);
            r.reward_cost = r.reward_cost.max(1);
            if let Some(n) = body["cooldownSecs"].as_u64() {
                r.cooldown_secs = n.min(3600);
            }
            if let Some(who) = body["who"].as_str() {
                r.who = match who {
                    "subscribers" => Who::Subscribers,
                    "vips" => Who::Vips,
                    "mods" => Who::Mods,
                    _ => Who::Everyone,
                };
            }
            if let Some(title) = body["rewardTitle"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                r.reward_title = title.chars().take(45).collect();
            }
        }
        let after = self.settings.read().unwrap().requests.clone();
        let reward_changed = before.points() != after.points()
            || (after.points()
                && (before.reward_cost != after.reward_cost
                    || before.reward_title != after.reward_title
                    || before.paused != after.paused));
        let result = if reward_changed { self.sync_reward().await } else { Ok(()) };
        self.save_settings();
        self.twitch.reconsider();
        self.keep_polling();
        self.emit();
        result
    }

    /// Makes the reward on Twitch match the settings, creating it if there
    /// isn't one this app owns. A failure to turn it on leaves it off.
    async fn sync_reward(self: &Arc<Self>) -> Result<(), String> {
        let rules = self.settings.read().unwrap().requests.clone();
        let on = rules.points();
        let result = if !self.twitch.connected() {
            if on { Err("Connect Twitch first".to_string()) } else { Ok(()) }
        } else {
            let changes = json!({
                "title": rules.reward_title,
                "cost": rules.reward_cost,
                // Off hides it, so nobody spends points on something that won't play.
                "is_enabled": on,
                // Paused shows viewers the reward but won't take their points.
                "is_paused": rules.paused,
            });
            let existing = match &rules.reward_id {
                Some(id) => self.twitch.update_reward(id, changes).await,
                None => Err(RewardError::Missing),
            };
            match existing {
                Ok(()) => Ok(()),
                Err(RewardError::Missing) if on => {
                    match self.twitch.create_reward(&rules.reward_title, rules.reward_cost).await {
                        Ok(id) => {
                            self.settings.write().unwrap().requests.reward_id = Some(id);
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }
                Err(RewardError::Missing) => {
                    self.settings.write().unwrap().requests.reward_id = None;
                    Ok(())
                }
                Err(RewardError::Other(e)) => Err(e),
            }
        };
        if result.is_err() && on {
            self.settings.write().unwrap().requests.points_enabled = false;
        }
        self.queue.lock().unwrap().points_error = result.clone().err();
        result
    }

    fn save_settings(&self) {
        let settings = self.settings.read().unwrap().clone();
        let _ = self.store.save_settings(&settings);
    }
}

fn allowed(who: Who, rank: Rank) -> bool {
    match who {
        Who::Everyone => true,
        Who::Subscribers => rank >= Rank::Subscriber,
        Who::Vips => rank >= Rank::Vip,
        Who::Mods => rank >= Rank::Moderator,
    }
}

/// The track in an open.spotify.com link or a spotify:track: URI, wherever
/// it sits in the message.
pub fn track_id(text: &str) -> Option<String> {
    let valid = |id: &str| (id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric())).then(|| id.to_owned());
    text.split_whitespace().find_map(|word| {
        let word = word.trim_matches(|c| c == '<' || c == '>');
        if let Some(id) = word.strip_prefix("spotify:track:") {
            return valid(id);
        }
        let (_, path) = word.split_once("open.spotify.com/")?;
        let mut parts = path.split(['/', '?', '#']).filter(|p| !p.is_empty());
        let mut kind = parts.next()?;
        // open.spotify.com/intl-de/track/…
        if kind.starts_with("intl-") {
            kind = parts.next()?;
        }
        if kind != "track" {
            return None;
        }
        valid(parts.next()?)
    })
}

#[cfg(test)]
mod tests {
    use super::track_id;

    #[test]
    fn finds_tracks() {
        let id = Some("4cOdK2wGLETKBW3PvgPWqT".to_string());
        assert_eq!(track_id("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc"), id);
        assert_eq!(track_id("!sr open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT"), id);
        assert_eq!(track_id("spotify:track:4cOdK2wGLETKBW3PvgPWqT"), id);
        assert_eq!(track_id("play this <https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT> pls"), id);
        assert_eq!(track_id("https://open.spotify.com/album/4cOdK2wGLETKBW3PvgPWqT"), None);
        assert_eq!(track_id("never gonna give you up"), None);
    }
}
