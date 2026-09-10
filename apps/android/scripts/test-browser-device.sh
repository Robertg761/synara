#!/usr/bin/env bash
# Test-only trust injection into an explicitly selected, rooted Android emulator.
set -euo pipefail
umask 077
serial=${1:?Usage: test-browser-device.sh emulator-SERIAL}
if [[ ! "$serial" =~ ^emulator-[0-9]+$ ]] || [[ $(adb -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r') != 1 ]]; then
  echo "Refusing to modify certificate trust outside an explicitly selected emulator." >&2
  exit 1
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
android_dir=$(cd "$script_dir/.." && pwd)
fixture_dir=$(mktemp -d)
fixture_port=${SYNARA_BROWSER_FIXTURE_PORT:-59443}
if [[ ! "$fixture_port" =~ ^[0-9]+$ ]] || (( fixture_port < 1024 || fixture_port > 65535 )); then exit 1; fi
remote_dir="/data/local/tmp/synara-browser-fixture-$(basename "$fixture_dir")"
server_pid=""
mounted_pids=()
adb_mounted=false
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  adb -s "$serial" shell am force-stop com.synara.android >/dev/null 2>&1 || true
  adb -s "$serial" shell am force-stop com.synara.android.test >/dev/null 2>&1 || true
  for pid in "${mounted_pids[@]}"; do
    adb -s "$serial" shell nsenter -t "$pid" -m -- umount /apex/com.android.conscrypt/cacerts >/dev/null 2>&1 || true
  done
  if $adb_mounted; then adb -s "$serial" shell umount /apex/com.android.conscrypt/cacerts >/dev/null 2>&1 || true; fi
  adb -s "$serial" shell rm -rf "$remote_dir" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
  exit "$result"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$fixture_dir/ca.key" -out "$fixture_dir/ca.pem" -subj '/CN=Synara browser instrumentation CA' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$fixture_dir/server.key" -out "$fixture_dir/server.csr" -subj '/CN=Synara browser fixture' >/dev/null 2>&1
cat > "$fixture_dir/server.ext" <<'CERT'
subjectAltName=IP:10.0.2.2,IP:127.0.0.1,DNS:localhost
extendedKeyUsage=serverAuth
basicConstraints=CA:FALSE
CERT
openssl x509 -req -in "$fixture_dir/server.csr" -CA "$fixture_dir/ca.pem" -CAkey "$fixture_dir/ca.key" -CAcreateserial -days 1 -out "$fixture_dir/server.pem" -extfile "$fixture_dir/server.ext" >/dev/null 2>&1
cert_hash=$(openssl x509 -in "$fixture_dir/ca.pem" -subject_hash_old -noout)
adb -s "$serial" root
adb -s "$serial" wait-for-device
[[ $(adb -s "$serial" shell id -u | tr -d '\r') == 0 ]]
adb -s "$serial" shell mkdir -p "$remote_dir"
adb -s "$serial" shell "cp /apex/com.android.conscrypt/cacerts/* '$remote_dir/'"
adb -s "$serial" push "$fixture_dir/ca.pem" "$remote_dir/$cert_hash.0" >/dev/null
adb -s "$serial" shell "chown -R root:root '$remote_dir' && chmod 755 '$remote_dir' && chmod 644 '$remote_dir'/* && chcon -R u:object_r:system_file:s0 '$remote_dir'"
for pid in $(adb -s "$serial" shell pidof zygote64 zygote | tr -d '\r'); do
  adb -s "$serial" shell nsenter -t "$pid" -m -- mount --bind "$remote_dir" /apex/com.android.conscrypt/cacerts
  mounted_pids+=("$pid")
done
[[ ${#mounted_pids[@]} -gt 0 ]]
adb -s "$serial" shell mount --bind "$remote_dir" /apex/com.android.conscrypt/cacerts
adb_mounted=true
adb -s "$serial" shell am force-stop com.synara.android
node "$script_dir/browser-fixture.mjs" "$fixture_dir/server.key" "$fixture_dir/server.pem" "$fixture_port" > "$fixture_dir/server.log" 2>&1 &
server_pid=$!
for attempt in {1..50}; do
  if curl --silent --fail --cacert "$fixture_dir/ca.pem" "https://127.0.0.1:$fixture_port/browser-fixture" >/dev/null; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$fixture_dir/server.log" >&2; exit 1; fi
  sleep 0.1
done
curl --silent --fail --cacert "$fixture_dir/ca.pem" "https://127.0.0.1:$fixture_port/browser-fixture" >/dev/null
# Install and execute only on the selected emulator. Do not let Gradle discover other devices.
"$android_dir/gradlew" -p "$android_dir" :app:assembleDebug :app:assembleDebugAndroidTest --stacktrace
adb -s "$serial" install -r "$android_dir/app/build/outputs/apk/debug/app-debug.apk"
adb -s "$serial" install -r "$android_dir/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
args=(-w -e browserFixtureUrl "https://10.0.2.2:$fixture_port/browser-fixture")
if [[ -n "${SYNARA_BROWSER_TEST_CLASS:-}" ]]; then args+=(-e class "$SYNARA_BROWSER_TEST_CLASS"); fi
mkdir -p "$android_dir/app/build/reports"
report="$android_dir/app/build/reports/browser-device-tests.txt"
adb -s "$serial" shell am instrument "${args[@]}" com.synara.android.test/androidx.test.runner.AndroidJUnitRunner | tee "$report"
# am instrument may return exit code zero even when JUnit fails.
if ! grep -Eq '^OK \([0-9]+ tests?\)' "$report"; then exit 1; fi
