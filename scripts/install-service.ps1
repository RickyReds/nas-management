# Installs the NAS-Management service on this computer. Windows PowerShell 5.1.
#
# Run from an ELEVATED PowerShell, as the user the service will run as:
#   & <project folder>\scripts\install-service.ps1
#
# It creates two things, replacing them if they already exist:
#   1. the scheduled task (taskName in data\config.json, default
#      "NAS-Management"), at logon of this user, NOT elevated
#      (RunLevel Limited), with no window;
#   2. the firewall rule for the port (port, default 8790), local subnet only.
# It does not start the service: at the end it says how.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'NAS-Management'
$port = 8790
$address = $null
# data\config.json; before the first start of 0.6 the settings may still be in dati\.
foreach ($f in @((Join-Path $root 'data\config.json'), (Join-Path $root 'dati\config.json'))) {
    if (Test-Path $f) {
        $cfg = Get-Content -Raw -Encoding UTF8 $f | ConvertFrom-Json
        if ($cfg.taskName) { $name = [string]$cfg.taskName }
        if ($cfg.port) { $port = [int]$cfg.port }
        if ($cfg.publicAddress) { $address = [string]$cfg.publicAddress }
        break
    }
}
if (-not $address) { $address = "http://localhost:$port" }

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'An elevated PowerShell is needed: creating a logon task and a firewall rule requires it. The service itself will run NOT elevated.'
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$server = Join-Path $root 'src\server.js'
if (-not (Test-Path $server)) { throw "Cannot find $server" }

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
    -Argument "--headless `"$node`" `"$server`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force `
    -Description "NAS-Management: devices, credentials and network drive profiles. Port $port, log in data\service.log." | Out-Null
"Task '$name' registered for $user."

Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $port `
    -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
"Firewall rule '$name': TCP $port from the local subnet."

''
'Next steps, from a NON-elevated PowerShell:'
"  cd $root"
'  node src/cli.js key               # access key for the web page, shown once'
"  Start-ScheduledTask -TaskName '$name'"
"  start $address"
