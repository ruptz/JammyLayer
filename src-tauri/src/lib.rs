//! JammyLayer: a Spotify now-playing overlay for OBS.
//!
//! The overlay is a page OBS loads from JammyLayer's local server, so this
//! process only hosts it. The window shows the setup page from that same
//! server, and the tray keeps it running when the window is closed.

mod requests;
mod server;
mod settings;
mod spotify;
mod twitch;

use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::UserAttentionType;
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use requests::Requests;
use settings::Store;
use spotify::Spotify;
use twitch::Twitch;

/// Passed by the "start when I sign in" entry: come up in the tray only.
const HIDDEN: &str = "--hidden";
/// WidgetCake stops the app by launching it again with this.
const QUIT: &str = "--quit";

struct Shared {
    spotify: Arc<Spotify>,
    requests: Arc<Requests>,
    base: String,
}

struct Tray {
    pause: CheckMenuItem<Wry>,
    close_to_tray: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

fn base_url(app: &AppHandle) -> String {
    app.state::<Shared>().base.clone()
}

/// Anything that isn't JammyLayer's own server goes to the real browser.
/// /login is ours but counts as leaving: it redirects to Spotify, whose
/// login has to run where the user's Spotify, Google or Apple session is.
fn leaves_app(base: &str, url: &tauri::Url) -> bool {
    !url.as_str().starts_with(base) || url.path() == "/login"
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let base = base_url(app);
    let Ok(url) = format!("{base}/setup").parse() else { return };
    let (nav, popup) = (app.clone(), app.clone());
    let nav_base = base.clone();
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("JammyLayer")
        .inner_size(1240.0, 840.0)
        .min_inner_size(980.0, 640.0)
        // The setup page draws its own title bar, like WidgetCake's.
        .decorations(false)
        // The setup page's own ground, so the first frame isn't a white flash.
        .background_color(Color(16, 17, 20, 255))
        .on_navigation(move |url| {
            if leaves_app(&nav_base, url) {
                let _ = nav.opener().open_url(url.as_str(), None::<&str>);
                return false;
            }
            true
        })
        .on_new_window(move |url, _| {
            let _ = popup.opener().open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        .build();
    if let Err(e) = built {
        eprintln!("[jammylayer] could not open the window: {e}");
    }
}

/// Back in front once the browser tab has finished logging in. Windows won't
/// hand the foreground to an app the user isn't using, so it's pinned on top
/// for a moment and the taskbar button flashes.
pub fn surface(app: &AppHandle) {
    show_window(app);
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let _ = window.set_always_on_top(false);
    });
}

/// The tray mirrors switches the setup page can also change.
pub fn sync_tray(app: &AppHandle) {
    if let Some(tray) = app.try_state::<Tray>() {
        let close = app.state::<Shared>().spotify.settings.read().unwrap().close_to_tray;
        let _ = tray.close_to_tray.set_checked(close);
        let _ = tray.autostart.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
        // Greyed out while song requests are off: there's nothing to pause.
        let (enabled, paused) = app.state::<Shared>().requests.pause_state();
        let _ = tray.pause.set_enabled(enabled);
        let _ = tray.pause.set_checked(enabled && paused);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let base = base_url(app);
    let close = app.state::<Shared>().spotify.settings.read().unwrap().close_to_tray;
    let serving = MenuItem::with_id(app, "serving", format!("Serving {base}"), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open setup…", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy", "Copy overlay URL", true, None::<&str>)?;
    let (enabled, paused) = app.state::<Shared>().requests.pause_state();
    let pause = CheckMenuItem::with_id(app, "pause", "Pause song requests", enabled, enabled && paused, None::<&str>)?;
    let close_to_tray = CheckMenuItem::with_id(
        app,
        "close-to-tray",
        "Keep running when I close the window",
        true,
        close,
        None::<&str>,
    )?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start when I sign in",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[&serving, &sep()?, &open, &copy, &sep()?, &pause, &sep()?, &close_to_tray, &sep()?, &autostart, &sep()?, &quit],
    )?;
    app.manage(Tray { pause, close_to_tray, autostart });

    TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().cloned().expect("an app icon"))
        .tooltip("JammyLayer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "copy" => {
                let _ = app.clipboard().write_text(format!("{}/", base_url(app)));
            }
            "pause" => {
                let requests = app.state::<Shared>().requests.clone();
                let paused = requests.pause_state().1;
                // The tray follows once the change lands, through the same
                // updates the setup page gets.
                tauri::async_runtime::spawn(async move {
                    let _ = requests.configure(&serde_json::json!({ "paused": !paused })).await;
                });
            }
            "close-to-tray" => {
                let shared = app.state::<Shared>();
                let settings = {
                    let mut s = shared.spotify.settings.write().unwrap();
                    s.close_to_tray = !s.close_to_tray;
                    s.clone()
                };
                let _ = app.state::<Store>().save_settings(&settings);
                sync_tray(app);
            }
            "autostart" => {
                let launch = app.autolaunch();
                let _ = if launch.is_enabled().unwrap_or(false) { launch.disable() } else { launch.enable() };
                sync_tray(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // First, so a second launch hands over its arguments and exits before
        // anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            if argv.iter().any(|a| a == QUIT) {
                app.exit(0);
            } else {
                show_window(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN])))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            // Asked to quit with nothing running: don't start a fresh copy.
            if args.iter().any(|a| a == QUIT) {
                std::process::exit(0);
            }

            // The folder the Electron build used, so an existing install keeps
            // its credentials and Spotify account.
            let store = Store::new(app.path().config_dir()?.join("JammyLayer"));
            let settings = Arc::new(RwLock::new(store.settings()));
            let port = settings.read().unwrap().port();
            let spotify = Spotify::new(store.clone(), settings.clone());
            let (twitch, incoming) = Twitch::new(store.clone(), settings);
            let requests = Requests::new(spotify.clone(), twitch.clone(), store.clone());

            let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => listener,
                Err(_) => {
                    let handle = app.handle().clone();
                    app.dialog()
                        .message(format!(
                            "Port {port} is already in use.\n\nAnother copy of the overlay may already be running. \
                             To pick a different port, set \"port\" in:\n{}\n\nThen update the redirect URI in your \
                             Spotify app to match.",
                            store.dir().join("settings.json").display()
                        ))
                        .title("JammyLayer could not start")
                        .kind(MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                    return Ok(());
                }
            };
            listener.set_nonblocking(true)?;

            app.manage(Shared {
                spotify: spotify.clone(),
                requests: requests.clone(),
                base: format!("http://127.0.0.1:{port}"),
            });
            app.manage(store.clone());

            let router =
                server::router(app.handle().clone(), store, spotify.clone(), twitch.clone(), requests.clone());
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("the listener");
                if let Err(e) = axum::serve(listener, router).await {
                    eprintln!("[jammylayer] server stopped: {e}");
                }
            });
            tauri::async_runtime::spawn(spotify.poll());
            tauri::async_runtime::spawn(twitch.run());
            // The tray's pause switch follows every change to song requests,
            // wherever it was made.
            let mut changes = requests.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) = changes.recv().await {
                    sync_tray(&handle);
                }
            });
            tauri::async_runtime::spawn(requests.run(incoming));

            build_tray(app.handle())?;
            if !args.iter().any(|a| a == HIDDEN) {
                show_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to the tray only when asked to; otherwise closing
            // the window quits, as it does everywhere else.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let keep = app.state::<Shared>().spotify.settings.read().unwrap().close_to_tray;
                if keep {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building JammyLayer");

    app.run(|_, event| {
        // Started hidden from the tray, there's no window whose closing should
        // end the app; only Quit does.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}
