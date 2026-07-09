import {
  AppSettings,
  DiagnosedIssue,
  DiagnosticResult,
  Fix,
  RiskLevel,
  ShellType,
} from '../types';

/**
 * AI API clients.
 *
 * - Gemini analyzes sanitized diagnostics and identifies the top issues
 *   (streamed so the user sees the analysis as it is written).
 * - DeepSeek generates one PowerShell/CMD fix script per issue, returned as
 *   strict JSON with description/riskLevel/shell metadata.
 *
 * Only sanitized diagnostic text ever leaves the machine.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEEPSEEK_BASE = 'https://api.deepseek.com';

// ---------------------------------------------------------------------------
// Gemini — diagnosis
// ---------------------------------------------------------------------------

const DIAGNOSIS_SYSTEM_PROMPT = `You are a Windows troubleshooting expert helping a NON-TECHNICAL user.
You receive the user's problem description and sanitized diagnostic output from their Windows PC.

Respond in two parts:
1. A short, friendly plain-English analysis of what you found (no jargon,
   no markdown headers, a few short paragraphs at most).
2. On the FINAL lines, a fenced JSON code block containing an array of the
   top 1-5 concrete issues, ordered by impact:

\`\`\`json
[
  {
    "title": "Short issue name",
    "category": "performance|storage|network|updates|filesystem|services",
    "reasoning": "1-2 sentences on why the diagnostics indicate this",
    "severity": "low|medium|high"
  }
]
\`\`\`

Only include issues actually supported by the diagnostics. If everything looks
healthy, say so and return an empty JSON array.`;

export async function streamGeminiDiagnosis(
  settings: AppSettings,
  userMessage: string,
  diagnostics: DiagnosticResult[],
  onChunk: (text: string) => void
): Promise<{ fullText: string; issues: DiagnosedIssue[] }> {
  if (!settings.geminiApiKey) {
    throw new Error(
      'Gemini API key is not configured. Add it in Settings before running a diagnosis.'
    );
  }

  const diagText = diagnostics
    .map((d) =>
      d.error
        ? `## ${d.category}\n(collection failed: ${d.error})`
        : `## ${d.category} (collected ${d.collectedAt})\n${d.data}`
    )
    .join('\n\n');

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(
    settings.geminiModel
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(settings.geminiApiKey)}`;

  const body = {
    system_instruction: { parts: [{ text: DIAGNOSIS_SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `User's problem: "${userMessage}"\n\nDiagnostics collected:\n\n${diagText}`,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini API error (${response.status}): ${detail.slice(0, 300)}`);
  }

  let fullText = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const text: string | undefined =
          parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          fullText += text;
          // Stream only the prose part; hold back the trailing JSON block.
          const jsonStart = fullText.indexOf('```json');
          const visible = jsonStart >= 0 ? fullText.slice(0, jsonStart) : fullText;
          onChunk(visible);
        }
      } catch {
        // Ignore malformed SSE fragments.
      }
    }
  }

  return { fullText, issues: parseIssuesFromText(fullText) };
}

export function parseIssuesFromText(text: string): DiagnosedIssue[] {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  const raw = match ? match[1] : findBareJsonArray(text);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i) => i && typeof i.title === 'string')
      .slice(0, 5)
      .map((i) => ({
        title: String(i.title).slice(0, 120),
        category: String(i.category || 'general'),
        reasoning: String(i.reasoning || ''),
        severity: normalizeRisk(i.severity),
      }));
  } catch {
    return [];
  }
}

function findBareJsonArray(text: string): string | null {
  const start = text.lastIndexOf('[');
  const end = text.lastIndexOf(']');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

// ---------------------------------------------------------------------------
// DeepSeek — fix-script generation
// ---------------------------------------------------------------------------

const SCRIPTING_SYSTEM_PROMPT = `You are a Windows automation expert writing SAFE, conservative fix scripts
for a consumer troubleshooting app. The app runs the script exactly as
returned, after user approval.

Rules:
- Prefer PowerShell for complex operations (registry, WMI, services);
  use CMD only for simple utility invocations.
- The script must be idempotent and safe to re-run.
- NEVER: format drives, delete user documents, disable antivirus, modify boot
  configuration, delete shadow copies, create accounts, or download+execute
  remote code. Deleting well-known cache/temp locations is fine.
- Emit progress with Write-Output / echo so the user sees what happened.
- Exit with code 0 on success and non-zero on failure.

Return ONLY a JSON object (no markdown fences, no commentary):
{
  "title": "Short fix name",
  "description": "2-3 plain-English sentences a non-technical user understands: what the fix does and any side effects.",
  "script": "the full script text",
  "shell": "powershell" or "cmd",
  "riskLevel": "low" | "medium" | "high",
  "critical": true if this touches registry/system services/boot-level tools (sfc, chkdsk, DISM) and warrants an explicit UAC confirmation, else false,
  "metricProbe": "OPTIONAL read-only PowerShell one-liner that prints the single metric this fix improves (e.g. free disk GB), or null"
}`;

export async function generateFixForIssue(
  settings: AppSettings,
  issue: DiagnosedIssue,
  userMessage: string
): Promise<Fix> {
  if (!settings.deepseekApiKey) {
    throw new Error(
      'DeepSeek API key is not configured. Add it in Settings before generating fixes.'
    );
  }

  const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: settings.deepseekModel,
      messages: [
        { role: 'system', content: SCRIPTING_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `User's original problem: "${userMessage}"

Issue to fix:
- Title: ${issue.title}
- Category: ${issue.category}
- Severity: ${issue.severity}
- Diagnosis reasoning: ${issue.reasoning}

Generate the fix script JSON now.`,
        },
      ],
      temperature: 0.2,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error (${response.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned an empty response');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonFences(content));
  } catch {
    throw new Error('DeepSeek returned malformed JSON for the fix script');
  }

  const script = String(parsed.script || '').trim();
  if (!script) throw new Error('DeepSeek returned a fix with an empty script');

  return {
    id: cryptoRandomId(),
    title: String(parsed.title || issue.title).slice(0, 120),
    description: String(parsed.description || issue.reasoning).slice(0, 600),
    script,
    shell: normalizeShell(parsed.shell),
    riskLevel: normalizeRisk(parsed.riskLevel),
    critical: Boolean(parsed.critical),
    category: issue.category,
    metricProbe:
      typeof parsed.metricProbe === 'string' && parsed.metricProbe.trim()
        ? parsed.metricProbe.trim()
        : undefined,
  };
}

function stripJsonFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (match ? match[1] : text).trim();
}

function normalizeShell(value: unknown): ShellType {
  return value === 'cmd' ? 'cmd' : 'powershell';
}

function normalizeRisk(value: unknown): RiskLevel {
  return value === 'high' ? 'high' : value === 'medium' ? 'medium' : 'low';
}

function cryptoRandomId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}
