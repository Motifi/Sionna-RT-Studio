"""Apply configured excess foliage loss to synthetic-array Sionna RT paths.

This module is also included in standalone scene exports. It uses public Paths
geometry and CIR and needs only NumPy. A crown is an axis-aligned ENU ellipsoid
with a constant attenuation rate in dB/m. Overlap is counted once at the
strongest rate present. Each successive leg of a ray traverses its own distance.
"""
from __future__ import annotations

import heapq

import numpy as np


_SEGMENT_CROWN_PAIRS = 32_768
_CFR_WORK_BYTES = 32 * 1024**2


def _interval_loss(start: np.ndarray, stop: np.ndarray, rates: np.ndarray) -> float:
    """Integrate the maximum active attenuation rate over the unit interval."""
    order = np.argsort(start)
    points = np.unique(np.concatenate((start, stop)))
    active: list[tuple[float, float]] = []
    loss = 0.0
    cursor = 0
    for left, right in zip(points, points[1:]):
        while cursor < order.size and start[order[cursor]] <= left:
            index = order[cursor]
            heapq.heappush(active, (-rates[index], stop[index]))
            cursor += 1
        while active and active[0][1] <= left:
            heapq.heappop(active)
        if active:
            loss += (right - left) * -active[0][0]
    return loss


def _segment_losses(start: np.ndarray, stop: np.ndarray, centers: np.ndarray,
                    radii: np.ndarray, rates: np.ndarray) -> np.ndarray:
    """Return the one-way excess loss in dB for each ray leg."""
    delta = stop - start
    lengths = np.linalg.norm(delta, axis=1)
    # First cull crowns by their ENU bounding box.
    low = np.minimum(start, stop)[:, None, :]
    high = np.maximum(start, stop)[:, None, :]
    possible = np.all((low <= centers + radii) & (high >= centers - radii), axis=2)
    possible &= lengths[:, None] > 0
    legs, crowns = np.nonzero(possible)
    if not legs.size:
        return np.zeros(len(start))

    # Transform to unit spheres and find the entry and exit along each segment.
    origin = (start[legs] - centers[crowns]) / radii[crowns]
    direction = delta[legs] / radii[crowns]
    norm = np.linalg.norm(direction, axis=1)
    unit = direction / norm[:, None]
    projection = np.einsum("ij,ij->i", origin, unit)
    nearest = origin - projection[:, None] * unit
    chord = np.sqrt(np.maximum(0.0, 1.0 - np.einsum("ij,ij->i", nearest, nearest)))
    enter = np.maximum(0.0, (-projection - chord) / norm)
    leave = np.minimum(1.0, (-projection + chord) / norm)
    hit = leave > enter
    legs, crowns, enter, leave = legs[hit], crowns[hit], enter[hit], leave[hit]
    loss = np.bincount(legs, weights=(leave - enter) * rates[crowns], minlength=len(start))
    for leg in np.flatnonzero(np.bincount(legs, minlength=len(start)) > 1):
        interval = slice(*np.searchsorted(legs, (leg, leg + 1)))
        loss[leg] = _interval_loss(enter[interval], leave[interval], rates[crowns[interval]])
    return loss * lengths


def _path_amplitude(paths, crowns) -> np.ndarray:
    valid = np.asarray(paths.valid, dtype=bool)
    scale = np.ones(valid.shape, dtype=np.float32)
    if not valid.any():
        return scale
    interactions = np.asarray(paths.interactions)
    vertices = np.asarray(paths.vertices)
    sources = np.asarray(paths.sources, dtype=float).reshape(3, -1).T
    targets = np.asarray(paths.targets, dtype=float).reshape(3, -1).T
    centers, radii, rates = (np.asarray(values, dtype=float) for values in zip(*crowns))
    path_block = max(1, _SEGMENT_CROWN_PAIRS // len(crowns))
    for rx, tx in np.ndindex(valid.shape[:2]):
        indices = np.flatnonzero(valid[rx, tx])
        for start in range(0, indices.size, path_block):
            rays = indices[start:start + path_block]
            previous = np.broadcast_to(sources[tx], (rays.size, 3)).copy()
            losses = np.zeros(rays.size)
            for depth in range(interactions.shape[0]):
                vertex = vertices[depth, rx, tx, rays]
                present = (interactions[depth, rx, tx, rays] != 0) & np.isfinite(vertex).all(axis=1)
                losses[present] += _segment_losses(previous[present], vertex[present], centers, radii, rates)
                previous[present] = vertex[present]
            endpoint = np.broadcast_to(targets[rx], previous.shape)
            losses += _segment_losses(previous, endpoint, centers, radii, rates)
            scale[rx, tx, rays] = np.power(10.0, -losses / 20.0)
    return scale


class FoliagePaths:
    """Traced path geometry with corrected coefficients and NumPy CIR/CFR."""

    def __init__(self, paths, amplitude: np.ndarray):
        self._paths = paths
        self._amplitude = amplitude[:, None, :, None, :]
        self._cir_data = None

    def __getattr__(self, name):
        value = getattr(self._paths, name)
        if callable(value):
            raise AttributeError(name)
        return value

    @property
    def a(self):
        return tuple(np.asarray(part) * self._amplitude for part in self._paths.a)

    def cir(self, *, normalize_delays=True, out_type="numpy"):
        if out_type != "numpy":
            raise ValueError("Foliage-corrected CIR uses NumPy output")
        if self._cir_data is None or self._cir_data[0] != normalize_delays:
            coefficients, delays = self._paths.cir(normalize_delays=normalize_delays, out_type="numpy")
            coefficients = np.asarray(coefficients) * self._amplitude[..., None]
            self._cir_data = normalize_delays, coefficients, np.asarray(delays)
        return self._cir_data[1:]

    def cfr(self, *, frequencies, normalize_delays=True, out_type="numpy"):
        if out_type != "numpy":
            raise ValueError("Foliage-corrected CFR uses NumPy output")
        coefficients, delays = self.cir(normalize_delays=normalize_delays)
        frequencies = np.asarray(frequencies, dtype=np.float32).reshape(-1)
        num_rx, rx_ports, num_tx, tx_ports, num_paths, num_times = coefficients.shape
        response = np.zeros((num_rx, rx_ports, num_tx, tx_ports, num_times, frequencies.size),
                            dtype=coefficients.dtype)
        valid = np.asarray(self.valid, dtype=bool)
        # Evaluate one link at a time to reuse the Fourier matrix across antenna
        # pairs without allocating an antennas × paths × frequencies tensor.
        for rx, tx in np.ndindex(valid.shape[:2]):
            mask = valid[rx, tx]
            if not mask.any():
                continue
            taps = np.moveaxis(coefficients[rx, :, tx], -2, -1)
            taps = taps.reshape(-1, num_paths)[:, mask]
            delay = delays[rx, tx, mask]
            frequency_block = max(1, _CFR_WORK_BYTES // (16 * (delay.size + taps.shape[0])))
            for start in range(0, frequencies.size, frequency_block):
                stop = min(start + frequency_block, frequencies.size)
                phase = np.exp(np.complex64(-2j * np.pi) * delay[:, None] * frequencies[start:stop])
                block = taps @ phase
                response[rx, :, tx, :, :, start:stop] = block.reshape(rx_ports, tx_ports, num_times, -1)
        return response


def attenuate_paths(paths, crowns):
    """Apply positive-loss crowns to a native synthetic-array Paths result."""
    active = tuple(crown for crown in crowns if crown[2] > 0)
    if not active:
        return paths
    amplitude = _path_amplitude(paths, active)
    return FoliagePaths(paths, amplitude) if np.any(amplitude < 1) else paths
