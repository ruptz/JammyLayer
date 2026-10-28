//! The local web server: OBS's browser source, the setup page shown in the
//! app's window, and the end of Spotify's login. It listens on this computer
//! only (127.0.0.1); JammyLayer is not reachable from the network.
//!
//! Listening locally doesn't keep out web pages open in the user's browser,
//! which can send requests to 127.0.0.1 too. So requests must name this
//! server as their host, which defeats DNS rebinding, and anything that
//! changes something must come from JammyLayer's own pages.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio_stream::wrappers::BroadcastStream;

use crate::requests::Requests;
use crate::settings::Store;
use crate::spotify::Spotify;
use crate::twitch::{Seat, Twitch};

/// Only Spotify's own image hosts are fetched on the overlay's behalf.
const ART_HOSTS: [&str; 2] = ["scdn.co", "spotifycdn.com"];
const ART_CACHE_MAX: usize = 16;

pub struct Ctx {
    pub app: AppHandle,
    pub store: Store,
    pub spotify: Arc<Spotify>,
    pub twitch: Arc<Twitch>,
    pub requests: Arc<Requests>,
    art: Mutex<VecDeque<(String, Bytes, String)>>,
}

pub fn router(
    app: AppHandle,
    store: Store,
    spotify: Arc<Spotify>,
    twitch: Arc<Twitch>,
    requests: Arc<Requests>,
) -> Router {
    let ctx = Arc::new(Ctx { app, store, spotify, twitch, requests, art: Mutex::new(VecDeque::new()) });
    Router::new().fallback(handle).with_state(ctx)
}

// ------------------------------------------------------------------- files

struct File {
    body: &'static [u8],
    kind: &'static str,
}

const HTML: &str = "text/html; charset=utf-8";

fn file(name: &str) -> Option<File> {
    let (body, kind): (&'static [u8], _) = match name {
        "overlay.html" => (include_bytes!("../../public/overlay.html"), HTML),
        "setup.html" => (include_bytes!("../../public/setup.html"), HTML),
        "overlay.css" => (include_bytes!("../../public/overlay.css"), "text/css; charset=utf-8"),
        "setup.css" => (include_bytes!("../../public/setup.css"), "text/css; charset=utf-8"),
        "overlay.js" => (include_bytes!("../../public/overlay.js"), "text/javascript; charset=utf-8"),
        "setup.js" => (include_bytes!("../../public/setup.js"), "text/javascript; charset=utf-8"),
        "logo.png" => (include_bytes!("../../public/logo.png"), "image/png"),
        // Bundled rather than fetched from Google, so the setup page looks
        // right without a connection.
        "fonts/archivo.woff2" => (include_bytes!("../../public/fonts/archivo.woff2"), "font/woff2"),
        "fonts/plex-mono-400.woff2" => (include_bytes!("../../public/fonts/plex-mono-400.woff2"), "font/woff2"),
        "fonts/plex-mono-500.woff2" => (include_bytes!("../../public/fonts/plex-mono-500.woff2"), "font/woff2"),
        "fonts/plex-mono-600.woff2" => (include_bytes!("../../public/fonts/plex-mono-600.woff2"), "font/woff2"),
        _ => return None,
    };
    Some(File { body, kind })
}

fn send(status: StatusCode, kind: &str, body: impl Into<Body>) -> Response {
    let mut res = Response::new(body.into());
    *res.status_mut() = status;
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(kind).unwrap());
    res
}

fn text(status: StatusCode, message: &'static str) -> Response {
    send(status, "text/plain; charset=utf-8", message)
}

fn static_file(name: &str) -> Response {
    match file(name) {
        Some(f) => {
            let mut res = send(StatusCode::OK, f.kind, f.body);
            // The overlay must pick up changes on an OBS cache refresh.
            res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            res
        }
        None => text(StatusCode::NOT_FOUND, "Not found"),
    }
}

fn send_json(status: StatusCode, value: Value) -> Response {
    let mut res = send(status, "application/json; charset=utf-8", value.to_string());
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

// ------------------------------------------------------------------- pages

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The pages Spotify's login ends on. They open in the user's own browser,
/// in a tab that's finished as soon as it renders, so they point back to the
/// app rather than offering a link.
fn page(status: StatusCode, heading: &str, body: &str, error: bool) -> Response {
    let tone = if error { "is-error" } else { "" };
    let html = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{heading}</title>
<link rel="icon" href="/logo.png">
<link rel="stylesheet" href="/setup.css"></head>
<body class="notice"><main class="notice__card {tone}">
<img class="notice__mark" src="/logo.png" alt="" width="60" height="60">
<p class="notice__tag">Step 02 — Account</p>
<h1>{heading}</h1>{body}
<p class="notice__act notice__act--quiet">Close this tab and carry on in the app.</p>
</main></body></html>"#
    );
    send(status, HTML, html)
}

// ------------------------------------------------------------------ routes

async fn handle(State(ctx): State<Arc<Ctx>>, req: Request) -> Response {
    let method = req.method().clone();
    if method != Method::GET && method != Method::HEAD && method != Method::POST {
        return text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let path = req.uri().path().trim_end_matches('/').to_owned();
    let path = if path.is_empty() { "/".to_owned() } else { path };
    let query = req.uri().query().unwrap_or_default().to_owned();
    let post = |res: fn() -> Response| if method == Method::POST { None } else { Some(res()) };
    let port = ctx.spotify.settings.read().unwrap().port();
    if !ours(req.headers().get(header::HOST), port) {
        return text(StatusCode::MISDIRECTED_REQUEST, "Wrong host");
    }
    if method == Method::POST
        && let Some(origin) = req.headers().get(header::ORIGIN)
        && !ours(Some(origin), port)
    {
        return text(StatusCode::FORBIDDEN, "Cross-origin requests are not accepted");
    }

    match path.as_str() {
        "/" | "/overlay" => static_file("overlay.html"),
        "/setup" => static_file("setup.html"),
        "/overlay.css" | "/overlay.js" | "/setup.css" | "/setup.js" | "/logo.png" => {
            static_file(&path[1..])
        }
        p if p.starts_with("/fonts/") => static_file(&p[1..]),
        // Browsers ask for this whatever the page's icon link says.
        "/favicon.ico" => static_file("logo.png"),
        "/healthz" => send_json(
            StatusCode::OK,
            json!({ "ok": true, "configured": ctx.spotify.configured(), "connected": ctx.spotify.connected() }),
        ),
        "/api/now-playing" => send_json(StatusCode::OK, json!(ctx.spotify.refetch().await)),
        "/api/config" => config(&ctx),
        "/events" => events(&ctx),
        "/art" => art(&ctx, &query).await,
        "/login" => login(&ctx),
        "/callback" => callback(&ctx, &query).await,
        "/api/credentials" => match post(use_post) {
            Some(res) => res,
            None => credentials(&ctx, req).await,
        },
        "/api/preferences" => match post(use_post) {
            Some(res) => res,
            None => preferences(&ctx, req).await,
        },
        "/api/disconnect" => match post(use_post) {
            Some(res) => res,
            None => {
                ctx.spotify.disconnect();
                ctx.twitch.changed();
                send_json(StatusCode::OK, json!({ "ok": true }))
            }
        },
        "/api/requests" => send_json(StatusCode::OK, ctx.requests.status()),
        "/requests/events" => request_events(&ctx),
        "/api/requests/settings" | "/api/requests/remove" | "/api/requests/move" | "/api/requests/clear" => {
            match post(use_post) {
                Some(res) => res,
                None => edit_requests(&ctx, &path, req).await,
            }
        }
        "/api/twitch/pair" | "/api/twitch/cancel" | "/api/twitch/disconnect" => match post(use_post) {
            Some(res) => res,
            None => twitch_account(&ctx, &path, req).await,
        },
        "/api/twitch/credentials" => match post(use_post) {
            Some(res) => res,
            None => twitch_credentials(&ctx, req).await,
        },
        _ => text(StatusCode::NOT_FOUND, "Not found"),
    }
}

/// A Host or Origin naming this server: the loopback address or "localhost",
/// on its port. Origins carry a scheme; hosts don't.
fn ours(value: Option<&HeaderValue>, port: u16) -> bool {
    let Some(value) = value.and_then(|v| v.to_str().ok()) else { return false };
    let value = value.strip_prefix("http://").unwrap_or(value);
    [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")]
        .iter()
        .any(|ok| value.eq_ignore_ascii_case(ok))
}

fn use_post() -> Response {
    text(StatusCode::METHOD_NOT_ALLOWED, "Use POST")
}

fn param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == name).then(|| decode(v))
    })
}

fn decode(value: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(hi), Some(lo)) => {
                    out.push(hi << 4 | lo);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the setup page needs to know. Every request comes from this
/// computer, so credentials and preferences are always editable here.
fn config(ctx: &Ctx) -> Response {
    let settings = ctx.spotify.settings.read().unwrap().clone();
    send_json(
        StatusCode::OK,
        json!({
            "configured": settings.configured(),
            "connected": ctx.spotify.connected(),
            "redirectUri": settings.redirect_uri(),
            "canEditCredentials": true,
            "canEditPreferences": true,
            "closeToTray": settings.close_to_tray,
            "clientId": settings.client_id,
            "version": env!("CARGO_PKG_VERSION"),
        }),
    )
}

/// Live now-playing updates for the overlay and the setup page's preview.
fn events(ctx: &Ctx) -> Response {
    let (updates, watching) = ctx.spotify.subscribe();
    let first = Event::default()
        .retry(Duration::from_secs(3))
        .data(json!(ctx.spotify.snapshot()).to_string());
    let later = BroadcastStream::new(updates)
        .filter_map(|s| async move { s.ok().map(|s| Event::default().data(json!(s).to_string())) });
    let stream = stream::once(async { first })
        .chain(later)
        // Polling carries on for exactly as long as this stream is open.
        .map(move |event| {
            let _ = &watching;
            Ok::<_, Infallible>(event)
        });
    // OBS keeps the source open for hours; a comment every 15s stops idle
    // connections being dropped.
    let sse = Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping"));
    ([(header::CACHE_CONTROL, "no-cache, no-transform")], sse).into_response()
}

/// Album art fetched on the overlay's behalf, so it's same-origin and the
/// overlay can read its pixels for the accent colour.
async fn art(ctx: &Ctx, query: &str) -> Response {
    let Some(source) = param(query, "u") else {
        return text(StatusCode::BAD_REQUEST, "Missing \"u\" parameter");
    };
    let Ok(url) = reqwest::Url::parse(&source) else {
        return text(StatusCode::BAD_REQUEST, "Malformed image URL");
    };
    let host = url.host_str().unwrap_or_default();
    let allowed = ART_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")));
    if url.scheme() != "https" || !allowed {
        return text(StatusCode::FORBIDDEN, "Only Spotify image hosts are proxied");
    }
    let key = url.to_string();
    let cached = {
        let mut cache = ctx.art.lock().unwrap();
        cache.iter().position(|(k, ..)| *k == key).map(|i| {
            let entry = cache.remove(i).unwrap();
            cache.push_back(entry.clone());
            entry
        })
    };
    let (body, kind) = match cached {
        Some((_, body, kind)) => (body, kind),
        None => {
            let Ok(resp) = reqwest::get(url).await else {
                return text(StatusCode::BAD_GATEWAY, "Could not load album art");
            };
            if !resp.status().is_success() {
                return text(StatusCode::BAD_GATEWAY, "Could not load album art");
            }
            let kind = resp
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_owned();
            let Ok(body) = resp.bytes().await else {
                return text(StatusCode::BAD_GATEWAY, "Could not load album art");
            };
            let mut cache = ctx.art.lock().unwrap();
            cache.push_back((key, body.clone(), kind.clone()));
            while cache.len() > ART_CACHE_MAX {
                cache.pop_front();
            }
            (body, kind)
        }
    };
    let mut res = send(StatusCode::OK, &kind, body);
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=604800, immutable"),
    );
    res
}

fn login(ctx: &Ctx) -> Response {
    if !ctx.spotify.configured() {
        return page(
            StatusCode::CONFLICT,
            "Client credentials are missing",
            "<p>Add your Spotify client ID and secret in JammyLayer's setup first, then connect again.</p>",
            true,
        );
    }
    let mut res = Response::new(Body::empty());
    *res.status_mut() = StatusCode::FOUND;
    res.headers_mut()
        .insert(header::LOCATION, HeaderValue::from_str(&ctx.spotify.authorize_url()).unwrap());
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn callback(ctx: &Ctx, query: &str) -> Response {
    if let Some(error) = param(query, "error") {
        return page(
            StatusCode::BAD_REQUEST,
            "Authorization failed",
            &format!(
                "<p>Spotify reported: <code>{}</code></p>\n<p>Nothing was saved. Start again when you're ready.</p>",
                escape(&error)
            ),
            true,
        );
    }
    let (Some(code), Some(state)) = (param(query, "code"), param(query, "state")) else {
        return expired();
    };
    if !ctx.spotify.consume_state(&state) {
        return expired();
    }
    match ctx.spotify.exchange_code(&code).await {
        Ok(()) => {
            // After the page is on its way, so raising the window can't hold it up.
            let app = ctx.app.clone();
            tokio::spawn(async move { crate::surface(&app) });
            page(
                StatusCode::OK,
                "Spotify connected",
                "<p>JammyLayer has your account and is back in front. You can close this tab.</p>",
                false,
            )
        }
        Err(message) => {
            let redirect = ctx.spotify.settings.read().unwrap().redirect_uri();
            page(
                StatusCode::BAD_GATEWAY,
                "Could not complete authorization",
                &format!(
                    "<p>{}</p>\n<p>Check that the client secret matches your Spotify app and that its redirect URI is exactly <code>{}</code>.</p>",
                    escape(&message),
                    escape(&redirect)
                ),
                true,
            )
        }
    }
}

fn expired() -> Response {
    page(
        StatusCode::BAD_REQUEST,
        "That link has expired",
        "<p>Authorization links are valid for ten minutes and can only be used once.\nSelect <strong>Connect Spotify</strong> again to start a fresh one.</p>",
        true,
    )
}

async fn read_json(req: Request) -> Result<Value, Response> {
    let bytes = to_bytes(req.into_body(), 8192)
        .await
        .map_err(|_| send_json(StatusCode::PAYLOAD_TOO_LARGE, json!({ "ok": false, "error": "Request body too large" })))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| send_json(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "Malformed JSON body" })))
}

/// The setup page's client ID and secret; there's no .env in a desktop app.
async fn credentials(ctx: &Ctx, req: Request) -> Response {
    let body = match read_json(req).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let field = |k: &str| body[k].as_str().unwrap_or_default().trim().to_owned();
    let (client_id, client_secret) = (field("clientId"), field("clientSecret"));
    if client_id.is_empty() || client_secret.is_empty() {
        return send_json(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "Both a client ID and a client secret are required." }),
        );
    }
    let settings = {
        let mut s = ctx.spotify.settings.write().unwrap();
        s.client_id = client_id;
        s.client_secret = client_secret;
        s.clone()
    };
    if let Err(e) = ctx.store.save_settings(&settings) {
        return send_json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "ok": false, "error": e.to_string() }));
    }
    // So the page's state follows straight away, not at the next poll.
    ctx.spotify.emit();
    send_json(StatusCode::OK, json!({ "ok": true, "configured": settings.configured() }))
}

async fn preferences(ctx: &Ctx, req: Request) -> Response {
    let body = match read_json(req).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(close_to_tray) = body["closeToTray"].as_bool() else {
        return send_json(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "closeToTray must be true or false." }),
        );
    };
    let settings = {
        let mut s = ctx.spotify.settings.write().unwrap();
        s.close_to_tray = close_to_tray;
        s.clone()
    };
    if let Err(e) = ctx.store.save_settings(&settings) {
        return send_json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "ok": false, "error": e.to_string() }));
    }
    // The tray menu shows the same switch.
    crate::sync_tray(&ctx.app);
    send_json(StatusCode::OK, json!({ "ok": true, "closeToTray": close_to_tray }))
}

// --------------------------------------------------------------- song requests

/// The queue and its switches, live, for the setup page's Requests section.
fn request_events(ctx: &Ctx) -> Response {
    let first = Event::default().retry(Duration::from_secs(3)).data(ctx.requests.status().to_string());
    let later = BroadcastStream::new(ctx.requests.subscribe())
        .filter_map(|s| async move { s.ok().map(|s| Event::default().data(s.to_string())) });
    let stream = stream::once(async { first }).chain(later).map(Ok::<_, Infallible>);
    let sse = Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping"));
    ([(header::CACHE_CONTROL, "no-cache, no-transform")], sse).into_response()
}

async fn edit_requests(ctx: &Ctx, path: &str, req: Request) -> Response {
    let body = match read_json(req).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let id = body["id"].as_u64().unwrap_or_default();
    let result = match path {
        "/api/requests/settings" => ctx.requests.configure(&body).await,
        "/api/requests/remove" => ctx.requests.remove(id).await.map(|_| ()).ok_or_else(|| "Not in the queue.".into()),
        "/api/requests/move" => {
            let up = body["up"].as_bool().unwrap_or(true);
            if ctx.requests.shift(id, up) { Ok(()) } else { Err("Can't move that one.".into()) }
        }
        _ => {
            ctx.requests.clear().await;
            Ok(())
        }
    };
    match result {
        Ok(()) => send_json(StatusCode::OK, json!({ "ok": true })),
        Err(error) => send_json(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": error })),
    }
}

async fn twitch_credentials(ctx: &Ctx, req: Request) -> Response {
    let body = match read_json(req).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let field = |k: &str| body[k].as_str().unwrap_or_default().trim().to_owned();
    let (client_id, client_secret) = (field("clientId"), field("clientSecret"));
    if client_id.is_empty() {
        return send_json(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "A client ID is required." }));
    }
    let settings = {
        let mut s = ctx.spotify.settings.write().unwrap();
        // A changed client ID belongs to a different app, whose secret (if
        // any) hasn't been typed yet; the same ID keeps the saved one.
        if s.twitch_client_id != client_id {
            s.twitch_client_secret.clear();
        }
        s.twitch_client_id = client_id;
        if !client_secret.is_empty() {
            s.twitch_client_secret = client_secret;
        }
        s.clone()
    };
    if let Err(e) = ctx.store.save_settings(&settings) {
        return send_json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "ok": false, "error": e.to_string() }));
    }
    ctx.twitch.reconsider();
    // The setup page redraws from its event stream, not from this answer.
    ctx.twitch.changed();
    send_json(StatusCode::OK, json!({ "ok": true, "configured": settings.twitch_configured() }))
}

/// Connecting, cancelling a code that's waiting, and disconnecting, for the
/// channel's account or the bot's.
async fn twitch_account(ctx: &Ctx, path: &str, req: Request) -> Response {
    let body = match read_json(req).await {
        Ok(body) => body,
        Err(res) => return res,
    };
    let seat = Seat::parse(body["seat"].as_str().unwrap_or_default());
    match path {
        "/api/twitch/pair" => match ctx.twitch.start_pairing(seat).await {
            Ok(pairing) => send_json(StatusCode::OK, json!({ "ok": true, "pairing": pairing })),
            Err(error) => send_json(StatusCode::BAD_GATEWAY, json!({ "ok": false, "error": error })),
        },
        "/api/twitch/cancel" => {
            ctx.twitch.cancel_pairing();
            send_json(StatusCode::OK, json!({ "ok": true }))
        }
        _ => {
            ctx.twitch.disconnect(seat);
            send_json(StatusCode::OK, json!({ "ok": true }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ours;
    use axum::http::HeaderValue;

    #[test]
    fn only_this_server() {
        let ok = |v: &str| ours(Some(&HeaderValue::from_str(v).unwrap()), 8888);
        assert!(ok("127.0.0.1:8888"));
        assert!(ok("localhost:8888"));
        assert!(ok("http://127.0.0.1:8888"));
        assert!(!ok("http://127.0.0.1:9999"));
        assert!(!ok("https://evil.example"));
        assert!(!ok("evil.example:8888"));
        assert!(!ok("null"));
        assert!(!ours(None, 8888));
    }
}
