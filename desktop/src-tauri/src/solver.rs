use crate::StudioResult;
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::Url;
use uuid::Uuid;

pub const DESKTOP_PORT: u16 = 43110;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(600);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub struct Solver {
    child: Child,
    pub origin: Url,
}

impl Solver {
    pub fn start(
        resource_dir: &Path,
        work_dir: &Path,
        log_path: &Path,
        acceptance_dir: Option<&Path>,
    ) -> StudioResult<Self> {
        let (python, mut command) = runtime_command(resource_dir)?;
        let log = File::create(log_path)?;
        let token = Uuid::new_v4().to_string();
        let port_file = work_dir.join("backend-port");
        if port_file.exists() {
            fs::remove_file(&port_file)?;
        }
        let requested_port = if acceptance_dir.is_some() {
            0
        } else {
            DESKTOP_PORT
        };
        command
            .arg(requested_port.to_string())
            .env("SRTS_DESKTOP_LAUNCH_TOKEN", &token)
            .env("SRTS_DESKTOP_PORT_FILE", &port_file)
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env_remove("PYTHONHOME")
            .env_remove("PYTHONPATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        if let Some(directory) = acceptance_dir {
            let runs = std::env::var_os("SRTS_RUNS_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| directory.join("runs"));
            command.env("SRTS_RUNS_DIR", runs);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = command
            .spawn()
            .map_err(|error| format!("Could not start Python at {}: {error}", python.display()))?;
        let mut solver = Self {
            child,
            origin: Url::parse("http://127.0.0.1/")?,
        };
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if acceptance_dir.is_some_and(|directory| directory.join("close").is_file()) {
                return Err("Desktop acceptance closed before the solver was ready.".into());
            }
            if let Some(status) = solver.child.try_wait()? {
                return Err(format!("The ray-tracing service exited ({status}).").into());
            }
            if let Ok(port) = fs::read_to_string(&port_file)
                .unwrap_or_default()
                .trim()
                .parse::<u16>()
            {
                if port != 0
                    && (requested_port == 0 || port == requested_port)
                    && ready(port, &token).unwrap_or(false)
                {
                    solver.origin = Url::parse(&format!("http://127.0.0.1:{port}/"))?;
                    return Ok(solver);
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err("The ray-tracing service did not start within 90 seconds.".into())
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn has_exited(&mut self) -> io::Result<bool> {
        Ok(self.child.try_wait()?.is_some())
    }
}

impl Drop for Solver {
    fn drop(&mut self) {
        // The existing Python server watches the parent pipe on both platforms.
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(7);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn runtime_command(resources: &Path) -> StudioResult<(PathBuf, Command)> {
    #[cfg(target_os = "windows")]
    let (python, directory, arguments): (PathBuf, PathBuf, Vec<std::ffi::OsString>) = {
        let runtime = std::env::current_exe()?
            .parent()
            .ok_or("Could not locate the Studio installation.")?
            .join("runtime");
        let portable = runtime.join("python/python.exe");
        let python = if portable.is_file() {
            portable
        } else {
            runtime.join(".venv/Scripts/python.exe")
        };
        let _ = resources;
        (
            python,
            runtime,
            vec!["-m".into(), "desktop.studio_server".into()],
        )
    };

    #[cfg(not(target_os = "windows"))]
    let (python, directory, arguments) = {
        let bundled = resources.join("python/bin/python3.12");
        let python = std::env::var_os("SRTS_PYTHON")
            .map(PathBuf::from)
            .or_else(|| bundled.is_file().then_some(bundled.clone()))
            .or_else(|| {
                let path = fs::read_to_string(resources.join("python-path.txt")).ok()?;
                let path = PathBuf::from(path.trim_end_matches(['\r', '\n']));
                path.is_absolute().then_some(path)
            })
            .unwrap_or(bundled);
        let script = resources.join("studio_server.py");
        if !script.is_file() {
            return Err("Studio's server is missing from the app bundle. Extract the complete ZIP or rebuild Studio.".into());
        }
        (python, resources.to_owned(), vec![script.into_os_string()])
    };

    if !python.is_file() {
        return Err(format!(
            "Studio's Python environment is missing at {}. Extract the complete Studio ZIP or rebuild the desktop app.",
            python.display()
        )
        .into());
    }
    let python = std::path::absolute(python)?;
    let mut command = Command::new(&python);
    command.arg("-B").args(arguments).current_dir(directory);
    Ok((python, command))
}

fn ready(port: u16, token: &str) -> io::Result<bool> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut connection = TcpStream::connect_timeout(&address, HANDSHAKE_TIMEOUT)?;
    connection.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    connection.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
    write!(
        connection,
        "GET /_desktop-ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nStudio-Token: {token}\r\nConnection: close\r\n\r\n"
    )?;
    let mut status = String::new();
    BufReader::new(connection)
        .take(256)
        .read_line(&mut status)?;
    Ok(status.split_whitespace().nth(1) == Some("204"))
}

pub fn log_tail(path: &Path) -> String {
    let read_tail = || -> io::Result<String> {
        let mut log = File::open(path)?;
        let start = log.metadata()?.len().saturating_sub(4096);
        log.seek(SeekFrom::Start(start))?;
        let mut tail = Vec::new();
        log.take(4096).read_to_end(&mut tail)?;
        Ok(String::from_utf8_lossy(&tail).trim().to_owned())
    };
    read_tail().unwrap_or_default()
}
