#!/usr/bin/env bash
set -euo pipefail

PLUGIN_PREFIX="SynaraComputerUsePlugin"
PLUGIN_DIR="${SYNARA_KWIN_PLUGIN_DIR:-/usr/lib64/qt6/plugins/kwin/plugins}"

log() {
    printf '[synara-kwin-plugin] %s\n' "$*"
}

die() {
    printf '[synara-kwin-plugin] ERROR: %s\n' "$*" >&2
    exit 1
}

valid_plugin_id() {
    [[ "$1" =~ ^${PLUGIN_PREFIX}(V[0-9]+)?$ ]]
}

known_plugin_ids() {
    local path name
    local plugin_files=()

    shopt -s nullglob
    plugin_files=("$PLUGIN_DIR"/${PLUGIN_PREFIX}*.so)
    shopt -u nullglob

    for path in "${plugin_files[@]}"; do
        name="${path##*/}"
        name="${name%.so}"
        if valid_plugin_id "$name"; then
            printf '%s\n' "$name"
        fi
    done | sort -u
}

extract_plugin_ids() {
    printf '%s\n' "$1" |
        grep -oE "${PLUGIN_PREFIX}(V[0-9]+)?" |
        sort -u || true
}

unload_required() {
    local plugin_id="$1"
    local response

    if ! response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s "$plugin_id" 2>&1)"; then
        die "failed to unload currently-loaded plugin $plugin_id: $response"
    fi
    if [[ "$response" != *"b true"* ]]; then
        die "KWin refused to unload currently-loaded plugin $plugin_id: $response"
    fi
    log "unloaded $plugin_id"
}

unload_if_present() {
    local plugin_id="$1"
    local response

    if ! response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s "$plugin_id" 2>&1)"; then
        log "could not contact KWin while trying $plugin_id; continuing with file removal"
        return
    fi
    if [[ "$response" == *"b true"* ]]; then
        log "unloaded $plugin_id"
    elif [[ "$response" != *"b false"* ]]; then
        log "KWin returned an unexpected response for $plugin_id: $response"
    fi
}

[[ -d "$PLUGIN_DIR" ]] || {
    log "KWin plugin directory does not exist; nothing to remove: $PLUGIN_DIR"
    exit 0
}

plugin_files=()
shopt -s nullglob
plugin_files=("$PLUGIN_DIR"/${PLUGIN_PREFIX}*.so)
shopt -u nullglob

if (( ${#plugin_files[@]} == 0 )); then
    log "no installed Synara KWin plugin files found"
    exit 0
fi

loaded_query_available=0
loaded_plugin_ids=""
if command -v busctl >/dev/null 2>&1; then
    if loaded_response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins loadedPlugins 2>&1)"; then
        loaded_query_available=1
        loaded_plugin_ids="$(extract_plugin_ids "$loaded_response")"
    else
        loaded_plugin_ids="$(known_plugin_ids)"
        log "KWin loadedPlugins is unavailable; trying known Synara plugin ids"
    fi

    if [[ -n "$loaded_plugin_ids" ]]; then
        while IFS= read -r plugin_id; do
            [[ -n "$plugin_id" ]] || continue
            if (( loaded_query_available )); then
                unload_required "$plugin_id"
            else
                unload_if_present "$plugin_id"
            fi
        done <<< "$loaded_plugin_ids"
    fi
else
    log "busctl is unavailable; removing plugin files without a KWin unload call"
fi

command -v sudo >/dev/null 2>&1 || die "Missing required command: sudo"
if ! sudo rm -f -- "${plugin_files[@]}"; then
    die "sudo could not remove the installed Synara KWin plugin files"
fi

log "removed ${#plugin_files[@]} installed Synara KWin plugin file(s)"
