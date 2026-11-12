#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod lifecycle;
mod navigation;
mod solver;

use lifecycle::Session;
use navigation::{
    is_bootstrap_page, is_studio_page, is_studio_resource, open_external, EXTERNAL_LINK_PATH,
};
use std::{
    error::Error,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

type StudioResult<T> = Result<T, Box<dyn Error>>;
const WINDOW: &str = "studio";
const ACCEPTANCE_SCRIPT: &str = include_str!("../../tauri_acceptance.js");
const EXTERNAL_LINK_SCRIPT: &str = include_str!("external_links.js");

fn acceptance_directory() -> StudioResult<Option<PathBuf>> {
    let mut args = std::env::args_os().skip(1);
    let Some(flag) = args.next() else {
        return Ok(None);
    };
    // Finder may pass its process serial number when reopening a macOS app.
    if flag.to_string_lossy().starts_with("-psn_") {
        return Ok(None);
    }
    if flag != "--acceptance" {
        return Err("Usage: SionnaRTStudio [--acceptance <directory>]".into());
    }
    let directory = PathBuf::from(args.next().ok_or("--acceptance requires a directory.")?);
    if args.next().is_some() {
        return Err("Usage: SionnaRTStudio [--acceptance <directory>]".into());
    }
    fs::create_dir_all(&directory)?;
    Ok(Some(directory.canonicalize()?))
}

fn open_window(
    app: &tauri::AppHandle,
    session: &Arc<Session>,
) -> StudioResult<tauri::WebviewWindow> {
    let navigation = Arc::clone(session);
    let downloads = Arc::clone(session);
    let load = Arc::clone(session);
    let acceptance_started = Mutex::new(false);
    let link_token = uuid::Uuid::new_v4().to_string();
    let link_setup = format!(
        "({EXTERNAL_LINK_SCRIPT})({});",
        serde_json::json!(link_token)
    );
    let builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
        .title("Sionna RT Studio")
        .inner_size(1360.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .initialization_script(link_setup)
        .on_navigation(move |url| {
            if is_bootstrap_page(url) {
                return true;
            }
            if let Some(origin) = navigation.origin() {
                if is_studio_page(url, &origin) {
                    match url.path() {
                        EXTERNAL_LINK_PATH => {
                            open_external(url, &link_token);
                            return false;
                        }
                        "/__studio_desktop_acceptance" => {
                            navigation.report_acceptance(url);
                            return false;
                        }
                        _ => {}
                    }
                }
                if is_studio_resource(url, &origin) {
                    return true;
                }
            }
            false
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(move |webview, event| {
            downloads
                .downloads
                .handle(webview, event, downloads.origin().as_ref())
        })
        .on_page_load(move |window, page| {
            if page.event() == PageLoadEvent::Finished
                && load.acceptance().is_some()
                && load
                    .origin()
                    .is_some_and(|origin| is_studio_page(page.url(), &origin))
            {
                let mut started = acceptance_started.lock().unwrap();
                if !*started {
                    *started = true;
                    if let Err(error) = window.eval(ACCEPTANCE_SCRIPT) {
                        load.write_acceptance_error(&error.to_string());
                    }
                }
            }
        });
    #[cfg(target_os = "windows")]
    let builder = builder.data_directory(match session.acceptance() {
        Some(directory) => directory.join("WebView2"),
        None => app.path().local_data_dir()?.join("SionnaRTStudio/WebView2"),
    });
    #[cfg(target_os = "macos")]
    let builder = builder.incognito(session.acceptance().is_some());

    let window = builder.build()?;
    let close = Arc::clone(session);
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if close.should_check_close() {
                api.prevent_close();
                close.request_close(&close_window);
            }
        }
    });
    Ok(window)
}

fn main() {
    let acceptance = match acceptance_directory() {
        Ok(directory) => directory,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let startup_acceptance = acceptance.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle();
            let session = Arc::new(Session::new(handle, acceptance)?);
            app.manage(Arc::clone(&session));
            match open_window(handle, &session) {
                Ok(window) => session.start(&window),
                Err(error) => {
                    let mut detail = error.to_string();
                    if cfg!(target_os = "windows") {
                        detail.push_str("\n\nCheck that Microsoft Edge WebView2 Runtime (x64) is installed.\n请确认已安装 Microsoft Edge WebView2 Runtime (x64)。");
                    }
                    if session.acceptance().is_some() {
                        session.write_acceptance_error(&detail);
                        handle.exit(1);
                    } else {
                        let handle = handle.clone();
                        handle
                            .dialog()
                            .message(detail)
                            .title("Could not open Sionna RT Studio / 无法打开实验台")
                            .kind(MessageDialogKind::Error)
                            .show(move |_| handle.exit(1));
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            if let Some(directory) = startup_acceptance {
                let _ = fs::write(
                    directory.join("desktop-error.json"),
                    serde_json::json!({"error": error.to_string()}).to_string(),
                );
            }
            eprintln!("Could not open Sionna RT Studio: {error}");
            std::process::exit(1);
        }
    };
    app.run(|handle, event| {
        let Some(session) = handle.try_state::<Arc<Session>>() else {
            return;
        };
        match event {
            RunEvent::ExitRequested { api, .. } => {
                if let Some(window) = handle.get_webview_window(WINDOW) {
                    if session.should_check_close() {
                        api.prevent_exit();
                        session.inner().request_close(&window);
                    }
                }
            }
            RunEvent::Exit => session.shutdown(),
            _ => {}
        }
    });
}
