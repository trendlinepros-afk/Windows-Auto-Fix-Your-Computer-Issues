import { execFile } from 'child_process';
import { DiagnosticCategory, DiagnosticResult } from '../types';
import { sanitizeDiagnostics } from './sanitizer';

/**
 * Diagnostic engine: collects system information per opted-in category.
 *
 * All collection is read-only PowerShell. Results are sanitized (usernames,
 * hostnames, MACs removed) before being returned; diagnostic data is never
 * written to disk — it exists only in memory for the AI round-trip.
 */

const PS_TIMEOUT_MS = 60_000;
const MAX_CATEGORY_CHARS = 12_000; // Keep each category within AI token limits.

function runPowerShell(script: string, timeoutMs = PS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve(`ERROR: ${stderr || error.message}`);
        } else {
          resolve(stdout + (stderr ? `\n[stderr]\n${stderr}` : ''));
        }
      }
    );
  });
}

function truncate(text: string, max = MAX_CATEGORY_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated ${text.length - max} chars]`;
}

const COLLECTORS: Record<DiagnosticCategory, () => Promise<string>> = {
  async eventLogs() {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($log in 'System','Application') {
  Write-Output "===== $log log: last 25 errors/warnings (7 days) ====="
  Get-WinEvent -FilterHashtable @{ LogName=$log; Level=1,2,3; StartTime=(Get-Date).AddDays(-7) } -MaxEvents 25 |
    Select-Object TimeCreated, LevelDisplayName, ProviderName, Id, @{n='Message';e={($_.Message -split "\\r?\\n")[0]}} |
    Format-Table -AutoSize | Out-String -Width 200
}
Write-Output "===== Security log: last 10 audit failures (7 days) ====="
Get-WinEvent -FilterHashtable @{ LogName='Security'; Keywords=4503599627370496; StartTime=(Get-Date).AddDays(-7) } -MaxEvents 10 |
  Select-Object TimeCreated, Id, @{n='Message';e={($_.Message -split "\\r?\\n")[0]}} |
  Format-Table -AutoSize | Out-String -Width 200
`;
    return runPowerShell(script);
  },

  async performance() {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor
$cpuLoad = ($cpu | Measure-Object -Property LoadPercentage -Average).Average
$totalMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
$freeMB  = [math]::Round($os.FreePhysicalMemory / 1024)
Write-Output "===== System ====="
Write-Output ("OS: {0} (build {1}), Uptime since: {2}" -f $os.Caption, $os.BuildNumber, $os.LastBootUpTime)
Write-Output ("CPU: {0}, Load: {1}%" -f ($cpu | Select-Object -First 1 -ExpandProperty Name), $cpuLoad)
Write-Output ("RAM: {0} MB total, {1} MB free ({2}% used)" -f $totalMB, $freeMB, [math]::Round(100 * ($totalMB - $freeMB) / $totalMB))
Write-Output ""
Write-Output "===== Top 15 processes by CPU time ====="
Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id,
  @{n='CPU(s)';e={[math]::Round($_.CPU,1)}}, @{n='RAM(MB)';e={[math]::Round($_.WorkingSet64/1MB)}} |
  Format-Table -AutoSize | Out-String -Width 200
Write-Output "===== Top 15 processes by RAM ====="
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, Id,
  @{n='RAM(MB)';e={[math]::Round($_.WorkingSet64/1MB)}} |
  Format-Table -AutoSize | Out-String -Width 200
Write-Output "===== Disk activity ====="
Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk |
  Where-Object { $_.Name -ne '_Total' } |
  Select-Object Name, PercentDiskTime, CurrentDiskQueueLength |
  Format-Table -AutoSize | Out-String -Width 200
`;
    return runPowerShell(script);
  },

  async network() {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Write-Output "===== Ping DNS servers ====="
foreach ($ip in '8.8.8.8','1.1.1.1') {
  $r = Test-Connection -ComputerName $ip -Count 3 -ErrorAction SilentlyContinue
  if ($r) {
    $avg = ($r | Measure-Object -Property ResponseTime -Average).Average
    Write-Output ("{0}: reachable, avg {1} ms" -f $ip, [math]::Round($avg))
  } else {
    Write-Output ("{0}: UNREACHABLE" -f $ip)
  }
}
Write-Output ""
Write-Output "===== DNS resolution ====="
foreach ($name in 'www.microsoft.com','www.google.com') {
  $d = Resolve-DnsName $name -ErrorAction SilentlyContinue
  if ($d) { Write-Output ("{0}: OK ({1})" -f $name, (($d | Where-Object Type -eq 'A' | Select-Object -First 1).IPAddress)) }
  else { Write-Output ("{0}: FAILED to resolve" -f $name) }
}
Write-Output ""
Write-Output "===== Adapter configuration ====="
Get-NetIPConfiguration | ForEach-Object {
  Write-Output ("Adapter: {0} ({1})" -f $_.InterfaceAlias, $_.NetAdapter.Status)
  Write-Output ("  IPv4: {0}  Gateway: {1}  DNS: {2}" -f ($_.IPv4Address.IPAddress -join ','), $_.IPv4DefaultGateway.NextHop, ($_.DNSServer.ServerAddresses -join ','))
}
Write-Output ""
Write-Output "===== WiFi signal (if applicable) ====="
netsh wlan show interfaces | Select-String 'SSID|Signal|Radio type|Channel' | Out-String
Write-Output "===== Simple throughput test (HTTP download) ====="
try {
  $url = 'https://speed.cloudflare.com/__down?bytes=5000000'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
  $sw.Stop()
  $mbps = [math]::Round((($resp.RawContentLength * 8) / 1MB) / $sw.Elapsed.TotalSeconds, 1)
  Write-Output ("Downloaded {0} MB in {1}s -> ~{2} Mbps" -f [math]::Round($resp.RawContentLength/1MB,1), [math]::Round($sw.Elapsed.TotalSeconds,1), $mbps)
} catch {
  Write-Output "Throughput test failed: $($_.Exception.Message)"
}
`;
    return runPowerShell(script, 90_000);
  },

  async storage() {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Write-Output "===== Volumes ====="
Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, FileSystem,
  @{n='Size(GB)';e={[math]::Round($_.Size/1GB,1)}},
  @{n='Free(GB)';e={[math]::Round($_.SizeRemaining/1GB,1)}},
  @{n='Used%';e={ if ($_.Size -gt 0) { [math]::Round(100 * ($_.Size - $_.SizeRemaining) / $_.Size) } else { 0 } }} |
  Format-Table -AutoSize | Out-String -Width 200
Write-Output "===== Temp folder sizes ====="
foreach ($p in "$env:TEMP", "$env:WINDIR\\Temp", "$env:LOCALAPPDATA\\Microsoft\\Windows\\INetCache") {
  $size = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  Write-Output ("{0}: {1} MB" -f $p, [math]::Round(($size|ForEach-Object {$_})/1MB))
}
Write-Output ""
Write-Output "===== Largest top-level folders on C: ====="
Get-ChildItem 'C:\\' -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  [PSCustomObject]@{ Folder = $_.FullName; 'Size(GB)' = [math]::Round(($size|ForEach-Object {$_})/1GB, 2) }
} | Sort-Object 'Size(GB)' -Descending | Select-Object -First 10 | Format-Table -AutoSize | Out-String -Width 200
Write-Output "===== 10 largest files in user profile ====="
Get-ChildItem $env:USERPROFILE -Recurse -File -Force -ErrorAction SilentlyContinue |
  Sort-Object Length -Descending | Select-Object -First 10 @{n='Size(MB)';e={[math]::Round($_.Length/1MB)}}, FullName |
  Format-Table -AutoSize | Out-String -Width 250
Write-Output "===== Recycle Bin size ====="
$rb = (New-Object -ComObject Shell.Application).NameSpace(10)
$rbSize = 0; foreach ($item in $rb.Items()) { $rbSize += $item.Size }
Write-Output ("Recycle Bin: {0} MB" -f [math]::Round($rbSize/1MB))
`;
    return runPowerShell(script, 180_000);
  },

  async services() {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Write-Output "===== Automatic services that are STOPPED ====="
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } |
  Select-Object Name, DisplayName, Status | Format-Table -AutoSize | Out-String -Width 200
Write-Output "===== Running third-party services ====="
Get-CimInstance Win32_Service | Where-Object { $_.State -eq 'Running' -and $_.PathName -notlike '*\\Windows\\*' } |
  Select-Object Name, DisplayName, StartMode | Format-Table -AutoSize | Out-String -Width 200
Write-Output "===== Startup items (registry + startup folder) ====="
Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User |
  Format-Table -AutoSize | Out-String -Width 250
Write-Output "===== Windows Update status ====="
$wu = Get-Service wuauserv
Write-Output ("Windows Update service: {0} ({1})" -f $wu.Status, $wu.StartType)
Write-Output "===== Recently failed scheduled tasks ====="
Get-ScheduledTask | Where-Object State -ne 'Disabled' | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue |
  Where-Object { $_.LastTaskResult -ne 0 -and $_.LastRunTime -gt (Get-Date).AddDays(-7) } |
  Select-Object TaskName, LastRunTime, LastTaskResult | Select-Object -First 15 |
  Format-Table -AutoSize | Out-String -Width 250
Write-Output "===== Problem devices (drivers) ====="
Get-PnpDevice -Status Error -ErrorAction SilentlyContinue | Select-Object Class, FriendlyName, Status |
  Format-Table -AutoSize | Out-String -Width 200
`;
    return runPowerShell(script, 120_000);
  },
};

export async function collectDiagnostics(
  categories: DiagnosticCategory[],
  onProgress?: (category: DiagnosticCategory) => void
): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  for (const category of categories) {
    onProgress?.(category);
    try {
      const raw = await COLLECTORS[category]();
      results.push({
        category,
        collectedAt: new Date().toISOString(),
        data: truncate(sanitizeDiagnostics(raw)),
      });
    } catch (err) {
      results.push({
        category,
        collectedAt: new Date().toISOString(),
        data: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Lightweight probe used by continuous monitoring mode. Returns a short
 * summary string, or null when everything looks healthy.
 */
export async function quickHealthCheck(): Promise<string | null> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$issues = @()
$os = Get-CimInstance Win32_OperatingSystem
$memUsed = 100 * (1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize)
if ($memUsed -gt 90) { $issues += ("High memory usage: {0}%" -f [math]::Round($memUsed)) }
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
if ($cpu -gt 90) { $issues += ("High CPU usage: {0}%" -f [math]::Round($cpu)) }
Get-Volume | Where-Object { $_.DriveLetter -and $_.Size -gt 10GB } | ForEach-Object {
  $freePct = 100 * $_.SizeRemaining / $_.Size
  if ($freePct -lt 10) { $issues += ("Drive {0}: only {1}% free" -f $_.DriveLetter, [math]::Round($freePct)) }
}
$stopped = Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' }
if ($stopped.Count -gt 5) { $issues += ("{0} automatic services are not running" -f $stopped.Count) }
if ($issues.Count -eq 0) { Write-Output 'HEALTHY' } else { $issues | ForEach-Object { Write-Output $_ } }
`;
  const output = await runPowerShell(script, 45_000);
  const trimmed = output.trim();
  if (!trimmed || trimmed === 'HEALTHY' || trimmed.startsWith('ERROR:')) {
    return null;
  }
  return sanitizeDiagnostics(trimmed);
}
