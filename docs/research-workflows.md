# Batch CSI experiments and measurement comparison

Run these commands from the Studio checkout with Python 3 and a running Studio
backend. The command-line tools use Python's standard library. Use the backend's
base URL, which defaults to `http://127.0.0.1:8000`. Both workflows take a saved
Studio project JSON. Versions 1–4 also work for static CSI. The tool assigns a
repeatable project ID based on the original file bytes to these legacy files.
Open and save them in Studio first if you want to share the app's project history.

Each command writes to a new report directory. It keeps exact copies and SHA-256
hashes of the inputs, the backend version and solver, and the project ID. CSI runs
are archived by that backend and can be opened and exported through Studio's
project history on the same machine. Reports include the run and scene IDs and
a hash of the JSON request for each submitted run. The report updates as work
progresses and sets `complete` when all cases or batches have been processed.
An exit code of 1 indicates that at least one case or point failed. An exit code
of 2 indicates that the command could not process the inputs or start the
workflow. After an HTTP timeout, check project history for a run that may have
finished on the server.

## Sweep frequency, array size and AP layout

Save a Studio project and create a JSON matrix like the
[indoor sweep](research-fixtures/indoor-sweep.json). Every combination of
`freqGhz`, `arrays` and `deployments` runs static CSI at the saved UE positions.
Omit an axis to use the project settings for that axis.

- `freqGhz` lists carrier frequencies in GHz.
- Each array variant has an `id` and may specify `tx` and `rx` as
  `[horizontal, vertical]`. A specified size applies to all devices on that
  side. CSI requires matching array sizes across the APs and across the UEs.
- Each deployment variant has an `id` and can provide an `aps` object keyed by
  saved AP ID. Only listed APs participate. An empty object **as an AP's value**
  keeps its saved settings. Overrides may include `enu` (`x`, `y`, `z` in
  meters), `height`, `heightReference`, `powerDbm`, `beamsteeringAzimuth`
  and `beamsteeringElevation`. With the `enu` height reference, set `height`
  to the desired absolute up coordinate. Omit `aps` to use all saved APs.
- Set `output` to `cir` (the default) or `cir_cfr`. The backend's data-size
  limits apply. Every successful case stores its CSI payload in project history.

```sh
python -m scripts.research_workflows sweep docs/research-fixtures/indoor-project.json \
  --matrix docs/research-fixtures/indoor-sweep.json --out indoor-sweep-report
```

This example runs eight cases. The JSON report lists the input combination,
per-link metrics and archived run for each successful case. A rejected case
records the error and the sweep continues.

## Compare with measurement points

Use a CSV with columns `point_id,ap_id,east_m,north_m,up_m` and at least one of
`power_dbm,first_arrival_ns`. Supply at least one measured value in each row.
The coordinates locate the UE antenna phase center in the project's ENU frame.
Use the AP ID from `state.devices.transmitters` in the project JSON. The same
point may be associated with several APs, with one row per point and AP pair.
An optional `split` column supports metrics for calibration and held-out
validation points.

Provide a [dataset metadata file](research-fixtures/indoor-metadata.json) with
`schemaVersion: 1`, `datasetKind` (`measured` or `synthetic`), `source`,
`coordinateFrame: "ENU_m"`, `carrierFrequencyGhz`, `rxDeviceId`,
`delayReference: "absolute_propagation"`, `materialNotes`, and `foliageNotes`.
The frequency must match the project. `rxDeviceId` selects the saved UE whose
array is used at every measurement point. Describe the instrument calibration,
power reference plane, antenna configuration, coordinate origin and delay
reference in the dataset metadata as applicable. Additional metadata fields
are retained in the report.

```sh
python -m scripts.research_workflows compare docs/research-fixtures/indoor-project.json \
  docs/research-fixtures/indoor-reference.csv \
  --metadata docs/research-fixtures/indoor-metadata.json --out indoor-comparison-report
```

The comparison traces static links for each AP and up to 64 UE positions per
run. The JSON report records the simulated value and signed residual
(simulated minus measured) at every point, and reports mean absolute error
(MAE), root mean squared error (RMSE) and mean signed error (bias) overall, by
AP and by split. Power residuals are in dB and delay residuals in ns. A link
with no valid paths is flagged `no_path` and contributes to the requested
count. Only pairs with a usable simulation and measurement contribute to the
error statistics. Use the `requested` and `compared` counts when judging fit.

The simulated received power is for an individual AP and sums modeled ray
powers incoherently across the paths and receive ports, after the configured
Tx beamforming. Use power measurements with a matching reference, transmit
power and array configuration. Account for cable losses, gains and
instrument offsets when preparing the CSV. First arrival is the minimum
absolute propagation delay among all valid traced rays, including rays beyond
the display cap. Use a calibrated delay reference with known sounder timing
offsets removed. Detection thresholds and synchronization differences can
change which path an instrument reports as the first arrival.

### Document calibration evidence

Run a baseline comparison. Then save candidate Studio projects with the
material or crown parameters you changed and re-run the comparison on the same
dataset. Describe the source and rationale for each candidate in
`materialNotes` and `foliageNotes`. Keep changes limited to the parameters
being tested and compare performance on the same calibration points. Use
held-out validation points to test whether the adjusted parameters generalize.
The input project snapshot and CSI runs retain the material parameters,
geometry, crown radii and attenuation settings. Calibrated values are
applicable to the measured frequency, geometry, equipment and environmental
conditions represented by the evaluation. Broader planning use requires
independent measurements across the intended conditions.

The bundled indoor example is **synthetic**. It uses a 24 m × 18 m room, two APs
and single-element isotropic antennas at 1.5 m with LOS enabled. Its four
reference links use the analytic Friis equation
`P_rx = P_tx − 20 log10(4πfd/c)` and `t = d/c`, where `d` is the Euclidean
distance in meters and `c = 299792458 m/s`. All four links should compare, with
absolute power and delay errors below `0.001 dB` and `0.001 ns` respectively.
This checks coordinate alignment, link selection, units and reporting. Physical
calibration of materials and foliage requires measured data with paths that
interact with those objects.
