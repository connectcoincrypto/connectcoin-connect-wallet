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
artifact_dir="$mobile_dir/.tools/ios-artifacts"
mkdir -p "$native_root" "$artifact_dir"

build_native() {
  local sdk="$1" arch="$2" build_dir="$native_root/$1/build"
  local cmake_args=(-S "$mobile_dir/native" -B "$build_dir" -G Ninja
    -DCMAKE_BUILD_TYPE=Release -DCONNECTWALLET_NATIVE_TESTS=OFF
    -DCONNECTWALLET_WALLET_CORE=ON -DCMAKE_OSX_ARCHITECTURES="$arch")
  if [[ "$sdk" != host ]]; then
    cmake_args+=(-DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT="$sdk"
      -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY)
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
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$product/Info.plist"
  xcrun lipo -info "$product/App"
  # These are explicitly labelled app bundles, not installable/signed IPAs.
  ditto -c -k --sequesterRsrc --keepParent "$product" "$artifact_dir/ConnectWallet-$label.app.zip"
}

node native/tools/check-provenance.mjs
if [[ "$mode" == all || "$mode" == core ]]; then build_core; fi
if [[ "$mode" != core ]]; then
  npm run sync:ios
  node scripts/check-ios.mjs
fi
if [[ "$mode" == all || "$mode" == simulator ]]; then
  build_app iphonesimulator "$(uname -m)" 'generic/platform=iOS Simulator' simulator
fi
if [[ "$mode" == all || "$mode" == device ]]; then
  build_app iphoneos arm64 'generic/platform=iOS' unsigned-device
fi
if [[ "$mode" != core ]]; then
  (cd "$artifact_dir" && shasum -a 256 ConnectWallet-*.app.zip > SHA256SUMS)
fi
