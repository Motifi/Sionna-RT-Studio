use crate::{lifecycle::write_report, navigation::is_studio_resource, StudioResult};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
};
use tauri::{webview::DownloadEvent, Webview};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogKind};
use tempfile::{NamedTempFile, TempDir};
use uuid::Uuid;

struct PendingDownload {
    stage: PathBuf,
    name: String,
}

#[derive(Default)]
struct DownloadState {
    pending: HashMap<String, PendingDownload>,
    active_saves: usize,
    closing: bool,
}

#[derive(Default)]
struct DownloadActivity {
    state: Mutex<DownloadState>,
    saves_finished: Condvar,
}

struct ActiveSave {
    activity: Arc<DownloadActivity>,
    download: PendingDownload,
}

impl Drop for ActiveSave {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.download.stage);
        let mut state = self.activity.state.lock().unwrap();
        state.active_saves -= 1;
        if state.active_saves == 0 {
            self.activity.saves_finished.notify_all();
        }
    }
}

pub struct Downloads {
    activity: Arc<DownloadActivity>,
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
            activity: Arc::new(DownloadActivity::default()),
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
                let mut state = self.activity.state.lock().unwrap();
                if state.closing || state.pending.contains_key(url.as_str()) {
                    return false;
                }
                let stage = self.staging.path().join(Uuid::new_v4().to_string());
                state.pending.insert(
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
                let pending = self
                    .activity
                    .state
                    .lock()
                    .unwrap()
                    .pending
                    .remove(url.as_str());
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

    // Called off the UI thread after the user has approved closing.
    pub fn finish_saves_before_exit(&self) {
        let mut state = self.activity.state.lock().unwrap();
        state.closing = true;
        while state.active_saves > 0 {
            state = self.activity.saves_finished.wait(state).unwrap();
        }
    }

    fn begin_save(&self, download: PendingDownload) -> Option<ActiveSave> {
        let mut state = self.activity.state.lock().unwrap();
        if state.closing {
            drop(state);
            let _ = fs::remove_file(download.stage);
            return None;
        }
        state.active_saves += 1;
        Some(ActiveSave {
            activity: Arc::clone(&self.activity),
            download,
        })
    }

    fn save(&self, webview: Webview, download: PendingDownload) {
        // Reserve the save before showing the picker so exit also waits for
        // a confirmation whose callback has yet to start writing.
        let Some(save) = self.begin_save(download) else {
            return;
        };
        if let Some(directory) = &self.acceptance {
            let destination = directory.join("downloads").join(&save.download.name);
            if let Err(error) = save_completed_download(&save.download.stage, &destination) {
                self.fail(&webview, &error.to_string());
            }
            return;
        }
        let window = webview.window();
        let dialog = webview
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(&save.download.name);
        #[cfg(target_os = "windows")]
        let dialog = match export_extension(&save.download.name) {
            // RFD uses the first filter's extension as the native default.
            Some(extension) => dialog
                .add_filter(
                    format!("{} (*.{extension})", extension.to_ascii_uppercase()),
                    &[extension],
                )
                .add_filter("All Files", &["*"]),
            None => dialog,
        };
        dialog.save_file(move |selection| {
            if let Some(FilePath::Path(destination)) = selection {
                if let Err(error) = save_completed_download(&save.download.stage, &destination) {
                    show_error(&window, &error.to_string(), move |_| drop(save));
                    return;
                }
            }
            drop(save);
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
            show_error(&webview.window(), detail, |_| {});
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn export_extension(name: &str) -> Option<&str> {
    Path::new(name)
        .extension()?
        .to_str()
        .filter(|extension| !extension.is_empty())
}

fn show_error(
    window: &tauri::Window,
    detail: &str,
    on_dismiss: impl FnOnce(bool) + Send + 'static,
) {
    window
        .dialog()
        .message(format!(
            "Could not save the export.\n无法保存导出文件。\n\n{detail}"
        ))
        .title("Sionna RT Studio")
        .kind(MessageDialogKind::Error)
        .parent(window)
        .show(on_dismiss);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::mpsc::{self, RecvTimeoutError},
        thread,
        time::Duration,
    };

    #[test]
    fn shutdown_waits_until_an_active_save_finishes_and_closes_admission() {
        let downloads = Downloads::new(None).unwrap();
        let stage = downloads.staging.path().join("active");
        fs::write(&stage, b"export").unwrap();
        let save = downloads
            .begin_save(PendingDownload {
                stage: stage.clone(),
                name: "project.json".into(),
            })
            .unwrap();

        let (started, wait_started) = mpsc::channel();
        let (finished, wait_finished) = mpsc::channel();
        thread::scope(|scope| {
            let downloads = &downloads;
            scope.spawn(move || {
                started.send(()).unwrap();
                downloads.finish_saves_before_exit();
                finished.send(()).unwrap();
            });
            wait_started.recv().unwrap();
            let premature_exit = wait_finished.recv_timeout(Duration::from_millis(50));
            drop(save);
            assert_eq!(premature_exit, Err(RecvTimeoutError::Timeout));
            wait_finished.recv_timeout(Duration::from_secs(5)).unwrap();
        });

        assert!(!stage.exists());
        let late_stage = downloads.staging.path().join("late");
        fs::write(&late_stage, b"export").unwrap();
        assert!(downloads
            .begin_save(PendingDownload {
                stage: late_stage.clone(),
                name: "late.zip".into(),
            })
            .is_none());
        assert!(!late_stage.exists());
    }

    #[test]
    fn export_extension_uses_the_suffix_of_the_suggested_filename() {
        assert_eq!(export_extension("project.json"), Some("json"));
        assert_eq!(export_extension("experiment.csi.zip"), Some("zip"));
        assert_eq!(export_extension("project"), None);
        assert_eq!(export_extension("project."), None);
    }
}
