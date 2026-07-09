import React, { useEffect, useRef, useState } from 'react';
import {
  ALL_DIAGNOSTIC_CATEGORIES,
  AppSettings,
  ChatStreamEvent,
  DIAGNOSTIC_CATEGORY_LABELS,
  DiagnosticCategory,
  Fix,
  FixExecutionResult,
} from '../../types';
import FixApprovalModal from './FixApprovalModal';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  fixes?: Fix[];
  streaming?: boolean;
}

interface Props {
  settings: AppSettings;
}

let idCounter = 0;
const nextId = () => `msg-${++idCounter}-${Date.now()}`;

export default function ChatInterface({ settings }: Props): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: 'assistant',
      content:
        "Hi! I'm your Windows troubleshooting assistant. Tell me what's wrong — for example:\n\n• \"My computer is running slow\"\n• \"I'm out of disk space\"\n• \"My internet keeps dropping\"\n\nI'll collect diagnostics (only the categories you allow), figure out what's going on, and propose fixes you can review and approve.",
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [categories, setCategories] = useState<DiagnosticCategory[]>(
    ALL_DIAGNOSTIC_CATEGORIES.filter((c) => settings.dataOptIn[c])
  );
  const [showCategories, setShowCategories] = useState(false);
  const [executedResults, setExecutedResults] = useState<
    Record<string, FixExecutionResult>
  >({});
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCategories(ALL_DIAGNOSTIC_CATEGORIES.filter((c) => settings.dataOptIn[c]));
  }, [settings]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  useEffect(() => {
    const off = window.api.chat.onStream((event: ChatStreamEvent) => {
      switch (event.type) {
        case 'status':
          setStatus(event.message);
          break;
        case 'chunk':
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
              copy[copy.length - 1] = { ...last, content: event.text };
            } else {
              copy.push({
                id: nextId(),
                role: 'assistant',
                content: event.text,
                streaming: true,
              });
            }
            return copy;
          });
          break;
        case 'fixes':
          setStatus('');
          setMessages((prev) => {
            const copy: ChatMessage[] = prev.map((m) => ({ ...m, streaming: false }));
            if (event.fixes.length > 0) {
              copy.push({
                id: nextId(),
                role: 'assistant',
                content: `I've prepared ${event.fixes.length} fix${
                  event.fixes.length > 1 ? 'es' : ''
                } for you to review. Each one shows exactly what it will do — expand the code if you want the details, and approve only the ones you're comfortable with.`,
                fixes: event.fixes,
              });
            } else {
              copy.push({
                id: nextId(),
                role: 'assistant',
                content:
                  'I did not find any actionable issues to fix automatically. If the problem persists, try describing it with more detail.',
              });
            }
            return copy;
          });
          break;
        case 'done':
          setStatus('');
          setBusy(false);
          break;
        case 'error':
          setStatus('');
          setBusy(false);
          setMessages((prev) => {
            const copy: ChatMessage[] = prev.map((m) => ({ ...m, streaming: false }));
            copy.push({
              id: nextId(),
              role: 'assistant',
              content: `⚠ Something went wrong: ${event.message}`,
            });
            return copy;
          });
          break;
      }
    });
    return off;
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: text }]);
    setStatus('Starting diagnostics…');
    await window.api.chat.diagnose(text, categories);
  };

  const toggleCategory = (category: DiagnosticCategory) => {
    setCategories((prev) =>
      prev.includes(category)
        ? prev.filter((c) => c !== category)
        : [...prev, category]
    );
  };

  const handleExecuted = (result: FixExecutionResult) => {
    setExecutedResults((prev) => ({ ...prev, [result.fixId]: result }));
  };

  return (
    <div className="chat">
      <div className="chat-messages">
        {messages.map((message) => (
          <div key={message.id} className={`bubble-row ${message.role}`}>
            <div className={`bubble ${message.role}`}>
              <div className="bubble-content">{message.content}</div>
              {message.fixes && (
                <div className="fix-list">
                  {message.fixes.map((fix) => (
                    <FixApprovalModal
                      key={fix.id}
                      fix={fix}
                      result={executedResults[fix.id]}
                      onExecuted={handleExecuted}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {status && (
          <div className="bubble-row assistant">
            <div className="bubble assistant thinking">
              <span className="spinner" /> {status}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-area">
        <div className="category-bar">
          <button
            className="btn ghost sm"
            onClick={() => setShowCategories((s) => !s)}
          >
            🔍 Diagnostics to collect ({categories.length}/
            {ALL_DIAGNOSTIC_CATEGORIES.length}) {showCategories ? '▴' : '▾'}
          </button>
          {showCategories && (
            <div className="category-list">
              {ALL_DIAGNOSTIC_CATEGORIES.map((category) => (
                <label key={category} className="category-item">
                  <input
                    type="checkbox"
                    checked={categories.includes(category)}
                    onChange={() => toggleCategory(category)}
                  />
                  {DIAGNOSTIC_CATEGORY_LABELS[category]}
                  {!settings.dataOptIn[category] && (
                    <span className="muted"> (disabled in Settings)</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="input-row">
          <textarea
            value={input}
            placeholder='Describe your issue, e.g. "My computer is running slow"'
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={busy}
          />
          <button className="btn primary send-btn" onClick={send} disabled={busy || !input.trim()}>
            {busy ? '…' : 'Send ➤'}
          </button>
        </div>
        <div className="model-indicator">
          🧠 Diagnosis: Google Gemini · <code>{settings.geminiModel}</code>
          <span className="model-sep">|</span>
          🛠 Fix scripts: DeepSeek · <code>{settings.deepseekModel}</code>
        </div>
      </div>
    </div>
  );
}
