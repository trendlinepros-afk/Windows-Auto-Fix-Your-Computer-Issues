import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  AppSettings,
  ChatStreamEvent,
  DiagnosticCategory,
  FixExecutionRequest,
  FixExecutionResult,
  LogClearRange,
  LogEntry,
  MonitoringAlert,
  UpdateInfo,
} from '../types';

/**
 * IPC bridge: the only surface the renderer can reach. contextIsolation is on
 * and nodeIntegration is off, so the renderer never touches Node APIs directly.
 */

export interface AppInfo {
  version: string;
  isAdmin: boolean;
  platform: string;
  logDir: string;
}

export interface ExportResult {
  ok: boolean;
  filePath?: string;
  canceled?: boolean;
  error?: string;
}

export interface DownloadResult {
  ok: boolean;
  filePath?: string;
  hashVerified?: boolean;
  error?: string;
}

export interface GeminiModelsResult {
  ok: boolean;
  models?: string[];
  recommended?: string | null;
  error?: string;
}

const api = {
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    save: (settings: AppSettings): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:save', settings),
  },

  chat: {
    diagnose: (
      message: string,
      categories: DiagnosticCategory[]
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:diagnose', message, categories),
    onStream: (callback: (event: ChatStreamEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, event: ChatStreamEvent) =>
        callback(event);
      ipcRenderer.on('chat:stream', listener);
      return () => ipcRenderer.removeListener('chat:stream', listener);
    },
  },

  gemini: {
    listModels: (): Promise<GeminiModelsResult> =>
      ipcRenderer.invoke('gemini:listModels'),
  },

  fixes: {
    execute: (request: FixExecutionRequest): Promise<FixExecutionResult> =>
      ipcRenderer.invoke('fix:execute', request),
    openSystemRestore: (): Promise<void> =>
      ipcRenderer.invoke('fix:openSystemRestore'),
  },

  logs: {
    list: (): Promise<LogEntry[]> => ipcRenderer.invoke('logs:list'),
    openFolder: (): Promise<string> => ipcRenderer.invoke('logs:openFolder'),
    clear: (range?: LogClearRange): Promise<number> =>
      ipcRenderer.invoke('logs:clear', range),
    export: (format: 'txt' | 'pdf'): Promise<ExportResult> =>
      ipcRenderer.invoke('logs:export', format),
  },

  updater: {
    check: (): Promise<UpdateInfo> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<DownloadResult> => ipcRenderer.invoke('updater:download'),
    onUpdateAvailable: (callback: (info: UpdateInfo) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, info: UpdateInfo) => callback(info);
      ipcRenderer.on('updater:available', listener);
      return () => ipcRenderer.removeListener('updater:available', listener);
    },
  },

  monitoring: {
    onAlert: (callback: (alert: MonitoringAlert) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, alert: MonitoringAlert) =>
        callback(alert);
      ipcRenderer.on('monitoring:alert', listener);
      return () => ipcRenderer.removeListener('monitoring:alert', listener);
    },
  },
};

export type PreloadApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
