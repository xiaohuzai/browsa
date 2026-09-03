# Platform pitfalls hit by this transport (and how to avoid them)

Everything below was found on real machines within the transport's first week —
each one produced a *silent* failure (bridge alive, zero frames), which is the worst
kind. If you write your own Native-Messaging host, read this first.

## 1. macOS system bash 3.2: process substitution on a background command hangs

`engine > >(downstream_loop) < <(upstream_loop) &` worked on Linux bash 5 and hung
forever on macOS's ancient system bash 3.2 — bridge alive, engine silent, zero frames
back. Fix: plumb both directions through **FIFOs** (`mkfifo up down`), which behave
identically on bash 3.2 and 5.

## 2. POSIX: an async job's stdin is silently /dev/null

`upstream_loop >fifo &` reads EOF immediately — POSIX redirects a background job's
stdin to /dev/null unless you pass it explicitly. The pump loop must be spawned as
`upstream_loop <&0 >fifo &`. (The old process-substitution form happened to dodge this
rule, which is why the bug only appeared after the FIFO refactor.)

## 3. macOS BSD `head -c N` over-reads pipes

GNU head (Linux) reads *exactly* N bytes from a pipe. BSD head (macOS) reads a full
buffer and **discards everything past N** — so reading the 4-byte NM length header
swallowed the frame payload behind it, and the engine never received one complete
message. `bash -x` tracing exposed it (`head -c 11` produced empty output).
Fix: never `head -c` from a pipe; use `dd bs=N count=1` (its read size IS bs) plus a
top-up loop for short reads on large frames.

## 4. `noclobber` shells make `cat > file` a silent no-op

A user shell with `set -C` refuses `>` overwrites of existing files. An install
command that does `cat > host-script <<EOF` fails — and if it doesn't `set -e`, it
still prints "installed", producing a fake success while the OLD bridge stays on disk.
Fix: `set -e`, `>|` (force overwrite), and a self-check line (`grep -c 'dd bs'`) that
proves the new content landed. Verify file mtimes when debugging installs.

## 5. One engine, two protocol namings (codex)

The codex core protocol names `SandboxPolicy` in kebab-case
(`workspace-write`/`network_access`); the app-server layer uses camelCase
(`workspaceWrite`/`networkAccess`) and rejects the other with
`unknown variant`. When wiring engine parameters, treat the **engine repo's own
protocol tests** as the wire-shape source of truth, not the core type definitions.

## 6. Chrome spawns hosts with a minimal environment

GUI-launched processes don't inherit your shell's `export`s — a codex configured with
an env-key provider (e.g. `ARK_API_KEY`) fails inside the bridge while working fine in
a terminal. Fix: hosts should source an optional env file (`~/.agent-bridge.env`) and
the discovery PATH should be extended with the usual dev prefixes (~/.local/bin,
/opt/homebrew/bin, …) because GUI PATH is minimal on macOS.

## 7. NM hosts must be executable — downloads are not

macOS requires the +x bit for double-clicked `.command` files, and browsers can't set
it on downloads. Either the consumer runs the file through `bash <file>` as a fallback,
or the install flow sets the bit (the CLI here chmods; browsers copying files should
too).

## 8. Two live app-server instances at once can stall the second one's startup

An app-server that just served a turn holds SQLite state locks (`~/.codex/state_5.sqlite`
WAL). A second instance spawned while the first is still alive can sit ~30 s before
answering even `initialize` (observed on Linux, codex 0.149.1). Clients that spawn one
engine per connection should end the previous connection before starting the next —
browsa's one-connection-per-turn lifecycle already does this; the conformance live test
closes stdin and waits before resuming on a fresh engine.
