//! What JammyLayer remembers between runs, in the same per-user folder and
//! files the Electron build used (%APPDATA%\JammyLayer\settings.json and
//! tokens.json), so an existing install keeps its credentials and account.

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::requests::Request;

/// The Twitch sign-in, kept apart from tokens.json, which the Spotify account
/// owns outright. Its shape is layer-twitch's.
pub use layer_twitch::TwitchTokens;
/// The Spotify sign-in (tokens.json). Its shape is layer-spotify's.
pub use layer_spotify::Tokens;

pub const DEFAULT_PORT: u16 = 8888;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    /// Only set by hand when 8888 is taken; Spotify's redirect URI must match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Off unless asked for: closing the window quits. On, it hides to the
    /// tray and keeps serving, which is what OBS wants but not what "close"
    /// usually means.
    #[serde(default)]
    pub close_to_tray: bool,
    /// A second app the user registers, on Twitch's developer console, for
    /// song requests from chat and channel points. The secret is optional:
    /// without one it's a Public client, whose sign-in lasts 30 days.
    #[serde(default)]
    pub twitch_client_id: String,
    #[serde(default)]
    pub twitch_client_secret: String,
    #[serde(default)]
    pub requests: RequestSettings,
}

/// Who may use !sr in chat. Channel points are open to anyone who can pay.
#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Who {
    #[default]
    Everyone,
    Subscribers,
    Vips,
    Mods,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestSettings {
    /// The whole feature, off unless switched on. Off, JammyLayer doesn't
    /// connect to Twitch, doesn't touch the queue, hides the reward, and
    /// doesn't ask Spotify for permission to control playback.
    pub enabled: bool,
    /// A break: no new requests, the reward shown as paused on Twitch, the
    /// queue still playing out. Set up stays set up, unlike `enabled`.
    pub paused: bool,
    /// Each source on its own, under `enabled`.
    pub chat_enabled: bool,
    pub points_enabled: bool,
    pub who: Who,
    /// Waiting requests one viewer may hold at once. Mods aren't limited.
    pub max_per_user: u32,
    /// Answers in chat: "Added …", "Removed …", "Now playing …". Off, requests
    /// still work and only the Queue section shows what happened.
    pub chat_replies: bool,
    /// Between one viewer's !sr and their next.
    pub cooldown_secs: u64,
    pub max_minutes: u32,
    pub allow_explicit: bool,
    pub queue_limit: u32,
    pub reward_title: String,
    pub reward_cost: u32,
    /// The channel points reward JammyLayer created. Twitch lets only the app
    /// that made a reward pause it or refund its redemptions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward_id: Option<String>,
}

impl Default for RequestSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            paused: false,
            chat_enabled: false,
            points_enabled: false,
            who: Who::Everyone,
            max_per_user: 2,
            chat_replies: true,
            cooldown_secs: 60,
            max_minutes: 10,
            allow_explicit: false,
            queue_limit: 20,
            reward_title: "Song request".into(),
            reward_cost: 1000,
            reward_id: None,
        }
    }
}

impl RequestSettings {
    /// !sr is being taken right now.
    pub fn chat(&self) -> bool {
        self.enabled && self.chat_enabled
    }

    /// The reward is on the channel right now.
    pub fn points(&self) -> bool {
        self.enabled && self.points_enabled
    }
}

impl Settings {
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_PORT)
    }

    pub fn configured(&self) -> bool {
        !self.client_id.is_empty() && !self.client_secret.is_empty()
    }

    /// Spotify accepts only HTTPS redirects or the literal loopback address;
    /// "localhost" is refused.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port())
    }

    pub fn twitch_configured(&self) -> bool {
        !self.twitch_client_id.is_empty()
    }
}

#[derive(Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn read<T: DeserializeOwned + Default>(&self, name: &str) -> T {
        fs::read_to_string(self.dir.join(name))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Through a temporary file and a rename, so a crash mid-write can't leave
    /// a truncated file holding the client secret.
    fn write<T: Serialize>(&self, name: &str, value: &T) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let target = self.dir.join(name);
        let tmp = self.dir.join(format!("{name}.{}.tmp", std::process::id()));
        let mut text = serde_json::to_string_pretty(value)?;
        text.push('\n');
        fs::write(&tmp, text)?;
        fs::rename(tmp, target)
    }

    pub fn settings(&self) -> Settings {
        self.read("settings.json")
    }

    pub fn save_settings(&self, settings: &Settings) -> std::io::Result<()> {
        self.write("settings.json", settings)
    }

    pub fn tokens(&self) -> Tokens {
        self.read("tokens.json")
    }

    pub fn save_tokens(&self, tokens: &Tokens) -> std::io::Result<()> {
        self.write("tokens.json", tokens)
    }

    pub fn twitch_tokens(&self) -> TwitchTokens {
        self.read("twitch.json")
    }

    pub fn save_twitch_tokens(&self, tokens: &TwitchTokens) -> std::io::Result<()> {
        self.write("twitch.json", tokens)
    }

    /// The song request queue, so a restart mid-stream doesn't lose requests
    /// viewers paid channel points for.
    pub fn queue(&self) -> Vec<Request> {
        self.read("requests.json")
    }

    pub fn save_queue(&self, queue: &[Request]) -> std::io::Result<()> {
        self.write("requests.json", &queue)
    }
}
