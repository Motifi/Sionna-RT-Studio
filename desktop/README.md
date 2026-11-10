# Sionna RT Studio desktop app

在仓库根目录运行 `./setup.sh` 和 `./desktop/build.sh`，再双击 `build/SionnaRTStudio.app`。应用以独立 macOS 窗口打开实验台，关闭最后一个窗口时停止本地仿真服务。桌面版单独保存语言偏好和自动保存的项目。

桌面版面向 Apple Silicon 和 macOS 14 或更新版本。应用内含前端资源和后端源码，运行时使用构建时指定的 Python 环境。在线底图和地理数据查询需要网络，内置三维场景与本地射线追踪可离线运行。

## Rebuild

Run `./setup.sh` and then `./desktop/build.sh` from the Studio checkout. The build requires the macOS Command Line Tools. By default it uses the repository's `.venv` and `.node`, or the Node.js binary on `PATH`. Use `SRTS_PYTHON` and `SRTS_NODE` to select existing installations. The app uses a stable loopback address on port `43110` for project and language storage.

For a development smoke check, launch the bundle executable with `--smoke-report /path/to/report.json`. It uses temporary WebKit storage and checks the canvas, both interface languages, multiple receiver placements, a LOS ray trace, and project export. Set `SRTS_DESKTOP_TEST_PORT` to use a separate loopback port during the check.
