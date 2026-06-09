'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';

const LEVEL_NAMES: Record<number, string> = { 10: 'TRC', 20: 'DBG', 30: 'INF', 40: 'WRN', 50: 'ERR', 60: 'FTL' };
const LEVEL_COLORS: Record<number, string> = {
  10: 'var(--color-muted)',
  20: 'var(--color-muted)',
  30: 'var(--color-text)',
  40: 'var(--color-warn)',
  50: 'var(--color-danger)',
  60: 'var(--color-danger)',
};

type LogEntry = {
  time: number;
  level: number;
  mod?: string;
  msg?: string;
  raw: string;
  fields?: Record<string, unknown>;
};

interface LogStreamState {
  paused: boolean;
  filter: string;
  minLevel: number;
  autoScroll: boolean;
  entries: LogEntry[];
  setPaused: (v: boolean) => void;
  setFilter: (v: string) => void;
  setMinLevel: (v: number) => void;
  setAutoScroll: (v: boolean) => void;
  clear: () => void;
}

/**
 * Shared polling hook used by both the inline panel (on /runs) and the
 * docked footer panel (mounted globally). Polls `runs.logs` every 1.5s
 * and keeps a capped in-memory window of the most recent entries.
 */
function useLogStream(): LogStreamState {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [minLevel, setMinLevel] = useState(30);
  const [autoScroll, setAutoScroll] = useState(true);
  const cursorRef = useRef(0);
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const logs = trpc.runs.logs.useQuery(
    { since: cursorRef.current, limit: 200, mod: filter || undefined, minLevel },
    {
      refetchInterval: paused ? false : 1500,
      refetchIntervalInBackground: true,
    },
  );

  useEffect(() => {
    if (!logs.data) return;
    if (logs.data.entries.length === 0 && cursorRef.current !== 0) return;
    setEntries((prev) => {
      const next = cursorRef.current === 0 ? logs.data!.entries : [...prev, ...logs.data!.entries];
      return next.length > 800 ? next.slice(-800) : next;
    });
    cursorRef.current = logs.data.tip;
  }, [logs.data]);

  useEffect(() => {
    cursorRef.current = 0;
    setEntries([]);
  }, [filter, minLevel]);

  return {
    paused,
    filter,
    minLevel,
    autoScroll,
    entries,
    setPaused,
    setFilter,
    setMinLevel,
    setAutoScroll,
    clear: () => {
      cursorRef.current = 0;
      setEntries([]);
    },
  };
}

interface LogControlsProps {
  state: LogStreamState;
  rightExtras?: React.ReactNode;
}

function LogControls({ state, rightExtras }: LogControlsProps) {
  return (
    <div className="flex items-center gap-3 text-xs flex-wrap">
      <label className="flex items-center gap-1">
        module:
        <input
          value={state.filter}
          onChange={(e) => state.setFilter(e.target.value)}
          placeholder="e.g. funding"
          className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-0.5 mono w-32"
        />
      </label>
      <label className="flex items-center gap-1">
        level:
        <select
          value={state.minLevel}
          onChange={(e) => state.setMinLevel(parseInt(e.target.value, 10))}
          className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-0.5"
        >
          <option value={20}>debug+</option>
          <option value={30}>info+</option>
          <option value={40}>warn+</option>
          <option value={50}>error+</option>
        </select>
      </label>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={state.autoScroll}
          onChange={(e) => state.setAutoScroll(e.target.checked)}
        />
        auto-scroll
      </label>
      <button
        onClick={() => state.setPaused(!state.paused)}
        className="text-xs px-2 py-0.5 rounded border border-[var(--color-border)]"
      >
        {state.paused ? 'resume' : 'pause'}
      </button>
      <button
        onClick={state.clear}
        className="text-xs px-2 py-0.5 rounded border border-[var(--color-border)]"
      >
        clear
      </button>
      {rightExtras}
    </div>
  );
}

interface LogListProps {
  entries: LogEntry[];
  autoScroll: boolean;
  className?: string;
}

function LogList({ entries, autoScroll, className }: LogListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  return (
    <div
      ref={scrollRef}
      className={`bg-[var(--color-bg)] border border-[var(--color-border)] rounded overflow-auto p-2 mono text-xs leading-snug ${className ?? ''}`}
    >
      {entries.length === 0 ? (
        <p className="text-[var(--color-muted)]">no log entries yet…</p>
      ) : (
        entries.map((e, i) => {
          const t = new Date(e.time).toLocaleTimeString();
          const lv = LEVEL_NAMES[e.level] ?? String(e.level);
          const color = LEVEL_COLORS[e.level] ?? 'var(--color-text)';
          const extra = e.fields
            ? ' ' +
              Object.entries(e.fields)
                .filter(([k]) => k !== 'pid' && k !== 'hostname')
                .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join(' ')
            : '';
          return (
            <div key={i} style={{ color }}>
              <span className="text-[var(--color-muted)]">{t}</span>{' '}
              <span style={{ color }}>{lv}</span>{' '}
              {e.mod && <span className="text-[var(--color-muted)]">[{e.mod}]</span>}{' '}
              {e.msg ?? ''}
              {extra && <span className="text-[var(--color-muted)]">{extra}</span>}
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Full-width inline log panel. Used on /runs as a fixed section in the page.
 */
export function LogPanel() {
  const state = useLogStream();
  return (
    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h3 className="font-medium">Logs</h3>
        <LogControls state={state} />
      </div>
      <LogList entries={state.entries} autoScroll={state.autoScroll} className="h-72" />
      <p className="text-[10px] text-[var(--color-muted)] mt-1">
        in-memory ring buffer (last 1000 lines). polls every 1.5s.
      </p>
    </div>
  );
}

/**
 * Sticky footer-docked log panel. Mounted in the root layout so logs are
 * visible from every page (wallets, runs, lp, overview). Collapsed by
 * default; click the header to expand. Persists collapsed state in
 * localStorage and shows a "new lines" badge while collapsed.
 */
export function DockedLogPanel() {
  const state = useLogStream();
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const lastSeenRef = useRef(0);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    setHydrated(true);
    try {
      const saved = window.localStorage.getItem('amm:dockedLogs:open');
      if (saved === '1') setOpen(true);
    } catch {
      // ignore (private mode etc)
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem('amm:dockedLogs:open', open ? '1' : '0');
    } catch {
      // ignore
    }
  }, [open, hydrated]);

  useEffect(() => {
    if (open) {
      lastSeenRef.current = state.entries.length > 0 ? state.entries[state.entries.length - 1]!.time : Date.now();
      setUnread(0);
      return;
    }
    const newer = state.entries.filter((e) => e.time > lastSeenRef.current).length;
    setUnread(newer);
  }, [state.entries, open]);

  const lastLine = state.entries.length > 0 ? state.entries[state.entries.length - 1] : null;
  const lastSummary = lastLine
    ? `${LEVEL_NAMES[lastLine.level] ?? lastLine.level}${lastLine.mod ? ` [${lastLine.mod}]` : ''} ${lastLine.msg ?? ''}`
    : 'no log activity yet';

  return (
    <div
      className="fixed left-0 right-0 bottom-0 z-40 border-t border-[var(--color-border)] bg-[var(--color-card)] shadow-[0_-2px_12px_rgba(0,0,0,0.35)]"
      style={{ maxHeight: open ? '50vh' : undefined }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-1.5 text-xs hover:bg-[var(--color-bg)] transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <span className="font-medium">{open ? '▼' : '▲'} Logs</span>
          {!open && unread > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-black text-[10px] mono">
              {unread > 99 ? '99+' : unread} new
            </span>
          )}
          {!open && (
            <span
              className="text-[var(--color-muted)] mono truncate max-w-[60vw]"
              style={{ color: lastLine ? LEVEL_COLORS[lastLine.level] : undefined }}
            >
              {lastSummary}
            </span>
          )}
        </span>
        <span className="text-[var(--color-muted)] text-[10px] mono">
          {open ? 'click to collapse' : 'click to expand'}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3">
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <span className="text-xs text-[var(--color-muted)] mono">
              {state.entries.length} lines · polls every 1.5s · ring buffer cap 1000
            </span>
            <LogControls state={state} />
          </div>
          <LogList entries={state.entries} autoScroll={state.autoScroll} className="h-64" />
        </div>
      )}
    </div>
  );
}
