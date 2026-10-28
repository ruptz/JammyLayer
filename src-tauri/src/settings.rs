//! What JammyLayer remembers between runs, in the same per-user folder and
//! files the Electron build used (%APPDATA%\JammyLayer\settings.json and
//! tokens.json), so an existing install keeps its credentials and account.
//!
//! The secrets — both apps' client secrets and the Spotify and Twitch
//! sign-ins — are kept in the system keystore instead (Credential Manager on
//! Windows), so the files hold nothing worth stealing and settings.json can be
//! pasted when asking for help. Secrets an older version left in the files
//! move across the first time they're read. Without a keystore they stay in
//! the files, as before.

use std::fs;
use std::path::{Path, PathBuf};

use layer_secrets::Vault;
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
    /// In the keystore, not the file, wherever there is one.
    #[serde(default, skip_serializing_if = "String::is_empty")]
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
    /// In the keystore, not the file, wherever there is one.
    #[serde(default, skip_serializing_if = "String::is_empty")]
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

/// What each secret is called in the keystore. Credential Manager lists them
/// as `<name>.JammyLayer`.
const SPOTIFY_SECRET: &str = "spotify-client-secret";
const TWITCH_SECRET: &str = "twitch-client-secret";
const SPOTIFY_SIGN_IN: &str = "spotify-refresh-token";
const TWITCH_SIGN_IN: &str = "twitch-refresh-token";
const TWITCH_BOT_SIGN_IN: &str = "twitch-bot-refresh-token";

#[derive(Clone)]
pub struct Store {
    dir: PathBuf,
    vault: Vault,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_vault(dir, Vault::new("JammyLayer"))
    }

    pub fn with_vault(dir: PathBuf, vault: Vault) -> Self {
        Self { dir, vault }
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
    /// a truncated file behind.
    fn write<T: Serialize>(&self, name: &str, value: &T) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let target = self.dir.join(name);
        let tmp = self.dir.join(format!("{name}.{}.tmp", std::process::id()));
        let mut text = serde_json::to_string_pretty(value)?;
        text.push('\n');
        fs::write(&tmp, text)?;
        fs::rename(tmp, target)
    }

    /// A secret read from a file: see `Vault::adopt`.
    fn adopt(&self, name: &str, value: &mut Option<String>) -> bool {
        let mut v = value.take().unwrap_or_default();
        let moved = self.vault.adopt(name, &mut v);
        *value = Some(v).filter(|v| !v.is_empty());
        moved
    }

    /// A secret about to be written to a file: see `Vault::keep`.
    fn keep(&self, name: &str, value: &mut Option<String>) {
        let mut v = value.take().unwrap_or_default();
        self.vault.keep(name, &mut v);
        *value = Some(v).filter(|v| !v.is_empty());
    }

    pub fn settings(&self) -> Settings {
        let mut s: Settings = self.read("settings.json");
        let moved = self.vault.adopt(SPOTIFY_SECRET, &mut s.client_secret)
            | self.vault.adopt(TWITCH_SECRET, &mut s.twitch_client_secret);
        if moved {
            let _ = self.save_settings(&s);
        }
        s
    }

    pub fn save_settings(&self, settings: &Settings) -> std::io::Result<()> {
        let mut file = settings.clone();
        self.vault.keep(SPOTIFY_SECRET, &mut file.client_secret);
        self.vault.keep(TWITCH_SECRET, &mut file.twitch_client_secret);
        self.write("settings.json", &file)
    }

    pub fn tokens(&self) -> Tokens {
        let mut t: Tokens = self.read("tokens.json");
        if self.adopt(SPOTIFY_SIGN_IN, &mut t.refresh_token) {
            let _ = self.save_tokens(&t);
        }
        t
    }

    pub fn save_tokens(&self, tokens: &Tokens) -> std::io::Result<()> {
        let mut file = tokens.clone();
        self.keep(SPOTIFY_SIGN_IN, &mut file.refresh_token);
        self.write("tokens.json", &file)
    }

    pub fn twitch_tokens(&self) -> TwitchTokens {
        let mut t: TwitchTokens = self.read("twitch.json");
        let mut moved = self.adopt(TWITCH_SIGN_IN, &mut t.channel.refresh_token);
        if let Some(bot) = &mut t.bot {
            moved |= self.adopt(TWITCH_BOT_SIGN_IN, &mut bot.refresh_token);
        }
        if moved {
            let _ = self.save_twitch_tokens(&t);
        }
        t
    }

    pub fn save_twitch_tokens(&self, tokens: &TwitchTokens) -> std::io::Result<()> {
        let mut file = tokens.clone();
        self.keep(TWITCH_SIGN_IN, &mut file.channel.refresh_token);
        match &mut file.bot {
            Some(bot) => self.keep(TWITCH_BOT_SIGN_IN, &mut bot.refresh_token),
            // No bot any more: nothing of its should be left behind.
            None => {
                self.vault.delete(TWITCH_BOT_SIGN_IN);
            }
        }
        self.write("twitch.json", &file)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jammylayer-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// What an older JammyLayer left behind: every secret in the files.
    fn old_files(dir: &Path) {
        let write = |name: &str, text: &str| fs::write(dir.join(name), text).unwrap();
        write(
            "settings.json",
            r#"{ "clientId": "sid", "clientSecret": "s-secret", "twitchClientId": "tid", "twitchClientSecret": "t-secret", "port": 9000 }"#,
        );
        write("tokens.json", r#"{ "refresh_token": "s-refresh", "obtained_at": "1" }"#);
        write(
            "twitch.json",
            r#"{ "refreshToken": "t-refresh", "userId": "1", "login": "me", "bot": { "refreshToken": "b-refresh", "userId": "2", "login": "bot" } }"#,
        );
    }

    fn files(dir: &Path) -> String {
        ["settings.json", "tokens.json", "twitch.json"].map(|f| fs::read_to_string(dir.join(f)).unwrap()).join("\n")
    }

    fn assert_signed_in(store: &Store) {
        let s = store.settings();
        assert_eq!((s.client_secret.as_str(), s.twitch_client_secret.as_str(), s.port), ("s-secret", "t-secret", Some(9000)));
        assert_eq!(store.tokens().refresh_token.as_deref(), Some("s-refresh"));
        let t = store.twitch_tokens();
        assert_eq!(t.channel.refresh_token.as_deref(), Some("t-refresh"));
        assert_eq!(t.bot.and_then(|b| b.refresh_token).as_deref(), Some("b-refresh"));
    }

    #[test]
    fn without_a_keystore_the_files_keep_working() {
        let dir = folder("plain");
        old_files(&dir);
        let store = Store::with_vault(dir.clone(), Vault::unavailable("JammyLayer-test"));
        assert_signed_in(&store);
        store.save_settings(&store.settings()).unwrap();
        assert!(files(&dir).contains("s-secret"));
        let _ = fs::remove_dir_all(dir);
    }

    /// Skipped where the machine has no keystore, as CI's Linux runner doesn't.
    #[test]
    fn secrets_move_out_of_the_files_and_stay_out() {
        let vault = Vault::new(&format!("JammyLayer-test-{}", std::process::id()));
        if !vault.available() {
            eprintln!("no keystore here; skipped");
            return;
        }
        let dir = folder("vault");
        old_files(&dir);
        let store = Store::with_vault(dir.clone(), vault.clone());

        // Read once: everything still works, and the files no longer hold a secret.
        assert_signed_in(&store);
        let text = files(&dir);
        for secret in ["s-secret", "t-secret", "s-refresh", "t-refresh", "b-refresh"] {
            assert!(!text.contains(secret), "{secret} is still in a file");
        }
        assert!(text.contains("sid") && text.contains("\"login\": \"me\""), "the rest stays in the files");

        // Read again from the keystore alone, as the next start will.
        assert_signed_in(&Store::with_vault(dir.clone(), vault.clone()));

        // Saving keeps them out, and signing out forgets them.
        store.save_settings(&store.settings()).unwrap();
        store.save_tokens(&Tokens::default()).unwrap();
        store.save_twitch_tokens(&TwitchTokens::default()).unwrap();
        assert!(!files(&dir).contains("s-secret"));
        assert_eq!(vault.get(SPOTIFY_SIGN_IN), None);
        assert_eq!(vault.get(TWITCH_SIGN_IN), None);
        assert_eq!(vault.get(TWITCH_BOT_SIGN_IN), None);

        for name in [SPOTIFY_SECRET, TWITCH_SECRET] {
            vault.delete(name);
        }
        let _ = fs::remove_dir_all(dir);
    }
}
