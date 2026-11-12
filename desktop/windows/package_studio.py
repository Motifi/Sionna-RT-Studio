r"""Create a relocatable Windows x64 payload from a Studio source installation.

Run using the installed runtime's .venv\Scripts\python.exe.
"""
import argparse
import json
from pathlib import Path
import shutil
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installed", type=Path)
    parser.add_argument("portable", type=Path)
    args = parser.parse_args()
    home = Path(sys.base_prefix)
    venv = args.installed / "runtime" / ".venv"
    if sys.platform != "win32" or sys.version_info[:2] != (3, 12) or Path(sys.prefix).resolve() != venv.resolve():
        parser.error("Run with the installed Studio runtime's Python 3.12 executable.")
    info = json.loads((args.installed / "build-info.json").read_text(encoding="utf-8"))
    shutil.copytree(args.installed, args.portable, ignore=shutil.ignore_patterns(".venv", "__pycache__"))
    python = args.portable / "runtime" / "python"
    python.mkdir()
    for name in ("python.exe", "python3.dll", "python312.dll", "LICENSE.txt"):
        shutil.copy2(home / name, python)
    for library in home.glob("vcruntime*.dll"):
        shutil.copy2(library, python)
    shutil.copytree(home / "DLLs", python / "DLLs")
    shutil.copytree(home / "Lib", python / "Lib", ignore=shutil.ignore_patterns("site-packages", "__pycache__"))
    shutil.copytree(venv / "Lib" / "site-packages", python / "Lib" / "site-packages",
                    ignore=shutil.ignore_patterns("__pycache__"))
    info["kind"] = "windows-x64-portable"
    (args.portable / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    (args.portable / "README.txt").write_text(
        "Sionna RT Studio candidate build for Windows 11 x64.\n"
        "Extract the entire ZIP, then open SionnaRTStudio.exe.\n"
        "Requires Microsoft Edge WebView2 Runtime and either an NVIDIA driver "
        "with CUDA/OptiX support or an x64 LLVM runtime for CPU tracing.\n"
        "For LLVM outside the standard install folder, set DRJIT_LIBLLVM_PATH to the full path of LLVM-C.dll.\n"
        "See build-info.json for the source revision and runtime versions.\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
