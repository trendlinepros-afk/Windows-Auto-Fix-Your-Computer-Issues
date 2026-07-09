import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  AppSettings,
  ChatStreamEvent,
  DiagnosticCategory,
  Fix,
  FixExecutionRequest,
  LogClearRange,
  LogEntry,
  UpdateInfo,
} from '../types';
import { generateFixForIssue, streamGeminiDiagnosis } from '../utils/apiClients';
import { collectDiagnostics, quickHealthCheck } from '../utils/diagnostics';
import {
  executeFix,
  isRunningAsAdmin,
  openSystemRestoreUi,
  relaunchAsAdmin,
} from '../utils/executor';
import { Logger } from '../utils/logger';
import { validateScript } from '../utils/scriptValidator';
import { SettingsStore } from '../utils/settings';
import { checkForUpdates, downloadUpdate } from '../utils/updater';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let monitoringTimer: NodeJS.Timeout | null = null;
let pendingUpdate: UpdateInfo | null = null;

let logger: Logger;
let settingsStore: SettingsStore;

const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// Window / lifecycle
// ---------------------------------------------------------------------------

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: 'Windows Troubleshooter',
    backgroundColor: '#0f1117',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'public', 'icon.png')
    : path.join(app.getAppPath(), 'public', 'icon.png');
}

async function ensureAdmin(): Promise<boolean> {
  if (process.platform !== 'win32') return true; // Dev on non-Windows.
  if (await isRunningAsAdmin()) return true;

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Administrator privileges required',
    message:
      'Windows Troubleshooter needs administrator privileges to run diagnostics and apply fixes.',
    detail: 'The app will restart and Windows will ask for confirmation (UAC).',
    buttons: ['Restart as Administrator', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) {
    await relaunchAsAdmin(process.execPath);
  }
  app.quit();
  return false;
}

app.whenReady().then(async () => {
  settingsStore = new SettingsStore(app.getPath('userData'));
  logger = new Logger(app.getPath('appData'));

  const settings = settingsStore.get();
  logger.enforceRetention(settings.logRetentionDays);

  if (!(await ensureAdmin())) return;

  registerIpcHandlers();
  createMainWindow();
  createTray();
  applyMonitoringSchedule(settings);

  if (settings.checkUpdatesOnStartup) {
    void startupUpdateCheck();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray only if monitoring is enabled.
  const settings = settingsStore?.get();
  if (!settings?.monitoringEnabled) {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (monitoringTimer) clearInterval(monitoringTimer);
  tray?.destroy();
});

// ---------------------------------------------------------------------------
// Tray + continuous monitoring
// ---------------------------------------------------------------------------

function createTray(): void {
  try {
    const image = nativeImage.createFromPath(iconPath());
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
    tray.setToolTip('Windows Troubleshooter');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Windows Troubleshooter', click: showMainWindow },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
    tray.on('double-click', showMainWindow);
  } catch {
    // Tray is a convenience; never fatal.
  }
}

function showMainWindow(): void {
  if (!mainWindow) createMainWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

function applyMonitoringSchedule(settings: AppSettings): void {
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }
  if (!settings.monitoringEnabled) return;

  const intervalMs = settings.monitoringIntervalMinutes * 60 * 1000;
  monitoringTimer = setInterval(async () => {
    try {
      const issues = await quickHealthCheck();
      if (!issues) return;
      const notification = new Notification({
        title: 'Windows Troubleshooter found potential issues',
        body: issues.split('\n').slice(0, 3).join('\n'),
      });
      notification.on('click', showMainWindow);
      notification.show();
      mainWindow?.webContents.send('monitoring:alert', {
        timestamp: new Date().toISOString(),
        summary: issues.split('\n')[0],
        details: issues,
      });
    } catch {
      // Monitoring must never crash the app.
    }
  }, intervalMs);
}

// ---------------------------------------------------------------------------
// Startup update check
// ---------------------------------------------------------------------------

async function startupUpdateCheck(): Promise<void> {
  const info = await checkForUpdates(app.getVersion());
  if (!info.updateAvailable || !mainWindow) return;
  pendingUpdate = info;
  mainWindow.webContents.send('updater:available', info);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function sendChatEvent(event: ChatStreamEvent): void {
  mainWindow?.webContents.send('chat:stream', event);
}

function registerIpcHandlers(): void {
  // ---- App info -----------------------------------------------------------
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    isAdmin: await isRunningAsAdmin(),
    platform: process.platform,
    logDir: logger.getLogDir(),
  }));

  // ---- Settings -----------------------------------------------------------
  ipcMain.handle('settings:get', () => settingsStore.get());

  ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
    settingsStore.save(settings);
    logger.enforceRetention(settings.logRetentionDays);
    applyMonitoringSchedule(settings);
    return settingsStore.get();
  });

  // ---- Chat / diagnosis pipeline -----------------------------------------
  ipcMain.handle(
    'chat:diagnose',
    async (_event, userMessage: string, categories: DiagnosticCategory[]) => {
      const settings = settingsStore.get();
      try {
        const optedIn = categories.filter((c) => settings.dataOptIn[c]);
        sendChatEvent({
          type: 'status',
          message:
            optedIn.length > 0
              ? 'Collecting system info…'
              : 'No diagnostic categories enabled — analyzing description only…',
        });

        const diagnostics = await collectDiagnostics(optedIn, (category) => {
          sendChatEvent({ type: 'status', message: `Collecting: ${category}…` });
        });

        sendChatEvent({ type: 'status', message: 'Analyzing with AI…' });
        const { issues } = await streamGeminiDiagnosis(
          settings,
          userMessage,
          diagnostics,
          (text) => sendChatEvent({ type: 'chunk', text })
        );

        if (issues.length === 0) {
          sendChatEvent({ type: 'fixes', fixes: [] });
          sendChatEvent({ type: 'done' });
          return { ok: true };
        }

        sendChatEvent({
          type: 'status',
          message: `Generating fix scripts for ${issues.length} issue(s)…`,
        });

        const fixes: Fix[] = [];
        for (const issue of issues) {
          try {
            const fix = await generateFixForIssue(settings, issue, userMessage);
            const validation = validateScript(fix.script);
            if (!validation.valid) {
              // Refuse dangerous AI output silently to the model, loudly to the user.
              sendChatEvent({
                type: 'status',
                message: `Skipped unsafe generated fix "${fix.title}": ${validation.reasons.join('; ')}`,
              });
              continue;
            }
            fixes.push(fix);
          } catch (err) {
            sendChatEvent({
              type: 'status',
              message: `Could not generate a fix for "${issue.title}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
        }

        sendChatEvent({ type: 'fixes', fixes });
        sendChatEvent({ type: 'done' });
        return { ok: true };
      } catch (err) {
        sendChatEvent({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        return { ok: false };
      }
    }
  );

  // ---- Fix execution ------------------------------------------------------
  ipcMain.handle('fix:execute', async (_event, request: FixExecutionRequest) => {
    const result = await executeFix(request.fix, request.createRestorePoint);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      fixName: request.fix.title,
      command: request.fix.script,
      description: request.fix.description,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
      errorMessage: result.errorMessage,
      beforeState: result.beforeState,
      afterState: result.afterState,
    };
    logger.append(entry);
    return result;
  });

  ipcMain.handle('fix:openSystemRestore', () => {
    openSystemRestoreUi();
  });

  // ---- Logs ---------------------------------------------------------------
  ipcMain.handle('logs:list', () => logger.readAll());

  ipcMain.handle('logs:openFolder', () => shell.openPath(logger.getLogDir()));

  ipcMain.handle('logs:clear', (_event, range?: LogClearRange) => logger.clear(range));

  ipcMain.handle('logs:export', async (_event, format: 'txt' | 'pdf') => {
    if (!mainWindow) return { ok: false, error: 'No window' };

    const defaultName = `troubleshooter-logs-${new Date()
      .toISOString()
      .slice(0, 10)}.${format}`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: `Export logs as ${format.toUpperCase()}`,
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters:
        format === 'pdf'
          ? [{ name: 'PDF', extensions: ['pdf'] }]
          : [{ name: 'Text', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    try {
      if (format === 'txt') {
        fs.writeFileSync(filePath, logger.exportAsText(), 'utf8');
      } else {
        await exportLogsAsPdf(filePath);
      }
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- Updater ------------------------------------------------------------
  ipcMain.handle('updater:check', async () => {
    pendingUpdate = await checkForUpdates(app.getVersion());
    return pendingUpdate;
  });

  ipcMain.handle('updater:download', async () => {
    if (!pendingUpdate?.updateAvailable) {
      return { ok: false, error: 'No update available' };
    }
    try {
      const { filePath, hashVerified } = await downloadUpdate(
        pendingUpdate,
        app.getPath('downloads')
      );
      logger.append({
        timestamp: new Date().toISOString(),
        fixName: 'App Update Downloaded',
        command: `download ${pendingUpdate.downloadUrl}`,
        description: `Downloaded update v${pendingUpdate.latestVersion} (hash verified: ${hashVerified})`,
        status: 'Success',
        exitCode: 0,
        output: filePath,
      });
      await shell.openPath(filePath);
      return { ok: true, filePath, hashVerified };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.append({
        timestamp: new Date().toISOString(),
        fixName: 'App Update Failed',
        command: `download ${pendingUpdate.downloadUrl}`,
        description: 'Update download or verification failed',
        status: 'Failed',
        exitCode: -1,
        output: '',
        errorMessage: message,
      });
      return { ok: false, error: message };
    }
  });
}

// ---------------------------------------------------------------------------
// PDF export (offscreen window + printToPDF — no extra dependencies)
// ---------------------------------------------------------------------------

async function exportLogsAsPdf(filePath: string): Promise<void> {
  const entries = logger.readAll();
  const html = buildLogReportHtml(entries);

  const pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await pdfWindow.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(html)
    );
    const pdf = await pdfWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
    });
    fs.writeFileSync(filePath, pdf);
  } finally {
    pdfWindow.destroy();
  }
}

function buildLogReportHtml(entries: LogEntry[]): string {
  const esc = (s: string | undefined) =>
    (s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const rows = entries
    .map(
      (e) => `
    <div class="entry">
      <h3>${esc(e.fixName)} — <span class="${e.status === 'Success' ? 'ok' : 'fail'}">${e.status}</span></h3>
      <p class="meta">${esc(e.timestamp)} · exit code ${e.exitCode}</p>
      <p>${esc(e.description)}</p>
      ${e.beforeState ? `<p><b>Before:</b> ${esc(e.beforeState)}</p>` : ''}
      ${e.afterState ? `<p><b>After:</b> ${esc(e.afterState)}</p>` : ''}
      ${e.errorMessage ? `<p class="fail"><b>Error:</b> ${esc(e.errorMessage)}</p>` : ''}
      <pre>${esc(e.command)}</pre>
      <pre class="out">${esc(e.output || '(no output)')}</pre>
    </div>`
    )
    .join('\n');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: 'Segoe UI', sans-serif; color: #1a1a2e; margin: 24px; }
    h1 { font-size: 20px; } h3 { margin-bottom: 2px; font-size: 14px; }
    .meta { color: #666; font-size: 11px; margin-top: 0; }
    .ok { color: #0a7d33; } .fail { color: #b91c1c; }
    pre { background: #f4f4f8; border: 1px solid #ddd; padding: 8px; font-size: 10px;
          white-space: pre-wrap; word-break: break-word; }
    .entry { page-break-inside: avoid; border-bottom: 1px solid #ccc; padding-bottom: 12px; }
  </style></head><body>
    <h1>Windows Troubleshooter — Fix Execution Log</h1>
    <p>Exported ${new Date().toISOString()} · ${entries.length} entries</p>
    ${rows || '<p>No log entries.</p>'}
  </body></html>`;
}
