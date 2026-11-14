#!/usr/bin/env bash
# Builds whisper.cpp's `whisper-server` for the macOS app (docs/specs/2026-11-14-local-voice-dictation.md,
# decision 4): the api spawns it as the dictation engine, and the `.dmg` ships it as
# Contents/Resources/bin/whisper-server (quasar.config.ts runs this script from beforePackaging).
# A dev run can point KERMANYCH_WHISPER_SERVER at the same output.
#
# The binary must run on any Apple Silicon Mac with nothing installed, so it is built
# self-contained: ggml and whisper linked statically, the Metal shaders embedded in the binary,
# and only system libraries/frameworks left as dylib deps (checked below with otool).
#
# Idempotent: when the output already matches the pinned commit it exits at once, so a tag bump
# below rebuilds on the next `pnpm build:app` and an unchanged one costs nothing.
set -euo pipefail

# Pinned release. The commit is checked after the clone so a moved tag cannot slip in other code.
TAG=v1.9.5
COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037

# Outside apps/ui on purpose: the whisper.cpp tree carries .ts and *.spec.js files that apps/ui's
# tsconfig (`../**/*`) and vitest would pick up. Gitignored (repo root .gitignore).
WORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/.whisper-build"
SRC="$WORK/src-$TAG"
BUILD="$WORK/build-$TAG"
OUT_DIR="$WORK/bin"
OUT="$OUT_DIR/whisper-server"
STAMP="$OUT_DIR/whisper-server.commit"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "build-whisper-server: macOS on Apple Silicon only (the .dmg is arm64-only)" >&2
  exit 1
fi

if [[ -x "$OUT" && -f "$STAMP" && "$(cat "$STAMP")" == "$COMMIT" ]]; then
  echo "build-whisper-server: $OUT is whisper.cpp $TAG, nothing to do"
  exit 0
fi

if ! command -v cmake >/dev/null; then
  echo "build-whisper-server: cmake is missing (brew install cmake)" >&2
  exit 1
fi

if [[ ! -d "$SRC/.git" ]]; then
  rm -rf "$SRC"
  git clone --quiet --depth 1 --branch "$TAG" -c advice.detachedHead=false \
    https://github.com/ggml-org/whisper.cpp.git "$SRC"
fi
actual="$(git -C "$SRC" rev-parse HEAD)"
if [[ "$actual" != "$COMMIT" ]]; then
  echo "build-whisper-server: $TAG is $actual, expected $COMMIT; refusing to build" >&2
  exit 1
fi

# A fresh build dir: an interrupted run leaves half-generated embedded Metal objects that CMake
# does not regenerate, and the link then misses ggml_metallib_* symbols.
rm -rf "$BUILD"

# BUILD_SHARED_LIBS=OFF: libwhisper and libggml* linked into the binary, no @rpath dylibs.
# GGML_METAL_EMBED_LIBRARY: the .metal shaders compiled into the binary instead of a
#   default.metallib that would have to sit beside it.
# GGML_NATIVE=OFF: -mcpu=native on the build Mac (an M4 locally, an M1 in CI) would emit
#   instructions older Apple Silicon lacks; the heavy work runs on Metal anyway.
# GGML_OPENMP=OFF: a Homebrew libomp found on the build machine would become a dylib dep.
# CMAKE_OSX_DEPLOYMENT_TARGET=13.3: ggml's BLAS backend calls Accelerate's new-LAPACK cblas_sgemm,
#   introduced in macOS 13.3 (upstream's build-xcframework.sh uses the same minimum). On an older
#   macOS the server cannot start, and dictation reports the engine failure.
# The server lives under examples/, hence WHISPER_BUILD_EXAMPLES; only its target is built.
cmake -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.3 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_SDL2=OFF \
  -DWHISPER_CURL=OFF
cmake --build "$BUILD" --config Release --target whisper-server --parallel "$(sysctl -n hw.ncpu)"

BUILT="$BUILD/bin/whisper-server"
foreign="$(otool -L "$BUILT" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)' || true)"
if [[ -n "$foreign" ]]; then
  echo "build-whisper-server: the binary links non-system libraries:" >&2
  echo "$foreign" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
# install -m 0755: electron-builder copies the file with its mode, and the api spawns it.
install -m 0755 "$BUILT" "$OUT"
echo "$COMMIT" > "$STAMP"
echo "build-whisper-server: built $OUT (whisper.cpp $TAG)"
