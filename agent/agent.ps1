# NAS-Management agent. Windows PowerShell 5.1, UTF-8 with BOM.
#
# Runs in the user's session, NOT elevated: drives mounted by an elevated
# session do not show up in File Explorer. Every minute it sends the server
# the snapshot of the network drives and, if there is a job, runs it.
#
# Drives stay mounted even when the agent is stopped: Windows reconnects
# them by itself. The agent is only needed to receive changes and report.
#
#   agent.ps1                ongoing loop (started at logon)
#   agent.ps1 -Once          a single round, for tests
#   agent.ps1 -Folder X      configuration elsewhere (default %LOCALAPPDATA%\NAS-Management)
#
# Started as agente.ps1 (update from the Italian agent 0.5.x), it migrates
# its own folder: configuration, key file names, logon entry and file name.

param(
    [Alias('Cartella')][string]$Folder = (Join-Path $env:LOCALAPPDATA 'NAS-Management'),
    [Alias('UnGiro')][switch]$Once
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Version = '0.6.1'
Add-Type -AssemblyName System.Security

$Folder = [IO.Path]::GetFullPath($Folder)
$defaultFolder = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NAS-Management'))
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'NAS-Management agent'
$oldRunName = 'NAS-Management agente'

# ------------------------------------------------------------------ texts
# Codes starting with "agent." are also sent to the server, which shows
# them in the page language (web/i18n); the others stay on this PC.
$Texts = @{
    en = @{
        'agent.removed' = 'removed'
        'agent.mounted' = 'mounted'
        'agent.port445' = '{server} does not answer on port 445: maybe it is off'
        'agent.cannotRemoveOld' = 'cannot remove the old drive: {error}'
        'agent.noCredentialSent' = 'the server did not send the credential'
        'agent.credManager' = 'Credential Manager: {error}'
        'agent.error1219' = 'error 1219: on {server} a session with another user is already open. {error}'
        'agent.notWritable' = 'mounted, but not writable: {error}'
        'agent.invalidOperation' = 'operation refused: letter or path not valid'
        'a.invalidName' = 'not a valid name or IP address'
        'a.netUseTimeout' = 'net use did not answer within {seconds} seconds (maybe it was asking for user and password)'
        'a.started' = 'agent {version} started for {user} towards {server}'
        'a.roundFailed' = 'round failed: {error}'
        'a.tokenRejected' = 'the server rejects the token: reinstall the agent with a new code ({error})'
        'a.updated' = 'updated from {from} to {to}: restarting'
        'a.updateFailed' = 'update to {to} failed, staying on {from}: {error}'
        'a.hashMismatch' = 'the downloaded file does not match the announced fingerprint'
        'a.syntaxErrors' = 'the downloaded file has syntax errors'
        'a.job' = 'job {id}: {n} operations'
        'a.diagRequested' = 'diagnostic of {server} requested by the server'
        'a.diagFailed' = 'diagnostic failed: {error}'
        'a.diagSendFailed' = 'sending the diagnostic failed: {error}'
        'a.migrated' = 'folder migrated from the Italian agent: {what}'
        'a.alreadyRunning' = 'another agent is already running in this session'
        'a.dTitle' = 'Diagnostic of {server} from {computer} ({user}), agent {version}, {time}'
        'a.dName' = '== Name resolution'
        'a.dNotResolved' = '  not resolved: {error}'
        'a.dLoopback' = '  ⚠ WARNING: {server} resolves to this PC itself (127.0.0.1): \\{server}\... does not reach the NAS. Use the NAS IP address, or add {server} to the hosts file.'
        'a.dHosts' = '== Hosts file'
        'a.dNoLines' = '  (no lines)'
        'a.dCache' = '== DNS cache'
        'a.dNoEntries' = '  (no entries)'
        'a.dPort' = '== Port 445'
        'a.dAnswers' = 'answers'
        'a.dNotAnswering' = 'NOT answering'
        'a.dManager' = '== Credential Manager (names only)'
        'a.dDrives' = '== Network drives (net use)'
    }
    it = @{
        'agent.removed' = 'tolta'
        'agent.mounted' = 'montata'
        'agent.port445' = '{server} non risponde sulla porta 445: forse è spento'
        'agent.cannotRemoveOld' = 'non riesco a togliere la vecchia unità: {error}'
        'agent.noCredentialSent' = 'il server non ha mandato la credenziale'
        'agent.credManager' = 'Gestore credenziali: {error}'
        'agent.error1219' = 'errore 1219: su {server} è già aperta una sessione con un altro utente. {error}'
        'agent.notWritable' = 'montata, ma non scrivibile: {error}'
        'agent.invalidOperation' = 'operazione rifiutata: lettera o percorso non validi'
        'a.invalidName' = 'non è un nome o un indirizzo IP valido'
        'a.netUseTimeout' = 'net use non ha risposto entro {seconds} secondi (forse chiedeva utente e password)'
        'a.started' = 'agente {version} avviato per {user} verso {server}'
        'a.roundFailed' = 'giro fallito: {error}'
        'a.tokenRejected' = 'il server rifiuta il token: reinstalla l''agente con un codice nuovo ({error})'
        'a.updated' = 'aggiornato da {from} a {to}: riparto'
        'a.updateFailed' = 'aggiornamento a {to} non riuscito, resto alla {from}: {error}'
        'a.hashMismatch' = 'il file scaricato non corrisponde all''impronta annunciata'
        'a.syntaxErrors' = 'il file scaricato ha errori di sintassi'
        'a.job' = 'lavoro {id}: {n} operazioni'
        'a.diagRequested' = 'diagnosi di {server} richiesta dal server'
        'a.diagFailed' = 'diagnosi non riuscita: {error}'
        'a.diagSendFailed' = 'invio diagnosi non riuscito: {error}'
        'a.migrated' = 'cartella migrata dall''agente italiano: {what}'
        'a.alreadyRunning' = 'un altro agente è già in esecuzione in questa sessione'
        'a.dTitle' = 'Diagnosi di {server} da {computer} ({user}), agente {version}, {time}'
        'a.dName' = '== Risoluzione del nome'
        'a.dNotResolved' = '  non risolto: {error}'
        'a.dLoopback' = '  ⚠ ATTENZIONE: {server} si risolve in questo PC stesso (127.0.0.1): \\{server}\... non raggiunge il NAS. Usa l''indirizzo IP del NAS, oppure aggiungi {server} al file hosts.'
        'a.dHosts' = '== File hosts'
        'a.dNoLines' = '  (nessuna riga)'
        'a.dCache' = '== Cache DNS'
        'a.dNoEntries' = '  (nessuna voce)'
        'a.dPort' = '== Porta 445'
        'a.dAnswers' = 'risponde'
        'a.dNotAnswering' = 'NON risponde'
        'a.dManager' = '== Gestore credenziali (solo nomi)'
        'a.dDrives' = '== Unità di rete (net use)'
    }
}
$Lang = 'en'

function T([string]$key, $params) {
    $s = $Texts[$script:Lang][$key]
    if (-not $s) { $s = $Texts['en'][$key] }
    if (-not $s) { return $key }
    if ($params) {
        foreach ($k in @($params.Keys)) { $s = $s.Replace('{' + $k + '}', [string]$params[$k]) }
    }
    $s
}

# ------------------------------------------------------- log and secrets

$logFile = Join-Path $Folder 'agent.log'

function Log([string]$text) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $text
    try {
        if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) { Move-Item -Force $logFile "$logFile.old" }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { }
    Write-Host $line
}

function Unprotect([string]$name) {
    $b = [IO.File]::ReadAllBytes((Join-Path $Folder $name))
    [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'))
}

function WriteAtomic([string]$path, [string]$text) {
    Set-Content -Path "$path.tmp" -Value $text -Encoding UTF8
    Move-Item -Force "$path.tmp" $path
}

function RunCommand([string]$script) {
    $cmd = "`"$env:WINDIR\System32\conhost.exe`" --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
    if ($Folder -ne $defaultFolder) { $cmd += " -Folder `"$Folder`"" }
    $cmd
}

function StartDetached([string]$script) {
    $a = @('--headless', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"")
    if ($Folder -ne $defaultFolder) { $a += @('-Folder', "`"$Folder`"") }
    Start-Process -FilePath "$env:WINDIR\System32\conhost.exe" -WindowStyle Hidden -ArgumentList $a
}

# ------------------------------------- migration from the Italian agent
# Every step can be repeated: if something stops halfway, the next start
# finishes the job. The old files are removed only once agent.ps1 runs.
$migrated = @()
$oldConf = Join-Path $Folder 'agente.json'
$newConf = Join-Path $Folder 'agent.json'
if (-not (Test-Path $newConf) -and (Test-Path $oldConf)) {
    $c = Get-Content -Raw -Path $oldConf | ConvertFrom-Json
    $lang = if ((Get-UICulture).Name -like 'it*') { 'it' } else { 'en' }
    WriteAtomic $newConf (ConvertTo-Json -InputObject ([ordered]@{ server = [string]$c.server; id = [string]$c.id; language = $lang }))
    $migrated += 'agent.json'
}
foreach ($pair in @(@('chiave.dpapi', 'key.dpapi'), @('nomi.json', 'names.json'), @('agente.log', 'agent.log'))) {
    $from = Join-Path $Folder $pair[0]; $to = Join-Path $Folder $pair[1]
    if ((Test-Path $from) -and -not (Test-Path $to)) { Move-Item -Force $from $to; $migrated += $pair[1] }
}

$conf = Get-Content -Raw -Path $newConf | ConvertFrom-Json
if ($conf.language -eq 'it') { $Lang = 'it' }
if ($migrated.Count) { Log (T 'a.migrated' @{ what = ($migrated -join ', ') }) }

$myName = Split-Path -Leaf $PSCommandPath
$agentPath = Join-Path $Folder 'agent.ps1'
if ($myName -ieq 'agente.ps1') {
    # Running under the old name: copy to agent.ps1, move the logon entry
    # (only if it points to this folder), then restart as agent.ps1.
    Copy-Item -Force -Path $PSCommandPath -Destination $agentPath
    $old = (Get-ItemProperty -Path $runKey -Name $oldRunName -ErrorAction SilentlyContinue).$oldRunName
    if ($old -and $old.IndexOf([IO.Path]::GetFullPath($PSCommandPath), [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Set-ItemProperty -Path $runKey -Name $runName -Value (RunCommand $agentPath)
        Remove-ItemProperty -Path $runKey -Name $oldRunName -ErrorAction SilentlyContinue
        Log (T 'a.migrated' @{ what = "$oldRunName -> $runName" })
    }
    if (-not $Once) {
        StartDetached $agentPath
        exit 0
    }
} else {
    foreach ($f in @('agente.ps1', 'agente.ps1.precedente', 'agente.ps1.nuovo', 'agente.json')) {
        Remove-Item -Force -Path (Join-Path $Folder $f) -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------ the agent

if (-not ('NasmCredentials' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NasmCredentials {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredWrite(ref CREDENTIAL c, int flags);
    // Like "cmdkey /add", but without the password on the command line.
    public static void Write(string target, string user, string password) {
        byte[] b = Encoding.Unicode.GetBytes(password);
        CREDENTIAL c = new CREDENTIAL();
        c.Type = 2; c.TargetName = target; c.UserName = user; c.Persist = 2;
        c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
        try {
            Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
            if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            for (int i = 0; i < b.Length; i++) b[i] = 0;
            Marshal.FreeHGlobal(c.CredentialBlob);
        }
    }
}
'@
}

$token = Unprotect 'token.dpapi'
$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
$rsa.FromXmlString((Unprotect 'key.dpapi'))

function Post([string]$path, $body) {
    $json = ConvertTo-Json -InputObject $body -Depth 8 -Compress
    Invoke-RestMethod -Method Post -Uri ($conf.server + $path) -TimeoutSec 20 `
        -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($json))
}

# Network credentials only (Domain:target=...), without passwords: the
# other Credential Manager entries never leave the machine. The "User:"
# label depends on the Windows language.
function WindowsCredentials {
    $entries = @()
    $target = $null
    foreach ($line in (& cmdkey.exe /list)) {
        if ($line -match 'Domain:target=(.+?)\s*$') { $target = $Matches[1]; continue }
        if ($line -match 'target=') { $target = $null; continue }
        if ($target -and $line -match '^\s*(User|Utente|Benutzer|Utilisateur|Usuario|Usuário|Gebruiker)\s*:\s*(.+?)\s*$') {
            $entries += [ordered]@{ target = $target; user = $Matches[2] }
            $target = $null
        }
    }
    , $entries
}

# How this PC resolves the NAS names (the server sends the list at each
# check-in). A DNS that answers 127.0.0.1 for unknown names makes \\name
# point to the PC itself: this way the page warns before using the name.
# Done again every 10 minutes, at most 3 seconds per name. The list is kept
# in names.json, so the first round after a start already has it.
$namesFile = Join-Path $Folder 'names.json'
$namesToResolve = @()
# ConvertFrom-Json in PowerShell 5.1 passes a list as a single object: put
# it in a variable and then iterate, otherwise the names merge into one.
try {
    if (Test-Path $namesFile) {
        $read = Get-Content -Raw -Path $namesFile | ConvertFrom-Json
        $namesToResolve = @(@($read) | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^[A-Za-z0-9.-]{1,253}$' })
    }
} catch { }
$resolved = $null
$resolvedAt = [datetime]::MinValue
function Resolutions {
    if (-not $script:namesToResolve.Count) { return $null }
    $key = ($script:namesToResolve | Sort-Object) -join ','
    if ($script:resolved -and $script:resolved.key -eq $key -and ((Get-Date) - $script:resolvedAt).TotalMinutes -lt 10) { return $script:resolved.result }
    $result = [ordered]@{}
    foreach ($n in $script:namesToResolve) {
        $addr = @()
        try {
            $t = [Net.Dns]::GetHostAddressesAsync($n)
            if ($t.Wait(3000)) { $addr = @($t.Result | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.IPAddressToString }) }
        } catch { }
        # [string]: names read from JSON are objects, and ConvertTo-Json in
        # PowerShell 5.1 rejects a dictionary with non-string keys.
        $result[[string]$n] = $addr
    }
    $script:resolved = @{ key = $key; result = $result }
    $script:resolvedAt = Get-Date
    $result
}

# net.exe can stop to ask for user and password when the saved credentials
# are not enough: with no window nobody answers and the agent would hang
# forever. So: input closed right away (a question gets "nothing" and
# fails) and a time limit.
function NetUse([string[]]$arguments, [int]$ms = 60000) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:WINDIR 'System32\net.exe'
    $psi.Arguments = ($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    try {
        $cp = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
        $psi.StandardOutputEncoding = $cp
        $psi.StandardErrorEncoding = $cp
    } catch { }
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($ms)) {
        try { $p.Kill() } catch { }
        return [pscustomobject]@{ code = -1; error = -1; text = (T 'a.netUseTimeout' @{ seconds = [int]($ms / 1000) }); raw = '' }
    }
    $p.WaitForExit()
    $raw = $out.Result + "`n" + $err.Result
    $text = ($raw -replace '\s+', ' ').Trim()
    $errNo = 0
    if ($text -match '(?:system error|errore di sistema|Systemfehler|erreur syst\S*me)\s+(\d+)') { $errNo = [int]$Matches[1] }
    elseif ($text -match 'HELPMSG\s+(\d+)') { $errNo = [int]$Matches[1] }
    [pscustomobject]@{ code = $p.ExitCode; error = $errNo; text = $text; raw = $raw }
}

# Network drives without WMI: Win32_NetworkConnection waits for every NAS
# that is off (86 seconds measured with three drives towards one NAS), more
# than the time after which the server marks the agent as stopped. The path
# comes from the registry (persistent drives), the state from "net use",
# which answers right away.
function Snapshot {
    $map = [ordered]@{}
    foreach ($k in @(Get-ChildItem -Path 'HKCU:\Network' -ErrorAction SilentlyContinue)) {
        $l = $k.PSChildName.ToUpper()
        if ($l -notmatch '^[A-Z]$') { continue }
        $p = (Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue).RemotePath
        if ($p) { $map[$l] = [ordered]@{ letter = $l; path = $p; status = 'disconnected' } }
    }
    # "net use" lines: [status]  X:  \\server\share  [network].
    # Status "OK" means connected; the path ends at two spaces or line end.
    $r = NetUse @('use') 15000
    foreach ($line in ($r.raw -split "`r?`n")) {
        if ($line -match '^(\S*)\s+([A-Z]):\s+(\\\\\S.*?)(\s{2,}.*)?$') {
            $l = $Matches[2]
            $status = if ($Matches[1] -eq 'OK') { 'connected' } else { 'disconnected' }
            if ($map.Contains($l)) { $map[$l].status = $status }
            else { $map[$l] = [ordered]@{ letter = $l; path = $Matches[3].Trim(); status = $status } }
        }
    }
    [ordered]@{
        drives = @($map.Values)
        windows_credentials = (WindowsCredentials)
        resolutions = (Resolutions)
        version = $Version
    }
}

function Port445([string]$server) {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $a = $c.BeginConnect($server, 445, $null, $null)
        if (-not $a.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $c.EndConnect($a)
        return $true
    } catch { return $false } finally { $c.Close() }
}

# Outcome of an operation: a code the page can translate, or plain text
# (the output of net use, already in the Windows language).
function Result($op, [string]$value, [string]$code, $params) {
    if ($code) {
        $p = [ordered]@{}
        if ($params) { foreach ($k in @($params.Keys)) { $p[[string]$k] = [string]$params[$k] } }
        return [ordered]@{ n = $op.n; result = $value; code = $code; params = $p; message = (T $code $p) }
    }
    [ordered]@{ n = $op.n; result = $value; message = [string]$params }
}

# What the server sends is checked here too, before it reaches a command
# line: a letter A-Z and \\server\share[\subfolder] paths without quotes or
# characters Windows does not allow in names. net.exe gets its arguments as
# one string, and a quote would let a path add options of its own.
function ValidPath([string]$path) {
    $path -match '^\\\\[A-Za-z0-9.-]{1,253}\\[^\\"<>|*?:\x00-\x1F]+(\\[^\\"<>|*?:\x00-\x1F]+)*$'
}
function ValidOperation($op) {
    if ([string]$op.letter -notmatch '^[A-Z]$') { return $false }
    if ($op.action -ne 'remove' -and -not (ValidPath ([string]$op.path))) { return $false }
    if ($op.old -and -not (ValidPath ([string]$op.old))) { return $false }
    $true
}

function Run($op, $credentials) {
    if (-not (ValidOperation $op)) { return Result $op 'error' 'agent.invalidOperation' }
    $l = "$($op.letter):"
    if ($op.action -eq 'remove') {
        $r = NetUse @('use', $l, '/delete', '/y')
        if ($r.code -eq 0 -or $r.error -eq 2250) { return Result $op 'ok' 'agent.removed' }
        return Result $op 'error' $null $r.text
    }

    $server = ($op.path -split '\\')[2]
    if (-not (Port445 $server)) { return Result $op 'waiting' 'agent.port445' @{ server = $server } }

    if ($op.action -eq 'replace') {
        $r = NetUse @('use', $l, '/delete', '/y')
        if ($r.code -ne 0 -and $r.error -ne 2250) { return Result $op 'error' 'agent.cannotRemoveOld' @{ error = $r.text } }
    }

    if ($op.credential) {
        $c = $credentials.($op.credential)
        if (-not $c) { return Result $op 'error' 'agent.noCredentialSent' }
        $password = [Text.Encoding]::UTF8.GetString($rsa.Decrypt([Convert]::FromBase64String($c.password), $true))
        try { [NasmCredentials]::Write($server, $c.user, $password) }
        catch { return Result $op 'error' 'agent.credManager' @{ error = $_.Exception.Message } }
        finally { $password = $null }
    }

    $r = NetUse @('use', $l, $op.path, '/persistent:yes')
    if ($r.code -ne 0) {
        if ($op.action -eq 'replace' -and $op.old) { NetUse @('use', $l, $op.old, '/persistent:yes') | Out-Null }
        if ($r.error -eq 86 -or $r.error -eq 1326) { return Result $op 'credential_error' $null $r.text }
        # Windows asked for user and password (answer: cancel, 1223): the
        # credential was rejected. Treated as such, so the server suspends it
        # and nobody retries: QNAP blocks the IP after a few rejections.
        if ($r.error -eq 1223 -or $r.text -match 'nome utente per|user name for|password per|password for|Benutzername f|Kennwort f') { return Result $op 'credential_error' $null $r.text }
        if ($r.error -eq 1219) { return Result $op 'error' 'agent.error1219' @{ server = $server; error = $r.text } }
        if ($r.error -eq 53) { return Result $op 'waiting' $null $r.text }
        return Result $op 'error' $null $r.text
    }

    # An OK from net use does not prove writing: create and remove a folder.
    if ($op.write) {
        $test = Join-Path "$l\" ('.nasm-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        try {
            New-Item -ItemType Directory -Path $test | Out-Null
            Remove-Item -Path $test -Force
        } catch {
            return Result $op 'error' 'agent.notWritable' @{ error = $_.Exception.Message }
        }
    }
    Result $op 'ok' 'agent.mounted'
}

# Fixed, READ-ONLY network diagnostic. The server only sends the name or IP
# to check (already validated there), never a command to run.
function Diagnostic([string]$server) {
    $o = New-Object System.Collections.Generic.List[string]
    $o.Add((T 'a.dTitle' @{ server = $server; computer = $env:COMPUTERNAME; user = "$env:USERDOMAIN\$env:USERNAME"; version = $Version; time = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }))

    $o.Add(''); $o.Add((T 'a.dName'))
    $addresses = @()
    try { $addresses = @([Net.Dns]::GetHostAddresses($server) | ForEach-Object { $_.IPAddressToString }); $addresses | ForEach-Object { $o.Add("  $_") } }
    catch { $o.Add((T 'a.dNotResolved' @{ error = $_.Exception.Message })) }
    if ($addresses | Where-Object { $_ -like '127.*' -or $_ -eq '::1' }) { $o.Add((T 'a.dLoopback' @{ server = $server })) }
    try { Resolve-DnsName $server -ErrorAction Stop | ForEach-Object { $o.Add(("  DNS: {0} {1} {2}" -f $_.Name, $_.Type, $_.IPAddress)) } } catch { $o.Add("  Resolve-DnsName: $($_.Exception.Message)") }

    $o.Add(''); $o.Add((T 'a.dHosts'))
    $h = @(Select-String -Path "$env:WINDIR\System32\drivers\etc\hosts" -Pattern ([regex]::Escape($server)) -ErrorAction SilentlyContinue)
    if ($h.Count) { $h | ForEach-Object { $o.Add("  $($_.Line)") } } else { $o.Add((T 'a.dNoLines')) }

    $o.Add(''); $o.Add((T 'a.dCache'))
    $c = @(& ipconfig.exe /displaydns | Select-String -Pattern ([regex]::Escape($server)) -Context 0, 6)
    if ($c.Count) { $c | ForEach-Object { $o.Add("  $($_.Line.Trim())"); $_.Context.PostContext | ForEach-Object { $o.Add("    $($_.Trim())") } } } else { $o.Add((T 'a.dNoEntries')) }

    $o.Add(''); $o.Add((T 'a.dPort'))
    $o.Add("  ${server}: $(if (Port445 $server) { T 'a.dAnswers' } else { T 'a.dNotAnswering' })")
    foreach ($a in $addresses) { $o.Add("  ${a}: $(if (Port445 $a) { T 'a.dAnswers' } else { T 'a.dNotAnswering' })") }

    $o.Add(''); $o.Add((T 'a.dManager'))
    & cmdkey.exe "/list:$server" | ForEach-Object { if ($_.Trim()) { $o.Add("  $($_.Trim())") } }

    $o.Add(''); $o.Add((T 'a.dDrives'))
    (NetUse @('use') 15000).raw -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $o.Add("  $_") }

    $o -join "`n"
}

function Round {
    $r = Post '/api/agent/checkin' (Snapshot)
    if ($r.names) {
        $new = @($r.names | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^[A-Za-z0-9.-]{1,253}$' })
        if ((($new | Sort-Object) -join ',') -ne (($script:namesToResolve | Sort-Object) -join ',')) {
            $script:namesToResolve = $new
            try { WriteAtomic $namesFile (ConvertTo-Json -InputObject @($new) -Compress) } catch { }
        }
    }
    foreach ($d in @($r.diagnostics)) {
        if (-not $d -or -not $d.id) { continue }
        Log (T 'a.diagRequested' @{ server = $d.server })
        $text = if ([string]$d.server -notmatch '^[A-Za-z0-9.-]{1,253}$') { T 'a.diagFailed' @{ error = (T 'a.invalidName') } }
                else { try { Diagnostic $d.server } catch { T 'a.diagFailed' @{ error = $_.Exception.Message } } }
        try { Post '/api/agent/diagnostics' ([ordered]@{ id = $d.id; text = $text }) | Out-Null } catch { Log (T 'a.diagSendFailed' @{ error = $_.Exception.Message }) }
    }
    if ($r.job) {
        Log (T 'a.job' @{ id = $r.job.id; n = @($r.job.operations).Count })
        $results = @(foreach ($op in $r.job.operations) {
            try { Run $op $r.job.credentials }
            catch { Result $op 'error' $null $_.Exception.Message }
        })
        foreach ($e in $results) { Log "  $($e.n) $($e.result) $($e.message)" }
        Post '/api/agent/result' ([ordered]@{ job = $r.job.id; results = $results; snapshot = (Snapshot) }) | Out-Null
    }
    $r
}

# ------------------------------------------------------ self-update
# At each check-in the server announces the fingerprint (sha256) of the
# current agent. If it differs from ours the new file is downloaded, its
# fingerprint and its PowerShell syntax are checked, and only then it
# replaces this one (keeping the previous copy) and the agent restarts. A
# failed attempt is retried after an hour at the earliest: the old agent
# stays in service. Fingerprint with .NET and not Get-FileHash: that cmdlet
# lives in a module Windows PowerShell 5.1 cannot load when started from a
# PowerShell 7 environment.
function Fingerprint([string]$file) {
    $s = [Security.Cryptography.SHA256]::Create()
    try { -join ($s.ComputeHash([IO.File]::ReadAllBytes($file)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $s.Dispose() }
}
$myHash = Fingerprint $PSCommandPath
$lastAttempt = [datetime]::MinValue

function Update($info) {
    if (-not $info -or -not $info.sha256) { return $false }
    if ($info.sha256.ToLower() -eq $script:myHash) { return $false }
    if (((Get-Date) - $script:lastAttempt).TotalMinutes -lt 60) { return $false }
    $script:lastAttempt = Get-Date
    $new = "$agentPath.new"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri ($conf.server + '/agent/agent.ps1') -OutFile $new -TimeoutSec 30
        if ((Fingerprint $new) -ne $info.sha256.ToLower()) { throw (T 'a.hashMismatch') }
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($new, [ref]$null, [ref]$errors)
        if ($errors -and $errors.Count) { throw (T 'a.syntaxErrors') }
        Copy-Item -Force -Path $agentPath -Destination "$agentPath.previous"
        Move-Item -Force -Path $new -Destination $agentPath
        Log (T 'a.updated' @{ from = $Version; to = $info.version })
        return $true
    } catch {
        Remove-Item -Force -Path $new -ErrorAction SilentlyContinue
        Log (T 'a.updateFailed' @{ from = $Version; to = $info.version; error = $_.Exception.Message })
        return $false
    }
}

# One copy per installation: the mutex name depends on the folder, so a test
# copy in another folder does not block (nor is blocked by) the real agent.
# An "abandoned" mutex (agent closed abruptly) counts as taken by us.
$sha1 = [Security.Cryptography.SHA1]::Create()
$folderHash = -join ($sha1.ComputeHash([Text.Encoding]::UTF8.GetBytes($Folder.ToLowerInvariant())) | Select-Object -First 6 | ForEach-Object { $_.ToString('x2') })
$mutex = New-Object Threading.Mutex($false, "Local\NAS-Management-agent-$folderHash")
$taken = $false
try { $taken = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $taken = $true }
if (-not $taken) {
    if ($Once) { throw (T 'a.alreadyRunning') }
    exit 0
}

Log (T 'a.started' @{ version = $Version; user = "$env:USERDOMAIN\$env:USERNAME"; server = $conf.server })
while ($true) {
    $wait = 60
    $r = $null
    try {
        $r = Round
        if ($r.interval) { $wait = [int]$r.interval }
    } catch {
        $msg = $_.Exception.Message
        if ($msg -match '401') { $wait = 600; $msg = T 'a.tokenRejected' @{ error = $msg } }
        Log (T 'a.roundFailed' @{ error = $msg })
        if ($Once) { throw }
    }
    # Update only with free hands, never in the middle of a job, and only
    # once this file is agent.ps1 (not during the migration from agente.ps1).
    if ($r -and -not $r.job -and ($PSCommandPath -ieq $agentPath) -and (Update $r.agent)) {
        if ($Once) { break }
        $mutex.ReleaseMutex()
        $mutex.Dispose()
        StartDetached $agentPath
        exit 0
    }
    if ($Once) { break }
    Start-Sleep -Seconds ([Math]::Max(15, $wait))
}
