import { execFile } from 'child_process';
import { DiagnosticCategory, DiagnosticResult } from '../types';
import { sanitizeDiagnostics } from './sanitizer';

/**
 * Diagnostic engine: collects system information per opted-in category.
 *
 * Each category runs as a series of small, individually time-boxed PowerShell
 * steps, and reports which step it is on via the progress callback so the UI
 * can show exactly what is being examined (and that work is still happening).
 *
 * All collection is read-only. Results are sanitized (usernames, hostnames,
 * MACs removed) before being returned; diagnostic data is never written to
 * disk — it exists only in memory for the AI round-trip.
 *
 * Storage scanning is intentionally limited to the system drive's
 * user-reclaimable locations (profile folders, temp/cache, Recycle Bin) so
 * machines with several large drives are not stuck in multi-minute scans.
 */

const STEP_TIMEOUT_MS = 45_000;
const MAX_CATEGORY_CHARS = 12_000; // Keep each category within AI token limits.

type ProgressFn = (detail: string) => void;

function runPowerShell(script: string, timeoutMs = STEP_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          resolve(
            (stdout || '') +
              `\n[step timed out after ${Math.round(timeoutMs / 1000)}s — partial results shown]`
          );
        } else if (error && !stdout) {
          resolve(`ERROR: ${stderr || error.message}`);
        } else {
          resolve(stdout + (stderr ? `\n[stderr]\n${stderr}` : ''));
        }
      }
    );
  });
}

async function runStep(
  progress: ProgressFn,
  label: string,
  script: string,
  timeoutMs = STEP_TIMEOUT_MS
): Promise<string> {
  progress(label + '…');
  const output = await runPowerShell(script, timeoutMs);
  return `===== ${label} =====\n${output.trim()}\n`;
}

function truncate(text: string, max = MAX_CATEGORY_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated ${text.length - max} chars]`;
}

const COLLECTORS: Record<DiagnosticCategory, (progress: ProgressFn) => Promise<string>> = {
  async eventLogs(progress) {
    const parts: string[] = [];
    parts.push(
      await runStep(
        progress,
        'Reading System event log (errors and warnings, last 7 days)',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-WinEvent -FilterHashtable @{ LogName='System'; Level=1,2,3; StartTime=(Get-Date).AddDays(-7) } -MaxEvents 25 |
  Select-Object TimeCreated, LevelDisplayName, ProviderName, Id, @{n='Message';e={($_.Message -split "\\r?\\n")[0]}} |
  Format-Table -AutoSize | Out-String -Width 200
`
      )
    );
    parts.push(
      await runStep(
        progress,
        'Reading Application event log (errors and warnings, last 7 days)',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-WinEvent -FilterHashtable @{ LogName='Application'; Level=1,2,3; StartTime=(Get-Date).AddDays(-7) } -MaxEvents 25 |
  Select-Object TimeCreated, LevelDisplayName, ProviderName, Id, @{n='Message';e={($_.Message -split "\\r?\\n")[0]}} |
  Format-Table -AutoSize | Out-String -Width 200
`
      )
    );
    parts.push(
      await runStep(
        progress,
        'Reading Security log audit failures (last 7 days)',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-WinEvent -FilterHashtable @{ LogName='Security'; Keywords=4503599627370496; StartTime=(Get-Date).AddDays(-7) } -MaxEvents 10 |
  Select-Object TimeCreated, Id, @{n='Message';e={($_.Message -split "\\r?\\n")[0]}} |
  Format-Table -AutoSize | Out-String -Width 200
`
      )
    );
    return parts.join('\n');
  },

  async performance(progress) {
    const parts: string[] = [];
    parts.push(
      await runStep(
        progress,
        'Reading CPU load and memory usage',
        `
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor
$cpuLoad = ($cpu | Measure-Object -Property LoadPercentage -Average).Average
$totalMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
$freeMB  = [math]::Round($os.FreePhysicalMemory / 1024)
Write-Output ("OS: {0} (build {1}), Uptime since: {2}" -f $os.Caption, $os.BuildNumber, $os.LastBootUpTime)
Write-Output ("CPU: {0}, Load: {1}%" -f ($cpu | Select-Object -First 1 -ExpandProperty Name), $cpuLoad)
Write-Output ("RAM: {0} MB total, {1} MB free ({2}% used)" -f $totalMB, $freeMB, [math]::Round(100 * ($totalMB - $freeMB) / $totalMB))
`
      )
    );
    parts.push(
      await runStep(
        progress,
        'Listing top processes by CPU and memory',
        `
$ErrorActionPreference = 'SilentlyContinue'
Write-Output "-- Top 15 by CPU time --"
Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id,
  @{n='CPU(s)';e={[math]::Round($_.CPU,1)}}, @{n='RAM(MB)';e={[math]::Round($_.WorkingSet64/1MB)}} |
  Format-Table -AutoSize | Out-String -Width 200
Write-Output "-- Top 15 by RAM --"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, Id,
  @{n='RAM(MB)';e={[math]::Round($_.WorkingSet64/1MB)}} |
  Format-Table -AutoSize | Out-String -Width 200
`
      )
    );
    parts.push(
      await runStep(
        progress,
        'Measuring disk activity',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk |
  Where-Object { $_.Name -ne '_Total' } |
  Select-Object Name, PercentDiskTime, CurrentDiskQueueLength |
  Format-Table -AutoSize | Out-String -Width 200
`
      )
    );
    return parts.join('\n');
  },

  async network(progress) {
    const parts: string[] = [];
    parts.push(
      await runStep(
        progress,
        'Pinging DNS servers 8.8.8.8 and 1.1.1.1',
        `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($ip in '8.8.8.8','1.1.1.1') {
  $r = Test-Connection -ComputerName $ip -Count 3 -ErrorAction SilentlyContinue
  if ($r) {
    $avg = ($r | Measure-Object -Property ResponseTime -Average).Average
    Write-Output ("{0}: reachable, avg {1} ms" -f $ip, [math]::Round($avg))
  } else {
    Write-Output ("{0}: UNREACHABLE" -f $ip)
  }
}
`,
        30_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Testing DNS name resolution',
        `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($name in 'www.microsoft.com','www.google.com') {
  $d = Resolve-DnsName $name -ErrorAction SilentlyContinue
  if ($d) { Write-Output ("{0}: OK ({1})" -f $name, (($d | Where-Object Type -eq 'A' | Select-Object -First 1).IPAddress)) }
  else { Write-Output ("{0}: FAILED to resolve" -f $name) }
}
`,
        30_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Reading network adapter configuration',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-NetIPConfiguration | ForEach-Object {
  Write-Output ("Adapter: {0} ({1})" -f $_.InterfaceAlias, $_.NetAdapter.Status)
  Write-Output ("  IPv4: {0}  Gateway: {1}  DNS: {2}" -f ($_.IPv4Address.IPAddress -join ','), $_.IPv4DefaultGateway.NextHop, ($_.DNSServer.ServerAddresses -join ','))
}
`,
        30_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Checking WiFi signal strength',
        `netsh wlan show interfaces | Select-String 'SSID|Signal|Radio type|Channel' | Out-String`,
        20_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Running a quick download speed test (about 5 MB)',
        `
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
`,
        30_000
      )
    );
    return parts.join('\n');
  },

  async storage(progress) {
    const parts: string[] = [
      'Note: deep scanning is limited to the system drive (usually C:) and user-reclaimable locations for speed. Other drives are listed with capacity/free-space only.\n',
    ];
    parts.push(
      await runStep(
        progress,
        'Listing all drives with capacity and free space',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, FileSystem,
  @{n='Size(GB)';e={[math]::Round($_.Size/1GB,1)}},
  @{n='Free(GB)';e={[math]::Round($_.SizeRemaining/1GB,1)}},
  @{n='Used%';e={ if ($_.Size -gt 0) { [math]::Round(100 * ($_.Size - $_.SizeRemaining) / $_.Size) } else { 0 } }} |
  Format-Table -AutoSize | Out-String -Width 200
`,
        20_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Measuring temp and cache folder sizes on the system drive',
        `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($p in "$env:TEMP", "$env:WINDIR\\Temp", "$env:LOCALAPPDATA\\Microsoft\\Windows\\INetCache", "$env:WINDIR\\SoftwareDistribution\\Download") {
  $size = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  Write-Output ("{0}: {1} MB" -f $p, [math]::Round(($size|ForEach-Object {$_})/1MB))
}
`,
        60_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Scanning your user profile folder sizes (system drive only)',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-ChildItem $env:USERPROFILE -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  [PSCustomObject]@{ Folder = $_.Name; 'Size(GB)' = [math]::Round(($size|ForEach-Object {$_})/1GB, 2) }
} | Sort-Object 'Size(GB)' -Descending | Select-Object -First 12 | Format-Table -AutoSize | Out-String -Width 200
`,
        90_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Finding large files in your user profile (over 100 MB, limited depth)',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-ChildItem $env:USERPROFILE -Recurse -Depth 4 -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -gt 100MB } |
  Sort-Object Length -Descending | Select-Object -First 10 @{n='Size(MB)';e={[math]::Round($_.Length/1MB)}}, FullName |
  Format-Table -AutoSize | Out-String -Width 250
`,
        60_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Measuring the Recycle Bin',
        `
$ErrorActionPreference = 'SilentlyContinue'
$rb = (New-Object -ComObject Shell.Application).NameSpace(10)
$rbSize = 0; foreach ($item in $rb.Items()) { $rbSize += $item.Size }
Write-Output ("Recycle Bin: {0} MB" -f [math]::Round($rbSize/1MB))
`,
        30_000
      )
    );
    return parts.join('\n');
  },

  async services(progress) {
    const parts: string[] = [];
    parts.push(
      await runStep(
        progress,
        'Checking automatic services that are not running',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } |
  Select-Object Name, DisplayName, Status | Format-Table -AutoSize | Out-String -Width 200
`
      )
    );
    parts.push(
      await runStep(
        progress,
        'Listing running third-party services',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Service | Where-Object { $_.State -eq 'Running' -and $_.PathName -notlike '*\\Windows\\*' } |
  Select-Object Name, DisplayName, StartMode | Format-Table -AutoSize | Out-String -Width 200
`
      )
    );
    parts.push(
      await runStep(
        progress,
        'Listing startup programs',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User |
  Format-Table -AutoSize | Out-String -Width 250
`
      )
    );
    parts.push(
      await runStep(
        progress,
        'Checking Windows Update service status',
        `
$ErrorActionPreference = 'SilentlyContinue'
$wu = Get-Service wuauserv
Write-Output ("Windows Update service: {0} ({1})" -f $wu.Status, $wu.StartType)
`,
        20_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Checking for scheduled tasks that failed recently',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-ScheduledTask | Where-Object State -ne 'Disabled' | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue |
  Where-Object { $_.LastTaskResult -ne 0 -and $_.LastRunTime -gt (Get-Date).AddDays(-7) } |
  Select-Object TaskName, LastRunTime, LastTaskResult | Select-Object -First 15 |
  Format-Table -AutoSize | Out-String -Width 250
`,
        60_000
      )
    );
    parts.push(
      await runStep(
        progress,
        'Checking for devices with driver problems',
        `
$ErrorActionPreference = 'SilentlyContinue'
Get-PnpDevice -Status Error -ErrorAction SilentlyContinue | Select-Object Class, FriendlyName, Status |
  Format-Table -AutoSize | Out-String -Width 200
`,
        30_000
      )
    );
    return parts.join('\n');
  },
};

export async function collectDiagnostics(
  categories: DiagnosticCategory[],
  onProgress?: (category: DiagnosticCategory, detail: string) => void
): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  for (const category of categories) {
    try {
      const raw = await COLLECTORS[category]((detail) => onProgress?.(category, detail));
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
