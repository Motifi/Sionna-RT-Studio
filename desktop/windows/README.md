# Windows 桌面版 · Windows desktop app

面向 Windows 11 x64。Studio 以独立窗口运行，通过 WebView2 显示界面，并随窗口启动和停止本地 Sionna RT 求解进程。Windows 与 macOS 使用相同的项目 JSON 和 CSI/CIR 文件格式。

The Windows 11 x64 app opens in its own WebView2 window and manages its local Sionna RT process. It uses the same project JSON and CSI/CIR formats as the macOS app.

## 安装 · Install

在 **Windows PowerShell** 中运行。构建需要 x64 的 Python 3.12、Node.js 22.12 或更新版本、.NET 8 SDK，以及 Microsoft Edge WebView2 Runtime。安装脚本会检查依赖，并在缺少时给出安装命令。建议先确认 `nvidia-smi` 能看到显卡及驱动。CUDA/OptiX 所需的驱动版本以 [Mitsuba 要求](https://github.com/mitsuba-renderer/mitsuba3#requirements)为准。

Use **Windows PowerShell** with x64 Python 3.12, Node.js 22.12 or newer, the .NET 8 SDK, and the Microsoft Edge WebView2 Runtime. The installer prints commands for missing prerequisites. Check `nvidia-smi` for the GPU and driver. See [Mitsuba's requirements](https://github.com/mitsuba-renderer/mitsuba3#requirements) for the CUDA/OptiX driver requirement.

```powershell
git clone https://github.com/Motifi/Sionna-RT-Studio.git
Set-Location .\Sionna-RT-Studio
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop\windows\Install-Studio.ps1
```

安装后在开始菜单打开 **Sionna RT Studio**，或执行下面的命令。更新时先关闭 Studio，再在同一个仓库更新代码并重跑安装脚本。

Open **Sionna RT Studio** from Start or run the command below. To update, close Studio, update the same checkout, and rerun the installer.

```powershell
Start-Process "$env:LOCALAPPDATA\SionnaRTStudio\app\SionnaRTStudio.exe"
```

## CUDA、CSI 和 CIR 验收 · CUDA, CSI, and CIR acceptance

在台式机登录 Windows 后，从仓库目录运行。Codex 可以执行同一条命令并读取生成的报告。

Run from the checkout while signed into the Windows desktop. Codex can run the same command and read the generated report.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop\windows\Test-Studio.ps1
```

脚本启动一个独立的验收窗口和求解进程，检查 WebView2 的工作区切换、项目自动保存和 WebGL2 画布。然后用该进程计算 2 AP × 3 UE 静态全链路与单 UE 多时刻轨迹，分别导出 CIR + CFR 和仅 CIR。它会用 NumPy 读取两份 ZIP，检查张量轴、有效路径、时刻和位置，并检查关闭窗口后的求解进程。终端会打印报告目录，里面有 `report.json`、求解日志和两份 ZIP。CUDA 验收通过时 `ok` 和 `cudaPassed` 都为 `true`。仅需 CPU 兼容性检查时，可以传 `-AllowCpu`。

The script checks workspace navigation, project autosave, and the WebGL2 canvas in WebView2, then uses that desktop session's backend to solve 2 AP × 3 UE static links and a single-UE trajectory. It exports CIR + CFR and CIR-only ZIPs and checks their array axes, valid paths, times, and positions with NumPy. It also checks that closing the acceptance window stops its solver. The terminal prints the folder containing `report.json`, the solver log, and both ZIPs. A successful CUDA acceptance has both `ok` and `cudaPassed` set to `true`. Pass `-AllowCpu` for a CPU compatibility check.

### 原生文件对话框 · Native file dialogs

1. 正常打开 Studio，切换中英文。用顶部「项目」菜单导入已有的 Studio 项目 JSON，检查 AP、UE、方向角和轨迹。
2. 在「仿真」的 CSI 中选择「CIR + 完整 CFR」并计算静态全链路，到「导出」保存 CSI ZIP。确认出现 Windows 保存对话框，文件能保存到你选择的位置。
3. 在「仿真」的 CSI 中选择「UE 轨迹」和「仅 CIR」，运行带轨迹的 UE，再用「导出」保存第二份 ZIP。关闭并重新打开 Studio，检查项目和语言偏好是否恢复。

1. Open Studio normally and switch languages. Import an existing Studio project JSON from the Project menu and check the APs, UEs, orientations, and route.
2. In Simulation, choose CIR + full CFR in the CSI task and solve all static links. Save the CSI ZIP from Export and confirm that the Windows save dialog writes it to the chosen location.
3. In Simulation, select UE trajectory and CIR only, then solve for a UE with a route. Save the second ZIP from Export. Close and reopen Studio and check that the project and language are restored.

如果启动或求解失败，把验收输出目录中的 `report.json`、`studio.log` 和 `nvidia-smi` 输出交给 Codex。正常启动的求解日志保存在 `%LOCALAPPDATA%\SionnaRTStudio\logs\studio.log`。CPU 回退需要 x64 LLVM 运行库。可将 `DRJIT_LIBLLVM_PATH` 指向 `LLVM-C.dll` 的完整路径。

For startup or solve failures, give Codex `report.json`, `studio.log`, and the output of `nvidia-smi`. The normal app writes its solver log to `%LOCALAPPDATA%\SionnaRTStudio\logs\studio.log`. CPU fallback requires the x64 LLVM runtime. Set `DRJIT_LIBLLVM_PATH` to the full path of `LLVM-C.dll` if needed.

## 便携候选包 · Portable candidates

候选 ZIP 解压后直接运行 `SionnaRTStudio.exe`。它自带 Python 和 .NET，不需要克隆仓库或安装开发工具。仍需 WebView2，以及支持 CUDA/OptiX 的 NVIDIA 驱动或用于 CPU 求解的 x64 LLVM。完整解压后可以移动整个文件夹。用同一候选提交的验收脚本传入 `-InstallDirectory` 指向解压目录，报告会记录包内 `build-info.json` 和实际使用的求解后端。

Extract the candidate ZIP and open `SionnaRTStudio.exe`. The package includes
Python and .NET. It requires WebView2 and either an NVIDIA CUDA/OptiX driver
or x64 LLVM. Move the whole extracted folder together. Run the verifier from
the matching checkout with `-InstallDirectory` pointing to the extracted
directory. The report captures `build-info.json` and the actual solver backend.
