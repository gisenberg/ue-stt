#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${ROOT_DIR}/vendor"
SPEECH_SWIFT_DIR="${VENDOR_DIR}/speech-swift"
SPEECH_SWIFT_REPO="${SPEECH_SWIFT_REPO:-https://github.com/soniqo/speech-swift.git}"

mkdir -p "${VENDOR_DIR}"

if [[ -d "${SPEECH_SWIFT_DIR}/.git" ]]; then
  git -C "${SPEECH_SWIFT_DIR}" pull --ff-only
else
  git clone --depth 1 "${SPEECH_SWIFT_REPO}" "${SPEECH_SWIFT_DIR}"
fi

if ! xcrun -f metal >/dev/null 2>&1; then
  echo "Installing Xcode Metal Toolchain component..."
  xcodebuild -downloadComponent MetalToolchain
fi

make -C "${SPEECH_SWIFT_DIR}" build

"${SPEECH_SWIFT_DIR}/.build/release/speech" --help >/dev/null
echo "speech-swift ready at ${SPEECH_SWIFT_DIR}/.build/release/speech"
