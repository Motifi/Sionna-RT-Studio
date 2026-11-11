"""Runtime identity recorded with diagnostics and reproducible runs."""
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
import platform
import subprocess


BACKENDS = {
    "metal_ad_mono_polarized": "Apple GPU · Metal",
    "cuda_ad_mono_polarized": "NVIDIA GPU · CUDA / OptiX",
    "llvm_ad_mono_polarized": "CPU · LLVM",
}


def package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


@lru_cache(maxsize=3)
def _device_model(variant: str) -> str | None:
    if variant.startswith("cuda"):
        import mitsuba as mi

        # Use the CUDA ordinal selected by Dr.Jit, including CUDA_VISIBLE_DEVICES.
        # Driver API queries report the name for that ordinal.
        import ctypes as c

        try:
            cuda = c.WinDLL("nvcuda.dll") if platform.system() == "Windows" else c.CDLL("libcuda.so.1")
            _, ordinal = mi.Float(0).__dlpack_device__()
            device = c.c_int()
            name = c.create_string_buffer(256)
            if cuda.cuDeviceGet(c.byref(device), ordinal) == 0 and cuda.cuDeviceGetName(name, len(name), device) == 0:
                return name.value.decode(errors="replace")
        except (AttributeError, OSError, RuntimeError, TypeError):
            return None
    elif platform.system() == "Darwin":
        try:
            return subprocess.check_output(
                ["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"], text=True, timeout=2,
            ).strip() or None
        except (OSError, subprocess.SubprocessError):
            return None
    elif variant.startswith("llvm"):
        return platform.processor() or None
    return None


def solver_runtime() -> dict:
    import mitsuba as mi

    variant = mi.variant()
    return {
        "engine": "Sionna RT", "variant": variant,
        "backend": BACKENDS.get(variant),
        "deviceModel": _device_model(variant) if variant else None,
        "pythonVersion": platform.python_version(),
        "sionnaRtVersion": package_version("sionna-rt"),
        "mitsubaVersion": package_version("mitsuba"),
        "drjitVersion": package_version("drjit"),
    }
