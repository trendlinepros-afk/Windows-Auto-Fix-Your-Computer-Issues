/**
 * Shared types used across main, preload, and renderer processes.
 */

export type DiagnosticCategory =
  | 'eventLogs'
  | 'performance'
  | 'network'
  | 'storage'
  | 'services';

export const ALL_DIAGNOSTIC_CATEGORIES: DiagnosticCategory[] = [
  'eventLogs',
  'performance',
  'network',
  'storage',
  'services',
];

export const DIAGNOSTIC_CATEGORY_LABELS: Record<DiagnosticCategory, string> = {
  eventLogs: 'Windows Event Logs',
  performance: 'Performance Counters',
  network: 'Network Diagnostics',
  storage: 'Storage Analysis',
  services: 'Services & Startup Items',
};

export interface DiagnosticResult {
  category: DiagnosticCategory;
  collectedAt: string; // ISO 8601
  /** Sanitized, human-readable diagnostic text for this category. */
  data: string;
  error?: string;
}

export type ShellType = 'powershell' | 'cmd';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface Fix {
  id: string;
  title: string;
  /** Plain-English summary shown to the user (2-3 sentences). */
  description: string;
  /** The actual script to execute. */
  script: string;
  shell: ShellType;
  riskLevel: RiskLevel;
  /**
   * Critical fixes (registry, system services, sfc/chkdsk) get an explicit
   * elevated execution; non-critical fixes run in the current (admin) process.
   */
  critical: boolean;
  /** Issue category this fix addresses (e.g. "storage"). */
  category: string;
  /** Optional PowerShell snippet used to snapshot a metric before/after. */
  metricProbe?: string;
}

export interface ScriptValidationResult {
  valid: boolean;
  reasons: string[];
}

export interface FixExecutionRequest {
  fix: Fix;
  createRestorePoint: boolean;
}

export interface FixExecutionResult {
  fixId: string;
  status: 'Success' | 'Failed';
  exitCode: number;
  output: string;
  errorMessage?: string;
  beforeState?: string;
  afterState?: string;
  restorePointCreated: boolean;
}

export interface LogEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  fixName: string;
  /** The actual PowerShell/CMD executed. */
  command: string;
  /** Plain-English description the user approved. */
  description: string;
  status: 'Success' | 'Failed';
  exitCode: number;
  /** Captured stdout/stderr. */
  output: string;
  errorMessage?: string;
  beforeState?: string;
  afterState?: string;
}

export interface LogClearRange {
  /** ISO date (inclusive). Omit for "since forever". */
  from?: string;
  /** ISO date (inclusive). Omit for "until now". */
  to?: string;
}

export interface DataOptIn {
  eventLogs: boolean;
  performance: boolean;
  network: boolean;
  storage: boolean;
  services: boolean;
}

export interface AppSettings {
  geminiApiKey: string;
  deepseekApiKey: string;
  geminiModel: string;
  deepseekModel: string;
  monitoringEnabled: boolean;
  monitoringIntervalMinutes: 15 | 30 | 60;
  logRetentionDays: number;
  dataOptIn: DataOptIn;
  checkUpdatesOnStartup: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  geminiApiKey: '',
  deepseekApiKey: '',
  geminiModel: 'gemini-2.0-flash',
  deepseekModel: 'deepseek-chat',
  monitoringEnabled: false,
  monitoringIntervalMinutes: 30,
  logRetentionDays: 30,
  dataOptIn: {
    eventLogs: true,
    performance: true,
    network: true,
    storage: true,
    services: true,
  },
  checkUpdatesOnStartup: true,
};

export interface DiagnosedIssue {
  title: string;
  category: string;
  reasoning: string;
  severity: RiskLevel;
}

/** Streaming events pushed from main -> renderer during a chat turn. */
export type ChatStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'chunk'; text: string }
  | { type: 'fixes'; fixes: Fix[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
  downloadUrl?: string;
  sha256Url?: string;
  error?: string;
}

export interface MonitoringAlert {
  timestamp: string;
  summary: string;
  details: string;
}
