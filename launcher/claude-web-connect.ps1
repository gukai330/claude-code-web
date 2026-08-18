<#
  claude-web connect (Windows)

  A connect dialog for claude-code-web: pick an SSH target, optionally supply a
  key passphrase, and it brings up the remote server + tunnel + browser.

  Targets come from %USERPROFILE%\.ssh\config, so Host aliases, IdentityFile,
  Port, User, ProxyJump and friends all work exactly as they do for `ssh`.
  Everything here shells out to the system OpenSSH client; nothing about the
  SSH protocol is reimplemented.

  Passphrase handling:
    - Nothing is ever written to disk.
    - A connection is first attempted with BatchMode=yes, which never prompts.
      If that works (agent already holds the key, or the key has no
      passphrase), the passphrase box is ignored entirely.
    - Otherwise the key is added to the Windows ssh-agent once via ssh-add,
      using a temporary SSH_ASKPASS helper that reads the value from this
      process's environment. The helper is deleted and the variable cleared in
      a finally block.
    - Prefer running `ssh-add` yourself once: the agent persists across
      reboots on Windows and then this box is never needed.

  Usage:  right-click -> Run with PowerShell
     or:  powershell -NoProfile -ExecutionPolicy Bypass -File .\claude-web-connect.ps1
#>

[CmdletBinding()]
param(
    [string]$Target,
    [switch]$NoDialog
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:SettingsPath = Join-Path $env:USERPROFILE '.claudecode-web\launcher.json'
$script:SshConfig    = Join-Path $env:USERPROFILE '.ssh\config'

# ---------------------------------------------------------------- settings --
# Non-secret only. The passphrase is never persisted.

function Get-Settings {
    $defaults = [ordered]@{
        target     = ''
        remoteRepo = '~/claudecode'
        project    = '~/'
        localPort  = 8080
        remotePort = 8080
        tmuxName   = 'ccw'
    }
    if (Test-Path $script:SettingsPath) {
        try {
            $saved = Get-Content $script:SettingsPath -Raw | ConvertFrom-Json
            foreach ($k in @($defaults.Keys)) {
                if ($saved.PSObject.Properties.Name -contains $k -and $null -ne $saved.$k -and "$($saved.$k)" -ne '') {
                    $defaults[$k] = $saved.$k
                }
            }
        } catch {
            Write-Warning "Could not read $($script:SettingsPath): $($_.Exception.Message)"
        }
    }
    return $defaults
}

function Save-Settings($s) {
    $dir = Split-Path $script:SettingsPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # explicit: no passphrase key is ever placed in this object
    [ordered]@{
        target     = $s.target
        remoteRepo = $s.remoteRepo
        project    = $s.project
        localPort  = [int]$s.localPort
        remotePort = [int]$s.remotePort
        tmuxName   = $s.tmuxName
    } | ConvertTo-Json | Set-Content -Path $script:SettingsPath -Encoding utf8
}

# -------------------------------------------------------------- ssh config --

function Get-SshConfigHosts {
    if (-not (Test-Path $script:SshConfig)) { return @() }
    $hosts = New-Object System.Collections.Generic.List[string]
    foreach ($line in Get-Content $script:SshConfig) {
        $t = $line.Trim()
        if ($t -match '^(?i)host\s+(.+)$') {
            foreach ($h in ($matches[1] -split '\s+')) {
                # skip patterns - they are not connectable targets
                if ($h -and $h -notmatch '[*?!]') { [void]$hosts.Add($h) }
            }
        }
    }
    return $hosts | Select-Object -Unique | Sort-Object
}

function Resolve-IdentityFiles([string]$target) {
    # `ssh -G` prints the *effective* config after Host/Match resolution, which
    # is the only reliable way to learn which key a given alias will use.
    $files = New-Object System.Collections.Generic.List[string]
    try {
        $out = & ssh -G $target 2>$null
        foreach ($line in $out) {
            if ($line -match '^(?i)identityfile\s+(.+)$') {
                $p = $matches[1].Trim()
                if ($p.StartsWith('~/')) { $p = Join-Path $env:USERPROFILE $p.Substring(2) }
                $p = [Environment]::ExpandEnvironmentVariables($p)
                if (Test-Path $p) { [void]$files.Add($p) }
            }
        }
    } catch { }
    return $files
}

# ---------------------------------------------------------------- ssh-agent --

function Test-SshAgent {
    try { $svc = Get-Service ssh-agent -ErrorAction Stop } catch { return 'missing' }
    if ($svc.Status -eq 'Running') { return 'running' }
    if ($svc.StartType -eq 'Disabled') { return 'disabled' }
    try { Start-Service ssh-agent -ErrorAction Stop; return 'running' } catch { return 'stopped' }
}

function Add-KeyWithPassphrase([string]$keyPath, [string]$passphrase) {
    # SSH_ASKPASS points at a helper that prints the passphrase on stdout.
    # OpenSSH >= 8.4 honours SSH_ASKPASS_REQUIRE=force even with a tty present.
    $helper = Join-Path $env:TEMP ("ccw-askpass-{0}.cmd" -f ([guid]::NewGuid().ToString('N')))
    $prevAskpass = $env:SSH_ASKPASS
    $prevRequire = $env:SSH_ASKPASS_REQUIRE
    try {
        # routed through PowerShell so passphrases containing % & ^ | survive cmd parsing
        Set-Content -Path $helper -Encoding ascii -Value @(
            '@echo off',
            'powershell -NoProfile -Command "[Console]::Out.WriteLine($env:CCW_PASSPHRASE)"'
        )
        $env:CCW_PASSPHRASE     = $passphrase
        $env:SSH_ASKPASS        = $helper
        $env:SSH_ASKPASS_REQUIRE = 'force'

        $errFile = [System.IO.Path]::GetTempFileName()
        $p = Start-Process -FilePath 'ssh-add' -ArgumentList @("`"$keyPath`"") `
                           -NoNewWindow -Wait -PassThru -RedirectStandardError $errFile
        $stderr = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
        Remove-Item $errFile -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ ExitCode = $p.ExitCode; Stderr = $stderr }
    } finally {
        $env:CCW_PASSPHRASE = $null
        $env:SSH_ASKPASS = $prevAskpass
        $env:SSH_ASKPASS_REQUIRE = $prevRequire
        Remove-Item $helper -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------------ connect --

function Test-SshNonInteractive([string]$target) {
    & ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new $target 'echo ok' 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Get-RemoteToken($s) {
    $bash = @"
set -e
if ! command -v tmux >/dev/null 2>&1; then echo 'CCW_ERR: tmux not installed on remote' >&2; exit 3; fi
if ! tmux has-session -t $($s.tmuxName) 2>/dev/null; then
  tmux new-session -d -s $($s.tmuxName) "cd $($s.project) && exec node $($s.remoteRepo)/server/dist/bin/claudecode-web.js --port $($s.remotePort)"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    curl -sf http://127.0.0.1:$($s.remotePort)/healthz >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
curl -sf http://127.0.0.1:$($s.remotePort)/healthz >/dev/null 2>&1 || { echo 'CCW_ERR: server did not come up; check: tmux attach -t $($s.tmuxName)' >&2; exit 4; }
cat ~/.claudecode-web/token
"@
    $bash = $bash -replace "`r`n", "`n"
    $out = $bash | & ssh -o ConnectTimeout=15 $s.target 'bash -s' 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n").Trim() }
}

function Start-Tunnel($s) {
    $existing = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape("$($s.localPort):127.0.0.1:$($s.remotePort)") }
    if ($existing) { return $null }

    return Start-Process -FilePath 'ssh' -PassThru -WindowStyle Hidden -ArgumentList @(
        '-N',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-L', "$($s.localPort):127.0.0.1:$($s.remotePort)",
        $s.target
    )
}

function Invoke-Connect($s, [string]$passphrase, [scriptblock]$Log) {
    & $Log "Target: $($s.target)"

    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
        throw "OpenSSH client not found. Settings > Apps > Optional features > OpenSSH Client."
    }

    & $Log "Trying key-based login (no prompt)..."
    if (-not (Test-SshNonInteractive $s.target)) {
        if ([string]::IsNullOrEmpty($passphrase)) {
            throw "Cannot log in non-interactively and no passphrase was given.`r`nEither enter the key passphrase, or run 'ssh-add' once in a terminal."
        }
        $agent = Test-SshAgent
        if ($agent -eq 'missing')  { throw "ssh-agent service not found. Install the OpenSSH Client optional feature." }
        if ($agent -eq 'disabled') { throw "ssh-agent service is Disabled. In an admin PowerShell:`r`n  Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent" }
        if ($agent -ne 'running')  { throw "ssh-agent service could not be started." }

        $keys = Resolve-IdentityFiles $s.target
        if ($keys.Count -eq 0) {
            throw "No existing IdentityFile resolved for '$($s.target)'. Set one in $($script:SshConfig)."
        }
        $loaded = $false
        foreach ($k in $keys) {
            & $Log "Adding key to agent: $k"
            $r = Add-KeyWithPassphrase $k $passphrase
            if ($r.ExitCode -eq 0) { $loaded = $true; break }
            & $Log "  rejected: $($r.Stderr.Trim())"
        }
        if (-not $loaded) { throw "ssh-add rejected the passphrase for every candidate key." }

        if (-not (Test-SshNonInteractive $s.target)) {
            throw "Key loaded but the server still refused the connection. Check the remote's authorized_keys."
        }
    }
    & $Log "SSH OK."

    & $Log "Starting remote server (tmux: $($s.tmuxName))..."
    $res = Get-RemoteToken $s
    if ($res.ExitCode -ne 0 -or $res.Output -match 'CCW_ERR:') {
        throw "Remote start failed:`r`n$($res.Output)"
    }
    $token = ($res.Output -split "`n" | Where-Object { $_ -match '^[0-9a-f]{32,}$' } | Select-Object -Last 1)
    if (-not $token) { throw "Could not read the auth token from the remote.`r`nGot: $($res.Output)" }
    & $Log "Token acquired."

    & $Log "Opening tunnel localhost:$($s.localPort) -> remote:$($s.remotePort)..."
    $proc = Start-Tunnel $s
    if ($null -eq $proc) {
        & $Log "A tunnel on that port is already running; reusing it."
    } else {
        Start-Sleep -Milliseconds 1200
        if ($proc.HasExited) { throw "Tunnel exited immediately (port $($s.localPort) already in use?)." }
    }

    $url = "http://localhost:$($s.localPort)/?t=$token"
    & $Log "Opening browser."
    Start-Process $url
    return $url
}

# ------------------------------------------------------------------- dialog --

function Show-ConnectDialog($s, [string[]]$hostList) {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'claude-web - connect'
    $form.Size = New-Object System.Drawing.Size(470, 430)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false

    $y = 15
    function New-Label($text, $top) {
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $text; $l.Left = 15; $l.Top = $top; $l.Width = 130
        return $l
    }

    $form.Controls.Add((New-Label 'SSH target' $y))
    $cbo = New-Object System.Windows.Forms.ComboBox
    $cbo.Left = 150; $cbo.Top = ($y - 3); $cbo.Width = 285
    $cbo.DropDownStyle = 'DropDown'   # editable: user@host also allowed
    foreach ($h in $hostList) { [void]$cbo.Items.Add($h) }
    $cbo.Text = $s.target
    $form.Controls.Add($cbo)
    $y += 30

    $hint = New-Object System.Windows.Forms.Label
    $hint.Left = 150; $hint.Top = $y; $hint.Width = 285; $hint.Height = 30
    $hint.ForeColor = [System.Drawing.Color]::Gray
    if ($hostList.Count -gt 0) {
        $hint.Text = "$($hostList.Count) host(s) from ~\.ssh\config, or type user@host"
    } else {
        $hint.Text = "No ~\.ssh\config found - type user@host"
    }
    $form.Controls.Add($hint)
    $y += 35

    $form.Controls.Add((New-Label 'Key passphrase' $y))
    $txtPass = New-Object System.Windows.Forms.TextBox
    $txtPass.Left = 150; $txtPass.Top = ($y - 3); $txtPass.Width = 285
    $txtPass.UseSystemPasswordChar = $true
    $form.Controls.Add($txtPass)
    $y += 28

    $passHint = New-Object System.Windows.Forms.Label
    $passHint.Left = 150; $passHint.Top = $y; $passHint.Width = 285; $passHint.Height = 30
    $passHint.ForeColor = [System.Drawing.Color]::Gray
    $passHint.Text = 'Leave empty if the agent already holds your key. Never stored.'
    $form.Controls.Add($passHint)
    $y += 40

    $fields = @{}
    foreach ($f in @(
        @{ key='remoteRepo'; label='Remote repo path' },
        @{ key='project';    label='Project dir'      },
        @{ key='localPort';  label='Local port'       },
        @{ key='remotePort'; label='Remote port'      }
    )) {
        $form.Controls.Add((New-Label $f.label $y))
        $tb = New-Object System.Windows.Forms.TextBox
        $tb.Left = 150; $tb.Top = ($y - 3); $tb.Width = 285
        $tb.Text = "$($s[$f.key])"
        $form.Controls.Add($tb)
        $fields[$f.key] = $tb
        $y += 30
    }

    $y += 10
    $status = New-Object System.Windows.Forms.TextBox
    $status.Left = 15; $status.Top = $y; $status.Width = 420; $status.Height = 90
    $status.Multiline = $true; $status.ReadOnly = $true; $status.ScrollBars = 'Vertical'
    $status.BackColor = [System.Drawing.Color]::WhiteSmoke
    $form.Controls.Add($status)
    $y += 100

    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = 'Connect'; $btn.Left = 335; $btn.Top = $y; $btn.Width = 100
    $form.Controls.Add($btn)
    $form.AcceptButton = $btn

    $log = {
        param($m)
        $status.AppendText("$m`r`n")
        $status.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
    }

    $btn.Add_Click({
        $btn.Enabled = $false
        $status.Clear()
        try {
            $s.target     = $cbo.Text.Trim()
            $s.remoteRepo = $fields['remoteRepo'].Text.Trim()
            $s.project    = $fields['project'].Text.Trim()
            $s.localPort  = [int]$fields['localPort'].Text.Trim()
            $s.remotePort = [int]$fields['remotePort'].Text.Trim()
            if (-not $s.target) { throw 'Enter an SSH target.' }

            $url = Invoke-Connect $s $txtPass.Text $log
            Save-Settings $s
            & $log ''
            & $log "Connected. $url"
            & $log 'Close this window when done; the tunnel keeps running.'
        } catch {
            & $log ''
            & $log "FAILED: $($_.Exception.Message)"
        } finally {
            $txtPass.Clear()
            $btn.Enabled = $true
        }
    }.GetNewClosure())

    [void]$form.ShowDialog()
}

# --------------------------------------------------------------------- main --

$settings = Get-Settings
if ($Target) { $settings.target = $Target }

if ($NoDialog) {
    if (-not $settings.target) { throw 'No target. Pass -Target user@host or run without -NoDialog.' }
    $url = Invoke-Connect $settings '' { param($m) Write-Host "[claude-web] $m" }
    Save-Settings $settings
    Write-Host "[claude-web] $url"
} else {
    Show-ConnectDialog $settings (Get-SshConfigHosts)
}
