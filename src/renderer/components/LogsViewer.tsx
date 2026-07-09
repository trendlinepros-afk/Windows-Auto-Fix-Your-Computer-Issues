import React, { useEffect, useMemo, useState } from 'react';
import { LogEntry } from '../../types';

/**
 * In-app log viewer: sortable/filterable table, expandable rows,
 * export (PDF/TXT), open-folder, and clear (all or date range).
 */

type SortKey = 'timestamp' | 'fixName' | 'status' | 'exitCode';

export default function LogsViewer(): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortAsc, setSortAsc] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'Success' | 'Failed'>('all');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showClear, setShowClear] = useState(false);
  const [clearFrom, setClearFrom] = useState('');
  const [clearTo, setClearTo] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      setEntries(await window.api.logs.list());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    let rows = entries;
    if (filterStatus !== 'all') {
      rows = rows.filter((e) => e.status === filterStatus);
    }
    const query = filterText.trim().toLowerCase();
    if (query) {
      rows = rows.filter(
        (e) =>
          e.fixName.toLowerCase().includes(query) ||
          e.description.toLowerCase().includes(query) ||
          e.command.toLowerCase().includes(query) ||
          (e.output || '').toLowerCase().includes(query)
      );
    }
    const sorted = [...rows].sort((a, b) => {
      let cmp: number;
      switch (sortKey) {
        case 'exitCode':
          cmp = a.exitCode - b.exitCode;
          break;
        default:
          cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
      }
      return sortAsc ? cmp : -cmp;
    });
    return sorted;
  }, [entries, filterText, filterStatus, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(key !== 'timestamp');
    }
    setExpanded(null);
  };

  const sortIndicator = (key: SortKey) =>
    key === sortKey ? (sortAsc ? ' ▲' : ' ▼') : '';

  const doExport = async (format: 'txt' | 'pdf') => {
    const result = await window.api.logs.export(format);
    if (result.ok) setNotice(`Exported to ${result.filePath}`);
    else if (!result.canceled) setNotice(`Export failed: ${result.error}`);
  };

  const doClear = async (all: boolean) => {
    const range = all
      ? undefined
      : {
          from: clearFrom || undefined,
          to: clearTo || undefined,
        };
    if (
      !window.confirm(
        all
          ? 'Delete ALL logs? This cannot be undone.'
          : `Delete logs ${clearFrom ? `from ${clearFrom} ` : ''}${clearTo ? `to ${clearTo}` : ''}?`
      )
    ) {
      return;
    }
    const removed = await window.api.logs.clear(range);
    setNotice(`Cleared ${removed} log file(s).`);
    setShowClear(false);
    await refresh();
  };

  return (
    <div className="logs-view">
      <div className="logs-toolbar">
        <input
          className="search-input"
          type="text"
          placeholder="Filter by keyword…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
        >
          <option value="all">All statuses</option>
          <option value="Success">Success only</option>
          <option value="Failed">Failed only</option>
        </select>
        <div className="toolbar-spacer" />
        <button className="btn ghost sm" onClick={refresh} title="Refresh">
          ⟳ Refresh
        </button>
        <button className="btn ghost sm" onClick={() => doExport('txt')}>
          ⬇ Export TXT
        </button>
        <button className="btn ghost sm" onClick={() => doExport('pdf')}>
          ⬇ Export PDF
        </button>
        <button
          className="btn ghost sm"
          onClick={() => window.api.logs.openFolder()}
          title="Open log folder in File Explorer"
        >
          📁 Open Folder
        </button>
        <button className="btn danger-ghost sm" onClick={() => setShowClear((s) => !s)}>
          🗑 Clear Logs
        </button>
      </div>

      {showClear && (
        <div className="clear-panel">
          <label>
            From{' '}
            <input
              type="date"
              value={clearFrom}
              onChange={(e) => setClearFrom(e.target.value)}
            />
          </label>
          <label>
            To{' '}
            <input
              type="date"
              value={clearTo}
              onChange={(e) => setClearTo(e.target.value)}
            />
          </label>
          <button className="btn danger-ghost sm" onClick={() => doClear(false)}>
            Clear range
          </button>
          <button className="btn danger-ghost sm" onClick={() => doClear(true)}>
            Clear ALL
          </button>
          <button className="btn ghost sm" onClick={() => setShowClear(false)}>
            Cancel
          </button>
        </div>
      )}

      {notice && (
        <div className="banner info-banner">
          <span>{notice}</span>
          <button className="btn ghost sm" onClick={() => setNotice('')}>
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <div className="logs-empty">Loading logs…</div>
      ) : filtered.length === 0 ? (
        <div className="logs-empty">
          {entries.length === 0
            ? 'No fixes have been executed yet. Logs will appear here after your first approved fix.'
            : 'No log entries match the current filter.'}
        </div>
      ) : (
        <table className="logs-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort('timestamp')}>
                Timestamp{sortIndicator('timestamp')}
              </th>
              <th onClick={() => toggleSort('fixName')}>
                Fix Name{sortIndicator('fixName')}
              </th>
              <th onClick={() => toggleSort('status')}>
                Status{sortIndicator('status')}
              </th>
              <th onClick={() => toggleSort('exitCode')}>
                Exit Code{sortIndicator('exitCode')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry, index) => (
              <React.Fragment key={`${entry.timestamp}-${index}`}>
                <tr
                  className={`log-row ${expanded === index ? 'open' : ''}`}
                  onClick={() => setExpanded(expanded === index ? null : index)}
                >
                  <td>{new Date(entry.timestamp).toLocaleString()}</td>
                  <td>{entry.fixName}</td>
                  <td>
                    <span className={entry.status === 'Success' ? 'ok' : 'fail'}>
                      {entry.status === 'Success' ? '✓' : '✗'} {entry.status}
                    </span>
                  </td>
                  <td>{entry.exitCode}</td>
                </tr>
                {expanded === index && (
                  <tr className="log-detail-row">
                    <td colSpan={4}>
                      <div className="log-detail">
                        <p>
                          <b>Description:</b> {entry.description}
                        </p>
                        {entry.beforeState && (
                          <p>
                            <b>Before:</b> {entry.beforeState}
                          </p>
                        )}
                        {entry.afterState && (
                          <p>
                            <b>After:</b> {entry.afterState}
                          </p>
                        )}
                        {entry.errorMessage && (
                          <p className="fail">
                            <b>Error:</b> {entry.errorMessage}
                          </p>
                        )}
                        <p>
                          <b>Command:</b>
                        </p>
                        <pre className="code-block">{entry.command}</pre>
                        <p>
                          <b>Output:</b>
                        </p>
                        <pre className="code-block">
                          {entry.output || '(no output)'}
                        </pre>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
