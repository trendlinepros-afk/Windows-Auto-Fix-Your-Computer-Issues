import React, { useState } from 'react';
import {
  ALL_DIAGNOSTIC_CATEGORIES,
  AppSettings,
  DIAGNOSTIC_CATEGORY_LABELS,
  DiagnosticCategory,
  UpdateInfo,
} from '../../types';

interface Props {
  settings: AppSettings;
  onSaved: (settings: AppSettings) => void;
}

export default function SettingsPanel({ settings, onSaved }: Props): JSX.Element {
  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showDeepseekKey, setShowDeepseekKey] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState('');
  const [geminiModels, setGeminiModels] = useState<string[]>([]);
  const [detectingModels, setDetectingModels] = useState(false);
  const [modelNotice, setModelNotice] = useState('');

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSavedNotice(false);
  };

  const setOptIn = (category: DiagnosticCategory, value: boolean) => {
    setDraft((d) => ({
      ...d,
      dataOptIn: { ...d.dataOptIn, [category]: value },
    }));
    setSavedNotice(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await window.api.settings.save(draft);
      onSaved(saved);
      setSavedNotice(true);
    } finally {
      setSaving(false);
    }
  };

  const detectGeminiModels = async () => {
    setDetectingModels(true);
    setModelNotice('');
    try {
      const result = await window.api.gemini.listModels();
      if (!result.ok) {
        setModelNotice(`Detection failed: ${result.error}`);
        return;
      }
      setGeminiModels(result.models || []);
      if (result.recommended) {
        set('geminiModel', result.recommended);
        setModelNotice(
          `Found ${result.models?.length ?? 0} models — recommended "${result.recommended}" applied. Save Settings to keep it.`
        );
      } else {
        setModelNotice(
          `Found ${result.models?.length ?? 0} models. Pick one from the field's dropdown.`
        );
      }
    } finally {
      setDetectingModels(false);
    }
  };

  const checkUpdates = async () => {
    setCheckingUpdate(true);
    setDownloadNotice('');
    try {
      setUpdateInfo(await window.api.updater.check());
    } finally {
      setCheckingUpdate(false);
    }
  };

  const downloadUpdate = async () => {
    setDownloading(true);
    setDownloadNotice('');
    try {
      const result = await window.api.updater.download();
      if (result.ok) {
        setDownloadNotice(
          `Installer downloaded${result.hashVerified ? ' (checksum verified)' : ''} and launched — close this app to finish installing.`
        );
      } else {
        setDownloadNotice(`Download failed: ${result.error}`);
      }
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="settings">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>🔑 API Keys</h3>
        <p className="muted">
          Keys are stored encrypted on this machine (Windows DPAPI via Electron
          safeStorage). They are only used to call the AI APIs directly.
        </p>
        <label className="field">
          Gemini API key (diagnosis)
          <div className="key-row">
            <input
              type={showGeminiKey ? 'text' : 'password'}
              value={draft.geminiApiKey}
              onChange={(e) => set('geminiApiKey', e.target.value)}
              placeholder="AIza…"
            />
            <button
              className="btn ghost sm"
              onClick={() => setShowGeminiKey((s) => !s)}
            >
              {showGeminiKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>
        <label className="field">
          DeepSeek API key (fix scripts)
          <div className="key-row">
            <input
              type={showDeepseekKey ? 'text' : 'password'}
              value={draft.deepseekApiKey}
              onChange={(e) => set('deepseekApiKey', e.target.value)}
              placeholder="sk-…"
            />
            <button
              className="btn ghost sm"
              onClick={() => setShowDeepseekKey((s) => !s)}
            >
              {showDeepseekKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>
        <div className="field-grid">
          <label className="field">
            Gemini model
            <div className="key-row">
              <input
                type="text"
                list="gemini-model-options"
                value={draft.geminiModel}
                onChange={(e) => set('geminiModel', e.target.value)}
              />
              <button
                className="btn ghost sm"
                onClick={detectGeminiModels}
                disabled={detectingModels}
                title="Ask Google which models your API key can use right now"
              >
                {detectingModels ? 'Detecting…' : '🔍 Detect'}
              </button>
            </div>
            <datalist id="gemini-model-options">
              {geminiModels.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label className="field">
            DeepSeek model
            <input
              type="text"
              value={draft.deepseekModel}
              onChange={(e) => set('deepseekModel', e.target.value)}
            />
          </label>
        </div>
        {modelNotice && <p className="muted update-notice">{modelNotice}</p>}
        <p className="muted">
          If Google retires the configured model, the app now detects a current
          replacement automatically during the next diagnosis and saves it here.
        </p>
      </section>

      <section className="settings-section">
        <h3>👁 Continuous Monitoring</h3>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.monitoringEnabled}
            onChange={(e) => set('monitoringEnabled', e.target.checked)}
          />
          Run lightweight health checks in the background and notify me when
          issues are found (nothing is ever fixed automatically)
        </label>
        <label className="field inline">
          Check every{' '}
          <select
            value={draft.monitoringIntervalMinutes}
            disabled={!draft.monitoringEnabled}
            onChange={(e) =>
              set(
                'monitoringIntervalMinutes',
                Number(e.target.value) as AppSettings['monitoringIntervalMinutes']
              )
            }
          >
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>60 minutes</option>
          </select>
        </label>
      </section>

      <section className="settings-section">
        <h3>🔒 Data Opt-In (per diagnostic category)</h3>
        <p className="muted">
          Only the categories you enable are collected and sent (sanitized — no
          usernames, hostnames, or MAC addresses) to the AI APIs. Diagnostic
          data is never stored on disk.
        </p>
        {ALL_DIAGNOSTIC_CATEGORIES.map((category) => (
          <label key={category} className="check-field">
            <input
              type="checkbox"
              checked={draft.dataOptIn[category]}
              onChange={(e) => setOptIn(category, e.target.checked)}
            />
            {DIAGNOSTIC_CATEGORY_LABELS[category]}
          </label>
        ))}
      </section>

      <section className="settings-section">
        <h3>📋 Logs</h3>
        <label className="field inline">
          Keep logs for{' '}
          <input
            type="number"
            min={1}
            max={365}
            value={draft.logRetentionDays}
            onChange={(e) =>
              set('logRetentionDays', Math.max(1, Number(e.target.value) || 30))
            }
            style={{ width: 70 }}
          />{' '}
          days (older logs are deleted automatically)
        </label>
      </section>

      <section className="settings-section">
        <h3>🔄 Updates</h3>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.checkUpdatesOnStartup}
            onChange={(e) => set('checkUpdatesOnStartup', e.target.checked)}
          />
          Check for updates on startup (GitHub releases)
        </label>
        <div className="update-check-row">
          <button className="btn ghost sm" onClick={checkUpdates} disabled={checkingUpdate || downloading}>
            {checkingUpdate ? 'Checking…' : 'Check now'}
          </button>
          {updateInfo && (
            <span className="muted">
              {updateInfo.error
                ? `Check failed: ${updateInfo.error}`
                : updateInfo.updateAvailable
                  ? `Update available: v${updateInfo.latestVersion}`
                  : `You are up to date (v${updateInfo.currentVersion}).`}
            </span>
          )}
          {updateInfo?.updateAvailable && (
            <button className="btn primary sm" onClick={downloadUpdate} disabled={downloading}>
              {downloading ? 'Downloading…' : `⬇ Download & install v${updateInfo.latestVersion}`}
            </button>
          )}
        </div>
        {downloadNotice && <p className="muted update-notice">{downloadNotice}</p>}
      </section>

      <div className="settings-footer">
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {savedNotice && <span className="ok">✓ Saved</span>}
      </div>
    </div>
  );
}
