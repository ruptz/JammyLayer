//! The Twitch account, for song requests: chat commands and channel points
//! arrive over one EventSub WebSocket, and replies go back through Helix.
//!
//! Sign-in, the socket and Helix live in layer-twitch, shared with the other
//! Layer apps. What's JammyLayer's own is here: its Twitch app's keys and
//! where the sign-in is saved (settings.json and twitch.json), the scopes it
//! asks for, the events it listens to, and when it wants them.

use std::sync::{Arc, RwLock};

use layer_twitch::{Condition, Config, Credentials, Host, Subscription, TwitchTokens};
pub use layer_twitch::{Incoming, Rank, RewardError, Seat, Twitch, Viewer};
use tokio::sync::mpsc;

use crate::settings::{Settings, Store};

/// Reading and answering chat, and owning the song request reward: pausing it
/// and refunding the redemptions it can't honour.
const CHANNEL_SCOPES: &str = "user:read:chat user:write:chat channel:read:redemptions channel:manage:redemptions";
/// A bot only talks.
const BOT_SCOPES: &str = "user:write:chat";

/// Chat always; channel points only when the channel can have them, which
/// an account without Affiliate can't.
const SUBSCRIPTIONS: &[Subscription] = &[
    Subscription {
        kind: "channel.chat.message",
        version: "1",
        condition: Condition::BroadcasterAsUser,
        label: "chat",
        required: true,
    },
    Subscription {
        kind: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        condition: Condition::Broadcaster,
        label: "channel points",
        required: false,
    },
];

/// What viewers see when they redeem the song request reward.
pub const REWARD_PROMPT: &str = "Paste a Spotify track link (open.spotify.com/track/…)";

struct Jammy {
    store: Store,
    settings: Arc<RwLock<Settings>>,
}

impl Host for Jammy {
    fn credentials(&self) -> Credentials {
        let s = self.settings.read().unwrap();
        Credentials { client_id: s.twitch_client_id.clone(), client_secret: s.twitch_client_secret.clone() }
    }

    /// The socket is open only while chat or channel point requests are
    /// switched on, so with both off this costs nothing at all.
    fn wants_events(&self) -> bool {
        let s = self.settings.read().unwrap();
        s.requests.chat() || s.requests.points()
    }

    fn load_tokens(&self) -> TwitchTokens {
        self.store.twitch_tokens()
    }

    fn save_tokens(&self, tokens: &TwitchTokens) {
        let _ = self.store.save_twitch_tokens(tokens);
    }
}

pub fn new(store: Store, settings: Arc<RwLock<Settings>>) -> (Arc<Twitch>, mpsc::UnboundedReceiver<Incoming>) {
    Twitch::new(
        Arc::new(Jammy { store, settings }),
        Config {
            app: "JammyLayer",
            version: env!("CARGO_PKG_VERSION"),
            channel_scopes: CHANNEL_SCOPES,
            bot_scopes: BOT_SCOPES,
            subscriptions: SUBSCRIPTIONS,
        },
    )
}
