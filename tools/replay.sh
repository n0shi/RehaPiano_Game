#!/bin/sh
# Builds tools/replay.ts with the esbuild binary shipped in node_modules and runs it. Usage: see the header of tools/replay.ts
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# node_modules may hold binaries for several platforms (copied from another machine): take the first one that runs here
ESBUILD=""
for b in "$ROOT"/node_modules/@esbuild/*/bin/esbuild; do
  if "$b" --version >/dev/null 2>&1; then ESBUILD="$b"; break; fi
done
[ -n "$ESBUILD" ] || { echo "no runnable esbuild in node_modules: run npm ci first" >&2; exit 1; }
OUT="${TMPDIR:-/tmp}/rehapiano-replay-$$.cjs"
"$ESBUILD" "$ROOT/tools/replay.ts" --bundle --platform=node --format=cjs --log-level=warning --outfile="$OUT"
node "$OUT" "$@"; CODE=$?
rm -f "$OUT"
exit $CODE
