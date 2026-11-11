# Desktop release candidates

`backend/version.py` supplies the backend and desktop build version. A stable tag and its asset filenames must use that version. The About panel checks `Motifi/Sionna-RT-Studio/releases/latest` once per day and supports an explicit check. Compatible packages offer a manual download.

- macOS arm64 filenames use `SionnaRTStudio-<version>-macos-arm64-min14.0.zip` or `.dmg`.
- Windows x64 filenames use `SionnaRTStudio-<version>-windows-x64-min10.0.22000.exe`, `.msi`, or `.zip`. The minimum is the Windows kernel build number.
- The suffix after `min` must reflect the actual package's supported minimum system.

## Build and verify

- macOS. Prepare a relocatable arm64 CPython 3.12 prefix with the packages in `backend/requirements.txt` installed in its own site-packages. Pass the prefix as `SRTS_BUNDLED_PYTHON` to `desktop/build.sh`. Archive the resulting app with `ditto -c -k --sequesterRsrc --keepParent`. Extract the archive to a different directory and exercise the native app and solver there.
- Windows. From the candidate source, run `desktop/windows/Install-Studio.ps1` on Windows x64 and `desktop/windows/Test-Studio.ps1` with the app closed. The test includes static and trajectory tensors, wall occlusion, reflection, import, standalone replay, and clean shutdown. The Windows CI uses `-Headless -AllowCpu`. On a desktop with an NVIDIA GPU, run without either switch to require CUDA and the actual WebView2 window.
- Use a trusted signing key outside the source tree. From the repository root run `python -m scripts.release_manifest sign <assets-folder> <private-key.pem> <asset-name> ...`. To verify, obtain the public key independently and run `python -m scripts.release_manifest verify <assets-folder> <public-key.pem>`. The verifier checks the signature, version, platform, architecture, OS minimum, byte size and SHA-256.

The local macOS build uses an ad-hoc signature. A production package needs a Developer ID signature and Apple notarization, and the Windows installer needs production code signing. The distribution signing key and OS signing identities must be provisioned for the formal release. Candidate checks cover the manual download flow. The automatic installer is gated on verified, cross-version upgrade and rollback acceptance using those production packages.
