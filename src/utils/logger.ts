import * as fs from 'fs';
import * as path from 'path';
import { LogClearRange, LogEntry } from '../types';

/**
 * Plain-TXT audit log for every fix executed.
 *
 * Location: %APPDATA%/WindowsTroubleshooter/logs/
 * Format:   one JSON object per line inside daily .txt files
 *           (human-readable AND machine-parseable).
 * Retention: configurable (default 30 days), enforced on startup and on
 *            every write; user can clear manually anytime.
 */
export class Logger {
  private logDir: string;

  constructor(appDataDir?: string) {
    const base =
      appDataDir ||
      process.env.APPDATA ||
      path.join(require('os').homedir(), '.config');
    this.logDir = path.join(base, 'WindowsTroubleshooter', 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  getLogDir(): string {
    return this.logDir;
  }

  private fileForDate(date: Date): string {
    const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(this.logDir, `troubleshooter-${iso}.txt`);
  }

  append(entry: LogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.fileForDate(new Date(entry.timestamp)), line, 'utf8');
  }

  readAll(): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const file of this.listLogFiles()) {
      const content = fs.readFileSync(path.join(this.logDir, file), 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as LogEntry);
        } catch {
          // Skip malformed lines rather than failing the whole viewer.
        }
      }
    }
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return entries;
  }

  /** Delete log files older than `retentionDays`. */
  enforceRetention(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const file of this.listLogFiles()) {
      const date = this.dateFromFilename(file);
      if (date && date.getTime() < cutoff) {
        try {
          fs.unlinkSync(path.join(this.logDir, file));
        } catch {
          // Ignore files we cannot delete (locked, permissions).
        }
      }
    }
  }

  /** Clear all logs, or only those within a date range (inclusive). */
  clear(range?: LogClearRange): number {
    let removed = 0;
    const from = range?.from ? new Date(range.from).getTime() : -Infinity;
    const to = range?.to
      ? new Date(range.to).getTime() + 24 * 60 * 60 * 1000 - 1
      : Infinity;

    for (const file of this.listLogFiles()) {
      const date = this.dateFromFilename(file);
      if (!date) continue;
      const t = date.getTime();
      if (t >= from && t <= to) {
        try {
          fs.unlinkSync(path.join(this.logDir, file));
          removed++;
        } catch {
          // Ignore.
        }
      }
    }
    return removed;
  }

  /** Render all entries as a human-readable TXT report. */
  exportAsText(): string {
    const entries = this.readAll();
    const lines: string[] = [
      'Windows Troubleshooter — Fix Execution Log',
      `Exported: ${new Date().toISOString()}`,
      `Entries: ${entries.length}`,
      '='.repeat(72),
      '',
    ];
    for (const e of entries) {
      lines.push(`Timestamp:    ${e.timestamp}`);
      lines.push(`Fix Name:     ${e.fixName}`);
      lines.push(`Status:       ${e.status} (exit code ${e.exitCode})`);
      lines.push(`Description:  ${e.description}`);
      lines.push(`Command:`);
      lines.push(indent(e.command, 4));
      if (e.beforeState) lines.push(`Before State: ${e.beforeState}`);
      if (e.afterState) lines.push(`After State:  ${e.afterState}`);
      if (e.errorMessage) lines.push(`Error:        ${e.errorMessage}`);
      lines.push(`Output:`);
      lines.push(indent(e.output || '(no output)', 4));
      lines.push('-'.repeat(72));
      lines.push('');
    }
    return lines.join('\n');
  }

  private listLogFiles(): string[] {
    try {
      return fs
        .readdirSync(this.logDir)
        .filter((f) => /^troubleshooter-\d{4}-\d{2}-\d{2}\.txt$/.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  private dateFromFilename(file: string): Date | null {
    const m = file.match(/^troubleshooter-(\d{4}-\d{2}-\d{2})\.txt$/);
    return m ? new Date(m[1] + 'T00:00:00Z') : null;
  }
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
