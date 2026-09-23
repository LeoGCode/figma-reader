#!/bin/sh
# Container tests, kept out of `npm test`: they need a daemon and take a minute, and a suite that is slow enough to
# skip stops being run. Each covers something a checkout structurally cannot.
set -eu
cd "$(dirname "$0")/../.."

echo "==> picker: a machine whose /usr/bin/chromium links into a snap"
# /snap cannot be made without root, so on a developer machine or a CI runner the demotion is only testable as
# strings. Here it is a real layout, and the confined build really does exit without opening a port.
docker build -q -f test/docker/picker.Dockerfile -t figma-reader-picker-test . >/dev/null
docker run --rm figma-reader-picker-test

echo
echo "==> smoke: the packed artifact on a machine with nothing of ours on it"
# A local install shares this checkout's node_modules and npm cache, so it cannot see a dependency that resolves
# only because it is already there, or a file the manifest forgets to ship.
npm pack >/dev/null
TARBALL=$(ls -t leogcode-figma-reader-*.tgz | head -1)
trap 'rm -f "$TARBALL"' EXIT
docker build -q -f test/docker/smoke.Dockerfile --build-arg "TARBALL=$TARBALL" -t figma-reader-smoke-test . >/dev/null
docker run --rm figma-reader-smoke-test
