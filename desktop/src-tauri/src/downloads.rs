use crate::{lifecycle::write_report, navigation::is_studio_resource, StudioResult};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{webview::DownloadEvent, Webview};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogKind};
use tempfile::{NamedTempFile, TempDir};
use uuid::Uuid;

struct PendingDownload {
    stage: PathBuf,
    name: String,
}

pub struct Downloads {
    pending: Mutex<HashMap<String, PendingDownload>>,
    staging: TempDir,
    acceptance: Option<PathBuf>,
}

impl Downloads {
    pub fn new(acceptance: Option<&Path>) -> StudioResult<Self> {
        let staging = tempfile::Builder::new()
            .prefix("studio-downloads-")
            .tempdir()?;
        if let Some(directory) = acceptance {
            fs::create_dir_all(directory.join("downloads"))?;
        }
        Ok(Self {
            pending: Mutex::new(HashMap::new()),
            staging,
            acceptance: acceptance.map(Path::to_owned),
        })
    }

    pub fn handle(
        &self,
        webview: Webview,
        event: DownloadEvent<'_>,
        origin: Option<&tauri::Url>,
    ) -> bool {
        match event {
            DownloadEvent::Requested { url, destination } => {
                if !origin.is_some_and(|origin| is_studio_resource(&url, origin)) {
                    return false;
                }
                let Some(name) = destination
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                else {
                    return false;
                };
                let mut pending = self.pending.lock().unwrap();
                if pending.contains_key(url.as_str()) {
                    return false;
                }
                let stage = self.staging.path().join(Uuid::new_v4().to_string());
                pending.insert(
                    url.to_string(),
                    PendingDownload {
                        stage: stage.clone(),
                        name,
                    },
                );
                *destination = stage;
                true
            }
            DownloadEvent::Finished { url, success, .. } => {
                let pending = self.pending.lock().unwrap().remove(url.as_str());
                if let Some(download) = pending {
                    // Use the exact path the shell reserved. WKWebView omits the
                    // completed path and WebView2 can report a normalized spelling.
                    if success && download.stage.is_file() {
                        self.save(webview, download);
                    } else {
                        let _ = fs::remove_file(download.stage);
                        self.fail(
                            &webview,
                            "The export download was interrupted.\n导出下载中断。",
                        );
                    }
                }
                true
            }
            _ => false,
        }
    }

    pub fn clean_up(&self) {
        let _ = fs::remove_dir_all(self.staging.path());
    }

    fn save(&self, webview: Webview, download: PendingDownload) {
        if let Some(directory) = &self.acceptance {
            let destination = directory.join("downloads").join(&download.name);
            if let Err(error) = save_completed_download(&download.stage, &destination) {
                self.fail(&webview, &error.to_string());
            }
            let _ = fs::remove_file(download.stage);
            return;
        }
        let window = webview.window();
        webview
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(download.name)
            .save_file(move |selection| {
                if let Some(FilePath::Path(destination)) = selection {
                    if let Err(error) = save_completed_download(&download.stage, &destination) {
                        show_error(&window, &error.to_string());
                    }
                }
                let _ = fs::remove_file(download.stage);
            });
    }

    fn fail(&self, webview: &Webview, detail: &str) {
        if let Some(directory) = &self.acceptance {
            write_report(
                directory,
                "desktop-error.json",
                &serde_json::json!({ "error": detail }),
            );
        } else {
            show_error(&webview.window(), detail);
        }
    }
}

fn show_error(window: &tauri::Window, detail: &str) {
    window
        .dialog()
        .message(format!(
            "Could not save the export.\n无法保存导出文件。\n\n{detail}"
        ))
        .title("Sionna RT Studio")
        .kind(MessageDialogKind::Error)
        .parent(window)
        .show(|_| {});
}

fn save_completed_download(source: &Path, destination: &Path) -> StudioResult<()> {
    let parent = destination.parent().ok_or("Choose a destination folder.")?;
    let overwrite = destination.exists();
    // Publish only the fully copied file, even when the two volumes differ.
    let stage = NamedTempFile::new_in(parent)?;
    fs::copy(source, stage.path())?;
    if overwrite {
        stage.persist(destination)?;
    } else {
        stage.persist_noclobber(destination)?;
    }
    Ok(())
}
