import { ScriptValidationResult } from '../types';

/**
 * Sanity-checks AI-generated scripts before execution.
 *
 * This is a defense-in-depth guardrail, not a sandbox: the user still reviews
 * and approves every script. Anything matching these patterns is refused
 * outright because no legitimate consumer troubleshooting fix needs it.
 */

interface DangerPattern {
  pattern: RegExp;
  reason: string;
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
  {
    pattern: /\bformat(-volume)?\b[^\n]*\b[a-z]:/i,
    reason: 'Formats a disk volume',
  },
  {
    pattern: /\bdiskpart\b[\s\S]*\bclean\b/i,
    reason: 'Wipes a disk with diskpart clean',
  },
  {
    pattern:
      /\b(remove-item|rmdir|rd|del|erase)\b[^\n]*(([a-z]:\\(windows|users|program files( \(x86\))?)?\\?("|')?\s*($|[-/]))|[a-z]:\\\s*($|[-/])|\\\\\?\\)/i,
    reason: 'Deletes a system root or drive root',
  },
  {
    pattern: /\bremove-item\b[^\n]*-recurse[^\n]*(c:\\windows\b|c:\\users\b|c:\\program)/i,
    reason: 'Recursively deletes protected system directories',
  },
  {
    pattern: /\bvssadmin\b[^\n]*\bdelete\b[^\n]*\bshadows\b/i,
    reason: 'Deletes volume shadow copies (restore points)',
  },
  {
    pattern: /\bwmic\b[^\n]*\bshadowcopy\b[^\n]*\bdelete\b/i,
    reason: 'Deletes volume shadow copies (restore points)',
  },
  {
    pattern: /\bbcdedit\b[^\n]*\/(delete|set)[^\n]*\b(recoveryenabled|bootstatuspolicy)\b/i,
    reason: 'Tampers with boot/recovery configuration',
  },
  {
    pattern: /\bcipher\b[^\n]*\/w/i,
    reason: 'Securely wipes free disk space',
  },
  {
    pattern: /\breg(\.exe)?\s+delete\b[^\n]*(hklm|hkey_local_machine)\\(system|sam|security)\b/i,
    reason: 'Deletes critical registry hives',
  },
  {
    pattern: /\bremove-itemproperty\b[^\n]*hklm:\\(system|sam|security)\b/i,
    reason: 'Deletes critical registry hives',
  },
  {
    pattern: /\bset-mppreference\b[^\n]*-disable(realtimemonitoring|ioavprotection|behaviormonitoring)/i,
    reason: 'Disables Windows Defender protection',
  },
  {
    pattern: /\bnet(\.exe)?\s+user\b[^\n]*\/add\b/i,
    reason: 'Creates a new user account',
  },
  {
    pattern: /\bnet(\.exe)?\s+localgroup\s+administrators\b[^\n]*\/add\b/i,
    reason: 'Adds an account to the Administrators group',
  },
  {
    pattern: /\b(invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget|certutil)\b[\s\S]*\|\s*(iex|invoke-expression)\b/i,
    reason: 'Downloads and executes remote code',
  },
  {
    pattern: /\biex\s*\(\s*(new-object\s+net\.webclient|\(?\s*invoke-webrequest)/i,
    reason: 'Downloads and executes remote code',
  },
  {
    pattern: /-(encodedcommand|enc|ec)\s+[a-z0-9+/=]{16,}/i,
    reason: 'Obfuscated (encoded) command',
  },
  {
    pattern: /\bmshta\b|\brundll32\b[^\n]*javascript:/i,
    reason: 'Suspicious script-host execution',
  },
  {
    pattern: /\btakeown\b[^\n]*\/f\s+[a-z]:\\windows\b/i,
    reason: 'Takes ownership of Windows system files',
  },
  {
    pattern: /\bdisable-computerrestore\b/i,
    reason: 'Disables System Restore',
  },
  {
    pattern: /\bstop-computer\b|\bshutdown(\.exe)?\s+[^\n]*\/s\b/i,
    reason: 'Shuts the computer down (restart-only fixes are allowed)',
  },
];

const MAX_SCRIPT_LENGTH = 20_000;

export function validateScript(script: string): ScriptValidationResult {
  const reasons: string[] = [];

  if (!script || !script.trim()) {
    return { valid: false, reasons: ['Script is empty'] };
  }
  if (script.length > MAX_SCRIPT_LENGTH) {
    reasons.push(`Script exceeds maximum length of ${MAX_SCRIPT_LENGTH} characters`);
  }

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(script)) {
      reasons.push(reason);
    }
  }

  return { valid: reasons.length === 0, reasons };
}
