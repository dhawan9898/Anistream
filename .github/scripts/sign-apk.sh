#!/usr/bin/env bash
# sign-apk.sh IN.apk OUT.apk
#
# Aligns and signs a release APK with key rotation, so phones that already have the app installed
# keep updating in place:
#   - the NEW key (KEYSTORE_BASE64 / KEYSTORE_PASSWORD / KEY_ALIAS) is the current signer;
#   - the OLD key (OLD_KEYSTORE_BASE64 / OLD_KEYSTORE_PASSWORD / OLD_KEY_ALIAS) stays in the signing
#     chain, because Android 12 and older only understand the original signer;
#   - LINEAGE_BASE64 is the signed old -> new chain. On Android 13+ the old key is not accepted
#     for a downgrade once the new one has been installed.
# The keys come from repository secrets only and are never written outside a temporary directory.
set -euo pipefail

IN="${1:?usage: sign-apk.sh IN.apk OUT.apk}"
OUT="${2:?usage: sign-apk.sh IN.apk OUT.apk}"

for v in KEYSTORE_BASE64 KEYSTORE_PASSWORD KEY_ALIAS OLD_KEYSTORE_BASE64 OLD_KEYSTORE_PASSWORD OLD_KEY_ALIAS LINEAGE_BASE64; do
  if [ -z "${!v:-}" ]; then
    echo "::error::The $v secret is not set: the release cannot be signed."
    exit 1
  fi
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "$KEYSTORE_BASE64" | base64 -d > "$WORK/new.p12"
echo "$OLD_KEYSTORE_BASE64" | base64 -d > "$WORK/old.p12"
echo "$LINEAGE_BASE64" | base64 -d > "$WORK/lineage.bin"

BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
mkdir -p "$(dirname "$OUT")"
"$BT/zipalign" -f -p 4 "$IN" "$WORK/aligned.apk"

export NEW_PASS="$KEYSTORE_PASSWORD" OLD_PASS="$OLD_KEYSTORE_PASSWORD"
"$BT/apksigner" sign \
  --ks "$WORK/old.p12" --ks-type pkcs12 --ks-key-alias "$OLD_KEY_ALIAS" --ks-pass env:OLD_PASS \
  --next-signer \
  --ks "$WORK/new.p12" --ks-type pkcs12 --ks-key-alias "$KEY_ALIAS" --ks-pass env:NEW_PASS \
  --lineage "$WORK/lineage.bin" \
  --out "$OUT" "$WORK/aligned.apk"

# Never publish an APK that does not carry the v2 and v3 signatures (v3 holds the rotation chain).
REPORT="$("$BT/apksigner" verify --print-certs -v "$OUT")"
echo "$REPORT"
echo "$REPORT" | grep -q "Verified using v3 scheme (APK Signature Scheme v3): true" || { echo "::error::The APK is not v3 signed."; exit 1; }
echo "$REPORT" | grep -q "Verified using v2 scheme (APK Signature Scheme v2): true" || { echo "::error::The APK is not v2 signed."; exit 1; }
ls -lh "$OUT"
