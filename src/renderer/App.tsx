import React, { useEffect, useState } from 'react';
import { AppSettings, MonitoringAlert, UpdateInfo } from '../types';
import ChatInterface from './components/ChatInterface';
import LogsViewer from './components/LogsViewer';
import SettingsPanel from './components/SettingsPanel';

type Tab = 'chat' | 'logs' | 'settings';

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('chat');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [version, setVersion] = useState('');
  const [isAdmin, setIsAdmin] = useState(true);
  const [platform, setPlatform] = useState('win32');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [monitorAlert, setMonitorAlert] = useState<MonitoringAlert | null>(null);

  useEffect(() => {
    void window.api.settings.get().then((loaded) => {
      setSettings(loaded);
      // Startup update check runs from the renderer so the result can never
      // arrive before the UI is ready to show the banner.
      if (loaded.checkUpdatesOnStartup) {
        void window.api.updater.check().then((info) => {
          if (info.updateAvailable) setUpdate(info);
        });
      }
    });
    void window.api.app.getInfo().then((info) => {
      setVersion(info.version);
      setIsAdmin(info.isAdmin);
      setPlatform(info.platform);
    });

    const offUpdate = window.api.updater.onUpdateAvailable(setUpdate);
    const offAlert = window.api.monitoring.onAlert(setMonitorAlert);
    return () => {
      offUpdate();
      offAlert();
    };
  }, []);

  const handleSettingsSaved = (saved: AppSettings) => {
    setSettings(saved);
  };

  const downloadUpdate = async () => {
    setUpdateBusy(true);
    try {
      const result = await window.api.updater.download();
      if (result.ok) setUpdate(null);
      else alert(`Update failed: ${result.error}`);
    } finally {
      setUpdateBusy(false);
    }
  };

  if (!settings) {
    return <div className="app-loading">Loading…</div>;
  }

  const apiKeysMissing = !settings.geminiApiKey || !settings.deepseekApiKey;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-icon">🛠️</span>
          <div>
            <div className="brand-name">Windows Troubleshooter</div>
            <div className="brand-version">v{version || '…'}</div>
          </div>
        </div>

        <button
          className={`nav-btn ${tab === 'chat' ? 'active' : ''}`}
          onClick={() => setTab('chat')}
        >
          💬 Chat
        </button>
        <button
          className={`nav-btn ${tab === 'logs' ? 'active' : ''}`}
          onClick={() => setTab('logs')}
        >
          📋 Logs
        </button>
        <button
          className={`nav-btn ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
        >
          ⚙️ Settings
        </button>

        <div className="sidebar-footer">
          {!isAdmin && platform === 'win32' && (
            <div className="badge warn">⚠ Not running as admin</div>
          )}
          {settings.monitoringEnabled && (
            <div className="badge ok">
              👁 Monitoring every {settings.monitoringIntervalMinutes} min
            </div>
          )}
        </div>
      </nav>

      <main className="content">
        {update?.updateAvailable && (
          <div className="banner update-banner">
            <span>
              🔄 Update available: v{update.latestVersion} (you have v
              {update.currentVersion})
            </span>
            <div className="banner-actions">
              <button className="btn primary sm" onClick={downloadUpdate} disabled={updateBusy}>
                {updateBusy ? 'Downloading…' : 'Download now'}
              </button>
              <button className="btn ghost sm" onClick={() => setUpdate(null)}>
                Later
              </button>
            </div>
          </div>
        )}

        {monitorAlert && (
          <div className="banner alert-banner">
            <span>👁 Monitoring alert: {monitorAlert.summary}</span>
            <div className="banner-actions">
              <button
                className="btn primary sm"
                onClick={() => {
                  setTab('chat');
                  setMonitorAlert(null);
                }}
              >
                Review in chat
              </button>
              <button className="btn ghost sm" onClick={() => setMonitorAlert(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {apiKeysMissing && tab === 'chat' && (
          <div className="banner warn-banner">
            <span>
              🔑 Add your Gemini and DeepSeek API keys in Settings to enable AI
              diagnosis.
            </span>
            <button className="btn primary sm" onClick={() => setTab('settings')}>
              Open Settings
            </button>
          </div>
        )}

        <div className="tab-body" style={{ display: tab === 'chat' ? 'flex' : 'none' }}>
          <ChatInterface settings={settings} />
        </div>
        {tab === 'logs' && (
          <div className="tab-body">
            <LogsViewer />
          </div>
        )}
        {tab === 'settings' && (
          <div className="tab-body">
            <SettingsPanel settings={settings} onSaved={handleSettingsSaved} />
          </div>
        )}
      </main>
    </div>
  );
}
