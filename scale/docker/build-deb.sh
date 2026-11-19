#!/bin/sh
# Builds the LabourLink Scale .deb inside the Ubuntu 24.04 build image.
# Run from the repo root on any machine with Docker:
#
#   docker build -t labourlink-scale-build -f scale/docker/Dockerfile.build scale/docker
#   docker run --rm -v "$PWD":/work -v llscale-cargo:/usr/local/cargo/registry \
#     -v llscale-deb-target:/cache/target labourlink-scale-build sh /work/scale/docker/build-deb.sh
#
# The repo is copied to /build first so the host's node_modules (possibly
# built for another OS) are never used. Output: scale/dist/*.deb
set -e
export CARGO_TARGET_DIR=/cache/target

rm -rf /build && mkdir -p /build
cd /work/scale
tar --exclude=node_modules --exclude=target --exclude=dist --exclude=src-tauri/bin -cf - service app packaging | tar -xf - -C /build

echo "== service: tests + release build"
cd /build/service
cargo test --release
cargo build --release
mkdir -p /build/app/src-tauri/bin
cp "$CARGO_TARGET_DIR/release/labourlink-scaled" /build/app/src-tauri/bin/

echo "== display: tests + tauri build"
cd /build/app
npm ci --no-audit --no-fund
npx vitest run
npx tauri build --bundles deb

mkdir -p /work/scale/dist
# Tauri names the bundle after productName ("LabourLink Scale_…"); ship it
# under the package name instead, without the space.
for f in "$CARGO_TARGET_DIR"/release/bundle/deb/*.deb; do
  cp "$f" "/work/scale/dist/$(basename "$f" | sed 's/^LabourLink Scale_/labourlink-scale_/')"
done
ls -l /work/scale/dist
