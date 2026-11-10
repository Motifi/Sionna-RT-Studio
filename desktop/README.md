# Sionna RT Studio desktop app

Windows 11 x64 用户请参阅 [Windows 安装与验收](windows/README.md)。

For Windows 11 x64, see [Windows installation and acceptance](windows/README.md).

## macOS

在仓库根目录运行 `./setup.sh` 和 `./desktop/build.sh`，再双击 `build/SionnaRTStudio.app`。应用以独立 macOS 窗口打开实验台，关闭最后一个窗口时停止本地仿真服务。桌面版单独保存语言偏好和自动保存的项目。

桌面版面向 Apple Silicon 和 macOS 14 或更新版本。应用内含前端资源和后端源码，运行时使用构建时指定的 Python 环境。在线底图和地理数据查询需要网络，内置三维场景与本地射线追踪可离线运行。

用底栏依次进入「场景」「规划」「预览」「导出」。在预览页计算静态全链路或所选 UE 的轨迹，随后在导出页用 macOS 保存对话框下载同一次运行的 CSI ZIP。项目文件保留可编辑的配置和控制点，CSI 随 ZIP 保存。详见[四工作区和 CSI 文件](../README.md#四个工作区--four-workspaces)。

## Rebuild

Run `./setup.sh` and then `./desktop/build.sh` from the Studio checkout. The build requires the macOS Command Line Tools. By default it uses the repository's `.venv` and `.node`, or the Node.js binary on `PATH`. Use `SRTS_PYTHON` and `SRTS_NODE` to select existing installations. The app uses a stable loopback address on port `43110` for project and language storage.

Quit the old app before opening the new build. Use the bottom bar to visit Scene, Planning, Preview, and Export. Solve all static links or one UE trajectory in Preview, then save that run's CSI ZIP with the macOS save dialog in Export. Editable settings and control points live in the project file. Keep the ZIP for your CSI data.

For a development smoke check, launch the bundle executable with `--smoke-report /path/to/report.json`. Set `SRTS_DESKTOP_TEST_PORT` to use a separate loopback port and inspect the resulting JSON report.
