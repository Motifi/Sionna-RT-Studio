"""Transient CSI runs shared by the Preview and Export workspaces."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory
import time
from typing import Literal
from uuid import uuid4
import zipfile

import numpy as np
from pydantic import BaseModel, Field, FiniteFloat, model_validator

from .models import (
    BuildingFootprint, ChannelMetrics, ENUVector, HandoverConfig, MaterialConfig,
    PropagationPath, Receiver, SolverOptions, Transmitter,
)
from .scene_build import build_scene
from .solver import (
    MAX_PATHS, _channel_metrics, _device_z, _handover_analysis, _mobility_kinematics,
    _mobility_step, _resolve_tx_specs, _set_rx_array, _set_tx_array,
    _summarize_batched, _trace_batched, _uniform_array_size, to_numpy,
)


_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
_MAX_CIR_BYTES = 512 * 1024 * 1024
_CFR_CHUNK_BYTES = 64 * 1024 * 1024
_CIR_CURVE_CHUNK_BYTES = 16 * 1024 * 1024
_MAX_LINK_SNAPSHOTS = 4096
_MAX_CURVE_POINTS = 256
_COMPLEX_BYTES = np.dtype(np.complex64).itemsize


class CsiRunRequest(BaseModel):
    mode: Literal["static", "trajectory"]
    output: Literal["cir_cfr", "cir"] = "cir_cfr"
    txs: list[Transmitter] = Field(min_length=1, max_length=64)
    rxs: list[Receiver] = Field(min_length=1, max_length=64)
    buildings: list[BuildingFootprint]
    freqGhz: FiniteFloat = Field(gt=0)
    systemBandwidthMhz: FiniteFloat = Field(default=100, gt=0)
    noiseFigureDb: FiniteFloat = Field(default=7, ge=0)
    maxDepth: int = Field(default=3, ge=0, le=10)
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: list[MaterialConfig] = Field(default_factory=list)
    numSubcarriers: int = Field(default=1024, ge=1, le=4096)
    subcarrierSpacing: FiniteFloat = Field(default=30_000, ge=1, le=1_000_000)
    normalizeDelays: bool = True
    waypoints: list[ENUVector] = Field(default_factory=list, max_length=100)
    timeSeconds: list[FiniteFloat] = Field(default_factory=list, max_length=100)
    speedKmh: FiniteFloat = Field(default=30, ge=0)
    combineMode: Literal["best_server", "sum"] = "best_server"
    handover: HandoverConfig = Field(default_factory=HandoverConfig)

    @model_validator(mode="after")
    def validate_scope(self):
        for devices in (self.txs, self.rxs):
            ids = [device.id for device in devices]
            if any(not ident.strip() for ident in ids) or len(set(ids)) != len(ids):
                raise ValueError("Device IDs must be nonempty and unique within each side")
        if self.mode == "trajectory":
            if len(self.rxs) != 1 or len(self.waypoints) < 2:
                raise ValueError("Trajectory CSI requires one Rx and at least two samples")
            if (len(self.timeSeconds) != len(self.waypoints) or self.timeSeconds[0] != 0
                    or any(b <= a for a, b in zip(self.timeSeconds, self.timeSeconds[1:]))):
                raise ValueError("Trajectory sample times must start at 0 and increase strictly")
        elif self.waypoints or self.timeSeconds:
            raise ValueError("Static CSI does not take trajectory samples")
        samples = len(self.waypoints) if self.mode == "trajectory" else len(self.rxs)
        if samples * len(self.txs) > _MAX_LINK_SNAPSHOTS:
            raise ValueError(f"CSI runs support at most {_MAX_LINK_SNAPSHOTS} link snapshots")
        points = [device.enu for device in (*self.txs, *self.rxs)] + self.waypoints
        if any(not math.isfinite(value) for point in points for value in (point.x, point.y, point.z)):
            raise ValueError("Device and waypoint coordinates must be finite")
        if any(not math.isfinite(device.height) for device in (*self.txs, *self.rxs)):
            raise ValueError("Antenna heights must be finite")
        if any(not math.isfinite(value) for tx in self.txs for value in
               (tx.powerDbm, tx.beamsteeringAzimuth, tx.beamsteeringElevation)):
            raise ValueError("Transmitter power and orientation must be finite")
        return self


class CsiExportRequest(BaseModel):
    fronthaulMbpsByTxId: dict[str, FiniteFloat | None] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_capacities(self):
        if any(value is not None and value < 0 for value in self.fronthaulMbpsByTxId.values()):
            raise ValueError("Fronthaul capacity must be nonnegative or null")
        return self


@dataclass
class _Link:
    paths: list[PropagationPath]
    metrics: ChannelMetrics


@dataclass
class CsiRun:
    directory: TemporaryDirectory
    summary: dict
    manifest: dict
    links: list[list[_Link]]
    curve_frequencies: np.ndarray
    curves_db: np.ndarray

    def preview(self, sample_index: int, tx_id: str, rx_id: str) -> dict:
        times = self.summary["timeSeconds"]
        if not 0 <= sample_index < len(times):
            raise ValueError("Sample index is outside the CSI run")
        if tx_id not in self.summary["txIds"] or rx_id not in self.summary["rxIds"]:
            raise ValueError("The selected AP or UE is not in the CSI run")
        tx_index = self.summary["txIds"].index(tx_id)
        rx_index = self.summary["rxIds"].index(rx_id)
        # PathSolver uses its receiver axis for waypoints in a trajectory run.
        link = self.links[sample_index * len(self.summary["rxIds"]) + rx_index][tx_index]
        curve = self.curves_db[sample_index, rx_index, tx_index]
        return {
            "paths": link.paths,
            "metrics": link.metrics,
            "frequenciesHz": self.curve_frequencies.tolist(),
            "magnitudeDb": [float(value) if np.isfinite(value) else None for value in curve],
        }

    def write_export(self, destination: Path, fronthaul: dict[str, float | None]) -> None:
        tx_ids = self.summary["txIds"]
        if set(fronthaul).difference(tx_ids):
            raise ValueError("Fronthaul includes an AP outside this CSI run")
        manifest = {
            **self.manifest,
            "fronthaulMbpsByTxId": {ident: fronthaul.get(ident) for ident in tx_ids},
        }
        # The NPZ was generated during Preview. Copy its exact bytes without
        # tracing or recompressing it, even when the fronthaul metadata changes.
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.write(Path(self.directory.name) / "csi.npz", "csi.npz")
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))


def _run_axes(native: np.ndarray, moving: bool, *, axis: int) -> np.ndarray:
    """Put the run time axis first and retain a singleton UE axis for movement."""
    snapshots = np.moveaxis(native, axis, 0)
    if snapshots.shape[0] != 1:
        raise RuntimeError("Expected one native time sample per traced position")
    return snapshots[0, :, None, ...] if moving else snapshots


def _geometric_axes(native: np.ndarray, moving: bool) -> np.ndarray:
    return native[:, None, ...] if moving else native[None, ...]


def _cir_curves(a: np.ndarray, tau: np.ndarray, valid: np.ndarray,
                frequencies: np.ndarray) -> np.ndarray:
    """Reconstruct sampled CFR power using the shared delays of synthetic arrays."""
    curves = np.full(tau.shape[:-1] + (frequencies.size,), -np.inf, dtype=np.float32)
    phase_scale = np.complex64(-2j * math.pi) * frequencies.astype(np.float32, copy=False)
    for sample, ue, ap in np.ndindex(tau.shape[:-1]):
        mask = valid[sample, ue, ap]
        delays = tau[sample, ue, ap, mask]
        if not delays.size:
            continue
        link = a[sample, ue, :, ap]
        rx_ports, tx_ports = link.shape[:2]
        power = np.zeros(frequencies.size, dtype=np.float32)
        # Limit the coefficient copy for masked or strided arrays, then budget
        # the Fourier matrix and response together for each frequency block.
        rx_block = max(1, _CIR_CURVE_CHUNK_BYTES // (2 * _COMPLEX_BYTES * tx_ports * delays.size))
        for rx_start in range(0, rx_ports, rx_block):
            coeffs = link[rx_start:rx_start + rx_block, :, mask].reshape(-1, delays.size)
            freq_block = max(1, _CIR_CURVE_CHUNK_BYTES // (2 * _COMPLEX_BYTES * (coeffs.shape[0] + delays.size)))
            for start in range(0, frequencies.size, freq_block):
                stop = min(start + freq_block, frequencies.size)
                phase = np.exp(delays[:, None] * phase_scale[start:stop])
                response = coeffs @ phase
                power[start:stop] += np.sum(np.abs(response) ** 2, axis=0)
        with np.errstate(divide="ignore"):
            curves[sample, ue, ap] = 10.0 * np.log10(power / (rx_ports * tx_ports))
    return curves


def _write_csi(directory: Path, paths, frequencies: np.ndarray, moving: bool, normalize: bool,
               shape: tuple[int, ...], metadata: dict[str, np.ndarray], *,
               output_mode: Literal["cir_cfr", "cir"] = "cir_cfr") -> tuple[np.ndarray, np.ndarray, int, int]:
    time_count, rx_count, rx_ports, tx_count, tx_ports, frequency_count = shape
    ports = time_count * rx_count * rx_ports * tx_count * tx_ports
    path_count = int(paths.valid.shape[-1])
    # Per path: a complex64 coefficient per port pair, plus one float32
    # delay and one boolean validity flag per link snapshot.
    cir_bytes = path_count * (ports * _COMPLEX_BYTES + time_count * rx_count * tx_count * 5)
    output_limit = _MAX_CIR_BYTES if output_mode == "cir" else _MAX_OUTPUT_BYTES
    if cir_bytes > output_limit:
        hint = "Choose CIR only or reduce antennas, trajectory samples, or ray interactions" if output_mode == "cir_cfr" else (
            "Reduce antennas, trajectory samples, or ray interactions"
        )
        raise ValueError(f"Uncompressed CIR alone requires {cir_bytes / 2**20:.1f} MiB, "
                         f"above the {output_limit / 2**20:g} MiB limit. {hint}")
    output_bytes = cir_bytes + (ports * frequency_count * _COMPLEX_BYTES if output_mode == "cir_cfr" else 0)
    if output_bytes > output_limit:
        raise ValueError(f"Uncompressed CIR + CFR requires {output_bytes / 2**20:.1f} MiB, above the 256 MiB limit. "
                         "Choose CIR only or reduce subcarriers, antennas, or samples")

    a, tau = paths.cir(normalize_delays=normalize, out_type="numpy")
    a = _run_axes(np.asarray(a), moving, axis=-1)
    tau = _geometric_axes(np.asarray(tau), moving)
    valid = _geometric_axes(to_numpy(paths.valid).astype(bool, copy=False), moving)
    curve_indices = np.linspace(0, frequency_count - 1, min(_MAX_CURVE_POINTS, frequency_count), dtype=int)
    curve_frequencies = frequencies[curve_indices]
    arrays = dict(a=a, tau_geometric=tau, valid_paths=valid, frequencies=frequencies, **metadata)
    if output_mode == "cir":
        curves_db = _cir_curves(a, tau, valid, curve_frequencies)
        np.savez_compressed(directory / "csi.npz", **arrays)
        return curve_frequencies, curves_db, path_count, output_bytes

    # CFR calculation broadcasts over paths as well as frequency, so size the
    # frequency chunks by the intermediate tensor, not just the final output.
    per_frequency_bytes = ports * max(1, path_count) * 32
    if per_frequency_bytes > _MAX_OUTPUT_BYTES:
        raise ValueError("The ray set is too large for dense CFR computation. "
                         "Choose CIR only or reduce antennas, samples, or interaction depth")
    chunk_size = max(1, _CFR_CHUNK_BYTES // per_frequency_bytes)
    output = np.lib.format.open_memmap(directory / "cfr.npy", mode="w+", dtype=np.complex64, shape=shape)
    curves_db = np.full((time_count, rx_count, tx_count, len(curve_indices)), -np.inf, dtype=np.float32)
    try:
        for start in range(0, frequency_count, chunk_size):
            stop = min(start + chunk_size, frequency_count)
            native = paths.cfr(frequencies=frequencies[start:stop], normalize_delays=normalize,
                               out_type="numpy")
            cfr = _run_axes(np.asarray(native), moving, axis=-2)
            output[..., start:stop] = cfr
            left, right = np.searchsorted(curve_indices, (start, stop))
            if left < right:
                power = np.mean(np.abs(cfr[..., curve_indices[left:right] - start]) ** 2, axis=(2, 4))
                with np.errstate(divide="ignore"):
                    curves_db[..., left:right] = 10.0 * np.log10(power)
        np.savez_compressed(directory / "csi.npz", h_freq=output, **arrays)
    finally:
        del output
        (directory / "cfr.npy").unlink(missing_ok=True)
    return curve_frequencies, curves_db, path_count, output_bytes


def solve_csi_run(req: CsiRunRequest) -> CsiRun:
    """Use one PathSolver result to build all inspection and export data."""
    from sionna.rt import subcarrier_frequencies

    started = time.perf_counter()
    tx_size = _uniform_array_size(req.txs, "Transmitter")
    rx_size = _uniform_array_size(req.rxs, "Receiver")
    moving = req.mode == "trajectory"
    times = list(req.timeSeconds) if moving else [0.0]
    scene = build_scene(req.buildings, req.freqGhz, req.materials)
    n_tx_ant = _set_tx_array(scene, tx_size, req.options)
    n_rx_ant = _set_rx_array(scene, rx_size, req.options)
    shape = (len(times), len(req.rxs), n_rx_ant, len(req.txs), n_tx_ant, req.numSubcarriers)
    cfr_bytes = math.prod(shape) * _COMPLEX_BYTES
    if req.output == "cir_cfr" and cfr_bytes > _MAX_OUTPUT_BYTES:
        raise ValueError(f"Uncompressed CFR alone requires {cfr_bytes / 2**20:.1f} MiB, above the 256 MiB limit. "
                         "Choose CIR only or reduce subcarriers, antennas, or samples")
    tx_specs = _resolve_tx_specs(req.txs, req.buildings)
    speed_ms = req.speedKmh / 3.6
    if moving:
        rx_positions, velocities = _mobility_kinematics(req.waypoints, req.rxs[0].height, req.buildings, speed_ms)
    else:
        rx_positions = [[rx.enu.x, rx.enu.y, _device_z(rx.enu, rx.height, req.buildings)] for rx in req.rxs]
        velocities = [[0.0, 0.0, 0.0] for _ in rx_positions]
    positions = _geometric_axes(np.asarray(rx_positions, dtype=float), moving)
    frequencies = np.asarray(to_numpy(subcarrier_frequencies(req.numSubcarriers, req.subcarrierSpacing)))
    paths = _trace_batched(scene, tx_specs, rx_positions, velocities, req.maxDepth, req.options)

    directory = TemporaryDirectory(prefix="srts_csi_")
    try:
        run_id = uuid4().hex
        tx_ids = [tx.id for tx in req.txs]
        rx_ids = [rx.id for rx in req.rxs]
        tx_positions = [spec.pos for spec in tx_specs]
        curve_frequencies, curves_db, path_count, output_bytes = _write_csi(
            Path(directory.name), paths, frequencies, moving, req.normalizeDelays, shape, {
                "tx_ids": np.asarray(tx_ids), "rx_ids": np.asarray(rx_ids),
                "tx_positions": np.asarray(tx_positions), "rx_positions": positions,
                "time_seconds": np.asarray(times), "carrier_frequency": np.asarray(req.freqGhz * 1e9),
                "subcarrier_spacing": np.asarray(req.subcarrierSpacing),
                "normalize_delays": np.asarray(req.normalizeDelays),
            }, output_mode=req.output,
        )
        traced_links = _summarize_batched(paths, tx_specs, rx_positions, n_tx_ant)
        links = [[_Link(rays[:MAX_PATHS], _channel_metrics(rays)) for rays, _ in row] for row in traced_links]
        summary = {
            "runId": run_id, "mode": req.mode, "output": req.output, "txIds": tx_ids, "rxIds": rx_ids,
            "txNames": [tx.name for tx in req.txs], "rxNames": [rx.name for rx in req.rxs],
            "timeSeconds": times, "rxPositions": positions.tolist(), "txPositions": tx_positions,
            "frequenciesHz": frequencies.tolist(), "shape": list(shape),
            "pathCount": path_count, "uncompressedBytes": output_bytes,
            "carrierFrequencyGhz": req.freqGhz, "systemBandwidthMhz": req.systemBandwidthMhz,
            "noiseFigureDb": req.noiseFigureDb, "numSubcarriers": req.numSubcarriers,
            "subcarrierSpacing": req.subcarrierSpacing, "normalizeDelays": req.normalizeDelays,
            "links": [{"rxId": rx_id, "txId": tx_id, "metrics": links[r][t].metrics}
                      for r, rx_id in enumerate(rx_ids) for t, tx_id in enumerate(tx_ids)],
        }
        if moving:
            steps = [_mobility_step(i, pos, tx_specs, row, req.combineMode)
                     for i, (pos, row) in enumerate(zip(rx_positions, traced_links))]
            summary["handover"] = _handover_analysis(req, steps, tx_specs, rx_positions, speed_ms,
                                                     time_seconds=times)
            summary["steps"] = [step.model_copy(update={"paths": []}) for step in steps]
            summary["execution"] = {
                "strategy": "single_batched_dispatch", "batchedResultUsed": True,
                "transmitterCount": len(tx_ids), "waypointCount": len(times),
                "pairCount": len(tx_ids) * len(times), "successfulPathSolverDispatches": 1,
                "samplesPerSource": req.options.pathSamplesPerSource, "seed": req.options.pathSeed,
                "solveTimeMs": (time.perf_counter() - started) * 1000.0,
            }
        manifest = {key: value for key, value in summary.items()
                    if key not in {"links", "handover", "steps", "execution"}}
        manifest.update({
            "schemaVersion": 1,
            "createdAtUtc": datetime.now(timezone.utc).isoformat(),
            "frequencyReference": "baseband_offset_hz",
            "delayReference": "first_arrival_per_link" if req.normalizeDelays else "absolute_propagation",
            "snapshotSemantics": "independent_geometric_samples" if moving else "static",
            "axes": {
                "h_freq": ["time", "ue", "rx_port", "ap", "tx_port", "subcarrier"],
                "a": ["time", "ue", "rx_port", "ap", "tx_port", "path"],
                "tau_geometric": ["time", "ue", "ap", "path"],
                "valid_paths": ["time", "ue", "ap", "path"],
            },
            "delayUnit": "s", "positionFrame": "ENU_m",
            "channelReference": "unprecoded_per_port_baseband",
            "buildingCount": len(req.buildings),
            "settings": req.model_dump(mode="json", exclude={"buildings"}),
        })
        if req.output == "cir":
            manifest["axes"].pop("h_freq")
        return CsiRun(directory, summary, manifest, links, curve_frequencies, curves_db)
    except Exception:
        directory.cleanup()
        raise
