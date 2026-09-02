# browsa ⇄ local agent engine native-messaging bridge (Windows).
#
# Same contract as lib/nm-bridge.sh (see it for the wire format, control frame,
# discovery order and the binary-not-found frame). The generated install
# command bakes the backend into the marker lines below; Chrome launches the
# companion .bat (the manifest's "path"), which runs this script.
#
# Concurrency: the main thread pumps NM stdin → engine stdin; a runspace pumps
# engine stdout → NM frames on stdout. Both directions must run concurrently —
# turn events flow while no client request is in flight.
#
# NOTE: authored blind (2026-09-02) — this box has no Windows to verify on.
# If a turn hangs or dies instantly, check that the .bat was generated next to
# this file and try running the .bat from a terminal to see the raw error.

$ErrorActionPreference = 'Stop'
#__BRIDGE_BIN_NAME__
#__BRIDGE_ARGS__
#__BRIDGE_BIN_OVERRIDE__

$envFile = Join-Path $env:USERPROFILE '.browsa-bridge.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
    }
  }
}

function Send-NmFrame([byte[]]$payload) {
  $out = $script:NmOut
  $hdr = [BitConverter]::GetBytes([UInt32]$payload.Length)
  $out.Write($hdr, 0, 4)
  $out.Write($payload, 0, $payload.Length)
  $out.Flush()
}

function Send-BridgeError([string]$code, [string]$message) {
  $json = '{"error":{"code":"' + $code + '","message":"' + ($message -replace '[\r\n"]', ' ') + '"}}'
  Send-NmFrame ([Text.Encoding]::UTF8.GetBytes($json))
}

$script:NmOut = [Console]::OpenStandardOutput()
$script:NmIn = [Console]::OpenStandardInput()

function Read-Exact([System.IO.Stream]$stream, [int]$count) {
  $b = New-Object byte[] $count
  $off = 0
  while ($off -lt $count) {
    $r = $stream.Read($b, $off, $count - $off)
    if ($r -le 0) { return $null }
    $off += $r
  }
  return , $b
}

# ── locate the engine binary ─────────────────────────────────────────────────
$engineBin = $null
if ($env:BROWSA_BRIDGE_BIN -and (Test-Path $env:BROWSA_BRIDGE_BIN)) {
  $engineBin = $env:BROWSA_BRIDGE_BIN
} else {
  $cmd = Get-Command $script:BridgeBinName -ErrorAction SilentlyContinue
  if ($cmd) { $engineBin = $cmd.Source }
  if (-not $engineBin) {
    $managed = Join-Path $env:USERPROFILE (".codex\packages\standalone\current\" + $script:BridgeBinName + ".exe")
    if (Test-Path $managed) { $engineBin = $managed }
  }
}
if (-not $engineBin) {
  Send-BridgeError 'engine-binary-not-found' ("没找到 " + $script:BridgeBinName + "。装对应的 CLI 或桌面 app 任一即可；也可在 browsa 设置里指定路径后重新生成安装命令。")
  exit 1
}

# ── frame 1: control frame {"argv":["flag",...]} ─────────────────────────────
# Elements are restricted to [A-Za-z0-9._-] by the client; invalid ones are
# dropped rather than trusted.
$extraArgs = @()
$ctrlPayload = Read-Exact $script:NmIn 4
if ($null -eq $ctrlPayload) {
  Send-BridgeError 'bridge-no-control-frame' '桥接控制帧缺失（browsa 客户端版本过旧？）'
  exit 1
}
$ctrlLen = [BitConverter]::ToUInt32($ctrlPayload, 0)
if ($ctrlLen -gt 0) {
  $ctrlBytes = Read-Exact $script:NmIn $ctrlLen
  if ($null -eq $ctrlBytes) {
    Send-BridgeError 'bridge-no-control-frame' '桥接控制帧不完整'
    exit 1
  }
  try {
    $ctrl = [Text.Encoding]::UTF8.GetString($ctrlBytes) | ConvertFrom-Json
    foreach ($el in @($ctrl.argv)) {
      if ($el -and ($el -match '^[A-Za-z0-9._-]+$')) { $extraArgs += $el }
    }
  } catch {
    Send-BridgeError 'bridge-bad-control-frame' '桥接控制帧无法解析'
    exit 1
  }
}

# ── spawn engine ─────────────────────────────────────────────────────────────
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $engineBin
$psi.Arguments = "$script:BridgeArgs $extraArgs"
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $false   # inherit — Chrome captures it
$proc = [System.Diagnostics.Process]::Start($psi)

# ── downstream runspace: engine stdout (JSONL) → NM frames ───────────────────
$downstream = {
  param($proc, $out)
  $stream = $proc.StandardOutput.BaseStream
  $acc = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 65536
  while ($true) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    for ($i = 0; $i -lt $n; $i++) {
      if ($buf[$i] -eq 10) {           # LF — flush the accumulated line
        $line = $acc.ToArray()
        $acc.SetLength(0)
        $usable = $line.Length
        if ($usable -gt 0 -and $line[$usable - 1] -eq 13) { $usable-- }  # CR strip
        if ($usable -gt 0) {
          $hdr = [BitConverter]::GetBytes([UInt32]$usable)
          $out.Write($hdr, 0, 4)
          $out.Write($line, 0, $usable)
          $out.Flush()
        }
      } else {
        $acc.WriteByte($buf[$i])
      }
    }
  }
}
$rs = [runspacefactory]::CreateRunspace()
$rs.Open()
$ds = [powershell]::Create()
$ds.Runspace = $rs
[void]$ds.AddScript($downstream).AddArgument($proc).AddArgument($script:NmOut)
$dsHandle = $ds.BeginInvoke()

# ── main thread: NM stdin → engine stdin (JSONL) ─────────────────────────────
try {
  while ($true) {
    $hdr = Read-Exact $script:NmIn 4
    if ($null -eq $hdr) { break }        # Chrome disconnected
    $len = [BitConverter]::ToUInt32($hdr, 0)
    $payload = New-Object byte[] 0
    if ($len -gt 0) {
      $payload = Read-Exact $script:NmIn $len
      if ($null -eq $payload) { break }
    }
    $stdinStream = $proc.StandardInput.BaseStream
    if ($payload.Length -gt 0) { $stdinStream.Write($payload, 0, $payload.Length) }
    $stdinStream.WriteByte(10)           # JSONL terminator
    $stdinStream.Flush()
  }
} finally {
  try { $proc.Kill() } catch {}
  try { $ds.Stop(); $rs.Close() } catch {}
}
exit 0
