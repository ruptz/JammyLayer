//! What JammyLayer remembers between runs, in the same per-user folder and
//! files the Electron build used (%APPDATA%\JammyLayer\settings.json and
//! tokens.json), so an existing install keeps its credentials and account.

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

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
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Tokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obtained_at: Option<String>,
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
}
