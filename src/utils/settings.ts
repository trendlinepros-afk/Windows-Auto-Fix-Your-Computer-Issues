import * as fs from 'fs';
import * as path from 'path';
import { safeStorage } from 'electron';
import { AppSettings, DEFAULT_SETTINGS } from '../types';

/**
 * Gemini models that have been retired by Google. Settings persisted with one
 * of these are silently upgraded to the current default so existing installs
 * keep working after a model is shut down.
 */
const RETIRED_GEMINI_MODELS = new Set([
  'gemini-pro',
  'gemini-1.0-pro',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
]);

/**
 * Persists app settings to userData/settings.json.
 * API keys are encrypted at rest with Electron safeStorage (DPAPI on Windows)
 * when encryption is available; environment variables act as dev fallbacks.
 */
export class SettingsStore {
  private filePath: string;
  private cache: AppSettings | null = null;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'settings.json');
  }

  get(): AppSettings {
    if (this.cache) return this.cache;

    let stored: Partial<AppSettings & { encryptedKeys?: Record<string, string> }> = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      // First run or corrupt file — fall back to defaults.
    }

    const encrypted = (stored as { encryptedKeys?: Record<string, string> })
      .encryptedKeys;
    const geminiApiKey =
      this.decrypt(encrypted?.gemini) ||
      (stored.geminiApiKey as string) ||
      process.env.GEMINI_API_KEY ||
      '';
    const deepseekApiKey =
      this.decrypt(encrypted?.deepseek) ||
      (stored.deepseekApiKey as string) ||
      process.env.DEEPSEEK_API_KEY ||
      '';

    this.cache = {
      ...DEFAULT_SETTINGS,
      ...stored,
      dataOptIn: { ...DEFAULT_SETTINGS.dataOptIn, ...(stored.dataOptIn || {}) },
      geminiApiKey,
      deepseekApiKey,
    };
    delete (this.cache as unknown as Record<string, unknown>).encryptedKeys;

    if (RETIRED_GEMINI_MODELS.has(this.cache.geminiModel)) {
      this.cache.geminiModel = DEFAULT_SETTINGS.geminiModel;
    }
    return this.cache;
  }

  save(settings: AppSettings): void {
    this.cache = { ...settings };

    const { geminiApiKey, deepseekApiKey, ...rest } = settings;
    const persisted: Record<string, unknown> = { ...rest };

    if (safeStorage.isEncryptionAvailable()) {
      persisted.encryptedKeys = {
        gemini: this.encrypt(geminiApiKey),
        deepseek: this.encrypt(deepseekApiKey),
      };
    } else {
      // Fallback: plain persistence (documented in README; dev machines only).
      persisted.geminiApiKey = geminiApiKey;
      persisted.deepseekApiKey = deepseekApiKey;
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(persisted, null, 2), 'utf8');
  }

  private encrypt(value: string): string {
    if (!value) return '';
    return safeStorage.encryptString(value).toString('base64');
  }

  private decrypt(value?: string): string {
    if (!value) return '';
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      return '';
    }
  }
}
