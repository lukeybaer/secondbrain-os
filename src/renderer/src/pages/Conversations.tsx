import React, { useState, useEffect, useMemo } from "react";

type FilterTab = "all" | "otter" | "chats";

interface Meta {
  id: string;
  title: string;
  date: string;
  durationMinutes: number;
  speakers: string[];
  myRole: string;
  meetingType: string;
  summary: string;
  topics: string[];
  keywords: string[];
  peopleMentioned: string[];
  companiesMentioned: string[];
  decisions: string[];
  sentiment: string;
}

interface Detail {
  meta: Meta;
  transcript: string;
}

const SENTIMENT_COLORS: Record<string, string> = {
  productive: "#4ade80",
  positive: "#4ade80",
  tense: "#f87171",
  problematic: "#f87171",
  exploratory: "#60a5fa",
  routine: "#94a3b8",
  mixed: "#fbbf24",
};

export default function Conversations({ onCountChange }: { onCountChange?: () => void }) {
  const [allList, setAllList] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterTab>("all");
  const [selected, setSelected] = useState<Detail | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const searchTimer = React.useRef<any>(null);

  useEffect(() => {
    load();
  }, []);

  async function load(query?: string) {
    setLoading(true);
    try {
      const results = query
        ? await window.api.conversations.search(query)
        : await window.api.conversations.list();
      // Sort newest first by date string (ISO YYYY-MM-DD sorts lexicographically)
      const sorted = [...results].sort((a, b) => b.date.localeCompare(a.date));
      setAllList(sorted);
    } finally {
      setLoading(false);
    }
  }

  function onSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setSearch(q);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      load(q || undefined);
    }, 300);
  }

  const list = useMemo(() => {
    return allList.filter(c => {
      if (filter === "chats") return c.meetingType === "OpenBrainChat";
      if (filter === "otter") return c.meetingType !== "OpenBrainChat";
      return true;
    });
  }, [allList, filter]);

  async function select(id: string) {
    const detail = await window.api.conversations.get(id);
    setSelected(detail);
    setShowTranscript(false);
  }

  const color = (s: string) => SENTIMENT_COLORS[s] || "#666";

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* List panel */}
      <div style={{
        width: 340,
        borderRight: "1px solid #1e1e1e",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid #1e1e1e" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={onSearch}
              style={{
                flex: 1,
                padding: "8px 12px",
                background: "#1a1a1a",
                border: "1px solid #2a2a2a",
                borderRadius: 6,
                color: "#e0e0e0",
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              onClick={() => load(search || undefined)}
              style={{
                padding: "8px 10px",
                background: "#1a1a1a",
                border: "1px solid #2a2a2a",
                borderRadius: 6,
                color: "#666",
                cursor: "pointer",
                fontSize: 14,
                flexShrink: 0,
              }}
              title="Refresh"
            >
              ↺
            </button>
          </div>
          <div style={{ display: "flex", gap: 2, marginTop: 8, background: "#161616", borderRadius: 5, padding: 2 }}>
            {(["all", "otter", "chats"] as FilterTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                style={{
                  flex: 1,
                  padding: "3px 0",
                  background: filter === tab ? "#2a2a2a" : "none",
                  border: "none",
                  borderRadius: 3,
                  color: filter === tab ? "#e0e0e0" : "#444",
                  cursor: "pointer",
                  fontSize: 10,
                  fontWeight: filter === tab ? 600 : 400,
                  textTransform: "capitalize",
                }}
              >
                {tab === "otter" ? "Otter" : tab === "chats" ? "Chats" : "All"}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#444", marginTop: 6 }}>
            {list.length} result{list.length !== 1 ? "s" : ""}
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {loading ? (
            <div style={{ padding: 20, color: "#444", fontSize: 13, textAlign: "center" }}>Loading...</div>
          ) : list.length === 0 ? (
            <div style={{ padding: 20, color: "#444", fontSize: 13, textAlign: "center", lineHeight: 1.6 }}>
              {search ? "No matching conversations." : "No conversations yet.\nClick Sync Otter.ai to import."}
            </div>
          ) : (
            list.map(conv => (
              <div
                key={conv.id}
                onClick={() => select(conv.id)}
                style={{
                  padding: "11px 14px",
                  borderBottom: "1px solid #181818",
                  cursor: "pointer",
                  background: selected?.meta.id === conv.id ? "#1a1a1a" : "transparent",
                  transition: "background 0.1s",
                }}
                onMouseEnter={e => { if (selected?.meta.id !== conv.id) (e.currentTarget as HTMLElement).style.background = "#161616"; }}
                onMouseLeave={e => { if (selected?.meta.id !== conv.id) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "#ddd", marginBottom: 4, lineHeight: 1.3 }}>
                  {conv.title}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 5 }}>
                  <span style={{ fontSize: 11, color: "#555" }}>{conv.date}</span>
                  {conv.durationMinutes > 0 && (
                    <span style={{ fontSize: 11, color: "#444" }}>{conv.durationMinutes}m</span>
                  )}
                  <span style={{
                    fontSize: 10,
                    padding: "1px 7px",
                    borderRadius: 10,
                    background: color(conv.sentiment) + "20",
                    color: color(conv.sentiment),
                    fontWeight: 600,
                  }}>
                    {conv.sentiment}
                  </span>
                </div>
                <div style={{
                  fontSize: 11,
                  color: "#555",
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  lineHeight: 1.5,
                }}>
                  {conv.summary}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div style={{ flex: 1, overflow: "auto", padding: 28 }}>
        {selected ? (
          <ConversationDetail detail={selected} showTranscript={showTranscript} onToggleTranscript={() => setShowTranscript(v => !v)} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#333", fontSize: 14 }}>
            Select a conversation
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationDetail({
  detail,
  showTranscript,
  onToggleTranscript,
}: {
  detail: Detail;
  showTranscript: boolean;
  onToggleTranscript: () => void;
}) {
  const { meta, transcript } = detail;
  const color = (s: string) => SENTIMENT_COLORS[s] || "#666";

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 10, lineHeight: 1.3 }}>
        {meta.title}
      </h1>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 20, fontSize: 13, color: "#666" }}>
        <span>📅 {meta.date}</span>
        {meta.durationMinutes > 0 && <span>⏱ {meta.durationMinutes} min</span>}
        <span>🏷 {meta.meetingType.replace(/_/g, " ")}</span>
        <span>👤 {meta.myRole}</span>
        <span style={{ color: color(meta.sentiment) }}>● {meta.sentiment}</span>
      </div>

      {/* Summary */}
      <Section title="Summary">
        <p style={{ fontSize: 14, color: "#ccc", lineHeight: 1.7 }}>{meta.summary}</p>
      </Section>

      {/* Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <TagBox title="Topics" items={meta.topics} color="#7c3aed" />
        <TagBox title="People Mentioned" items={meta.peopleMentioned} color="#10b981" />
        <TagBox title="Decisions" items={meta.decisions} color="#f59e0b" />
        <TagBox title="Companies" items={meta.companiesMentioned} color="#3b82f6" />
      </div>

      {/* Speakers + Keywords */}
      {meta.speakers?.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <span style={{ fontSize: 11, color: "#555", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginRight: 8 }}>Speakers</span>
          {meta.speakers.map(s => (
            <span key={s} style={{
              fontSize: 12,
              background: "#1e1e1e",
              border: "1px solid #2a2a2a",
              color: "#aaa",
              padding: "2px 8px",
              borderRadius: 4,
              marginRight: 6,
              display: "inline-block",
              marginBottom: 4,
            }}>{s}</span>
          ))}
        </div>
      )}

      {meta.keywords?.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <span style={{ fontSize: 11, color: "#555", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginRight: 8 }}>Keywords</span>
          {meta.keywords.map(k => (
            <span key={k} style={{
              fontSize: 11,
              background: "#161616",
              border: "1px solid #222",
              color: "#666",
              padding: "2px 7px",
              borderRadius: 4,
              marginRight: 5,
              display: "inline-block",
              marginBottom: 4,
            }}>{k}</span>
          ))}
        </div>
      )}

      {/* Transcript */}
      <button
        onClick={onToggleTranscript}
        style={{
          padding: "6px 14px",
          background: "#1a1a1a",
          border: "1px solid #2a2a2a",
          borderRadius: 6,
          color: "#888",
          cursor: "pointer",
          fontSize: 12,
          marginBottom: showTranscript ? 12 : 0,
        }}
      >
        {showTranscript ? "Hide Transcript" : "Show Transcript"}
      </button>

      {showTranscript && (
        <div style={{
          background: "#0d0d0d",
          border: "1px solid #1e1e1e",
          borderRadius: 8,
          padding: 16,
          fontFamily: "monospace",
          fontSize: 12,
          color: "#888",
          lineHeight: 1.9,
          maxHeight: 420,
          overflow: "auto",
          whiteSpace: "pre-wrap",
        }}>
          {transcript || "No transcript available."}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#141414", border: "1px solid #1e1e1e", borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function TagBox({ title, items, color }: { title: string; items: string[]; color: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ background: "#141414", border: "1px solid #1e1e1e", borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
        {title}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.slice(0, 8).map((item, i) => (
          <li key={i} style={{ fontSize: 12, color: "#aaa", padding: "3px 0", lineHeight: 1.4 }}>
            · {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
