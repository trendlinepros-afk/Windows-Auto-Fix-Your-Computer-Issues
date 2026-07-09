import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Fix, FixExecutionResult } from '../types';
import { validateScript } from './scriptValidator';

/**
 * Fix execution system.
 *
 * - Scripts are validated against a dangerous-command blocklist, written to a
 *   private temp directory, executed with output/exit-code capture, then the
 *   temp file is removed.
 * - The app itself runs elevated (requireAdministrator manifest), so
 *   non-critical fixes run in-process with no extra UAC prompt.
 * - Critical fixes (fix.critical === true) are launched through
 *   `Start-Process -Verb RunAs` so Windows shows an explicit UAC confirmation
 *   for exactly that action.
 * - Optionally creates a System Restore Point first.
 */

const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OUTPUT_CHARS = 100_000;

interface RawExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function scratchDir(): string {
  const dir = path.join(os.tmpdir(), 'WindowsTroubleshooter');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScriptFile(fix: Fix): string {
  const ext = fix.shell === 'powershell' ? 'ps1' : 'cmd';
  const file = path.join(
    scratchDir(),
    `fix-${fix.id}-${Date.now()}.${ext}`
  );
  // BOM makes PowerShell treat the file as UTF-8 reliably.
  const prefix = fix.shell === 'powershell' ? '﻿' : '';
  fs.writeFileSync(file, prefix + fix.script, 'utf8');
  return file;
}

function runShell(
  command: string,
  args: string[],
  timeoutMs = EXEC_TIMEOUT_MS
): Promise<RawExecution> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

async function executeInProcess(fix: Fix, scriptFile: string): Promise<RawExecution> {
  if (fix.shell === 'powershell') {
    return runShell('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptFile,
    ]);
  }
  return runShell('cmd.exe', ['/d', '/c', scriptFile]);
}

/**
 * Critical fixes run through an explicit elevated process so the user sees a
 * dedicated UAC prompt. Output and exit code are captured via files because
 * an elevated child's stdio cannot be piped across the integrity boundary.
 */
async function executeElevated(fix: Fix, scriptFile: string): Promise<RawExecution> {
  const outFile = scriptFile + '.out.txt';
  const codeFile = scriptFile + '.code.txt';

  const inner =
    fix.shell === 'powershell'
      ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`
      : `cmd.exe /d /c "${scriptFile}"`;

  const wrapper = `
$ErrorActionPreference = 'Continue'
try {
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',"${inner.replace(/"/g, '\\"')} > \\"${outFile}\\" 2>&1" -Verb RunAs -Wait -PassThru
  Set-Content -Path "${codeFile}" -Value $p.ExitCode
} catch {
  Set-Content -Path "${outFile}" -Value $_.Exception.Message
  Set-Content -Path "${codeFile}" -Value -1
}
`;

  const launch = await runShell('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    wrapper,
  ]);

  let stdout = '';
  let exitCode = launch.exitCode;
  try {
    stdout = fs.readFileSync(outFile, 'utf8');
  } catch {
    stdout = launch.stdout;
  }
  try {
    exitCode = parseInt(fs.readFileSync(codeFile, 'utf8').trim(), 10);
    if (Number.isNaN(exitCode)) exitCode = -1;
  } catch {
    // Keep launcher exit code.
  }
  for (const f of [outFile, codeFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      // Ignore.
    }
  }
  return { exitCode, stdout, stderr: launch.stderr, timedOut: launch.timedOut };
}

export async function createRestorePoint(label: string): Promise<{ ok: boolean; message: string }> {
  const safeLabel = label.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60) || 'Windows Troubleshooter Fix';
  const script = `
$ErrorActionPreference = 'Stop'
try {
  Enable-ComputerRestore -Drive "$env:SystemDrive\\" -ErrorAction SilentlyContinue
  Checkpoint-Computer -Description "WT: ${safeLabel}" -RestorePointType MODIFY_SETTINGS
  Write-Output 'RESTORE_POINT_OK'
} catch {
  Write-Output "RESTORE_POINT_FAILED: $($_.Exception.Message)"
  exit 1
}
`;
  const result = await runShell(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    3 * 60 * 1000
  );
  const ok = result.stdout.includes('RESTORE_POINT_OK');
  return {
    ok,
    message: ok
      ? 'Restore point created'
      : (result.stdout + result.stderr).trim() || 'Restore point creation failed',
  };
}

/** Run the fix's metric probe (a read-only PowerShell one-liner) if present. */
async function probeMetric(fix: Fix): Promise<string | undefined> {
  if (!fix.metricProbe) return undefined;
  const validation = validateScript(fix.metricProbe);
  if (!validation.valid) return undefined;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', fix.metricProbe as string],
      { timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        resolve(error && !stdout ? undefined : stdout.trim().slice(0, 500) || undefined);
      }
    );
  });
}

export async function executeFix(
  fix: Fix,
  createRestorePointFirst: boolean
): Promise<FixExecutionResult> {
  // Final validation gate immediately before execution.
  const validation = validateScript(fix.script);
  if (!validation.valid) {
    return {
      fixId: fix.id,
      status: 'Failed',
      exitCode: -1,
      output: '',
      errorMessage: `Script blocked by safety validator: ${validation.reasons.join('; ')}`,
      restorePointCreated: false,
    };
  }

  let restorePointCreated = false;
  let restoreNote = '';
  if (createRestorePointFirst) {
    const rp = await createRestorePoint(fix.title);
    restorePointCreated = rp.ok;
    restoreNote = `[Restore point] ${rp.message}\n\n`;
  }

  const beforeState = await probeMetric(fix);
  const scriptFile = writeScriptFile(fix);

  let raw: RawExecution;
  try {
    raw = fix.critical
      ? await executeElevated(fix, scriptFile)
      : await executeInProcess(fix, scriptFile);
  } finally {
    try {
      fs.unlinkSync(scriptFile);
    } catch {
      // Ignore.
    }
  }

  const afterState = await probeMetric(fix);
  const success = raw.exitCode === 0 && !raw.timedOut;
  const output = (restoreNote + raw.stdout + (raw.stderr ? `\n[stderr]\n${raw.stderr}` : ''))
    .trim()
    .slice(0, MAX_OUTPUT_CHARS);

  return {
    fixId: fix.id,
    status: success ? 'Success' : 'Failed',
    exitCode: raw.exitCode,
    output,
    errorMessage: success
      ? undefined
      : raw.timedOut
        ? 'Fix timed out after 10 minutes'
        : raw.stderr.trim() || `Exited with code ${raw.exitCode}`,
    beforeState,
    afterState,
    restorePointCreated,
  };
}

/** Check whether the current process is elevated (Windows only). */
export function isRunningAsAdmin(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('net.exe', ['session'], { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

/** Relaunch the app elevated and quit the current instance. */
export function relaunchAsAdmin(exePath: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process -FilePath "${exePath}" -Verb RunAs`],
      { windowsHide: true },
      () => resolve()
    );
  });
}

/** Launch the Windows System Restore UI so the user can roll back a fix. */
export function openSystemRestoreUi(): void {
  spawn('rstrui.exe', [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}
