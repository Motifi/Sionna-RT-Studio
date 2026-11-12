# Sionna RT Studio

使用 NVIDIA Sionna RT 做交互式无线传播仿真。底栏提供场景、部署、仿真和导出四个工作区。界面支持中文和英文，并提供 Windows x64 和 Apple Silicon macOS 桌面版。

An interactive wireless propagation studio built on NVIDIA Sionna RT. The bottom bar opens the Scene, Deployment, Simulation, and Export workspaces. The bilingual desktop app supports Windows x64 and Apple Silicon Macs.

## 安装与运行 · Setup

推荐 Python 3.11–3.13。Web 版支持 Linux、Apple Silicon macOS 和 Windows WSL2。`setup.sh` 会安装前后端依赖，并在需要时下载项目本地的 Node.js。Debian / Ubuntu / WSL2 上需先安装与 Python 版本匹配的 `venv` 软件包。

Python 3.11–3.13 is recommended. The web app runs on Linux, Apple Silicon macOS, and Windows WSL2. `setup.sh` installs the dependencies and downloads a project-local Node.js if needed. On Debian, Ubuntu, or WSL2, install the matching Python `venv` package first.

```bash
git clone https://github.com/Motifi/Sionna-RT-Studio.git
cd Sionna-RT-Studio
./setup.sh
./run.sh
```

打开 [http://localhost:3000](http://localhost:3000)。右上角显示 Sionna RT 就绪后即可开始计算。使用 `Ctrl+C` 停止。若后端默认端口 8000 已占用，可运行 `SRTS_BACKEND_PORT=8011 ./run.sh`。

Open [http://localhost:3000](http://localhost:3000). When the upper-right status shows Sionna RT is ready, you can run a solve. Press `Ctrl+C` to stop. Set `SRTS_BACKEND_PORT=8011` when running `./run.sh` if port 8000 is occupied.

射线追踪使用可用的 CUDA、Metal 或 LLVM 后端。CPU 回退需要 LLVM 运行库。Web 版可用 `GET /api/health` 查看后端类型和 GPU 状态。

Ray tracing uses an available CUDA, Metal, or LLVM backend. CPU fallback requires the LLVM runtime. For the web app, check the backend and GPU status at [`/api/health`](http://127.0.0.1:8000/api/health).

## Windows 桌面版 · Windows desktop app

Windows 11 x64 可用 PowerShell 从源码安装独立窗口版。安装脚本准备项目自己的 Python 环境和前端，并创建开始菜单快捷方式。参见 [Windows 安装和 CUDA、CSI、CIR 验收](desktop/windows/README.md)。

On Windows 11 x64, use PowerShell to install the desktop app from source. The installer prepares the app's Python environment and frontend, and adds a Start menu shortcut. See [Windows installation and CUDA, CSI, and CIR acceptance](desktop/windows/README.md).

## macOS 桌面版 · macOS desktop app

在 Apple Silicon Mac 上安装 Xcode Command Line Tools 后，先按上文完成 `./setup.sh`，再从仓库目录构建。若使用自备环境，请将 `SRTS_PYTHON` 指向已安装后端依赖的解释器，并将 `SRTS_NODE` 指向 Node.js 可执行文件。

On an Apple Silicon Mac with Xcode Command Line Tools, run `./setup.sh` first, then build from the repository root. For a custom environment, set `SRTS_PYTHON` to a Python interpreter with the backend dependencies installed and `SRTS_NODE` to the Node.js executable.

```bash
./desktop/build.sh
open build/SionnaRTStudio.app
```

应用会在独立窗口中运行，并随窗口退出停止本地服务。构建产物使用构建时指定的 Python 环境，请保留该环境。更多信息见[桌面版构建说明](desktop/README.md)。

The app opens in its own window and stops its local service when it quits. Keep the Python environment selected at build time available. See the [desktop build notes](desktop/README.md) for details.

## 四个工作区 · Four workspaces

1. **场景**从内置街区、空白场景、OSM 地图或网格开始。在对象列表或三维视图选中对象来编辑几何和材质，用「求解检查」查看实际参与求解的网格。
2. **部署**使用三维工具栏放置和移动 AP、UE。选中 AP 可设置阵列、功率、波束方向和前传容量。选中 UE 后用「绘制轨迹」添加控制点。
3. **仿真**配置共享无线参数，运行 CSI、覆盖或链路诊断并在同页查看结果。CSI 可计算静态全链路或单 UE 轨迹。计算前可查看采样时刻数、收发端口和 CFR 的预计大小。大规模阵列或较长轨迹可选「仅 CIR」。
4. **导出**可下载本次仿真的 CSI ZIP，或从「CSI 运行历史」打开并导出之前保存的结果。用顶部「项目」菜单打开或保存可编辑的项目文件。

1. **Scene** opens a built-in or blank scene or imports OSM or mesh data. Select geometry in the object list or 3D view to edit it. Solver Check shows the meshes used by the solver.
2. **Deployment** places and moves APs and UEs. Select an AP to edit its array, power, orientation, and fronthaul capacity. Select a UE to draw its route.
3. **Simulation** provides shared wireless settings and three tasks for CSI, coverage, and link diagnostics. CSI solves all static links or one selected UE's trajectory. Check the estimated CFR size before running and choose CIR only for large arrays or long routes.
4. **Export** downloads the current CSI ZIP or a saved run selected in **CSI run history**. Open or save an editable project file from the Project menu.

「场景」支持离线绘制矩形、多边形和墙，也可编辑内置街区和已下载的 OSM 对象。「求解检查」可查看 Sionna RT 实际使用的三角形和导入问题。PLY、OBJ 和带引用网格的 Mitsuba ZIP 可以先检查尺度、坐标轴和材质，再导入并随项目保存。顶部的求解状态与 3D 画布的 WebGL 状态分开。

Use Scene to draw rectangles, polygons, and walls offline, or edit the built-in street scene and imported OSM objects. Solver mesh displays the triangles used by Sionna RT along with object participation, material provenance, and import issues. Review the scale, axes, and material of PLY, OBJ, and Mitsuba ZIP imports before embedding them in the project. The solver and the WebGL canvas report their status separately.

在线底图和首次 OSM 导入需要网络，保存后的场景可离线重开。更新后，Web 版请强制刷新，桌面版请退出旧应用后打开新构建。桌面稳定版检查与审查包流程见[发行说明](desktop/RELEASE.md)。

Map tiles and the initial OSM import need a network connection. Saved scenes reopen offline. After updating, hard-refresh the web page or quit the old desktop app and open the new build. See the [desktop release notes](desktop/RELEASE.md) for update checks and candidate builds.

## 示例与覆盖对比 · Examples and coverage comparison

从「场景来源 → 示例实验」载入静态 CSI、街道到大厅或街区覆盖预设。按面板中的预期结果核对首径、逐 AP 轨迹或覆盖占比。载入示例会替换当前场景和部署，可用「场景」中的撤销恢复。

Open **Scene Source → Example experiments** to load static CSI, street-to-lobby mobility, or street coverage. The example panel lists the expected first arrival, per-AP trajectory, or coverage results. Loading an example replaces the scene and deployment. Use Scene Undo to restore them.

CSI 和覆盖任务在同一个求解队列执行。仿真页会显示排队、追踪和保存阶段。取消会在求解器可安全停止的位置生效，重试沿用该任务提交时的输入。打开另一个项目时，会请求取消当前界面提交且仍可取消的任务。轨迹运行前显示实际采样间隔，覆盖运行前显示格点数、AP–格点数、体积估算和超限修正。

CSI and coverage share a solver queue. Simulation shows waiting, tracing, and saving. Cancellation takes effect at a safe checkpoint, and retry uses the original request. Opening another project requests cancellation of the previous project’s pending UI tasks. The trajectory panel shows the actual sample interval. Coverage preflight shows grid size, AP–cell count, estimated size, and adjustments for exceeded limits.

覆盖可指定 ENU 矩形测区、物理楼板和达标阈值。先运行并保存基线，再调整部署，用相同测区、测量面、栅格和指标运行第二次。A/B 共用色标，可导出实际栅格、逐格差值、P5、达标率变化及差值 PNG。

Set an ENU rectangle, physical floor slab, and threshold in Coverage. Save the first run as a baseline, then adjust the deployment and reuse the same area, surface, grid, and metric. The A/B views share a color scale. Download the actual grids, cell deltas, P5, changes in served percentage, and a difference PNG.

## 城市场景与场景包 · Urban scenes and scene packages

在三维视口左上角选「平移」，可直接拖动视图。查看建筑内部时，先选楼层，然后选「漫游」并点击楼板。进入漫游后会显示完整建筑和天花板。拖动鼠标转头，用 WASD 或方向键移动，Q/E 下降或上升，Esc 返回之前的视角。漫游可穿过墙体，以便检查模型。

Choose **Pan** in the 3D viewport and drag to move the view. For an interior view, select a floor, choose **Walk**, and click the floor. Walk shows the full building, including ceilings. Drag to look around, use WASD or the arrow keys to move, use Q/E to change elevation, and press Esc to restore the previous view. Walk mode can pass through walls for inspection.

在「场景 → 添加模型 → 生成建筑」中点选矩形的两个对角，再填写高度。可选择办公楼或公寓楼，楼层数可以自动估算。生成后切换楼层查看内部，选中建筑部件可编辑整栋的尺寸与布局，或调整部件的射频材质。重新生成是一条可撤销的场景编辑。

Choose **Scene → Add Geometry → Generate a building**, pick opposite footprint corners, and enter the height. Choose an office or apartment layout, with optional automatic floor count. Inspect individual floors, regenerate the building from its parameters, or edit the radio material of a selected component. Regeneration can be undone in a single step.

在「部署」可分别选择地形相对高度、原有的地面或屋顶高度，以及绝对 ENU 标高。选择具体楼板后，布站和绘制轨迹会按命中位置及离板高度记录绝对标高。轨迹仿真按实际三维采样点显示与播放。

In **Deployment**, choose terrain-relative height, the existing ground-or-roof reference, or absolute ENU elevation. With a floor slab selected, device placement and route drawing use the hit position and the height above that slab. Trajectory simulation displays and plays the actual 3D samples.

在「场景来源」中打开城市场景示例铸造大道。楼层切到「1 层」可查看首层入口、玻璃幕墙和室内分隔。「求解检查」显示参与传播的地面、墙体和树冠。示例已放置街边 AP、室内 AP 和 UE，并预设从街边穿过入口的步行轨迹。可直接在「仿真」中计算覆盖或 UE 轨迹 CSI。场景为自建，树冠衰减和材质取值用于演示，尚未做现场校准。参见[场景包制作说明](docs/scene-package.md)。

Open Foundry Avenue from **Scene Source** and select `1F` to inspect the entrance, glazing, and interior partitions. **Solver Check** shows the terrain, walls, and crowns that participate in propagation. A street AP, a lobby AP, and a walking UE route are ready for coverage and trajectory CSI. The example uses synthetic geometry and illustrative propagation parameters. See the [scene package format](docs/scene-package.md) to author your own.

## CSI 文件 · CSI files

ZIP 包含 `csi.npz` 和 `manifest.json`。复数 `h_freq` 的轴顺序为 `[时间, UE, Rx 端口, AP, Tx 端口, 子载波]`。静态计算的时间维为 1，轨迹计算的 UE 维为 1。清单记录设备 ID、实际采样时间和位置、基带频率轴、时延参考及求解设置。逐 AP 前传容量以 Mb/s 记录在 `fronthaulMbpsByTxId`，`null` 表示未设置。调整前传容量后可复用同一份 CSI。

The ZIP contains `csi.npz` and `manifest.json`. Complex `h_freq` uses the axis order `[time, UE, Rx port, AP, Tx port, subcarrier]`. Static runs have one time sample, and trajectory runs have one UE. The manifest records device IDs, actual sample times and positions, the baseband frequency axis, delay reference, and solver settings. AP fronthaul capacities are exported in Mb/s under `fronthaulMbpsByTxId`, with `null` for an unspecified capacity. The same CSI can be exported with revised fronthaul metadata.

同一项目的 CSI 运行保存在当前设备上。重启后可在「仿真」或「导出」选择历史运行，预览其场景快照或再次下载。跨机器传递结果时请带上 CSI ZIP，其中包含运行输入、实际求解网格、依赖版本和复算说明。准备好依赖后，在解压目录执行 `python replay_csi.py`，生成 `csi-replay.npz`。

CSI runs are saved for the project on this device. After restarting, select a saved run in **Simulation** or **Export** to view its scene snapshot or download it again. Share the CSI ZIP to transfer results to another machine. The ZIP includes run inputs, solver meshes, dependency versions, and replay instructions. With the dependencies ready, run `python replay_csi.py` from the extracted directory to generate `csi-replay.npz`.

默认将每条链路的时延以该链路首径为参考。需要保留 AP 间传播时延差时，可在「仿真」的 CSI「频率网格与时延」中选择绝对时延后计算。系统带宽和 CSI 网格分别配置，默认值为 100 MHz 与 1024 × 30 kHz。

By default, each link uses its own first arrival as the delay reference. To preserve relative propagation delays across APs, select absolute delays in the CSI frequency grid settings before running. System bandwidth and the CSI grid are configured separately and default to 100 MHz and 1024 × 30 kHz.

「CIR + CFR」保存路径数据与完整 `h_freq`。「仅 CIR」保存每条路径的复系数 `a`、时延 `tau_geometric`、有效路径掩码 `valid_paths` 和频率轴。清单中的 `output` 分别为 `cir_cfr` 或 `cir`，`shape` 在两种模式下都描述完整 CFR 的形状。仅 CIR 模式的大小取决于求解找到的路径数。两种模式分别以 256 MiB 和 512 MiB 为上限，按实际要保存的未压缩信道数组估算。

CIR + CFR stores the path data and the full `h_freq`. CIR only stores the complex path coefficients `a`, delays `tau_geometric`, mask `valid_paths`, and frequency axis. The manifest records `output` as `cir_cfr` or `cir`, and `shape` describes the full CFR shape in either mode. The CIR-only size depends on the paths found. The limits are 256 MiB for CIR + CFR and 512 MiB for CIR only, measured on the uncompressed channel arrays being saved.

下面的示例读取两种格式中的任一种，得到首个时刻、首个 UE、首个 AP 的 CFR，轴顺序为 `[Rx 端口, Tx 端口, 子载波]`。

This example reads either format and returns the first time sample, UE, and AP as a CFR with axes `[Rx port, Tx port, subcarrier]`.

```python
from io import BytesIO
from zipfile import ZipFile

import numpy as np

with ZipFile("your-csi-run.zip") as archive:
    with np.load(BytesIO(archive.read("csi.npz"))) as data:
        time_seconds = data["time_seconds"]
        frequencies_hz = data["frequencies"]
        if "h_freq" in data.files:
            H = data["h_freq"][0, 0, :, 0, :, :]
        else:
            valid = data["valid_paths"][0, 0, 0]
            delay = data["tau_geometric"][0, 0, 0, valid]
            a = data["a"][0, 0, :, 0, :, :][..., valid]
            phase = np.exp(-2j * np.pi * delay[:, None] * frequencies_hz[None, :])
            H = a @ phase
```

## 研究导出与检查 · Research exports and checks

可导出项目、CIR/CFR 数据及独立的 Sionna RT 场景。可选的 5G NR PUSCH BER/BLER 分析使用 `backend/requirements-phy.txt` 中的依赖。

Export projects, CIR/CFR data, and standalone Sionna RT scenes. The optional 5G NR PUSCH BER/BLER analysis uses the dependencies in `backend/requirements-phy.txt`. See the [backend reference](backend/README.md) for the API.

```bash
export PATH="$PWD/.node/bin:$PATH"
npm run lint -- --noUnusedLocals
npm run check:osm-parser
./.venv/bin/python -m unittest discover backend/tests
```

## 批量实验与测量对照 · Research workflows

使用 `python -m scripts.research_workflows` 从保存的项目扫描频率、阵列和部署方案，或导入带 ENU 坐标的测量 CSV 并对照接收功率及绝对首径时延。每组结果都可追溯到对应的 CSI 运行。示例使用可复算的室内解析参考值，现场校准使用自己的测量数据。参见[命令和数据格式](docs/research-workflows.md)。

Use `python -m scripts.research_workflows` to sweep frequency, array sizes, and deployment from a saved project, or import ENU-tagged measurements for received-power and absolute first-arrival comparisons. Reports link to the associated CSI runs. The indoor fixture uses reproducible analytic references. Use your own measured data for field calibration. See the [commands and data format](docs/research-workflows.md).

## 来源与许可 · Credits and license

本项目基于 Pulok Tarafder 的 SionnaRTStudio，并使用 NVIDIA Sionna RT。代码采用 Apache-2.0 许可。地图数据 © OpenStreetMap contributors，适用 ODbL。

This project builds on Pulok Tarafder’s SionnaRTStudio and uses NVIDIA Sionna RT. The code is licensed under Apache-2.0. Map data © OpenStreetMap contributors, available under the ODbL.

- [Upstream SionnaRTStudio](https://github.com/puloktarafder/SionnaRTStudio) · [Upstream citation](CITATION.cff)
- [NVIDIA Sionna RT](https://github.com/NVlabs/sionna-rt)
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)
- [License](LICENSE) · [Notices](NOTICE)
