# SionnaRTStudio backend

A minimal FastAPI service that runs **real NVIDIA Sionna RT** ray tracing for the
React frontend. It builds a Sionna/Mitsuba scene from the building footprints the
frontend sends (ENU meters) and returns paths / coverage in the exact shapes the
frontend already uses (`src/types.ts`). Scenes are cached by a geometry hash, so
consecutive solves over the same area reuse one build.

## Requirements

- Startup tries the `cuda_ad_mono_polarized` and `metal_ad_mono_polarized`
  Mitsuba variants before falling back to `llvm_ad_mono_polarized` on the CPU.
  The CPU fallback requires the LLVM runtime. `/api/health` reports the active
  variant and whether it uses a GPU.
- Python 3.11+.

## Run

```bash
# from the project root
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

uvicorn backend.main:app --port 8000
```

Then start the frontend (`npm install && npm run dev`); Vite proxies `/api` → `:8000`.
Or just use `./run.sh` from the project root to start both.

## Tests

`backend/tests/` covers solver reductions, link-level KPIs, the A3 handover
state machine, and CSI and scene-export packaging. No GPU, no
Sionna scene build, no network:

```bash
# from the project root
./.venv/bin/python -m unittest discover backend/tests
```

## Endpoints

| Method | Path            | Body                                                          | Returns                  |
|--------|-----------------|---------------------------------------------------------------|--------------------------|
| GET    | `/api/health`   | —                                                             | `{ok, variant, gpu, …}`  |
| POST   | `/api/building-generate` | Building ID, name, footprint center and dimensions, height, and layout | Normalized `{spec, objects}` |
| POST   | `/api/solve`    | `{tx, rx, buildings, freqGhz, maxDepth, options}`             | `{paths, metrics}`       |
| POST   | `/api/radiomap` | `{txs, buildings, freqGhz, gridSize, gridHeight, maxDepth, options}` | `RadioMapGrid`    |
| POST   | `/api/radiomap/preflight` | Coverage request | Grid dimensions, AP–cell count, budgets, and corrections |
| POST   | `/api/simulation-jobs/csi` | CSI run request, optional UUID query `jobId` | Job status (202) |
| POST   | `/api/simulation-jobs/coverage` | Coverage request, optional UUID query `jobId` | Job status (202) |
| GET    | `/api/simulation-jobs/{jobId}` | — | Job status, stage, and completed result |
| DELETE | `/api/simulation-jobs/{jobId}` | — | Current job status after requesting cancellation |
| POST   | `/api/mobility` | `{txs, rx, buildings, waypoints, freqGhz, speedKmh, maxDepth, options, combineMode, handover}` | `{steps, execution, handover}` |
| POST   | `/api/csi-runs` | Solver settings and optional `projectId` and `fronthaulMbpsByTxId` | CSI run summary with `runId` |
| GET    | `/api/projects/{projectId}/csi-runs` | — | Run summaries, newest first |
| GET    | `/api/projects/{projectId}/csi-runs/{runId}` | — | Run, scene and device snapshot, and archived fronthaul |
| GET    | `/api/csi-runs/{runId}/preview` | Query `txId`, `rxId`, `sampleIndex` (default 0), and optional `projectId` | Stored rays, metrics, and channel frequency curve |
| POST   | `/api/csi-runs/{runId}/export` | Query `projectId` (optional), body `{}` or `{fronthaulMbpsByTxId}` | CSI replay ZIP |
| POST   | `/api/cir`      | one/all Tx/Rx + optional OFDM grid + output format           | raw CIR or CIR/CFR `.npz`; single-link CSV |
| POST   | `/api/cir-bundle` | heterogeneous Tx/Rx arrays + raw-CIR options                | ZIP with per-pair NPZ + manifest |
| POST   | `/api/linkkpi`  | link request + OFDM grid + noise figure                     | Shannon-capacity KPIs    |
| POST   | `/api/phyber`   | link request + PUSCH config (MCS, PRBs, Eb/N0 sweep)        | `{jobId}` (409 if busy)  |
| GET    | `/api/phyber/{jobId}` | —                                                     | job status + BER/BLER points |
| POST   | `/api/channel-grid` | Tx/Rx arrays + receiver cells + OFDM grid               | ray-traced MIMO CFR `.npz` |
| POST   | `/api/scene-export` | buildings + optional devices + OFDM grid                | ZIP: `scene.xml`, `meshes/*.ply`, `load_scene.py`, manifest |

See [procedural buildings](../docs/scene-package.md#参数化建筑--procedural-buildings) for an example of calling the generator from a script or an agent.

`/api/csi-runs` accepts `mode="static"` for every selected AP and UE, or
`mode="trajectory"` for one UE and up to 100 `waypoints` with matching
`timeSeconds`. Trajectory times start at zero and increase strictly. Both modes
use one `PathSolver` dispatch for rays, link metrics, and unprecoded complex
channel data. The trajectory axis describes independent geometric snapshots.
Each side needs uniform antenna array sizes for the dense tensor. For static
mixed arrays, use the existing per-pair `/api/cir-bundle` endpoint.

Select `output="cir_cfr"` (the default) to store both CIR and CFR or
`output="cir"` to store only CIR. In both modes, the run summary and
manifest report the nominal CFR `shape`, padded `pathCount`, and
`uncompressedBytes` for the stored channel arrays before compression.

The CFR `h_freq` has axes `[time, ue, rx_port, ap, tx_port, subcarrier]`.
Static runs have one time entry, and trajectory runs have one UE. In both
modes `csi.npz` includes `a`, with the same leading axes and `path` replacing
`subcarrier`. `tau_geometric` (seconds) and `valid_paths` share
`[time, ue, ap, path]`. To reconstruct CFR, sum the valid path coefficients
weighted by `exp(-2j * pi * tau_geometric * f)`, where `f` is a baseband offset
in Hz from the stored `frequencies` axis. The Preview curve shows
`10 log10(mean(|H|²))` across antenna ports at up to 256 sampled subcarriers.
`null` marks zero magnitude on that curve.

CSI and coverage jobs run in submission order and share the solver lock with
synchronous requests. Poll the returned `jobId` for its status, including
`queuePosition` while queued and `stage` while running. After a submission
timeout, reuse the same client-generated UUID and identical request to recover
the accepted job. The server returns 409 when that ID belongs to a different
request and 429 when eight jobs are already waiting. To retry a failed or
cancelled run, submit its inputs with a new job ID.

A queued job cancels immediately. A running job reports `cancelling` until
it reaches a safe stopping point, which may require waiting for a native
ray-tracing call to finish. Once `canCancel` is false, an atomic CSI
publication may already be in progress. Cancelled jobs have a null result
and leave no CSI record in project history. The running backend retains up
to 16 finished jobs, with up to two coverage grids. Archived CSI runs can
still be opened using their `runId` and `projectId`.

Supply a UUID `projectId` at creation to keep the run across restarts. History,
preview, and export use the same project ID. Legacy requests that omit it use
a transient cache of two runs for the life of the server process.

Records are stored under `SionnaRTStudio/csi-runs/<projectId>/<runId>` in
`~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows, or
`${XDG_DATA_HOME:-~/.local/share}` on Linux. Set `SRTS_RUNS_DIR` to override
the CSI history root.

Before compression, CIR + CFR is limited to 256 MiB. The CIR-only limit of
512 MiB counts the CIR data. CIR-only preview evaluates sampled frequency
responses in blocks.
Preview and export read the stored result. Export with `{}` to use the archived
per-AP fronthaul capacity. Supply `fronthaulMbpsByTxId` to update the ZIP
manifest. Use `null` for an unset capacity or `0` for an explicit zero.

The ZIP includes the original `csi.npz`, a manifest with SHA-256 checksums,
`request.json` with resolved positions and velocities, and the solver's
`scene.xml` and PLY meshes. On a machine with the bundled dependency versions
and a usable Mitsuba backend, extract the ZIP and run `python replay_csi.py`
in that directory. It verifies the files and writes `csi-replay.npz` offline.

`options` selects the ray interaction types and both scene arrays.

```json
{
  "los": true, "specularReflection": true, "diffuseReflection": false,
  "refraction": false, "diffraction": false, "edgeDiffraction": false,
  "txPattern": "tr38901", "txPolarization": "V",
  "rxPattern": "iso", "rxPolarization": "V",
  "pathSamplesPerSource": 1000000, "pathSeed": 42
}
```

The PathSolver sample count and seed are recorded in mobility execution
telemetry. Sionna RT's shooting-and-bouncing candidate stage is sampled, so pin
both for controlled studies; identical seeds do not imply bitwise equality when
the number of simultaneously traced sources changes.

`/api/radiomap` also accepts `samplesPerTx` (1,000–10,000,000) and `seed`.
Both are returned in `RadioMapGrid`, so convergence and sensitivity studies can
pin or vary the Monte Carlo sequence explicitly.

`/api/mobility` places every transmitter and waypoint receiver into one Sionna
scene and normally resolves all Tx × waypoint pairs in one `PathSolver` call.
Each `MobilityStep` carries real per-Tx paths/KPIs, best-server identity, and
Doppler. The `execution` object reports the pair count, solve time, and whether
the batched result or defensive serial fallback was actually used.

`combineMode="sum"` is a non-coherent incident-power sum. A joint cross-Tx delay
spread is marked invalid because independent cells have no common delay/phase
reference in this model; use each entry in `perTx` for transmitter-specific delay
spread.

For controlled benchmarking, `executionMode="batched"` requires the single-call
path and fails rather than silently falling back; `executionMode="serial_reference"`
uses the same request/scene but dispatches each Tx–waypoint pair separately.
Normal browser requests use `executionMode="auto"`.

`/api/linkkpi` re-traces the link and reduces the CFR to Shannon-capacity KPIs
(open-loop / MRT / applied-steered-beam capacity, coherence bandwidth, transmit-
covariance eigenstructure, link-budget effective SNR) in pure NumPy — no extra
dependency.

`/api/phyber` needs the **optional** Sionna PHY package
(`pip install -r requirements-phy.txt`, ~4 GB with torch); `/api/health` reports
its availability as `"phy"`. It runs the ray-traced channel through the 5G NR
PUSCH chain (LDPC, QAM, DMRS, LMMSE) as the reciprocal uplink, CPU-pinned so the
GPU stays exclusive to the ray tracer. Sweeps run as one background job at a
time (a second POST returns 409); poll `GET /api/phyber/{jobId}` for progress
and the BER/BLER points. Runtime scales with `slotsPerPoint` — roughly 8 s for a
13-point sweep at 4 slots/point and ~70 s at the default 32 on an RTX 4000 Ada
class machine.

Only `category:"building"` footprints are ray-traced (a ground plane is added);
roads/parks/water are visual-only.

## Notes

- The Tx antenna array is physically modeled: a `PlanarArray` with the requested
  size/pattern/polarization, oriented toward the steered beam; uniform precoding
  forms the main lobe along boresight in both `PathSolver` and `RadioMapSolver`.
- PathSolver links use a physical scene-level Rx `PlanarArray` with the requested
  size/pattern/polarization and `synthetic_array=True`, exactly like Sionna's
  notebook workflow. CIR/CFR and channel-grid exports preserve every Rx port.
  Multi-device CIR/CFR places all Tx and Rx into one scene and retains native
  `[num_rx, num_rx_ant, num_tx, num_tx_ant, ...]` axes; all Tx must share one
  array size and all Rx must share one array size. Exported `tau` is broadcast
  over synthetic antenna axes for tutorial compatibility, with Sionna's native
  `[num_rx, num_tx, num_paths]` values also stored as `tau_geometric`.
  Scalar link/mobility RSS sums the actual Sionna per-port powers (the ideal-MRC
  signal term); no separate `10·log10(Nr)` gain is added.
- `RadioMapSolver` retains Sionna's documented ideal dual-polarized isotropic
  map receiver and does not use `scene.rx_array`.
- Sionna/Mitsuba is not re-entrant, so solves are serialized with a lock.
