# ConnectWallet installers

These build recipes package ConnectWallet, not ConnectCoin Core. They do not
install a blockchain node, configure Huge Pages, open firewall ports, enable
claims, or handle a user's recovery words. The version comes from `package.json`
(currently **1.1.0**); Core's version is independent.

## Outputs

| Native build host | Architecture | Formats |
| --- | --- | --- |
| Windows | x64 | MSI and assisted NSIS EXE |
| macOS Intel | x64 | DMG and ZIP containing ConnectWallet.app |
| macOS Apple Silicon | arm64 | DMG and ZIP containing ConnectWallet.app |
| Ubuntu 22.04 desktop/build environment | x64 | DEB, RPM, AppImage, tar.gz |

Each filename includes the version, OS and architecture. Outputs are in
`dist/installers/win32-x64`, `darwin-x64`, `darwin-arm64`, or `linux-x64`.
The command refuses nonempty output directories to avoid mixing releases or
erasing old files. Move an earlier output directory aside before rebuilding.
The helper build itself refreshes its generated files under `helpers/bin/` and
`tmp/`; it does not replace an already-open wallet's `dist/win-unpacked` files.

All installer-controlled text is English. Windows explicitly restricts NSIS to
`en_US`/1033 and MSI to product language 1033 and WiX culture `en-us`. Neither
installer launches the wallet automatically. UAC, Finder and distribution
package-manager dialogs belong to the OS and can follow its own locale.
The installer, application, shortcuts and installed-program entry use the
ConnectWallet artwork. Windows taskbar IDs and Linux desktop IDs match the app.

## Local build

Use Node.js 24+, npm, Python 3.11+ with venv/pip, and Git. The Node and Python
architectures must match the target. Builds download the exact dependencies in
the lockfiles, builder toolchains and original third-party license files.
End users do not need Node.js or Python: the native helper includes its runtime.

The pinned cryptography 50.0.1 release has no macOS Intel wheel, so Intel builds
also need the native C/Rust compiler toolchain and OpenSSL static libraries and
headers. Packaging rebuilds that provider with static OpenSSL linkage to avoid
colliding with CPython's bundled OpenSSL library, and checks the result with
`otool` before bundling. Set `OPENSSL_DIR` to the development prefix, or the build
uses `brew --prefix openssl@3`. The macOS Intel Actions runner supplies these
build dependencies. License
collection supports both binary wheels and source builds: the latter uses the
reviewed SHA-256 of the exact cryptography source archive and its locked Rust
dependency checksums, and includes notices for the actual OpenSSL providers.

```sh
npm ci
npm run check
npm test
```

Then run exactly one appropriate command:

```sh
# Windows PowerShell: MSI + EXE
npm.cmd run dist:win

# macOS: native Intel or native Apple Silicon, no Rosetta/cross-build mixing
npm run dist:mac

# Ubuntu 22.04 x86_64: install build tools, then all four Linux formats
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip rpm fakeroot dpkg-dev libarchive-tools libfuse2
npm run dist:linux
```

`PYTHON` can select an exact Python executable before the first helper setup.
An existing `.claims-venv` is reused and its architecture checked; do not copy
venvs or native helpers between computers/architectures. The generic `npm run
dist` selects the native host. Unsupported targets and cross-compilation are
rejected instead of shipping a helper for the wrong OS.

The build runs Python regressions, collects dependency licenses, compiles the
helper, regenerates icons, checks the helper's pinned crypto provider/protocol,
and invokes the pinned electron-builder with `--publish never`. It then checks
the packaged app and helper, validates installer metadata/container signatures,
and creates `SHA256SUMS` and `manifest.json`. No secrets or signing credentials
are stored in the repository.

## GitHub Actions

Use **Actions → Wallet installers → Run workflow** and select the desired ref.
The workflow runs Windows x64, Ubuntu 22.04 x64, macOS Intel and macOS Apple
Silicon jobs, each building its own helper and running the tests. It has
read-only repository permissions and uploads versioned **Actions artifacts**
with installers and checksums, retained for 14 days. It does not create tags,
publish Releases, or replace assets. Ordinary commits continue to run the
separate Wallet tests workflow without triggering the installer matrix.

The repository changes must first reach GitHub before the new workflow can be
selected. Publishing tested artifacts to a GitHub Release remains an explicit,
separate maintainer action.

To publish, first wait for **Wallet installers** and **Wallet tests** to succeed
on the current `main` commit. Then manually run **Publish wallet release** on
`main`, supplying that installer run's numeric ID. It downloads artifacts within
GitHub Actions, verifies all four target manifests and SHA-256 hashes, uploads
ten installers plus four manifests and a combined `SHA256SUMS` to a draft, and
publishes only after verifying the complete uploaded set and version tag. It
requires the build and publishing checkout to use the same clean source commit;
if `main` advances, build the new commit first. A wrong existing tag or an already
published release is never overwritten. This separate manual workflow needs
`contents: write`; neither a normal push nor the build workflow publishes a release.

## Verification and limits

- Unit tests enforce English-only Windows configuration, stable upgrade IDs,
  valid target options, host-architecture matching and safe output handling.
- Packaged smoke checks inspect app.asar, Electron/helper executable architecture,
  roots and license checksums, then run helper self-test and protocol start/close.
  They send no DNS/TLS jobs, access no wallets and do not launch the GUI.
- On Windows, the MSI database is read **without installing it** to verify
  English language/UI, Windows version requirement, icons, shortcuts, app ID
  and the native helper's inclusion.
- Each expected installer must exist and have the appropriate container header.
  SHA-256 is streamed over its complete bytes. A hash is integrity metadata,
  not a publisher signature. The manifest records repository HEAD and whether
  source changes were present; it does not claim a reproducible build.
- macOS CI also verifies the app's local ad-hoc code signature. This is **not**
  Apple notarization or a verified developer identity.

These checks do not constitute a clean-machine install/uninstall or GUI test of
each generated format. Linux/macOS binaries must be built and checked on their
native runners; a successful Windows build cannot validate them. The Linux
build baseline is Ubuntu 22.04/glibc, not universal Linux compatibility. Test
DEB on the intended Ubuntu/Debian/Mint release and RPM on the intended Fedora
release before publishing; do not assume compatibility with every RPM distro
or musl-based systems. AppImage still needs host desktop libraries and FUSE 2
(or the AppImage runtime's extraction mode).

No launcher adds `--no-sandbox`. Native Linux packages use electron-builder's
desktop/sandbox integration; portable packages still depend on host namespace
and sandbox policy. Do not disable the OS sandbox globally to make a package
run. Test in an unprivileged desktop session, not as root.

## Signing and upgrades

The default Windows artifacts are **unsigned**. macOS uses **ad-hoc signing**
with hardened runtime disabled and notarization disabled, without searching for
or consuming personal signing certificates. These settings permit local/native
build testing; they do not remove SmartScreen/Gatekeeper publisher warnings.
Do not describe these artifacts as Authenticode-signed, Developer-ID-signed or
notarized. A trusted public macOS release needs a separate Developer ID signing,
entitlements/hardened-runtime and notarization configuration; Windows signing
likewise requires an authorized publisher certificate/service.

Keep `build.appId`, `build.nsis.guid` and `build.msi.upgradeCode` stable across
versions. Keep versions compatible with MSI's three-part numeric version rules.
Use **one Windows installer family at a time**: MSI and NSIS do not migrate each
other's installation registration. To switch formats, close the app, back up
your wallet, uninstall the prior program, then install the new format. MSI and
EXE uninstallers must retain the profile data; NSIS explicitly keeps app data.
No recipe here changes recovery words, network profiles or wallet encryption.
