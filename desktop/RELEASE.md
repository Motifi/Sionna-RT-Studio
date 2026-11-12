# Desktop release candidates

Build both Tauri desktop candidates from the same clean checkout. The backend version in
`backend/version.py` must match the frontend package and lockfile, plus the Tauri crate and configuration. Set the
release version after the P0–P2 work is complete. Each package contains
`build-info.json` with its app version, Git commit, source status, frontend
lockfile hash and solver dependency versions. Archive the package SHA-256 with
the corresponding acceptance reports.

## Build and relocate

### macOS arm64

Prepare a relocatable arm64 CPython 3.12 prefix with the dependencies from
`backend/requirements.txt` installed in that prefix. The build checks that
Python and its native packages load from inside the staged app. Use a
standard checkout and build the frontend with its locked dependencies.

```sh
mkdir -p "$out/Studio Candidate" "$out/Moved Studio"
SRTS_BUNDLED_PYTHON="$python_prefix" ./desktop/build.sh "$out/Studio Candidate/SionnaRTStudio.app"
app="$out/Studio Candidate/SionnaRTStudio.app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out/macos-candidate.zip"
shasum -a 256 "$out/macos-candidate.zip"
ditto -x -k "$out/macos-candidate.zip" "$out/Moved Studio"
app="$out/Moved Studio/SionnaRTStudio.app"
```

Use an Apple Silicon account without a development Python or checkout. Open
the extracted app with the network disconnected, load the built-in scene and
solve CSI. Move the entire app to another folder with spaces and repeat. Use
a disposable package copy to simulate missing bundled Python and confirm the
startup message directs the user to extract the full package again. Check that
the app version, active backend and any fallback reason match
`/api/health`. Metal requires access to the Apple GPU. CPU compatibility
requires LLVM and can use `DRJIT_LIBLLVM_PATH` to point to `libLLVM.dylib`.

### Windows x64

Use the Windows workflow's portable ZIP from a pull request or manual
workflow run. The workflow builds the Tauri executable and copies the
base CPython 3.12 interpreter and installed wheels into the payload. It
extracts the ZIP into a different path with spaces and runs the installed
headless LLVM verifier. For a local build, use the developer installer, then
run the packaging script with that installation's Python.

```powershell
& .\desktop\windows\Install-Studio.ps1 -InstallDirectory $installed -NoShortcut
$python = Join-Path $installed 'runtime\.venv\Scripts\python.exe'
& $python -B -I .\desktop\windows\package_studio.py $installed (Join-Path $staging 'SionnaRTStudio')
tar.exe -a -cf $zip -C $staging SionnaRTStudio
Get-FileHash -Algorithm SHA256 -LiteralPath $zip
```

Extract the entire ZIP into a path with spaces on Windows 11 x64. The clean
account needs WebView2 Runtime and either a supported NVIDIA CUDA/OptiX driver
or x64 LLVM. Windows CPU fallback can use `DRJIT_LIBLLVM_PATH` set to the
full path of `LLVM-C.dll`. Open the packaged executable while disconnected
from the network and solve an offline built-in scene. Move the entire folder
and repeat. On a disposable copy or clean VM, exercise startup with missing
Python and missing WebView2. Confirm the displayed repair instructions and
check the actual backend, version and fallback reasons in `/api/health`.
See the [Windows setup and diagnostics](windows/README.md).

## Collect acceptance reports

Use free local ports and keep the report folders with the candidate ZIPs.
The physical fixtures cover 40 m LOS, occlusion, a reflection, terrain and two
slabs, a vertical two-AP trajectory, archive replay, and history across a
process restart. The reports include exact fixture inputs, expected
tolerances, runtime details and failure reasons.

```sh
SRTS_MITSUBA_VARIANT=llvm_ad_mono_polarized .venv/bin/python -B scripts/verify_scene_workbench.py \
  http://127.0.0.1:8011 "$out/llvm" --launch
resources="$app/Contents/Resources"
env -u SRTS_PYTHON SRTS_MITSUBA_VARIANT=metal_ad_mono_polarized \
  "$resources/python/bin/python3.12" -B scripts/verify_scene_workbench.py \
  http://127.0.0.1:8011 "$out/metal" --mac-runtime "$resources"
env -u SRTS_PYTHON SRTS_MITSUBA_VARIANT=metal_ad_mono_polarized \
  "$resources/python/bin/python3.12" -B desktop/verify_studio.py \
  --app "$app/Contents/MacOS/SionnaRTStudio" --runtime "$resources" --report-directory "$out/macos"
```

On Windows, use the matching checkout and point the verifier to the extracted
package. The default requires the desktop session, WebView2 and a real CUDA
solve. Use `-Headless -AllowCpu` for LLVM compatibility.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop\windows\Test-Studio.ps1 `
  -InstallDirectory $extracted -ReportDirectory $report
```

Check each desktop report for `ok`, `webgl2`, `backendStopped`,
`workspaceNavigation`, `projectAutosave` and the project JSON and CSI ZIP in
`desktopDownloads`. Confirm the Metal variant on macOS and `cudaPassed` on
Windows. Both platforms also need a manual pass with the normal GUI.
Save a project and CSI ZIP through the native dialogs, quit, reopen the project,
and find and re-export the same history entry. Extract a CSI ZIP on an offline
machine with the listed solver dependencies, run `python replay_csi.py`, and
verify the result against the original arrays.

## Production signing and stable assets

Use an Apple Developer ID Application identity and a notarization profile, a
Windows production code-signing identity with an RFC 3161 timestamp service,
and a separate release-manifest private key. Distribute the manifest public
key independently of the release assets.

1. On macOS, sign all bundled native Python code and executables inside out with Developer ID and Hardened Runtime, then sign the enclosing app. Validate the bundled Python's JIT and library loading with the signed app. Submit a ZIP with `xcrun notarytool submit ... --wait`, retain the notarization log, and staple the accepted ticket to the app. Check `codesign --verify --deep --strict`, `xcrun stapler validate` and `spctl --assess --type execute` on the final app, then rearchive the stapled app. [Apple notarization instructions](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
2. On Windows, production-sign the executable or installer using SignTool with SHA-256 and an RFC 3161 timestamp. Verify with `signtool verify /pa /v` after extracting the final package. [Microsoft SignTool documentation](https://learn.microsoft.com/windows/win32/seccrypto/signtool)
3. Name the stable assets `SionnaRTStudio-<version>-macos-arm64-min14.0.zip` or `.dmg`, and `SionnaRTStudio-<version>-windows-x64-min10.0.22000.zip`, `.msi`, or `.exe`. The minimum suffix must match the oldest OS validated with the final package. Run the clean-account and GPU acceptance again on these signed assets.
4. Sign the manifest only after the asset bytes are final.

```sh
python -m scripts.release_manifest sign "$assets" "$private_key" "$mac_asset" "$windows_asset"
python -m scripts.release_manifest verify "$assets" "$public_key" --version "$version"
python -m unittest backend.tests.test_release_updates
```

The verifier checks signature, version, platform, architecture, OS minimum,
length and SHA-256. Verify on copies that editing the manifest or replacing
a package invalidates verification.

## Upgrade and rollback rehearsal

1. Start the previous version with its original runtime. Verify the project and language load at `http://127.0.0.1:43110`. Export a compatible project JSON and keep existing CSI exports. Quit Studio and back up the app, its runtime, browser profile and user data. Preserve the previous runtime path for any source install using a venv.
2. On macOS, include the app's WebKit profile under `~/Library/WebKit` for `org.radioworld.sionna-studio`, its preferences, and `~/Library/Application Support/SionnaRTStudio`. On Windows, include `%LOCALAPPDATA%\SionnaRTStudio`, including `WebView2`, with the app and its runtime retained separately for rollback.
3. Install the signed candidate, reopen Studio at the same origin and verify migration, language and existing exports. Save the migrated v5 project and run and export a new CSI result. Quit and preserve a copy of the migrated profile, project file and `csi-runs` directory.
4. Simulate a startup failure in a disposable copy of the candidate. Restore the previous app, runtime and pre-upgrade profile or compatible project JSON. Open Studio and verify the old project and exports. Then reinstall the candidate, restore its saved profile and run directory, and verify the migrated project still finds the same run via its project ID.
5. Record candidate commit, package hashes, OS builds, runtime versions, and report paths. Publish the same verified assets and manifest with the matching stable tag. From the previous version's About panel, check the manual download link for the appropriate OS and architecture.

The current update flow offers a manual download. Automatic installation is a
separate change after cross-version acceptance.
