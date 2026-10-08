#!/usr/bin/env bash
# Deterministic build-script fixture: no Apple tools, network or wallet access.
set -euo pipefail

uname() { if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi; }
ninja() { :; }
npm() { :; }
swift() { :; }
node() {
  if [[ "$1" == -p ]]; then echo 1.0.0
  elif [[ "$1" == -e ]]; then
    cat >/dev/null
    if [[ "$2" == *runtimes* ]]; then echo com.apple.CoreSimulator.SimRuntime.iOS-26-2
    else echo com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro; fi
  fi
}
cmake() {
  local build_dir='' arg
  while [[ $# -gt 0 ]]; do
    case "$1" in -B|--build) build_dir="$2"; shift ;; esac
    shift
  done
  [[ -n "$build_dir" ]] || return 1
  mkdir -p "$build_dir/licenses"
  for arg in connectwallet_wallet connectwallet_p2c connectwallet_scrypt secp256k1 mbedcrypto mbedx509 mbedtls; do
    printf 'mock archive\n' > "$build_dir/lib$arg.a"
  done
  printf 'mock license\n' > "$build_dir/licenses/LICENSE-SCRYPT.txt"
  printf 'mock license\n' > "$build_dir/licenses/LICENSE-SECP256K1.txt"
}
function /usr/libexec/PlistBuddy() {
  case "$2" in
    *CFBundleIdentifier) echo com.connectcoincrypto.connectwallet.mobile.alpha ;;
    *CFBundleDisplayName) echo ConnectWallet ;;
    *CFBundleShortVersionString) echo 1.0.0 ;;
    *CFBundleVersion) echo 2 ;;
    *) return 1 ;;
  esac
}
xcodebuild() {
  if [[ "$1" == -version ]]; then printf 'Xcode 26.3\nBuild version 1\n'; return; fi
  local sdk='' derived='' result='' mode=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -sdk) sdk="$2"; shift ;;
      -derivedDataPath) derived="$2"; shift ;;
      -resultBundlePath) result="$2"; shift ;;
      test|build) mode="$1" ;;
    esac
    shift
  done
  if [[ "$mode" == test ]]; then
    if [[ -e "$result" ]]; then echo 'Refusing existing resultBundlePath' >&2; return 73; fi
    mkdir -p "$result"
    printf 'current invocation fixture\n' > "$result/fixture.txt"
    return "${IOS_BUILD_TEST_EXIT:-0}"
  fi
  local product="$derived/Build/Products/Release-$sdk/App.app"
  mkdir -p "$product"
  printf 'mock privacy manifest\n' > "$product/PrivacyInfo.xcprivacy"
  printf 'mock property list\n' > "$product/Info.plist"
}
xcrun() {
  local tool="$1"; shift
  case "$tool" in
    libtool)
      while [[ "$1" != -o ]]; do shift; done
      printf 'mock native library\n' > "$2" ;;
    lipo) echo 'mock arm64 image' ;;
    simctl)
      case "$1" in
        list) echo '{}' ;;
        create) echo 11111111-2222-3333-4444-555555555555 ;;
        boot|bootstatus|shutdown|delete) : ;;
        io) printf 'mock screenshot\n' > "$4" ;;
        spawn) echo 'mock simulator log' ;;
        *) return 1 ;;
      esac ;;
    xcresulttool)
      if [[ "$1" == export ]]; then
        while [[ "$1" != --output-path ]]; do shift; done
        mkdir -p "$2"
        printf 'current invocation fixture\n' > "$2/fixture.txt"
      else printf '{"fixture":true}\n'; fi ;;
    *) return 1 ;;
  esac
}
ditto() { printf 'mock packaged app\n' > "${!#}"; }
shasum() {
  shift 2
  local archive
  for archive in "$@"; do printf 'mock-sha256  %s\n' "$archive"; done
}
find() {
  # Never inspect real host crash reports while testing diagnostic collection.
  if [[ "$1" == *'/.tools/ios-native/'* ]]; then command find "$@"; fi
}

source "$1" "$2"
