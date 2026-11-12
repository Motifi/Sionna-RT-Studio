use crate::{downloads::Downloads, navigation::is_studio_page, solver, StudioResult};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tempfile::{NamedTempFile, TempDir};

const SAVE_TIMEOUT: Duration = Duration::from_secs(2);
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);
const PAGE_PROBE_TIMEOUT: Duration = Duration::from_millis(800);
const DISCARD: &str = "Discard changes / 放弃修改";

pub struct Session {
    acceptance: Option<PathBuf>,
    resource_dir: PathBuf,
    log_path: PathBuf,
    work: TempDir,
    solver: Mutex<Option<solver::Solver>>,
    origin: Mutex<Option<Url>>,
    pub downloads: Downloads,
    closing: AtomicBool,
    approved: AtomicBool,
}

impl Session {
    pub fn new(app: &AppHandle, acceptance: Option<PathBuf>) -> StudioResult<Self> {
        let log_dir = match &acceptance {
            Some(directory) => directory.clone(),
            None => app.path().local_data_dir()?.join("SionnaRTStudio/logs"),
        };
        fs::create_dir_all(&log_dir)?;
        let downloads = Downloads::new(acceptance.as_deref())?;
        Ok(Self {
            acceptance,
            resource_dir: app.path().resource_dir()?,
            log_path: log_dir.join("studio.log"),
            work: tempfile::Builder::new()
                .prefix("studio-session-")
                .tempdir()?,
            solver: Mutex::new(None),
            origin: Mutex::new(None),
            downloads,
            closing: AtomicBool::new(false),
            approved: AtomicBool::new(false),
        })
    }

    pub fn acceptance(&self) -> Option<&Path> {
        self.acceptance.as_deref()
    }

    pub fn origin(&self) -> Option<Url> {
        self.origin.lock().unwrap().clone()
    }

    pub fn stop(&self) {
        let solver = self.solver.lock().unwrap().take();
        drop(solver);
    }

    pub fn shutdown(&self) {
        self.approved.store(true, Ordering::Release);
        self.stop();
        self.downloads.clean_up();
        let _ = fs::remove_dir_all(self.work.path());
    }

    pub fn start(self: &Arc<Self>, window: &WebviewWindow) {
        let session = Arc::clone(self);
        let window = window.clone();
        thread::spawn(move || {
            let solver = solver::Solver::start(
                &session.resource_dir,
                session.work.path(),
                &session.log_path,
                session.acceptance(),
            );
            match solver {
                Ok(solver) => {
                    let origin = solver.origin.clone();
                    {
                        let mut current = session.solver.lock().unwrap();
                        if session.approved.load(Ordering::Acquire) {
                            return;
                        }
                        *session.origin.lock().unwrap() = Some(origin.clone());
                        *current = Some(solver);
                    }
                    // A restart at the same origin keeps the loaded workspace and its edits.
                    let loaded = workspace_loaded(&window, &origin);
                    if !loaded {
                        if let Err(error) = window.navigate(origin.clone()) {
                            session.startup_failed(&window, &error.to_string());
                            return;
                        }
                    }
                    session.monitor(&window, &origin, loaded);
                }
                Err(error) => session.startup_failed(&window, &error.to_string()),
            }
        });
    }

    fn monitor(self: &Arc<Self>, window: &WebviewWindow, origin: &Url, mut loaded: bool) {
        let deadline = Instant::now() + PAGE_TIMEOUT;
        loop {
            if self.approved.load(Ordering::Acquire) {
                return;
            }
            if self
                .acceptance()
                .is_some_and(|directory| directory.join("close").is_file())
            {
                self.request_close(window);
                return;
            }
            let running = self
                .solver
                .lock()
                .unwrap()
                .as_mut()
                .map(solver::Solver::has_exited);
            match running {
                Some(Ok(false)) => {
                    if !loaded {
                        loaded = workspace_loaded(window, origin);
                        if !loaded && Instant::now() >= deadline {
                            self.startup_failed(
                                window,
                                "The Studio workspace could not load.\n实验台工作区无法加载。",
                            );
                            return;
                        }
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                Some(Ok(true)) => {
                    self.startup_failed(
                        window,
                        "The ray-tracing service stopped.\n射线追踪服务已停止。",
                    );
                    return;
                }
                Some(Err(error)) => {
                    self.startup_failed(window, &error.to_string());
                    return;
                }
                None => return,
            }
        }
    }

    fn startup_failed(self: &Arc<Self>, window: &WebviewWindow, reason: &str) {
        self.stop();
        if self.approved.load(Ordering::Acquire) {
            return;
        }
        let mut detail = format!("{reason}\n\nLog / 日志: {}", self.log_path.display());
        let tail = solver::log_tail(&self.log_path);
        if !tail.is_empty() {
            detail.push_str("\n\n");
            detail.push_str(&tail);
        }
        if self.acceptance().is_some() {
            self.write_acceptance_error(&detail);
            // Let the verifier read the error before requesting shutdown.
            let session = Arc::clone(self);
            let window = window.clone();
            thread::spawn(move || {
                if let Some(directory) = session.acceptance() {
                    let deadline = Instant::now() + Duration::from_secs(20);
                    while !directory.join("close").is_file() && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(100));
                    }
                }
                window.app_handle().exit(0);
            });
            return;
        }
        let session = Arc::clone(self);
        let dialog_window = window.clone();
        window
            .dialog()
            .message(detail)
            .title("Could not start Sionna RT Studio / 实验台启动失败")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Retry / 重试".into(),
                "Quit / 退出".into(),
            ))
            .parent(window)
            .show(move |retry| {
                if retry {
                    session.start(&dialog_window);
                } else if session.should_check_close() {
                    session.request_close(&dialog_window);
                } else {
                    dialog_window.app_handle().exit(1);
                }
            });
    }

    pub fn report_acceptance(&self, url: &Url) {
        if self.acceptance().is_none() {
            return;
        }
        let value = url
            .query_pairs()
            .find(|(key, _)| key == "data")
            .filter(|(_, data)| data.len() <= 65_536)
            .and_then(|(_, data)| serde_json::from_str::<Value>(&data).ok());
        let Some(mut report) = value else {
            self.write_acceptance_error("The desktop UI returned an invalid acceptance report.");
            return;
        };
        if report["ok"] != true
            || [
                "uiReady",
                "webgl2",
                "workspaceNavigation",
                "projectAutosave",
            ]
            .iter()
            .any(|key| report[*key] != true)
        {
            let error = report["error"]
                .as_str()
                .unwrap_or("The desktop UI did not complete acceptance.");
            self.write_acceptance_error(error);
            return;
        }
        let solver = self.solver.lock().unwrap();
        if let Some(solver) = solver.as_ref() {
            report["origin"] = json!(solver.origin.as_str().trim_end_matches('/'));
            report["backendPid"] = json!(solver.pid());
            self.write_acceptance("desktop-ready.json", &report);
        }
    }

    pub fn write_acceptance_error(&self, error: &str) {
        self.write_acceptance("desktop-error.json", &json!({ "error": error }));
    }

    fn write_acceptance(&self, name: &str, report: &Value) {
        if let Some(directory) = self.acceptance() {
            write_report(directory, name, report);
        }
    }

    pub fn should_check_close(&self) -> bool {
        !self.approved.load(Ordering::Acquire) && self.origin().is_some()
    }

    pub fn request_close(self: &Arc<Self>, window: &WebviewWindow) {
        if self.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        let session = Arc::clone(self);
        let window = window.clone();
        thread::spawn(move || {
            let on_studio_page = window
                .url()
                .ok()
                .zip(session.origin())
                .is_some_and(|(url, origin)| is_studio_page(&url, &origin));
            if !on_studio_page || wait_for_project_save(&window) {
                session.exit(&window);
                return;
            }
            if session.acceptance().is_some() {
                session.write_acceptance_error("Project did not finish saving before close.");
                session.approved.store(true, Ordering::Release);
                window.app_handle().exit(1);
                return;
            }

            let dialog_window = window.clone();
            window
                .dialog()
                .message("The project has unsaved changes. Keep Studio open to retry saving or export the project.\n\n项目有未保存的修改。请保持实验台打开，以重试保存或导出项目。")
                .title("Sionna RT Studio")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::YesNoCancelCustom(
                    "Keep open / 保持打开".into(),
                    DISCARD.into(),
                    "Cancel".into(),
                ))
                .parent(&window)
                .show_with_result(move |result| {
                    if discard_requested(&result) {
                        session.exit(&dialog_window);
                    } else {
                        session.closing.store(false, Ordering::Release);
                    }
                });
        });
    }

    fn exit(&self, window: &WebviewWindow) {
        self.approved.store(true, Ordering::Release);
        window.app_handle().exit(0);
    }
}

pub fn write_report(directory: &Path, name: &str, report: &Value) {
    let result = (|| -> StudioResult<()> {
        let mut stage = NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut stage, report)?;
        stage.persist(directory.join(name))?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("Could not write desktop acceptance report: {error}");
    }
}

fn discard_requested(result: &MessageDialogResult) -> bool {
    matches!(result, MessageDialogResult::Custom(label) if label == DISCARD)
}

fn evaluate(window: &WebviewWindow, script: &str, timeout: Duration) -> Option<String> {
    let (sender, receiver) = mpsc::channel();
    window
        .eval_with_callback(script, move |value| {
            let _ = sender.send(value);
        })
        .ok()?;
    receiver.recv_timeout(timeout).ok()
}

fn workspace_loaded(window: &WebviewWindow, origin: &Url) -> bool {
    window.url().is_ok_and(|url| is_studio_page(&url, origin))
        && evaluate(
            window,
            "Boolean(document.querySelector('#nav-btn-scene'))",
            PAGE_PROBE_TIMEOUT,
        )
        .as_deref()
            == Some("true")
}

fn wait_for_project_save(window: &WebviewWindow) -> bool {
    if window
        .eval("window.dispatchEvent(new Event('sionna-studio-flush-project'))")
        .is_err()
    {
        return false;
    }
    let deadline = Instant::now() + SAVE_TIMEOUT;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let Some(value) = evaluate(
            window,
            "document.documentElement.dataset.projectSaveState ?? 'saved'",
            remaining,
        ) else {
            return false;
        };
        match serde_json::from_str::<String>(&value).as_deref() {
            Ok("saved") => return true,
            Ok("saving") => thread::sleep(Duration::from_millis(50)),
            _ => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_explicit_discard_button_allows_closing_with_unsaved_changes() {
        assert!(discard_requested(&MessageDialogResult::Custom(
            DISCARD.into()
        )));
        for result in [
            MessageDialogResult::Cancel,
            MessageDialogResult::No,
            MessageDialogResult::Yes,
            MessageDialogResult::Custom("Keep open / 保持打开".into()),
            MessageDialogResult::Custom("Cancel".into()),
        ] {
            assert!(!discard_requested(&result));
        }
    }
}
