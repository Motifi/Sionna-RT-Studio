# Sionna RT Studio

使用 NVIDIA Sionna RT 做交互式无线传播仿真。可以导入 OpenStreetMap 建筑，在三维场景中放置多个 AP 和 UE，计算全链路矩阵、覆盖图和移动轨迹上的传播路径。界面支持中文和英文，并提供 Apple Silicon macOS 桌面版。

An interactive wireless propagation studio built on NVIDIA Sionna RT. Import OpenStreetMap buildings, place multiple APs and UEs in 3D, and trace all device pairs, coverage maps, or a receiver trajectory. The interface supports Chinese and English, including a desktop app for Apple Silicon Macs.

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

## 快速上手 · First run

1. 在**三维场景**中从默认的一台 AP 和一台 UE 开始。点击 **+ 新增 AP** 后在场景中点一次，再按 **Esc** 或点 **完成**。
2. 点击 **+ 新增 UE**，在场景中点击两个不同位置，再结束布点。此时应有 2 台 AP 和 3 台 UE。可在**场景设备**中选中终端，再点击 **移动所选 UE** 调整位置。
3. 点击 **计算所有链路**。在 **AP × UE 链路矩阵**中查看 6 条链路的接收功率。点击矩阵中的单元格可查看这对设备的射线路径。

1. Start in **3D scene** with the default AP and UE. Select **+ Add AP**, click once in the scene, and press **Esc** or **Done**.
2. Select **+ Add UE**, click two distinct locations, and finish placement. You should have 2 APs and 3 UEs. Select a receiver under **Scene devices** and use **Move selected UE** to adjust its position.
3. Select **Solve all links**. The **AP × UE Link Matrix** shows received power for six pairs. Select a cell to inspect its propagation paths.

**移动轨迹**模式使用当前选中的单台 UE。仿真会追踪所有 AP 到该 UE 沿途各采样位置的链路，可查看传播和服务 AP 的变化。在线底图和建筑导入需要网络，默认场景可直接计算。

**Trajectory** mode follows the currently selected UE and traces every AP to its sampled positions. Use it to inspect propagation and serving-AP changes along the path. Map tiles and building imports need a network connection. You can run solves directly in the built-in scene.

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
