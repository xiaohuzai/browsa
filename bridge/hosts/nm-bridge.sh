#!/usr/bin/env bash
# agent-bridge ⇄ local agent engine native-messaging bridge (macOS / Linux).
#
# ONE generic bridge serves every agent backend; the generated install
# command (options page) bakes the backend into the two marker lines below:
#   #__BRIDGE_BIN_NAME__     binary to discover (codex, codebuddy, ...)
#   #__BRIDGE_ARGS__         fixed engine args (e.g. "app-server --stdio")
# plus, when the user configured an explicit binary path, an override line:
#   #__BRIDGE_BIN_OVERRIDE__ (e.g. export AGENT_BRIDGE_BIN='/usr/local/bin/codex')
#
# Wire contract: Chrome launches this script per chrome.runtime.connectNative()
# and exchanges native-messaging frames (4-byte LE length + JSON) on
# stdin/stdout. Frame 1 is a control frame {"argv":["flag",...]} whose elements
# the client restricts to [A-Za-z0-9._-] (no quoting hazards); they are
# appended to the baked engine args (used to pass --resume <session-id>).
# After frame 1 the bridge is a dumb pipe: NM frames ↔ newline-delimited JSON
# on the engine's stdio.
#
# Binary discovery order: AGENT_BRIDGE_BIN → <bin> on PATH (extended with the
# usual dev prefixes — Chrome GUI apps get a minimal PATH on macOS) →
# ~/.codex/packages/standalone/current/<bin> (Codex desktop's managed copy;
# the check is harmless for other backends).
#
# On failure before the bridge is up it emits exactly one NM frame
# {"error":{code,message}} so the client can show a precise reason. Engine
# stderr is appended to a small log file for post-mortem. Users can export
# extra environment the engine needs (Chrome spawns us without the shell's
# exports — real case: ARK_API_KEY) via KEY=VALUE lines in
# ~/.agent-bridge.env.

set -u
export LC_ALL=C  # everything below is byte-oriented; no multibyte length math

#__BRIDGE_BIN_NAME__
#__BRIDGE_ARGS__
#__BRIDGE_BIN_OVERRIDE__

NM_LOG="${TMPDIR:-/tmp}/agent-bridge-${BRIDGE_BIN_NAME}.log"

if [ -f "$HOME/.agent-bridge.env" ]; then
  while IFS= read -r ev; do
    case "$ev" in ''|'#'*) continue ;; esac
    export "$ev"
  done <"$HOME/.agent-bridge.env"
fi

emit_error() {
  # $1 = machine-readable code, $2 = human message
  local payload msg
  msg=$(printf '%s' "$2" | tr -d '\r\n')
  payload=$(printf '{"error":{"code":"%s","message":"%s"}}' "$1" "$msg")
  local len=${#payload}
  printf "$(printf '\\x%02x\\x%02x\\x%02x\\x%02x' \
    $((len & 255)) $(((len >> 8) & 255)) $(((len >> 16) & 255)) $(((len >> 24) & 255)))"
  printf '%s' "$payload"
  printf '[agent-bridge] %s: %s\n' "$1" "$2" >>"$NM_LOG" 2>/dev/null
}

# ── read exactly $1 bytes from stdin, payload → stdout ───────────────────────
# NEVER use `head -c` here: macOS's BSD head reads a full pipe buffer and
# DISCARDS everything past the requested count (real Mac incident 2026-09-02:
# each 4-byte header read silently swallowed the frame payload behind it, so
# the engine never received a single complete message). `dd bs=N count=1`
# caps its read() at exactly N bytes on every platform. JSON payloads contain
# no NULs and never end with a newline, so command substitution is safe for
# them; the top-up loop covers short pipe reads on large frames.
read_exact_bytes() {
  local need=$1 payload more
  [ "$need" -le 0 ] && return 0
  payload=$(dd bs="$need" count=1 2>/dev/null) || return 1
  while [ ${#payload} -lt "$need" ]; do
    more=$(dd bs=$((need - ${#payload})) count=1 2>/dev/null) || return 1
    [ -n "$more" ] || return 1
    payload="$payload$more"
  done
  printf '%s' "$payload"
}

# ── read one NM frame from stdin, payload → stdout as text ───────────────────
read_frame_text() {
  local bytes
  bytes=$(dd bs=4 count=1 2>/dev/null | od -An -tu1 | tr '\n' ' ') || return 1
  set -- $bytes
  [ $# -eq 4 ] || return 1
  local len=$(( $1 + $2 * 256 + $3 * 65536 + $4 * 16777216 ))
  read_exact_bytes "$len"
}

# ── locate the engine binary ─────────────────────────────────────────────────
ENGINE_BIN=""
if [ -n "${AGENT_BRIDGE_BIN:-}" ] && [ -x "$AGENT_BRIDGE_BIN" ]; then
  ENGINE_BIN="$AGENT_BRIDGE_BIN"
else
  PATH="$PATH:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin"
  if command -v "$BRIDGE_BIN_NAME" >/dev/null 2>&1; then
    ENGINE_BIN=$(command -v "$BRIDGE_BIN_NAME")
  elif [ -x "$HOME/.codex/packages/standalone/current/$BRIDGE_BIN_NAME" ]; then
    ENGINE_BIN="$HOME/.codex/packages/standalone/current/$BRIDGE_BIN_NAME"
  fi
fi
if [ -z "$ENGINE_BIN" ]; then
  emit_error engine-binary-not-found \
    "没找到 ${BRIDGE_BIN_NAME}。装对应的 CLI 或桌面 app 任一即可；或在 agent-bridge 安装时用 --bin 指定路径。"
  exit 1
fi

# ── frame 1: control frame {"argv":["flag",...]} ─────────────────────────────
# Elements are restricted to [A-Za-z0-9._-] by the client, so stripping the
# JSON punctuation here is safe (no escapes to decode). Invalid elements are
# dropped rather than trusted.
CONFIG=$(read_frame_text) || { emit_error bridge-no-control-frame '桥接控制帧缺失（客户端版本过旧？）'; exit 1; }
EXTRA_ARGS=""
argv_json=$(printf '%s' "$CONFIG" | sed -n 's/^{"argv":\[\(.*\)\]}$/\1/p')
if [ -n "$argv_json" ]; then
  while IFS= read -r el; do
    case "$el" in ''|*[!A-Za-z0-9._-]*) continue ;; esac
    EXTRA_ARGS="$EXTRA_ARGS $el"
  done <<EOF
$(printf '%s' "$argv_json" | tr -d '"[]' | tr ',' '\n')
EOF
fi

# ── upstream: NM frames (stdin) → JSONL (engine stdin) ───────────────────────
upstream_loop() {
  while :; do
    local bytes len payload
    bytes=$(dd bs=4 count=1 2>/dev/null | od -An -tu1 | tr '\n' ' ') || return 0
    set -- $bytes
    [ $# -eq 4 ] || return 0  # EOF / partial header → Chrome disconnected
    len=$(( $1 + $2 * 256 + $3 * 65536 + $4 * 16777216 ))
    payload=$(read_exact_bytes "$len") || return 0
    printf '%s' "$payload"
    printf '\n'
  done
}

# ── downstream: JSONL (engine stdout) → NM frames (stdout) ───────────────────
downstream_loop() {
  while IFS= read -r line; do
    line=${line%$'\r'}
    [ -n "$line" ] || continue
    len=${#line}  # LC_ALL=C ⇒ char count == byte count
    printf "$(printf '\\x%02x\\x%02x\\x%02x\\x%02x' \
      $((len & 255)) $(((len >> 8) & 255)) $(((len >> 16) & 255)) $(((len >> 24) & 255)))"
    printf '%s' "$line"
  done
}

# 1 MB cap so a wedged engine can't grow the log forever.
if [ -f "$NM_LOG" ] && [ "$(wc -c <"$NM_LOG")" -gt 1048576 ]; then
  : >"$NM_LOG"
fi
printf '[agent-bridge] %s spawn: %s %s%s\n' "$(date '+%F %T')" "$ENGINE_BIN" "$BRIDGE_ARGS" "$EXTRA_ARGS" >>"$NM_LOG"

# engine's stdout streams into a downstream subshell (JSONL → NM frames on our
# stdout) and its stdin is fed by an upstream subshell (NM frames on our stdin
# → JSONL). Plumbed through two FIFOs instead of bash process substitution:
# `cmd > >(f) < <(g) &` hangs on macOS's ancient system bash 3.2 (real Mac
# report 2026-09-02: bridge alive, engine silent, zero frames back), while
# FIFOs behave identically on bash 3.2 and bash 5.
BRIDGE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-bridge.XXXXXX")
mkfifo "$BRIDGE_DIR/up" "$BRIDGE_DIR/down" || { emit_error bridge-fifo-failed '创建管道失败'; exit 1; }
CPID=""; UP=""; DOWN=""
trap 'kill "$CPID" "$UP" "$DOWN" 2>/dev/null; rm -rf "$BRIDGE_DIR"' EXIT

# Start both pump loops first: each blocks on its FIFO open until the engine
# connects the opposite ends, so the spawn order below cannot deadlock.
# upstream_loop's stdin MUST be passed explicitly (<&0): POSIX silently
# redirects an async job's stdin to /dev/null, which would make the loop read
# EOF immediately and never forward a single frame.
upstream_loop <&0 >"$BRIDGE_DIR/up" &
UP=$!
downstream_loop <"$BRIDGE_DIR/down" &
DOWN=$!

# shellcheck disable=SC2086  # BRIDGE_ARGS/EXTRA_ARGS are baked/restricted word lists
"$ENGINE_BIN" $BRIDGE_ARGS $EXTRA_ARGS 2>>"$NM_LOG" <"$BRIDGE_DIR/up" >"$BRIDGE_DIR/down" &
CPID=$!

# Chrome kills this process on port disconnect, which closes our stdin: the
# upstream loop hits EOF, the engine exits, and the whole tree winds down.
# wait is the natural end-of-bridge signal.
wait "$CPID" 2>/dev/null
exit 0
