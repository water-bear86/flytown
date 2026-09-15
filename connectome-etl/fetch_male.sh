#!/bin/sh
# Fetch the pinned MaleCNS v1.0 inputs for build_male.py into raw/malecns/ and
# verify each against the MD5 in Janelia's public bucket metadata (~3 GB).
set -e
DEST="$(cd "$(dirname "$0")" && pwd)/raw/malecns"
mkdir -p "$DEST"
cd "$DEST"
BASE="https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
md5b64() { python3 -c "import base64,hashlib,sys; h=hashlib.md5(); f=open(sys.argv[1],'rb'); [h.update(c) for c in iter(lambda: f.read(8<<20), b'')]; print(base64.b64encode(h.digest()).decode())" "$1"; }
for spec in \
  "body-annotations-male-cns-v1.0-minconf-0.5.feather UKdxh3DFciDxYLpPQxq4ng==" \
  "body-neurotransmitters-male-cns-v1.0.feather PYQrEv5cSe763lKNfdJKHw==" \
  "syn-partners-male-cns-v1.0-minconf-0.5-traced-only.feather 9bwcXONKAbaJVkFLUw7dqA=="; do
  name=${spec% *}; md5=${spec#* }
  if [ -f "$name" ] && [ "$(md5b64 "$name")" = "$md5" ]; then echo "$(date +%H:%M:%S) OK   $name already present and verified"; continue; fi
  echo "$(date +%H:%M:%S) fetching $name"
  curl -sS -L --fail --retry 8 --retry-delay 5 -C - -o "$name" "$BASE/$name"
  got=$(md5b64 "$name")
  if [ "$got" = "$md5" ]; then echo "$(date +%H:%M:%S) OK   $name md5 verified"; else echo "$(date +%H:%M:%S) FAIL $name md5 $got != $md5"; exit 1; fi
done
echo "$(date +%H:%M:%S) all inputs verified"
