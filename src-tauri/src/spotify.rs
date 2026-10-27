//! The Spotify account and what it's playing.
//!
//! Polling runs only while something is watching (an overlay in OBS, or the
//! setup page's preview), so a stream that's offline costs no API quota.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Notify, broadcast};

use crate::settings::{Settings, Store, Tokens};

const ACCOUNTS: &str = "https://accounts.spotify.com";
const API: &str = "https://api.spotify.com/v1";
const SCOPES: &str = "user-read-currently-playing user-read-playback-state";
/// Asked for only once song requests are switched on: adding to the queue, and
/// skipping a request a mod removed after it was already handed to Spotify.
const QUEUE_SCOPE: &str = "user-modify-playback-state";

const POLL_PLAYING: Duration = Duration::from_secs(3);
const POLL_IDLE: Duration = Duration::from_secs(10);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// How long a "Connect Spotify" link stays usable.
const STATE_LIFETIME: Duration = Duration::from_secs(10 * 60);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub(crate) id: String,
    #[serde(rename = "type")]
    kind: String,
    title: String,
    subtitle: String,
    context: String,
    pub(crate) duration_ms: u64,
    art_url: Option<String>,
    explicit: bool,
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

#[derive(Default)]
struct Account {
    refresh_token: Option<String>,
    access_token: Option<String>,
    expires_at: Option<Instant>,
    /// What the account granted, as of the last token. An account connected
    /// before song requests existed lacks the queue scope until reconnected.
    scope: Option<String>,
    auth_error: Option<String>,
}

/// A track as a song request needs it.
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub art_url: Option<String>,
    pub duration_ms: u64,
    pub explicit: bool,
}

pub struct Spotify {
    http: reqwest::Client,
    store: Store,
    pub settings: Arc<RwLock<Settings>>,
    account: Mutex<Account>,
    playback: Mutex<Playback>,
    /// "Connect Spotify" links handed out and not yet used, with when they lapse.
    pending: Mutex<HashMap<String, Instant>>,
    /// One refresh at a time, however many requests want a token.
    refreshing: tokio::sync::Mutex<()>,
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

struct ApiError {
    message: String,
    retry_after: Option<Duration>,
}

impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self { message, retry_after: None }
    }
}

impl Spotify {
    pub fn new(store: Store, settings: Arc<RwLock<Settings>>) -> Arc<Self> {
        let refresh_token = store.tokens().refresh_token;
        let (updates, _) = broadcast::channel(16);
        Arc::new(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("JammyLayer/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("an HTTP client"),
            store,
            settings,
            account: Mutex::new(Account { refresh_token, ..Default::default() }),
            playback: Mutex::new(Playback::default()),
            pending: Mutex::new(HashMap::new()),
            refreshing: tokio::sync::Mutex::new(()),
            failures: Mutex::new(0),
            watchers: AtomicUsize::new(0),
            wake: Notify::new(),
            updates,
        })
    }

    pub fn configured(&self) -> bool {
        self.settings.read().unwrap().configured()
    }

    pub fn connected(&self) -> bool {
        self.account.lock().unwrap().refresh_token.is_some()
    }

    pub fn snapshot(&self) -> Snapshot {
        let p = self.playback.lock().unwrap();
        let auth_error = self.account.lock().unwrap().auth_error.clone();
        Snapshot {
            playing: p.playing,
            item: p.item.clone(),
            progress_ms: p.progress_ms,
            device: p.device.clone(),
            fetched_at: p.fetched_at,
            error: p.error.clone(),
            configured: self.configured(),
            connected: self.connected(),
            auth_error,
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
        let account = self.account.lock().unwrap();
        account.refresh_token.as_ref()?;
        let scope = account.scope.as_deref()?;
        Some(scope.split(' ').any(|s| s == QUEUE_SCOPE))
    }

    // ------------------------------------------------------------ authorization

    pub fn authorize_url(&self) -> String {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("randomness for the login state");
        let state: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        {
            let mut pending = self.pending.lock().unwrap();
            let now = Instant::now();
            pending.retain(|_, expires| *expires > now);
            pending.insert(state.clone(), now + STATE_LIFETIME);
        }
        let settings = self.settings.read().unwrap();
        let scopes = if settings.requests.enabled { format!("{SCOPES} {QUEUE_SCOPE}") } else { SCOPES.to_owned() };
        let query = [
            ("response_type", "code"),
            ("client_id", settings.client_id.as_str()),
            ("scope", scopes.as_str()),
            ("redirect_uri", settings.redirect_uri().as_str()),
            ("state", state.as_str()),
        ]
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&");
        format!("{ACCOUNTS}/authorize?{query}")
    }

    /// Each link works once, and only within its lifetime.
    pub fn consume_state(&self, state: &str) -> bool {
        self.pending
            .lock()
            .unwrap()
            .remove(state)
            .is_some_and(|expires| expires >= Instant::now())
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<Value, (String, Option<String>)> {
        let (id, secret) = {
            let s = self.settings.read().unwrap();
            (s.client_id.clone(), s.client_secret.clone())
        };
        let resp = self
            .http
            .post(format!("{ACCOUNTS}/api/token"))
            .basic_auth(id, Some(secret))
            .form(form)
            .send()
            .await
            .map_err(|_| ("Couldn't reach Spotify.".to_string(), None))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let code = body["error"].as_str().map(str::to_owned);
            let message = body["error_description"]
                .as_str()
                .or(code.as_deref())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("token request failed ({status})"));
            return Err((message, code));
        }
        Ok(body)
    }

    fn remember(&self, refresh_token: &str) {
        let _ = self.store.save_tokens(&Tokens {
            refresh_token: Some(refresh_token.to_owned()),
            obtained_at: Some(now_ms().to_string()),
        });
    }

    pub async fn exchange_code(&self, code: &str) -> Result<(), String> {
        let redirect = self.settings.read().unwrap().redirect_uri();
        let granted = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &redirect),
            ])
            .await
            .map_err(|(message, _)| message)?;
        let refresh = granted["refresh_token"].as_str().unwrap_or_default().to_owned();
        {
            let mut account = self.account.lock().unwrap();
            account.access_token = granted["access_token"].as_str().map(str::to_owned);
            account.expires_at = Some(Instant::now() + expires_in(&granted));
            account.scope = granted["scope"].as_str().map(str::to_owned);
            account.refresh_token = Some(refresh.clone());
            account.auth_error = None;
        }
        *self.failures.lock().unwrap() = 0;
        self.remember(&refresh);
        self.tick().await;
        Ok(())
    }

    pub fn disconnect(&self) {
        *self.account.lock().unwrap() = Account::default();
        let _ = self.store.save_tokens(&Tokens::default());
        {
            let mut p = self.playback.lock().unwrap();
            *p = Playback { fetched_at: p.fetched_at, ..Default::default() };
        }
        self.emit();
    }

    async fn access_token(&self) -> Result<String, String> {
        if !self.configured() {
            return Err("Spotify client credentials are not set".into());
        }
        let _one_at_a_time = self.refreshing.lock().await;
        let refresh = {
            let account = self.account.lock().unwrap();
            let Some(refresh) = account.refresh_token.clone() else {
                return Err("No Spotify account connected".into());
            };
            if let (Some(token), Some(expires)) = (&account.access_token, account.expires_at) {
                if expires > Instant::now() + Duration::from_secs(60) {
                    return Ok(token.clone());
                }
            }
            refresh
        };
        match self
            .token_request(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)])
            .await
        {
            Ok(granted) => {
                let token = granted["access_token"].as_str().unwrap_or_default().to_owned();
                let rotated = granted["refresh_token"].as_str().filter(|r| *r != refresh);
                let mut account = self.account.lock().unwrap();
                account.access_token = Some(token.clone());
                account.expires_at = Some(Instant::now() + expires_in(&granted));
                if let Some(scope) = granted["scope"].as_str() {
                    account.scope = Some(scope.to_owned());
                }
                account.auth_error = None;
                // A rotated refresh token has to be saved, or the next start
                // signs in with one Spotify has already retired.
                if let Some(rotated) = rotated {
                    account.refresh_token = Some(rotated.to_owned());
                    drop(account);
                    self.remember(rotated);
                }
                Ok(token)
            }
            Err((message, code)) => {
                if code.as_deref() == Some("invalid_grant") {
                    *self.account.lock().unwrap() = Account {
                        auth_error: Some(
                            "Spotify rejected the saved authorization. Connect the account again."
                                .into(),
                        ),
                        ..Default::default()
                    };
                    let _ = self.store.save_tokens(&Tokens::default());
                }
                Err(message)
            }
        }
    }

    // -------------------------------------------------------------- now playing

    async fn fetch_now_playing(&self) -> Result<Playback, ApiError> {
        let resp = self
            .call(reqwest::Method::GET, "/me/player/currently-playing?additional_types=track,episode")
            .await?;
        match resp.status().as_u16() {
            429 => {
                let secs = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(5);
                Err(ApiError {
                    message: "Spotify rate limit reached".into(),
                    retry_after: Some(Duration::from_secs(secs + 1)),
                })
            }
            // Connected, but nothing is loaded in any player.
            204 => Ok(Playback::default()),
            status if !(200..300).contains(&status) => {
                Err(format!("Spotify API returned {status}").into())
            }
            _ => {
                let body: Value = resp
                    .json()
                    .await
                    .map_err(|_| "Spotify sent something unexpected".to_string())?;
                Ok(normalize(&body))
            }
        }
    }

    async fn call(&self, method: reqwest::Method, path: &str) -> Result<reqwest::Response, String> {
        let url = format!("{API}{path}");
        let send = |token: String| {
            self.http
                .request(method.clone(), &url)
                .bearer_auth(token)
                // The player POSTs carry everything in the query, but Spotify
                // still wants a length.
                .header(reqwest::header::CONTENT_LENGTH, "0")
                .send()
        };
        let unreachable = |_| "Couldn't reach Spotify".to_string();
        let mut resp = send(self.access_token().await?).await.map_err(unreachable)?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            // Revoked or expired early: force one refresh and retry once.
            self.account.lock().unwrap().access_token = None;
            resp = send(self.access_token().await?).await.map_err(unreachable)?;
        }
        Ok(resp)
    }

    // ------------------------------------------------------------ song requests

    pub async fn track(&self, id: &str) -> Result<Track, String> {
        let resp = self.call(reqwest::Method::GET, &format!("/tracks/{id}?market=from_token")).await?;
        match resp.status().as_u16() {
            400 | 404 => return Err("that track doesn't exist on Spotify".into()),
            status if !(200..300).contains(&status) => return Err(format!("Spotify returned {status}")),
            _ => {}
        }
        let body: Value = resp.json().await.map_err(|_| "Spotify sent something unexpected".to_string())?;
        if body["is_playable"] == false {
            return Err("that track isn't playable in this country".into());
        }
        Ok(Track {
            id: id.to_owned(),
            title: body["name"].as_str().unwrap_or_default().to_owned(),
            artist: body["artists"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
                .unwrap_or_default(),
            art_url: pick_image(&body["album"]["images"]),
            duration_ms: body["duration_ms"].as_u64().unwrap_or(0),
            explicit: body["explicit"].as_bool().unwrap_or(false),
        })
    }

    pub async fn add_to_queue(&self, track_id: &str) -> Result<(), String> {
        let uri = encode(&format!("spotify:track:{track_id}"));
        let resp = self.call(reqwest::Method::POST, &format!("/me/player/queue?uri={uri}")).await?;
        player_result(resp).await
    }

    pub async fn skip(&self) -> Result<(), String> {
        let resp = self.call(reqwest::Method::POST, "/me/player/next").await?;
        player_result(resp).await
    }

    /// Whether a track is still waiting in Spotify's own queue.
    pub async fn queued(&self, track_id: &str) -> Result<bool, String> {
        let resp = self.call(reqwest::Method::GET, "/me/player/queue").await?;
        if !resp.status().is_success() {
            return Err(format!("Spotify returned {}", resp.status().as_u16()));
        }
        let body: Value = resp.json().await.map_err(|_| "Spotify sent something unexpected".to_string())?;
        Ok(body["queue"].as_array().is_some_and(|q| q.iter().any(|t| t["id"] == track_id)))
    }

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
        match self.fetch_now_playing().await {
            Ok(mut next) => {
                next.fetched_at = now_ms();
                let playing = next.playing;
                *self.playback.lock().unwrap() = next;
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

fn expires_in(granted: &Value) -> Duration {
    Duration::from_secs(granted["expires_in"].as_u64().unwrap_or(3600))
}

/// Around 300px keeps the art crisp at overlay sizes without pulling a 640px
/// JPEG every track.
/// The player endpoints' refusals, in words a streamer can act on.
async fn player_result(resp: reqwest::Response) -> Result<(), String> {
    let status = resp.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(());
    }
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let reason = body["error"]["reason"].as_str().unwrap_or_default();
    let message = body["error"]["message"].as_str().unwrap_or_default();
    Err(match (status, reason) {
        (403, "PREMIUM_REQUIRED") => "Spotify Premium is needed to queue songs".into(),
        (404, _) | (_, "NO_ACTIVE_DEVICE") => "nothing is playing on Spotify".into(),
        (403, _) if message.contains("scope") => "reconnect Spotify to allow song requests".into(),
        (429, _) => "Spotify rate limit reached".into(),
        _ => format!("Spotify returned {status}"),
    })
}

fn pick_image(images: &Value) -> Option<String> {
    images
        .as_array()?
        .iter()
        .min_by_key(|i| (i["width"].as_i64().unwrap_or(0) - 300).abs())
        .and_then(|i| i["url"].as_str())
        .map(str::to_owned)
}

fn normalize(body: &Value) -> Playback {
    let device = body["device"]["name"].as_str().map(str::to_owned);
    let playing = body["is_playing"].as_bool().unwrap_or(false);
    let item = &body["item"];
    if item.is_null() {
        return Playback { playing, device, ..Default::default() };
    }
    let episode = item["type"] == "episode";
    let images = if episode {
        if item["images"].is_array() { &item["images"] } else { &item["show"]["images"] }
    } else {
        &item["album"]["images"]
    };
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    let subtitle = if episode {
        text(&item["show"]["name"])
    } else {
        item["artists"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default()
    };
    let id = [&item["id"], &item["uri"], &item["name"]]
        .into_iter()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
        .unwrap_or_default()
        .to_owned();
    Playback {
        playing,
        progress_ms: body["progress_ms"].as_u64().unwrap_or(0),
        device,
        item: Some(Item {
            id,
            kind: text(&item["type"]),
            title: text(&item["name"]),
            subtitle,
            context: text(if episode { &item["show"]["publisher"] } else { &item["album"]["name"] }),
            duration_ms: item["duration_ms"].as_u64().unwrap_or(0),
            art_url: pick_image(images),
            explicit: item["explicit"].as_bool().unwrap_or(false),
        }),
        ..Default::default()
    }
}

/// Percent-encoding for query values.
pub fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
