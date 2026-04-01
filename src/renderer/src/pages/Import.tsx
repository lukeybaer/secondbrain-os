import React, { useState, useEffect, useRef } from "react";

type ItemStatus = "remote" | "downloading" | "tagging" | "done" | "tagged" | "error";
type FilterTab = "all" | "otter" | "chats";

interface ImportItem {
  otterId: string;
  title: string;
  date: string;
  durationMinutes: number;
  status: ItemStatus;
  errorMessage?: string;
  itemType?: "otter" | "chat";
}

const STATUS_LABEL: Record<ItemStatus, string> = {
  remote: "Not imported",
  downloading: "Downloading…",
  tagging: "Tagging with AI…",
  done: "Done",
  tagged: "Imported",
  error: "Error",
};

const STATUS_COLOR: Record<ItemStatus, string> = {
  remote: "#444",
  downloading: "#60a5fa",
  tagging: "#a78bfa",
  done: "#4ade80",
  tagged: "#4ade80",
  error: "#f87171",
};

export default function Import({ onImported }: { onImported?: () => void }) {
  const [otterItems, setOtterItems] = useState<ImportItem[]>([]);
  const [chatItems, setChatItems] = useState<ImportItem[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchDone, setFetchDone] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterTab>("otter");

  // ── Load cached list on mount ──────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const cached = await window.api.import.loadCached();
        if (cached.length > 0) {
          setOtterItems(cached.map((i: any) => ({ ...i, itemType: "otter" })));
          setFetchDone(true);
        }
      } catch {}
      loadChatItems();
    })();
  }, []);

  async function loadChatItems() {
    try {
      const all = await window.api.conversations.list();
      const chats = all
        .filter((c: any) => c.meetingType === "OpenBrainChat")
        .map((c: any): ImportItem => ({
          otterId: c.id,
          title: c.title,
          date: c.date,
          durationMinutes: c.durationMinutes || 0,
          status: "tagged",
          itemType: "chat",
        }));
      setChatItems(chats);
    } catch {}
  }

  // ── Streaming fetch listeners ──────────────────────────────────────────────
  useEffect(() => {
    window.api.import.onListBatch((newItems) => {
      setOtterItems(prev => {
        const prevMap = new Map(prev.map(i => [i.otterId, i]));
        const toAdd: ImportItem[] = [];
        for (const item of newItems) {
          const typed = { ...item, itemType: "otter" as const };
          if (prevMap.has(item.otterId)) {
            // Update status only if not currently being processed
            const existing = prevMap.get(item.otterId)!;
            const isProcessing = existing.status === "downloading" || existing.status === "tagging";
            if (!isProcessing) prevMap.set(item.otterId, { ...existing, status: typed.status });
          } else {
            toAdd.push(typed);
          }
        }
        return [...Array.from(prevMap.values()), ...toAdd];
      });
    });

    window.api.import.onItemProgress(({ otterId, status, message }) => {
      setOtterItems(prev =>
        prev.map(item =>
          item.otterId === otterId
            ? { ...item, status: status as ItemStatus, errorMessage: message }
            : item
        )
      );
    });

    return () => {
      window.api.import.offListBatch();
      window.api.import.offItemProgress();
    };
  }, []);

  // ── Fetch from Otter ────────────────────────────────────────────────────────
  async function fetchList() {
    setFetching(true);
    setFetchDone(false);
    setFetchError(null);
    // Don't clear existing items — keep them visible while refreshing

    try {
      const result = await window.api.import.fetchList();
      if (!result.success) {
        setFetchError(result.error || "Failed to fetch list");
      }
    } catch (err: any) {
      setFetchError(err.message);
    } finally {
      setFetching(false);
      setFetchDone(true);
    }
  }

  // ── Process ────────────────────────────────────────────────────────────────
  async function processIds(otterIds: string[]) {
    if (otterIds.length === 0 || processing) return;
    setProcessing(true);

    setOtterItems(prev =>
      prev.map(item =>
        otterIds.includes(item.otterId) ? { ...item, status: "downloading" } : item
      )
    );

    try {
      await window.api.import.processIds(otterIds);
      onImported?.();
    } finally {
      setProcessing(false);
    }
  }

  const processSelected = () =>
    processIds(Array.from(selected).filter(id => itemMap.get(id)?.status === "remote"));

  const processAll = () =>
    processIds(visibleOtterItems.filter(i => i.status === "remote").map(i => i.otterId));

  function toggleSelect(otterId: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(otterId) ? next.delete(otterId) : next.add(otterId);
      return next;
    });
  }

  function selectAllNew() {
    setSelected(new Set(visibleOtterItems.filter(i => i.status === "remote").map(i => i.otterId)));
  }

  const itemMap = new Map(otterItems.map(i => [i.otterId, i]));

  const visibleOtterItems = search.trim()
    ? otterItems.filter(i =>
        i.title.toLowerCase().includes(search.toLowerCase()) ||
        i.date.includes(search)
      )
    : otterItems;

  const visibleChatItems = search.trim()
    ? chatItems.filter(i =>
        i.title.toLowerCase().includes(search.toLowerCase()) ||
        i.date.includes(search)
      )
    : chatItems;

  const otterCounts = {
    total: otterItems.length,
    tagged: otterItems.filter(i => i.status === "tagged" || i.status === "done").length,
    remote: otterItems.filter(i => i.status === "remote").length,
    active: otterItems.filter(i => i.status === "downloading" || i.status === "tagging").length,
    error: otterItems.filter(i => i.status === "error").length,
  };

  const selectedUnprocessed = Array.from(selected).filter(
    id => itemMap.get(id)?.status === "remote"
  );

  const showOtter = filter === "all" || filter === "otter";
  const showChats = filter === "all" || filter === "chats";

  const activeItems = [
    ...(showOtter ? visibleOtterItems : []),
    ...(showChats ? visibleChatItems : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0f0f0f" }}>

      {/* Progress bar */}
      <ProgressBar fetching={fetching} processing={processing} counts={otterCounts} />

      {/* Header */}
      <div style={{
        padding: "16px 24px 12px",
        borderBottom: "1px solid #1e1e1e",
        background: "#111",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <h1 style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 2 }}>
              {filter === "chats" ? "SecondBrain Chats" : "Import from Otter.ai"}
            </h1>
            <div style={{ fontSize: 12, color: "#555" }}>
              {filter === "chats"
                ? `${chatItems.length} saved chat${chatItems.length !== 1 ? "s" : ""}`
                : fetching
                  ? `Fetching… ${otterCounts.total} found so far`
                  : fetchDone || otterItems.length > 0
                    ? `${otterCounts.total} total · ${otterCounts.tagged} imported · ${otterCounts.remote} new`
                    : "Fetch your conversation list to get started"}
            </div>
          </div>

          {filter !== "chats" && (
            <button
              onClick={fetchList}
              disabled={fetching || processing}
              style={{
                padding: "7px 16px",
                background: fetching ? "#1a1a1a" : "#1e1e2e",
                border: `1px solid ${fetching ? "#2a2a2a" : "#7c3aed"}`,
                borderRadius: 6,
                color: fetching ? "#555" : "#a78bfa",
                cursor: fetching ? "not-allowed" : "pointer",
                fontSize: 13,
                fontWeight: 600,
                minWidth: 140,
              }}
            >
              {fetching ? "Fetching…" : fetchDone || otterItems.length > 0 ? "↺ Refresh" : "Fetch from Otter.ai"}
            </button>
          )}
        </div>

        {/* Filter tabs + toolbar */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, background: "#161616", borderRadius: 6, padding: 2, marginRight: 6 }}>
            {(["all", "otter", "chats"] as FilterTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                style={{
                  padding: "4px 11px",
                  background: filter === tab ? "#2a2a2a" : "none",
                  border: "none",
                  borderRadius: 4,
                  color: filter === tab ? "#e0e0e0" : "#555",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: filter === tab ? 600 : 400,
                  textTransform: "capitalize",
                }}
              >
                {tab === "otter" ? "Otter" : tab === "chats" ? "Chats" : "All"}
              </button>
            ))}
          </div>

          <input
            type="text"
            placeholder="Filter…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              padding: "5px 10px",
              background: "#1a1a1a",
              border: "1px solid #2a2a2a",
              borderRadius: 5,
              color: "#e0e0e0",
              fontSize: 12,
              outline: "none",
              width: 140,
            }}
          />

          {showOtter && otterCounts.remote > 0 && !processing && (
            <button onClick={selectAllNew} style={tbtn(false)}>
              Select all new ({otterCounts.remote})
            </button>
          )}

          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())} style={tbtn(false)}>
              Clear ({selected.size})
            </button>
          )}

          <div style={{ flex: 1 }} />

          {selectedUnprocessed.length > 0 && showOtter && (
            <button onClick={processSelected} disabled={processing} style={tbtn(true, processing)}>
              {processing ? "Processing…" : `Import selected (${selectedUnprocessed.length})`}
            </button>
          )}

          {showOtter && otterCounts.remote > 0 && (
            <button onClick={processAll} disabled={processing} style={tbtnPrimary(processing)}>
              {processing ? "Processing…" : `Import all new (${otterCounts.remote})`}
            </button>
          )}
        </div>

        {fetchError && (
          <div style={{
            marginTop: 10,
            padding: "8px 12px",
            background: "#2a1010",
            border: "1px solid #5a2020",
            borderRadius: 6,
            fontSize: 12,
            color: "#f87171",
          }}>
            ❌ {fetchError}
          </div>
        )}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {activeItems.length === 0 && !fetching ? (
          filter === "chats" ? (
            <div style={{ padding: 32, color: "#444", fontSize: 13, textAlign: "center", lineHeight: 1.8 }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>💬</div>
              No saved chats yet. Start chatting and your conversations will appear here.
            </div>
          ) : (
            <EmptyState />
          )
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#111", borderBottom: "1px solid #1e1e1e" }}>
                <Th width={40} />
                <Th align="left">Title</Th>
                <Th width={100}>Date</Th>
                <Th width={70}>Duration</Th>
                <Th width={90}>Type</Th>
                <Th width={170}>Status</Th>
                <Th width={90} />
              </tr>
            </thead>
            <tbody>
              {activeItems.map(item => (
                <Row
                  key={item.otterId}
                  item={item}
                  selected={selected.has(item.otterId)}
                  processing={processing}
                  onToggle={() => toggleSelect(item.otterId)}
                  onProcess={() => processIds([item.otterId])}
                />
              ))}
              {fetching && otterItems.length > 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: "10px 16px", fontSize: 12, color: "#444", fontStyle: "italic" }}>
                    Loading more…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function ProgressBar({ fetching, processing, counts }: {
  fetching: boolean;
  processing: boolean;
  counts: { total: number; active: number; tagged: number; done: number; remote: number };
}) {
  if (!fetching && !processing) return null;

  const isDeterminate = processing && counts.total > 0;
  const doneCount = counts.tagged + counts.active;
  const pct = isDeterminate ? Math.round((doneCount / counts.total) * 100) : 0;

  return (
    <div style={{ height: 3, background: "#1a1a1a", position: "relative", flexShrink: 0 }}>
      {isDeterminate ? (
        <div style={{
          position: "absolute",
          left: 0,
          top: 0,
          height: "100%",
          width: `${pct}%`,
          background: "#7c3aed",
          transition: "width 0.4s ease",
        }} />
      ) : (
        <div style={{
          position: "absolute",
          top: 0,
          height: "100%",
          width: "30%",
          background: "linear-gradient(90deg, transparent, #7c3aed, transparent)",
          animation: "sweep 1.4s ease-in-out infinite",
        }} />
      )}
      <style>{`@keyframes sweep { 0% { left: -30%; } 100% { left: 130%; } }`}</style>
    </div>
  );
}

// ── Table row ──────────────────────────────────────────────────────────────────

function Row({ item, selected, processing, onToggle, onProcess }: {
  item: ImportItem;
  selected: boolean;
  processing: boolean;
  onToggle: () => void;
  onProcess: () => void;
}) {
  const isActive = item.status === "downloading" || item.status === "tagging";
  const isDone = item.status === "done" || item.status === "tagged";
  const isRemote = item.status === "remote";
  const isError = item.status === "error";
  const isChat = item.itemType === "chat";

  return (
    <tr style={{
      borderBottom: "1px solid #161616",
      background: selected ? "#1a1520" : isActive ? "#101810" : "transparent",
      transition: "background 0.1s",
    }}>
      <td style={{ padding: "9px 12px", textAlign: "center", width: 40 }}>
        {isRemote && !isChat && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            disabled={processing && !isActive}
            style={{ cursor: "pointer", accentColor: "#7c3aed" }}
          />
        )}
      </td>

      <td style={{ padding: "9px 12px" }}>
        <div style={{ fontSize: 13, color: isDone ? "#666" : "#ddd", fontWeight: isDone ? 400 : 500 }}>
          {item.title}
        </div>
        {isError && item.errorMessage && (
          <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>{item.errorMessage}</div>
        )}
      </td>

      <td style={{ padding: "9px 12px", width: 100, textAlign: "center" }}>
        <span style={{ fontSize: 11, color: "#555" }}>{item.date}</span>
      </td>

      <td style={{ padding: "9px 12px", width: 70, textAlign: "center" }}>
        <span style={{ fontSize: 11, color: "#444" }}>
          {item.durationMinutes > 0 ? `${item.durationMinutes}m` : "—"}
        </span>
      </td>

      <td style={{ padding: "9px 12px", width: 90, textAlign: "center" }}>
        <span style={{
          fontSize: 10,
          padding: "2px 8px",
          borderRadius: 10,
          background: isChat ? "#1e1530" : "#151520",
          color: isChat ? "#a78bfa" : "#4a6fa5",
          fontWeight: 600,
        }}>
          {isChat ? "Chat" : "Otter"}
        </span>
      </td>

      <td style={{ padding: "9px 12px", width: 170, textAlign: "center" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          {isActive && (
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: STATUS_COLOR[item.status],
              display: "inline-block",
              animation: "blink 0.8s infinite",
            }} />
          )}
          <span style={{
            fontSize: 11,
            color: STATUS_COLOR[item.status],
            fontWeight: isDone ? 600 : 400,
          }}>
            {isDone ? "✓ " : ""}{STATUS_LABEL[item.status]}
          </span>
        </span>
      </td>

      <td style={{ padding: "9px 12px", width: 90, textAlign: "right", paddingRight: 16 }}>
        {isRemote && !processing && !isChat && (
          <ActionBtn onClick={onProcess} color="#888" hoverColor="#a78bfa">Import</ActionBtn>
        )}
        {isError && !processing && (
          <ActionBtn onClick={onProcess} color="#f87171" hoverColor="#fca5a5">Retry</ActionBtn>
        )}
      </td>
    </tr>
  );
}

// ── Small components ───────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", height: "100%", color: "#444", gap: 10,
    }}>
      <div style={{ fontSize: 36 }}>📥</div>
      <div style={{ fontSize: 14, color: "#555" }}>Click "Fetch from Otter.ai" to load your conversations</div>
      <div style={{ fontSize: 12, color: "#333", maxWidth: 340, textAlign: "center", lineHeight: 1.6 }}>
        Fetches the list first — you choose which ones to import.
        Make sure your Otter.ai email and password are saved in Settings.
      </div>
    </div>
  );
}

function ActionBtn({ onClick, color, hoverColor, children }: {
  onClick: () => void; color: string; hoverColor: string; children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "3px 10px",
        background: "none",
        border: `1px solid ${hovered ? hoverColor : "#2a2a2a"}`,
        borderRadius: 4,
        color: hovered ? hoverColor : color,
        cursor: "pointer",
        fontSize: 11,
        transition: "all 0.1s",
      }}
    >
      {children}
    </button>
  );
}

function Th({ children, width, align = "center" }: {
  children?: React.ReactNode; width?: number; align?: string;
}) {
  return (
    <th style={{
      padding: "7px 12px",
      fontSize: 10,
      fontWeight: 600,
      color: "#3a3a3a",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      width: width,
      textAlign: align as any,
      position: "sticky",
      top: 0,
      background: "#111",
      zIndex: 1,
    }}>
      {children}
    </th>
  );
}

function tbtn(primary: boolean, disabled = false): React.CSSProperties {
  return {
    padding: "5px 11px",
    background: "none",
    border: `1px solid ${disabled ? "#2a2a2a" : primary ? "#7c3aed" : "#333"}`,
    borderRadius: 5,
    color: disabled ? "#444" : primary ? "#a78bfa" : "#777",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    fontWeight: primary ? 600 : 400,
  };
}

function tbtnPrimary(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 12px",
    background: disabled ? "#1a1a1a" : "#7c3aed",
    border: `1px solid ${disabled ? "#2a2a2a" : "#7c3aed"}`,
    borderRadius: 5,
    color: disabled ? "#555" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    fontWeight: 700,
  };
}


