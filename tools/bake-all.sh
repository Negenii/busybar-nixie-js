#!/bin/sh
# Rebuilds src/animations from the renderer: 12 tube sets, the hint and the gauge.
# Needs Node, Python 3 with Pillow, and scripts/seq2anim.py from the BUSY Bar firmware
# (https://github.com/busy-app/busybar-firmware), given as SEQ2ANIM. Takes a few minutes.
set -eu
cd "$(dirname "$0")"
: "${SEQ2ANIM:?set SEQ2ANIM to <busybar-firmware>/scripts/seq2anim.py}"
PY=${PYTHON:-python3}
OUT=${OUT:-../.bake}
DEST=../src/animations

# <dir> <stem> <width> <height> <name in DEST>
convert() {
  AW=$3 AH=$4 "$PY" raw2anim.py "$1" "$2"
  "$PY" "$SEQ2ANIM" -o "$1/$2.anim" "$1/$2.zip" >/dev/null
  cp "$1/$2.anim" "$DEST/$5.anim"
}

bake_set() { # <colour name> <colour index> <level> <count>
  set_name=$1-$3-$4; dir=$OUT/$set_name
  node bake.mjs "$dir" "$2" "$3" "$4" >/dev/null
  mkdir -p "$DEST/$set_name"
  i=0; while [ $i -lt "$4" ]; do convert "$dir" s$i 11 15 "$set_name/tube$i"; i=$((i + 1)); done
  convert "$dir" k 2 15 "$set_name/colons"
  echo "$set_name"
}

for colour in orange:0 white:4; do
  for level in steady calm live; do
    for count in 4 6; do bake_set "${colour%:*}" "${colour#*:}" $level $count & done
  done
done
wait

mkdir -p "$DEST/ui"
node bake_hint.mjs "$OUT/ui" >/dev/null && convert "$OUT/ui" hint 72 16 ui/hint
node bake_gauge.mjs "$OUT/ui" >/dev/null && convert "$OUT/ui" gauge 72 1 ui/gauge

# busy-cli's Vite inlines assets under 4 KB into the script, and the firmware cannot open those
small=$(find "$DEST" -name '*.anim' -size -4096c)
if [ -n "$small" ]; then echo "under 4 KB, would be inlined: $small" >&2; exit 1; fi
