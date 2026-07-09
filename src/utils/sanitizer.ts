import * as os from 'os';

/**
 * Sanitizes diagnostic text before it is sent to external AI APIs.
 * Removes usernames, machine names, and other PII-adjacent strings.
 * Diagnostic data is never persisted locally — it is collected, sanitized,
 * sent to the AI APIs, and discarded.
 */
export function sanitizeDiagnostics(text: string): string {
  if (!text) return text;

  let sanitized = text;

  // Replace the current username anywhere it appears (paths, process owners, ...).
  const username = safeUsername();
  if (username && username.length > 1) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(username), 'gi'),
      '<user>'
    );
  }

  // Replace user-profile paths for ANY user, not just the current one.
  sanitized = sanitized.replace(
    /([A-Za-z]:\\Users\\)([^\\\s"']+)/gi,
    '$1<user>'
  );

  // Replace the computer name.
  const hostname = os.hostname();
  if (hostname && hostname.length > 1) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(hostname), 'gi'),
      '<computer>'
    );
  }

  // Redact email addresses.
  sanitized = sanitized.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    '<email>'
  );

  // Redact MAC addresses.
  sanitized = sanitized.replace(
    /\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
    '<mac>'
  );

  // Redact anything that looks like a serial number label.
  sanitized = sanitized.replace(
    /(SerialNumber\s*[:=]\s*)\S+/gi,
    '$1<serial>'
  );

  return sanitized;
}

function safeUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
