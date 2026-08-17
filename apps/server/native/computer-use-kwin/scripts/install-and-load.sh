#!/usr/bin/env bash
set -euo pipefail

umask 077

PLUGIN_PREFIX="SynaraComputerUsePlugin"
PLUGIN_DIR="${SYNARA_KWIN_PLUGIN_DIR:-/usr/lib64/qt6/plugins/kwin/plugins}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_ROOT="${SYNARA_KWIN_CACHE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/synara/kwin-computer-use-plugin}"
STATE_ROOT="${SYNARA_KWIN_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/synara/kwin-computer-use-plugin}"
BUILD_DIR="${SYNARA_KWIN_BUILD_DIR:-$CACHE_ROOT/build}"
STAMP_FILE="$STATE_ROOT/install.stamp"
LOCK_FILE="$STATE_ROOT/install.lock"

FORCE=0
NONINTERACTIVE=0

usage() {
    cat <<EOF
Usage: $0 [--force] [--noninteractive]

Builds the Synara KWin plugin against the installed KWin headers, installs it
under the next unused versioned filename, unloads older Synara plugin ids, and
loads the new id into the current KWin session.

  --force           create and load a new version even when the signature is unchanged
  --noninteractive  pass -n to sudo, for user systemd services
EOF
}

log() {
    printf '[synara-kwin-plugin] %s\n' "$*"
}

die() {
    printf '[synara-kwin-plugin] ERROR: %s\n' "$*" >&2
    exit 1
}

need_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)
            FORCE=1
            shift
            ;;
        --noninteractive)
            NONINTERACTIVE=1
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "Unknown argument: $1"
            ;;
    esac
done

need_command cmake
need_command ninja
need_command sha256sum
need_command stat
need_command awk
need_command grep
need_command sort
need_command flock
need_command mktemp
need_command busctl
need_command sudo

[[ -d "$PLUGIN_DIR" ]] || die "KWin plugin directory does not exist: $PLUGIN_DIR"

mkdir -p "$CACHE_ROOT" "$STATE_ROOT"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "another rebuild or install is already running"
    exit 0
fi

source_hash() {
    (
        cd -- "$SOURCE_DIR"
        sha256sum \
            CMakeLists.txt \
            metadata.json \
            main.cpp \
            synaracomputeruseplugin.h \
            synaracomputeruseplugin.cpp \
            synaracomputerusebuildinfo.h.in |
            sha256sum |
            awk '{ print $1 }'
    )
}

path_signature() {
    local path
    for path in \
        /usr/lib64/libkwin.so* \
        /usr/lib64/cmake/KWin/KWinConfig.cmake \
        /usr/lib64/cmake/KWin/KWinConfigVersion.cmake \
        /usr/lib64/cmake/KWin/KWinTargets.cmake
    do
        if [[ -e "$path" ]]; then
            stat -Lc '%n:%i:%s:%Y' "$path"
        fi
    done
}

rpm_signature() {
    if command -v rpm >/dev/null 2>&1; then
        rpm -q kwin kwin-libs kwin-devel 2>/dev/null || true
    fi
}

kwin_version() {
    if command -v kwin_wayland >/dev/null 2>&1; then
        kwin_wayland --version 2>/dev/null || true
    fi
}

current_signature_details() {
    printf 'source=%s\n' "$(source_hash)"
    printf 'plugin_dir=%s\n' "$PLUGIN_DIR"
    printf 'kwin_version=%s\n' "$(kwin_version)"
    printf 'rpm_signature<<EOF\n%s\nEOF\n' "$(rpm_signature)"
    printf 'path_signature<<EOF\n%s\nEOF\n' "$(path_signature)"
}

current_signature="$(current_signature_details | sha256sum | awk '{ print $1 }')"
installed_signature=""
installed_plugin_id=""
if [[ -f "$STAMP_FILE" ]]; then
    installed_signature="$(awk -F= '/^signature=/{ print $2; exit }' "$STAMP_FILE")"
    installed_plugin_id="$(awk -F= '/^plugin_id=/{ print $2; exit }' "$STAMP_FILE")"
fi

valid_plugin_id() {
    [[ "$1" =~ ^${PLUGIN_PREFIX}(V[0-9]+)?$ ]]
}

known_plugin_ids() {
    local path name
    local plugin_files=()

    shopt -s nullglob
    plugin_files=("$PLUGIN_DIR"/${PLUGIN_PREFIX}*.so)
    shopt -u nullglob

    {
        printf '%s\n' "$PLUGIN_PREFIX"
        for path in "${plugin_files[@]}"; do
            name="${path##*/}"
            name="${name%.so}"
            if valid_plugin_id "$name"; then
                printf '%s\n' "$name"
            fi
        done
    } | sort -u
}

extract_plugin_ids() {
    printf '%s\n' "$1" |
        grep -oE "${PLUGIN_PREFIX}(V[0-9]+)?" |
        sort -u || true
}

next_plugin_id() {
    local path name version max_version=0
    local plugin_files=()

    shopt -s nullglob
    plugin_files=("$PLUGIN_DIR"/${PLUGIN_PREFIX}*.so)
    shopt -u nullglob

    for path in "${plugin_files[@]}"; do
        name="${path##*/}"
        if [[ "$name" =~ ^${PLUGIN_PREFIX}V([0-9]+)\.so$ ]]; then
            version="${BASH_REMATCH[1]}"
            if (( version > max_version )); then
                max_version="$version"
            fi
        fi
    done

    printf '%sV%d\n' "$PLUGIN_PREFIX" "$((max_version + 1))"
}

# KWin's UnloadPlugin reply differs by version: some return `b`, newer ones are
# void. Treat a successful call with an empty or `b true` reply as unloaded and
# only `b false` as "was not loaded"; any call failure is fatal.
unload_plugin() {
    local plugin_id="$1"
    local response

    if ! response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s "$plugin_id" 2>&1)"; then
        die "KWin D-Bus UnloadPlugin failed for $plugin_id: $response"
    fi
    if [[ "$response" == *"b false"* ]]; then
        return 0
    fi
    log "unloaded $plugin_id"
}

sudo_install() {
    local source_path="$1"
    local destination_path="$2"
    local sudo_options=()

    if (( NONINTERACTIVE )); then
        sudo_options=(-n)
    fi
    if ! sudo "${sudo_options[@]}" install -m 755 "$source_path" "$destination_path"; then
        die "sudo install failed for $destination_path"
    fi
}

plugin_id=""
needs_install=1
if (( FORCE == 0 )) && [[ "$installed_signature" == "$current_signature" ]] && valid_plugin_id "$installed_plugin_id" && [[ -f "$PLUGIN_DIR/$installed_plugin_id.so" ]]; then
    plugin_id="$installed_plugin_id"
    needs_install=0
    log "signature is unchanged; reusing installed $plugin_id"
fi

if (( needs_install )); then
    log "configuring the plugin build in $BUILD_DIR"
    cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
    cmake --build "$BUILD_DIR"

    built_plugin="$BUILD_DIR/kwin/plugins/${PLUGIN_PREFIX}.so"
    [[ -f "$built_plugin" ]] || die "CMake did not produce $built_plugin"

    plugin_id="$(next_plugin_id)"
    destination="$PLUGIN_DIR/$plugin_id.so"
    log "installing $plugin_id to $destination"
    sudo_install "$built_plugin" "$destination"
else
    destination="$PLUGIN_DIR/$plugin_id.so"
fi

# Loaded-plugin discovery also differs by KWin version: prefer the
# LoadedPlugins property, fall back to the loadedPlugins method, then to every
# Synara id we could have installed.
old_plugin_ids=""
if loaded_response="$(busctl --user get-property org.kde.KWin /Plugins org.kde.KWin.Plugins LoadedPlugins 2>&1)"; then
    old_plugin_ids="$(extract_plugin_ids "$loaded_response")"
    log "queried the LoadedPlugins property"
elif loaded_response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins loadedPlugins 2>&1)"; then
    old_plugin_ids="$(extract_plugin_ids "$loaded_response")"
    log "queried loaded KWin plugin ids"
else
    old_plugin_ids="$(known_plugin_ids)"
    log "KWin loaded-plugin queries are unavailable; trying known Synara plugin ids"
fi

if [[ -n "$old_plugin_ids" ]]; then
    while IFS= read -r old_plugin_id; do
        [[ -n "$old_plugin_id" ]] || continue
        unload_plugin "$old_plugin_id"
    done <<< "$old_plugin_ids"
fi

load_response=""
if ! load_response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins LoadPlugin s "$plugin_id" 2>&1)"; then
    die "KWin D-Bus LoadPlugin failed for $plugin_id: $load_response"
fi
if [[ "$load_response" != *"b true"* ]]; then
    die "KWin refused $plugin_id: $load_response. This usually means the plugin has a mismatching plugin version. Rebuild on this host against its installed kwin-devel package and inspect: journalctl --user -b -g 'mismatching plugin version'"
fi

health_response=""
if ! health_response="$(busctl --user call org.synara.ComputerUse /org/synara/ComputerUse org.synara.ComputerUse1 healthJson 2>&1)"; then
    die "plugin $plugin_id loaded, but healthJson failed: $health_response"
fi
printf '%s\n' "$health_response"

if (( needs_install )); then
    stamp_tmp="$(mktemp "$STATE_ROOT/install.stamp.XXXXXX")"
    {
        printf 'signature=%s\n' "$current_signature"
        printf 'plugin_id=%s\n' "$plugin_id"
        printf 'installed_at=%s\n' "$(date -Is)"
        printf 'plugin_path=%s\n' "$destination"
        # The server reads this back to explain a later LoadPlugin refusal:
        # KWin only accepts a plugin built against the running KWin version.
        printf 'kwin_version=%s\n' "$(kwin_version | head -n 1)"
    } >"$stamp_tmp"
    mv -f "$stamp_tmp" "$STAMP_FILE"
fi

log "Synara KWin plugin is loaded as $plugin_id"
