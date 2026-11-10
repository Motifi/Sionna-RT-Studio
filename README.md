# Sionna RT Studio

使用 NVIDIA Sionna RT 做交互式无线传播仿真。四个工作区覆盖场景配置、AP 与 UE 规划、CSI 预览和数据导出。界面支持中文和英文，并提供 Apple Silicon macOS 桌面版。

An interactive wireless propagation studio built on NVIDIA Sionna RT. Four workspaces cover scene setup, device planning, CSI preview, and export. The interface supports Chinese and English, including a desktop app for Apple Silicon Macs.

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

1. **场景**选择内置场景或导入 OSM 建筑，设置载频、系统带宽、传播机制和 CSI 子载波网格。默认的 100 MHz 系统带宽与 1024 × 30 kHz 的 CSI 网格分别设置。
2. **规划**使用三维工具栏新增和移动 AP、UE。选中 AP 可设置阵列、功率、波束方向和前传容量。选中 UE 后用「绘制轨迹」添加控制点，并设置速度和采样间隔。
3. **预览**计算静态全链路或所选 UE 轨迹。试算时可在场景页选择较少的每源射线采样数。2 台 AP 和 3 台 UE 会生成 6 条静态链路。移动模式追踪一台 UE 与全部 AP 的链路。
4. **导出**下载本次预览的 CSI ZIP。切换工作区后仍可查看本次运行。更改传播输入后，在预览页重新计算。

1. **Scene** opens the built-in scene or imports OSM buildings. Set the carrier, system bandwidth, propagation mechanisms, and CSI subcarrier grid. The default system bandwidth is 100 MHz, and the CSI grid uses 1024 subcarriers spaced at 30 kHz.
2. **Planning** places and moves APs and UEs. Select an AP to edit its array, power, orientation, and fronthaul capacity. Select a UE to draw its trajectory and set the speed and sampling interval.
3. **Preview** solves all static links or one selected UE's trajectory. Choose a lower ray sample count in Scene for a quick check. Two APs and three UEs produce six static links. A trajectory run traces one moving UE against all APs.
4. **Export** saves the CSI ZIP from the Preview run. You can revisit a run after switching workspaces. Recompute in Preview after changing propagation inputs.

在线底图和建筑导入需要网络，内置场景可直接计算。更新后，Web 版请强制刷新，桌面版请退出旧应用后打开新构建。

Map tiles and building imports need a network connection. The built-in scene is ready to solve. After updating, hard-refresh the web page or quit the old desktop app and open the new build.

## CSI 文件 · CSI files

ZIP 包含 `csi.npz` 和 `manifest.json`。复数 `h_freq` 的轴顺序为 `[时间, UE, Rx 端口, AP, Tx 端口, 子载波]`。静态计算的时间维为 1，轨迹计算的 UE 维为 1。清单记录设备 ID、实际采样时间和位置、基带频率轴、时延参考及求解设置。逐 AP 前传容量以 Mb/s 记录在 `fronthaulMbpsByTxId`，`null` 表示未设置。调整前传容量后可复用同一份 CSI。

The ZIP contains `csi.npz` and `manifest.json`. Complex `h_freq` uses the axis order `[time, UE, Rx port, AP, Tx port, subcarrier]`. Static runs have one time sample, and trajectory runs have one UE. The manifest records device IDs, actual sample times and positions, the baseband frequency axis, delay reference, and solver settings. AP fronthaul capacities are exported in Mb/s under `fronthaulMbpsByTxId`, with `null` for an unspecified capacity. The same CSI can be exported with revised fronthaul metadata.

默认将每条链路的时延以该链路首径为参考。需要保留 AP 间传播时延差时，可在「场景」中选择绝对时延后计算。

By default, each link uses its own first arrival as the delay reference. To preserve relative propagation delays across APs, select absolute delays in Scene before running CSI.

```python
from io import BytesIO
from zipfile import ZipFile

import numpy as np

with ZipFile("your-csi-run.zip") as archive:
    with np.load(BytesIO(archive.read("csi.npz"))) as data:
        H = data["h_freq"]
        time_seconds = data["time_seconds"]
        frequencies_hz = data["frequencies"]
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

## 来源与许可 · Credits and license

本项目基于 Pulok Tarafder 的 SionnaRTStudio，并使用 NVIDIA Sionna RT。代码采用 Apache-2.0 许可。地图数据 © OpenStreetMap contributors，适用 ODbL。

This project builds on Pulok Tarafder’s SionnaRTStudio and uses NVIDIA Sionna RT. The code is licensed under Apache-2.0. Map data © OpenStreetMap contributors, available under the ODbL.

- [Upstream SionnaRTStudio](https://github.com/puloktarafder/SionnaRTStudio) · [Upstream citation](CITATION.cff)
- [NVIDIA Sionna RT](https://github.com/NVlabs/sionna-rt)
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)
- [License](LICENSE) · [Notices](NOTICE)
