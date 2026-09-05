#!/bin/bash
# Creates a self-signed code-signing identity for local Synara builds.
#
# Why you want one
# ----------------
# macOS pins a TCC grant made to an ad-hoc signed app to that build's cdhash.
# Every local rebuild changes the cdhash, so Accessibility and Screen Recording
# silently stop applying while System Settings goes on showing Synara switched
# on — the failure mode a user cannot diagnose from the outside, and the one
# that makes local computer-use work impossible to iterate on. A real signing
# identity, even a self-signed one, gives the app a stable designated
# requirement (identifier + certificate), and TCC keys the grant on that
# instead. Grant it once and it survives every rebuild.
#
# This script only creates and imports the certificate. Trusting it needs your
# login password in a Keychain Access dialog that cannot be scripted safely, so
# the exact steps are printed at the end for you to do by hand.
#
# Usage:
#   bash scripts/create-local-signing-identity.sh [common-name]
#
# Idempotent: an existing identity with the same common name is reported and
# left alone.

set -euo pipefail

COMMON_NAME="${1:-${SYNARA_LOCAL_SIGNING_IDENTITY:-Synara Dev}}"
# 10 years: long enough that the certificate never expires mid-project, short
# enough that a forgotten one does not live forever.
VALIDITY_DAYS="${SYNARA_LOCAL_SIGNING_VALIDITY_DAYS:-3650}"
LOGIN_KEYCHAIN="$(security default-keychain | tr -d '"' | xargs)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: code-signing identities are a macOS concept; nothing to do here." >&2
  exit 1
fi

# `find-identity -v -p codesigning` lists only identities that are valid *and*
# trusted for code signing, so it answers "is this usable?" rather than "does a
# certificate by this name exist?". A half-finished run — certificate imported,
# trust not yet granted — must therefore fall through to the instructions.
if security find-identity -v -p codesigning | grep -Fq "\"$COMMON_NAME\""; then
  echo "Signing identity \"$COMMON_NAME\" already exists and is trusted for code signing."
  echo
  echo "Build with it:"
  echo "  CSC_NAME=\"$COMMON_NAME\" bun run dist:desktop:dmg:arm64 -- --signed"
  exit 0
fi

if security find-certificate -c "$COMMON_NAME" "$LOGIN_KEYCHAIN" >/dev/null 2>&1; then
  echo "A certificate named \"$COMMON_NAME\" is already in $LOGIN_KEYCHAIN but is not"
  echo "trusted for code signing yet. Skipping creation; finish the trust step below."
else
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/synara-signing-identity.XXXXXX")"
  trap 'rm -rf "$WORK_DIR"' EXIT

  # A code-signing certificate is an ordinary self-signed X.509 with two
  # non-negotiable extensions: `codeSigning` extended key usage, and
  # `digitalSignature` key usage. Without them `codesign` rejects the identity
  # with "no identity found" rather than anything that names the real problem.
  cat >"$WORK_DIR/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = codesign
prompt = no

[ dn ]
CN = $COMMON_NAME

[ codesign ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

  echo "Creating a self-signed code-signing certificate for \"$COMMON_NAME\"..."
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$WORK_DIR/key.pem" \
    -out "$WORK_DIR/cert.pem" \
    -days "$VALIDITY_DAYS" \
    -config "$WORK_DIR/openssl.cnf" >/dev/null 2>&1

  # A PKCS#12 bundle is how the certificate and its private key enter the
  # keychain as one identity; importing them separately leaves a certificate
  # `codesign` cannot sign with. The passphrase is local to this script and the
  # file it protects is deleted on exit.
  openssl pkcs12 -export \
    -inkey "$WORK_DIR/key.pem" \
    -in "$WORK_DIR/cert.pem" \
    -name "$COMMON_NAME" \
    -passout pass:synara \
    -out "$WORK_DIR/identity.p12" >/dev/null 2>&1

  # `-T /usr/bin/codesign` lets codesign use the key without prompting for the
  # login password on every single build.
  security import "$WORK_DIR/identity.p12" \
    -k "$LOGIN_KEYCHAIN" \
    -P synara \
    -T /usr/bin/codesign \
    -T /usr/bin/security >/dev/null

  # Without this, the first `codesign` run raises a blocking "wants to use your
  # confidential information" dialog per build.
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 ||
    echo "note: could not pre-authorize codesign for the new key; macOS may prompt on the first build."

  echo "Imported \"$COMMON_NAME\" into $LOGIN_KEYCHAIN."
fi

cat <<EOF

One manual step is left — trusting the certificate for code signing. It needs
your login password in a dialog macOS will not let a script drive:

  1. Open Keychain Access, choose the "login" keychain and the "My Certificates"
     category, and double-click "$COMMON_NAME".
  2. Expand "Trust", set "Code Signing" to "Always Trust", close the window and
     enter your password when asked.

Or, equivalently, from a terminal (this also prompts for your password):

  sudo security add-trusted-cert -d -r trustRoot \\
    -p codeSign -k /Library/Keychains/System.keychain \\
    <(security find-certificate -c "$COMMON_NAME" -p "$LOGIN_KEYCHAIN")

Confirm it took:

  security find-identity -v -p codesigning | grep "$COMMON_NAME"

Then build a locally signed Synara:

  CSC_NAME="$COMMON_NAME" bun run dist:desktop:dmg:arm64 -- --signed

See docs/release.md, "Locally signed builds", for what this buys you.
EOF
