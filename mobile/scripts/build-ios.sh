#!/usr/bin/env bash
# Builds only local artifacts. Never signs, publishes, starts claims, or uses a wallet.
set -euo pipefail

mobile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-all}"
case "$mode" in all|core|simulator|device) ;; *) echo 'Usage: build-ios.sh [all|core|simulator|device]' >&2; exit 2 ;; esac
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'An Apple build requires macOS with Xcode 26 or newer.' >&2
  exit 2
fi
xcode_version="$(xcodebuild -version | awk 'NR == 1 {print $2}')"
if [[ "${xcode_version%%.*}" -lt 26 ]]; then echo 'Capacitor 8 requires Xcode 26 or newer.' >&2; exit 2; fi
command -v cmake >/dev/null
command -v ninja >/dev/null
cd "$mobile_dir"
native_root="$mobile_dir/.tools/ios-native"
artifact_root="$mobile_dir/.tools/ios-artifacts"
mkdir -p "$native_root" "$artifact_root"
# xcodebuild requires a new resultBundlePath. Keep each invocation's archives,
# checksums and diagnostics together, without deleting or reusing an old result.
artifact_dir="$(mktemp -d "$artifact_root/$mode-XXXXXXXX")"
printf 'iOS artifacts for this invocation: %s\n' "$artifact_dir"

build_native() {
  local sdk="$1" arch="$2" build_dir="$native_root/$1/build"
  local cmake_args=(-S "$mobile_dir/native" -B "$build_dir" -G Ninja
    -DCMAKE_BUILD_TYPE=Release -DCONNECTWALLET_NATIVE_TESTS=OFF
    -DCONNECTWALLET_WALLET_CORE=ON -DCMAKE_OSX_ARCHITECTURES="$arch")
  if [[ "$sdk" != host ]]; then
    cmake_args+=(-DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT="$sdk"
      -DCMAKE_OSX_DEPLOYMENT_TARGET=15.4 -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY)
  else
    cmake_args+=(-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0)
  fi
  cmake "${cmake_args[@]}"
  cmake --build "$build_dir" --parallel 3 --target connectwallet_wallet connectwallet_p2c
  local archives=() archive
  while IFS= read -r archive; do archives+=("$archive"); done < <(
    find "$build_dir" -type f \( -name libconnectwallet_wallet.a -o -name libconnectwallet_p2c.a \
      -o -name libconnectwallet_scrypt.a -o -name libsecp256k1.a -o -name libmbedcrypto.a \
      -o -name libmbedx509.a -o -name libmbedtls.a -o -name libeverest.a -o -name libp256m.a \) | sort
  )
  for required in connectwallet_wallet connectwallet_p2c connectwallet_scrypt secp256k1 mbedcrypto mbedx509 mbedtls; do
    local count=0
    for archive in "${archives[@]}"; do [[ "${archive##*/}" == "lib${required}.a" ]] && count=$((count+1)); done
    if [[ "$count" != 1 ]]; then echo "Expected exactly one lib${required}.a, found $count." >&2; exit 1; fi
  done
  xcrun libtool -static -o "$native_root/$sdk/libconnectwallet_native.a" "${archives[@]}"
  local licenses="$mobile_dir/ios/App/App/ThirdPartyLicenses"
  mkdir -p "$licenses"
  cp "$mobile_dir/../LICENSE" "$licenses/CONNECTWALLET-MIT.txt"
  cp "$mobile_dir/native/vendor/core/COPYING" "$licenses/CORE-MIT.txt"
  cp "$mobile_dir/native/vendor/MBEDTLS-LICENSE" "$licenses/MBEDTLS-LICENSE.txt"
  cp "$mobile_dir/native/vendor/NOTICE" "$licenses/NOTICE.txt"
  cp "$build_dir/licenses/LICENSE-SCRYPT.txt" "$build_dir/licenses/LICENSE-SECP256K1.txt" "$licenses/"
}

build_core() {
  build_native host "$(uname -m)"
  CONNECTWALLET_NATIVE_LIB_DIR="$native_root/host" swift test \
    --package-path "$mobile_dir/ios/WalletCore" --parallel
}

build_app() {
  local sdk="$1" arch="$2" destination="$3" label="$4"
  build_native "$sdk" "$arch"
  CONNECTWALLET_NATIVE_LIB_DIR="$native_root/$sdk" xcodebuild \
    -project "$mobile_dir/ios/App/App.xcodeproj" -scheme App -configuration Release \
    -sdk "$sdk" -destination "$destination" -derivedDataPath "$native_root/$sdk/DerivedData" \
    ARCHS="$arch" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY= DEVELOPMENT_TEAM= build
  local product="$native_root/$sdk/DerivedData/Build/Products/Release-$sdk/App.app"
  test -d "$product"
  test -s "$product/PrivacyInfo.xcprivacy"
  local bundle_id display_name marketing_version build_version expected_version
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$product/Info.plist")"
  if [[ "$bundle_id" != com.connectcoincrypto.connectwallet.mobile.alpha ]]; then
    echo "Unexpected application identity: $bundle_id" >&2; exit 1
  fi
  display_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$product/Info.plist")"
  if [[ "$display_name" != ConnectWallet ]]; then
    echo "Unexpected installed app name: $display_name" >&2; exit 1
  fi
  echo "Verified installed app name: $display_name"
  expected_version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
  marketing_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$product/Info.plist")"
  build_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$product/Info.plist")"
  if [[ "$marketing_version" != "$expected_version" || "$build_version" != 2 ]]; then
    echo "Unexpected installed app version: $marketing_version ($build_version)" >&2; exit 1
  fi
  echo "Verified installed app version: $marketing_version ($build_version)"
  xcrun lipo -info "$product/App"
  # These are explicitly labelled app bundles, not installable/signed IPAs.
  ditto -c -k --sequesterRsrc --keepParent "$product" "$artifact_dir/ConnectWallet-$label.app.zip"
}

smoke_simulator() (
  # A new owned Simulator has no user wallets or credentials. The Debug-only
  # launch argument is enforced by native code to deny all network transports.
  local runtime device simulator test_status=0
  runtime="$(xcrun simctl list runtimes -j | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const r=JSON.parse(s).runtimes.filter(x=>x.isAvailable&&x.identifier.includes(".iOS-")).sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}))[0];if(!r)process.exit(1);console.log(r.identifier)})')"
  device="$(xcrun simctl list devicetypes -j | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const d=JSON.parse(s).devicetypes.filter(x=>x.name.startsWith("iPhone"));const v=d.find(x=>x.name==="iPhone 17 Pro")||d.find(x=>x.name==="iPhone 16 Pro")||d.at(-1);if(!v)process.exit(1);console.log(v.identifier)})')"
  simulator="$(xcrun simctl create "ConnectWallet-CI-$RANDOM" "$device" "$runtime")"
  [[ "$simulator" =~ ^[A-Fa-f0-9-]{36}$ ]] || exit 1
  trap 'xcrun simctl shutdown "$simulator" >/dev/null 2>&1 || true; xcrun simctl delete "$simulator" >/dev/null 2>&1 || true' EXIT
  xcrun simctl boot "$simulator"
  xcrun simctl bootstatus "$simulator" -b
  CONNECTWALLET_NATIVE_LIB_DIR="$native_root/iphonesimulator" xcodebuild \
    -project "$mobile_dir/ios/App/App.xcodeproj" -scheme WalletUISmoke -configuration Debug \
    -sdk iphonesimulator -destination "platform=iOS Simulator,id=$simulator" \
    -derivedDataPath "$native_root/iphonesimulator/DerivedData" \
    -resultBundlePath "$artifact_dir/WalletUISmoke.xcresult" -parallel-testing-enabled NO \
    ARCHS="$(uname -m)" ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY= DEVELOPMENT_TEAM= test || test_status=$?
  # Preserve the failing test's exit status while making its diagnostics usable
  # without Xcode. This Simulator contains only disposable public test fixtures.
  local result="$artifact_dir/WalletUISmoke.xcresult" diagnostics="$artifact_dir/ui-diagnostics"
  mkdir -p "$diagnostics"
  if [[ -d "$result" ]]; then
    xcrun xcresulttool export attachments --path "$result" \
      --output-path "$artifact_dir/ui-screenshots" >"$diagnostics/attachments-export.log" 2>&1 || true
    xcrun xcresulttool export diagnostics --path "$result" \
      --output-path "$diagnostics/xcresult" >"$diagnostics/diagnostics-export.log" 2>&1 || true
    xcrun xcresulttool get test-results summary --path "$result" \
      >"$diagnostics/test-summary.json" 2>"$diagnostics/test-summary-error.log" || true
    xcrun xcresulttool get test-results tests --path "$result" \
      >"$diagnostics/tests.json" 2>"$diagnostics/tests-error.log" || true
    xcrun xcresulttool get log --path "$result" --type console \
      >"$diagnostics/test-console.log" 2>"$diagnostics/test-console-error.log" || true
  fi
  xcrun simctl io "$simulator" screenshot "$diagnostics/simulator-final.png" \
    >"$diagnostics/screenshot.log" 2>&1 || true
  xcrun simctl spawn "$simulator" log show --last 10m --style compact \
    --predicate 'process == "App" OR eventMessage CONTAINS "com.connectcoincrypto.connectwallet.mobile.alpha"' \
    >"$diagnostics/app-system.log" 2>"$diagnostics/app-system-error.log" || true
  # Do not scan arbitrary host data: copy only App crash reports from the owned
  # simulator and this disposable CI user's diagnostic directory.
  local reports report_dir report
  reports="$diagnostics/crashes"
  mkdir -p "$reports"
  for report_dir in "$HOME/Library/Developer/CoreSimulator/Devices/$simulator/data/Library/Logs/CrashReporter" \
    "$HOME/Library/Logs/DiagnosticReports"; do
    [[ -d "$report_dir" ]] || continue
    while IFS= read -r -d '' report; do
      cp "$report" "$reports/$(basename "$report")" || true
    done < <(find "$report_dir" -maxdepth 1 -type f \( -name 'App-*.ips' -o -name 'App_*.crash' \) -print0)
  done
  if [[ "$test_status" != 0 ]]; then
    printf 'Simulator UI test failed with exit status %s; diagnostics preserved in %s\n' "$test_status" "$diagnostics" >&2
  fi
  exit "$test_status"
)

node native/tools/check-provenance.mjs
if [[ "$mode" == all || "$mode" == core ]]; then build_core; fi
if [[ "$mode" != core ]]; then
  npm run sync:ios
  node scripts/check-ios.mjs
fi
if [[ "$mode" == all || "$mode" == simulator ]]; then
  build_app iphonesimulator "$(uname -m)" 'generic/platform=iOS Simulator' simulator
  smoke_simulator
fi
if [[ "$mode" == all || "$mode" == device ]]; then
  build_app iphoneos arm64 'generic/platform=iOS' unsigned-device
fi
if [[ "$mode" != core ]]; then
  (cd "$artifact_dir" && shasum -a 256 ConnectWallet-*.app.zip > SHA256SUMS)
fi
