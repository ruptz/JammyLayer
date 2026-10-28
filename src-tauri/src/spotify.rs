//! The Spotify account and what it's playing.
//!
//! Polling runs only while something is watching (an overlay in OBS, or the
//! setup page's preview), so a stream that's offline costs no API quota.
//!
//! Sign-in and the Web API live in layer-spotify, shared with the other Layer
//! apps. What's JammyLayer's own is here: its Spotify app's keys and redirect
//! (settings.json), where the sign-in is saved (tokens.json), when it asks to
//! control playback, and the polling behind the overlay.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use layer_spotify::{CONTROL_SCOPE, Config, Credentials, Host, READ_SCOPES, Tokens};
pub use layer_spotify::{Item, Track};
use serde::Serialize;
use tokio::sync::{Notify, broadcast};

use crate::settings::{Settings, Store};

const POLL_PLAYING: Duration = Duration::from_secs(3);
const POLL_IDLE: Duration = Duration::from_secs(10);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What the overlay and the setup page are told, field for field what the
/// pages in public/ expect.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub(crate) playing: bool,
    pub(crate) item: Option<Item>,
    pub(crate) progress_ms: u64,
    device: Option<String>,
    fetched_at: u64,
    error: Option<String>,
    configured: bool,
    connected: bool,
    auth_error: Option<String>,
    server_time: u64,
}

#[derive(Default)]
struct Playback {
    playing: bool,
    item: Option<Item>,
    progress_ms: u64,
    device: Option<String>,
    fetched_at: u64,
    error: Option<String>,
}

struct Jammy {
    store: Store,
    settings: Arc<RwLock<Settings>>,
}

impl Host for Jammy {
    fn credentials(&self) -> Credentials {
        let s = self.settings.read().unwrap();
        Credentials { client_id: s.client_id.clone(), client_secret: s.client_secret.clone(), redirect_uri: s.redirect_uri() }
    }

    /// Control is asked for only once song requests are switched on: adding
    /// to the queue, and skipping a request a mod removed after it was
    /// already handed to Spotify.
    fn scopes(&self) -> String {
        if self.settings.read().unwrap().requests.enabled {
            format!("{READ_SCOPES} {CONTROL_SCOPE}")
        } else {
            READ_SCOPES.to_owned()
        }
    }

    fn load_tokens(&self) -> Tokens {
        self.store.tokens()
    }

    fn save_tokens(&self, tokens: &Tokens) {
        let _ = self.store.save_tokens(tokens);
    }
}

pub struct Spotify {
    client: Arc<layer_spotify::Spotify>,
    pub settings: Arc<RwLock<Settings>>,
    playback: Mutex<Playback>,
    failures: Mutex<u32>,
    watchers: AtomicUsize,
    wake: Notify,
    updates: broadcast::Sender<Snapshot>,
}

/// Held for as long as an overlay or preview is watching; polling stops when
/// the last one is dropped.
pub struct Watching(Arc<Spotify>);

impl Drop for Watching {
    fn drop(&mut self) {
        self.0.watchers.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Spotify {
    pub fn new(store: Store, settings: Arc<RwLock<Settings>>) -> Arc<Self> {
        let (updates, _) = broadcast::channel(16);
        let client = layer_spotify::Spotify::new(
            Arc::new(Jammy { store, settings: settings.clone() }),
            Config { app: "JammyLayer", version: env!("CARGO_PKG_VERSION") },
        );
        Arc::new(Self {
            client,
            settings,
            playback: Mutex::new(Playback::default()),
            failures: Mutex::new(0),
            watchers: AtomicUsize::new(0),
            wake: Notify::new(),
            updates,
        })
    }

    pub fn configured(&self) -> bool {
        self.client.configured()
    }

    pub fn connected(&self) -> bool {
        self.client.connected()
    }

    pub fn snapshot(&self) -> Snapshot {
        let p = self.playback.lock().unwrap();
        Snapshot {
            playing: p.playing,
            item: p.item.clone(),
            progress_ms: p.progress_ms,
            device: p.device.clone(),
            fetched_at: p.fetched_at,
            error: p.error.clone(),
            configured: self.configured(),
            connected: self.connected(),
            auth_error: self.client.auth_error(),
            server_time: now_ms(),
        }
    }

    pub fn emit(&self) {
        let _ = self.updates.send(self.snapshot());
    }

    pub fn subscribe(self: &Arc<Self>) -> (broadcast::Receiver<Snapshot>, Watching) {
        (self.listen(), self.watch())
    }

    /// Updates, without asking for any polling to happen.
    pub fn listen(&self) -> broadcast::Receiver<Snapshot> {
        self.updates.subscribe()
    }

    /// Polling, for as long as the guard is held.
    pub fn watch(self: &Arc<Self>) -> Watching {
        self.watchers.fetch_add(1, Ordering::SeqCst);
        self.wake.notify_one();
        Watching(self.clone())
    }

    /// None until a token has said either way.
    pub fn can_queue(&self) -> Option<bool> {
        self.client.can_control()
    }

    // ------------------------------------------------------------ authorization

    pub fn authorize_url(&self) -> String {
        self.client.authorize_url()
    }

    /// Each link works once, and only within its lifetime.
    pub fn consume_state(&self, state: &str) -> bool {
        self.client.consume_state(state)
    }

    pub async fn exchange_code(&self, code: &str) -> Result<(), String> {
        self.client.exchange_code(code).await?;
        *self.failures.lock().unwrap() = 0;
        self.tick().await;
        Ok(())
    }

    pub fn disconnect(&self) {
        self.client.disconnect();
        {
            let mut p = self.playback.lock().unwrap();
            *p = Playback { fetched_at: p.fetched_at, ..Default::default() };
        }
        self.emit();
    }

    // ------------------------------------------------------------ song requests

    pub async fn track(&self, id: &str) -> Result<Track, String> {
        self.client.track(id).await
    }

    pub async fn add_to_queue(&self, track_id: &str) -> Result<(), String> {
        self.client.add_to_queue(track_id).await
    }

    pub async fn skip(&self) -> Result<(), String> {
        self.client.skip().await
    }

    /// Whether a track is still waiting in Spotify's own queue.
    pub async fn queued(&self, track_id: &str) -> Result<bool, String> {
        self.client.queued(track_id).await
    }

    // -------------------------------------------------------------- now playing

    /// One poll. Returns how long to wait before the next.
    async fn tick(&self) -> Duration {
        if !self.configured() || !self.connected() {
            {
                let mut p = self.playback.lock().unwrap();
                *p = Playback { fetched_at: p.fetched_at, ..Default::default() };
            }
            self.emit();
            return POLL_IDLE;
        }
        match self.client.now_playing().await {
            Ok(now) => {
                let playing = now.playing;
                *self.playback.lock().unwrap() = Playback {
                    playing,
                    item: now.item,
                    progress_ms: now.progress_ms,
                    device: now.device,
                    fetched_at: now_ms(),
                    error: None,
                };
                *self.failures.lock().unwrap() = 0;
                self.emit();
                if playing { POLL_PLAYING } else { POLL_IDLE }
            }
            Err(error) => {
                // Keep the last track on screen rather than blanking the
                // overlay mid-stream.
                self.playback.lock().unwrap().error = Some(error.message);
                self.emit();
                error.retry_after.unwrap_or_else(|| {
                    let mut failures = self.failures.lock().unwrap();
                    let wait = POLL_PLAYING.saturating_mul(1 << (*failures).min(4));
                    *failures += 1;
                    wait.min(BACKOFF_MAX)
                })
            }
        }
    }

    /// A fresh answer for the JSON endpoint when no overlay is streaming.
    pub async fn refetch(&self) -> Snapshot {
        let fetched_at = self.playback.lock().unwrap().fetched_at;
        if now_ms().saturating_sub(fetched_at) > 2000 {
            self.tick().await;
        }
        self.snapshot()
    }

    /// Runs for the life of the app, polling only while someone watches.
    pub async fn poll(self: Arc<Self>) {
        loop {
            if self.watchers.load(Ordering::SeqCst) == 0 {
                self.wake.notified().await;
                continue;
            }
            let wait = self.tick().await;
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                // A new watcher gets an immediate answer.
                _ = self.wake.notified() => {}
            }
        }
    }
}
