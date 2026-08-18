<#
  claude-web connect 鈥?one click from a Windows client.

  Brings up: the remote server (if it is not already listening), the forward
  tunnel the browser uses, the reverse tunnel file sync needs, and the browser
  itself with the token filled in.

  Passphrase: never stored, never passed on a command line. The key goes into
  the Windows ssh-agent once, interactively, the first time you run this; the
  agent is a service and keeps it across reboots, so every later run is
  genuinely one click. A passphrase written into a script is readable by
  anything that can read the script, which defeats having one.

  Usage:  right-click -> Run with PowerShell
     or:  powershell -NoProfile -ExecutionPolicy Bypass -File .\ccw-connect.ps1
#>

[CmdletBinding()]
param(
    # Host alias from %USERPROFILE%\.ssh\config, so User/Port/IdentityFile/
    # ProxyJump all behave exactly as they do for plain `ssh`.
    [string]$Target = 'home',

    # Browser <-> server. Same number on both ends keeps the banner's URL right.
    [int]$LocalPort = 8080,
    [int]$RemotePort = 8080,

    # Server -> this machine, for file sync. The server reaches your sshd at
    # localhost:<ReversePort>, which is what the sync panel is defaulted to.
    [int]$ReversePort = 2222,
    [int]$LocalSshPort = 22,

    # Project the server opens. Only used when this script has to start it.
    [string]$Project = '~/projects/娆ч櫌灏勯鑺墖',
    [string]$RemoteRepo = '~/claudecode',

    # Leave the tunnel running and skip the browser (for scripting).
    [switch]$NoBrowser
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }

Write-Host ''
Write-Host 'claude-web connect' -ForegroundColor Cyan
Write-Host ''

# ------------------------------------------------------------------ ssh-agent
# BatchMode never prompts, so it answers "can I connect without typing
# anything?" 鈥?which is the only thing that decides whether the agent needs
# feeding.
Write-Step "checking $Target ..."
& ssh -o BatchMode=yes -o ConnectTimeout=8 $Target 'exit' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warn 'cannot connect without a passphrase yet'

    $agent = Get-Service ssh-agent -ErrorAction SilentlyContinue
    if ($null -eq $agent) {
        throw 'The ssh-agent service is missing. Install the Windows OpenSSH client feature.'
    }
    if ($agent.Status -ne 'Running') {
        Write-Step 'starting the ssh-agent service (needs admin once)'
        try {
            Set-Service ssh-agent -StartupType Automatic -ErrorAction Stop
            Start-Service ssh-agent -ErrorAction Stop
        } catch {
            throw "Could not start ssh-agent. Run once in an elevated PowerShell: Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent"
        }
    }

    # ssh-add prompts on the console. You type the passphrase here, once ever:
    # nothing about it is written down, and the agent survives reboots.
    Write-Host ''
    Write-Host '  Enter your key passphrase once 鈥?the agent remembers it from now on.' -ForegroundColor Cyan
    & ssh-add
    if ($LASTEXITCODE -ne 0) { throw 'ssh-add failed; the key was not loaded.' }

    & ssh -o BatchMode=yes -o ConnectTimeout=8 $Target 'exit' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Still cannot reach $Target without prompting." }
}
Write-Ok 'ssh works without prompting'

# -------------------------------------------------------------- remote server
$check = "ss -tln 2>/dev/null | grep -q ':$RemotePort ' && echo up || echo down"
$state = (& ssh -o BatchMode=yes $Target $check 2>$null | Select-Object -Last 1)
if ($state -ne 'up') {
    Write-Step "starting claudecode-web on $Target (port $RemotePort)"
    $start = "cd $RemoteRepo && setsid nohup node server/dist/bin/claudecode-web.js --port $RemotePort --cwd '$Project' > ~/ccw.log 2>&1 < /dev/null & sleep 2; echo started"
    & ssh -o BatchMode=yes $Target $start 2>$null | Out-Null
} else {
    Write-Ok "server already listening on $RemotePort"
}

# --------------------------------------------------------------------- tunnel
# A stale tunnel holds the local port and the new one dies silently, so the old
# process is cleared first.
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "-L\s*${LocalPort}:" } |
    ForEach-Object {
        Write-Step "closing an earlier tunnel (pid $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

$sshArgs = @(
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', "${LocalPort}:127.0.0.1:$RemotePort",
    '-R', "${ReversePort}:127.0.0.1:$LocalSshPort",
    $Target
)
Write-Step "tunnel: -L $LocalPort -> $RemotePort   -R $ReversePort -> local $LocalSshPort"
$tunnel = Start-Process -FilePath 'ssh' -ArgumentList $sshArgs -PassThru -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(20)
$ready = $false
while ((Get-Date) -lt $deadline) {
    if ($tunnel.HasExited) { break }
    try {
        $probe = New-Object Net.Sockets.TcpClient
        $probe.Connect('127.0.0.1', $LocalPort)
        $probe.Close()
        $ready = $true
        break
    } catch { Start-Sleep -Milliseconds 400 }
}
if (-not $ready) {
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    throw "The tunnel did not come up on 127.0.0.1:$LocalPort. Is the server running on $Target`:$RemotePort?"
}
Write-Ok "tunnel up (pid $($tunnel.Id))"

# ---------------------------------------------------------------------- token
# Read over the connection that already exists rather than kept in a file here.
$token = (& ssh -o BatchMode=yes $Target 'cat ~/.claudecode-web/token' 2>$null | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Warn 'could not read the token; open the URL from the server banner instead'
    $url = "http://localhost:$LocalPort/"
} else {
    $url = "http://localhost:$LocalPort/?t=$($token.Trim())"
}

if (-not $NoBrowser) {
    Write-Step 'opening the browser'
    Start-Process $url | Out-Null
}

Write-Host ''
Write-Ok 'connected'
Write-Host "  $url" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Leave this window open 鈥?closing it drops the tunnel.' -ForegroundColor DarkGray
Write-Host '  Ctrl+C to disconnect.' -ForegroundColor DarkGray
Write-Host ''

try {
    while (-not $tunnel.HasExited) { Start-Sleep -Seconds 1 }
    Write-Warn 'the tunnel closed'
} finally {
    if (-not $tunnel.HasExited) {
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
        Write-Step 'tunnel closed'
    }
}

