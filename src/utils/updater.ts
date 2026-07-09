import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UpdateInfo } from '../types';

/**
 * Auto-update via GitHub releases.
 *
 * On startup (if enabled) the app checks the latest release; when a newer
 * version exists the user is prompted to download. The installer .exe is
 * downloaded to the user's Downloads folder, its SHA-256 verified against a
 * .sha256 release asset when one is published, and then launched (which
 * requires an app restart).
 */

const REPO_OWNER = 'trendlinepros-afk';
const REPO_NAME = 'Windows-Auto-Fix-Your-Computer-Issues';
const API_LATEST = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  body?: string;
  assets?: GitHubAsset[];
}

export async function checkForUpdates(currentVersion: string): Promise<UpdateInfo> {
  try {
    const response = await fetch(API_LATEST, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'WindowsTroubleshooter-Updater',
      },
    });
    if (response.status === 404) {
      return { updateAvailable: false, currentVersion };
    }
    if (!response.ok) {
      return {
        updateAvailable: false,
        currentVersion,
        error: `GitHub API returned ${response.status}`,
      };
    }

    const release = (await response.json()) as GitHubRelease;
    const latestVersion = release.tag_name.replace(/^v/i, '');
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return { updateAvailable: false, currentVersion, latestVersion };
    }

    const exeAsset = release.assets?.find((a) => a.name.toLowerCase().endsWith('.exe'));
    const shaAsset = release.assets?.find((a) =>
      a.name.toLowerCase().endsWith('.sha256')
    );

    return {
      updateAvailable: Boolean(exeAsset),
      currentVersion,
      latestVersion,
      releaseNotes: release.body?.slice(0, 2000),
      downloadUrl: exeAsset?.browser_download_url,
      sha256Url: shaAsset?.browser_download_url,
    };
  } catch (err) {
    return {
      updateAvailable: false,
      currentVersion,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function downloadUpdate(
  info: UpdateInfo,
  downloadsDir: string
): Promise<{ filePath: string; hashVerified: boolean }> {
  if (!info.downloadUrl) throw new Error('No download URL for the update');

  const fileName = path.basename(new URL(info.downloadUrl).pathname);
  const filePath = path.join(downloadsDir, fileName);

  const response = await fetch(info.downloadUrl, {
    headers: { 'User-Agent': 'WindowsTroubleshooter-Updater' },
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, data);

  let hashVerified = false;
  if (info.sha256Url) {
    const shaResponse = await fetch(info.sha256Url, {
      headers: { 'User-Agent': 'WindowsTroubleshooter-Updater' },
    });
    if (shaResponse.ok) {
      const expected = (await shaResponse.text())
        .trim()
        .split(/\s+/)[0]
        .toLowerCase();
      const actual = crypto.createHash('sha256').update(data).digest('hex');
      if (expected !== actual) {
        fs.unlinkSync(filePath);
        throw new Error(
          'Update hash verification FAILED — the downloaded file was discarded.'
        );
      }
      hashVerified = true;
    }
  }

  return { filePath, hashVerified };
}

/** Semver-ish comparison: returns >0 if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
