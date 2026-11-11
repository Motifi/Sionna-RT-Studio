"""Platform-specific native runtime discovery.

Shell launchers normally configure this first. This module also covers direct
``python -m uvicorn backend.main:app`` launches on macOS and Windows.
"""
from __future__ import annotations

import os
from pathlib import Path
import platform
import shutil
import subprocess


def _keep_windows_llvm_loaded(library: Path) -> None:
    import ctypes
    from ctypes import wintypes

    # Some LLVM builds crash at process exit if Dr.Jit unloads the DLL first.
    # Keep this particular DLL loaded until Windows tears down the process.
    ctypes.WinDLL(str(library))
    get_module_handle = ctypes.WinDLL("kernel32", use_last_error=True).GetModuleHandleExW
    get_module_handle.argtypes = (wintypes.DWORD, wintypes.LPCWSTR, ctypes.POINTER(wintypes.HMODULE))
    get_module_handle.restype = wintypes.BOOL
    handle = wintypes.HMODULE()
    pin_module = 0x00000001  # GET_MODULE_HANDLE_EX_FLAG_PIN
    if not get_module_handle(pin_module, str(library), ctypes.byref(handle)):
        raise ctypes.WinError(ctypes.get_last_error())


def configure_drjit_llvm_path() -> str | None:
    """Prepare the LLVM library used by Dr.Jit on macOS and Windows."""
    configured = os.environ.get("DRJIT_LIBLLVM_PATH")
    system = platform.system()
    if system == "Windows":
        if not configured:
            program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
            standard_dll = program_files / "LLVM" / "bin" / "LLVM-C.dll"
            configured = str(standard_dll) if standard_dll.is_file() else shutil.which("LLVM-C.dll")
        if configured and Path(configured).is_file():
            library = Path(configured).resolve()
            os.environ["DRJIT_LIBLLVM_PATH"] = configured = str(library)
            try:
                _keep_windows_llvm_loaded(library)
            except OSError as exc:
                # An unusable optional LLVM installation must not block CUDA.
                print(f"[startup] Could not keep {library.name} loaded: {exc}")
        return configured
    if configured or system != "Darwin":
        return configured

    prefixes: list[Path] = []
    brew = shutil.which("brew")
    if brew:
        result = subprocess.run(
            [brew, "--prefix", "llvm"],
            capture_output=True,
            check=False,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            prefixes.append(Path(result.stdout.strip()))

    # Also work when Homebrew is installed but not present on a GUI app's PATH.
    prefixes.extend((Path("/opt/homebrew/opt/llvm"), Path("/usr/local/opt/llvm")))
    for prefix in prefixes:
        library = prefix / "lib" / "libLLVM.dylib"
        if library.is_file():
            os.environ["DRJIT_LIBLLVM_PATH"] = str(library)
            return str(library)
    return None


def trace_paths_for_runtime(scene, **options):
    """Trace paths with a compatible execution mode for Windows CPU solves."""
    from sionna.rt import PathSolver

    solver = PathSolver()
    if platform.system() != "Windows":
        return solver(scene, **options)

    import mitsuba as mi

    if not mi.variant().startswith("llvm_"):
        return solver(scene, **options)

    import drjit as dr

    # Dr.Jit 1.5 uses LLVM RuntimeDyld on Windows. Its linker can fail to
    # resolve constant-pool symbols in kernels containing symbolic callables.
    # Evaluated loops and calls trace the same paths in smaller kernels.
    solver.loop_mode = "evaluated"
    with (
        dr.scoped_set_flag(dr.JitFlag.SymbolicLoops, False),
        dr.scoped_set_flag(dr.JitFlag.SymbolicConditionals, False),
        dr.scoped_set_flag(dr.JitFlag.SymbolicCalls, False),
    ):
        return solver(scene, **options)
