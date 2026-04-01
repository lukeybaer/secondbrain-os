import React, { useState, useEffect, useRef } from "react";

export default function Settings() {
  const [config, setConfig] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [linkStatus, setLinkStatus] = useState<"idle" | "linking" | "ok" | "err">("idle");

  useEffect(() => {
    window.api.config.get().then(setConfig);
  }, []);

  async function save() {
    await window.api.config.save(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (!config) {
    return <div style={{ padding: 32, color: "#444", fontSize: 14 }}>Loading...</div>;
  }

  return (
    <div style={{ padding: 36, maxWidth: 560, color: "#e0e0e0", overflow: "auto", flex: 1 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 28 }}>Settings</h1>

      <ProfileSection />

      <SettingsSection title="Otter.ai Account">
        <div style={{ fontSize: 12, color: "#555", marginBottom: 14, lineHeight: 1.6 }}>
          Used to fetch your conversations. Credentials are stored locally on this machine only.
        </div>
        <Field
          label="Email"
          value={config.otterEmail || ""}
          onChange={v => setConfig({ ...config, otterEmail: v })}
          type="email"
          placeholder="you@example.com"
        />
        <Field
          label="Password"
          value={config.otterPassword || ""}
          onChange={v => setConfig({ ...config, otterPassword: v })}
          type="password"
          placeholder="your otter.ai password"
        />
      </SettingsSection>

      <SettingsSection title="OpenAI">
        <Field
          label="API Key"
          value={config.openaiApiKey || ""}
          onChange={v => setConfig({ ...config, openaiApiKey: v })}
          type="password"
          help="Used for AI tagging and chat Q&A"
        />
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 13, color: "#888", marginBottom: 6 }}>
            Model
          </label>
          <select
            value={config.openaiModel || "gpt-4o"}
            onChange={e => setConfig({ ...config, openaiModel: e.target.value })}
            style={{
              width: "100%",
              padding: "8px 12px",
              background: "#1a1a1a",
              border: "1px solid #2a2a2a",
              borderRadius: 6,
              color: "#e0e0e0",
              fontSize: 13,
              outline: "none",
              cursor: "pointer",
            }}
          >
            <option value="gpt-4o">gpt-4o (recommended)</option>
            <option value="gpt-4-turbo">gpt-4-turbo</option>
            <option value="gpt-3.5-turbo">gpt-3.5-turbo (faster, cheaper)</option>
          </select>
        </div>
        <Field
          label="Max conversations per chat query"
          value={String(config.maxContextConversations || 10)}
          onChange={v => setConfig({ ...config, maxContextConversations: parseInt(v) || 10 })}
          type="number"
          help="Higher = richer answers but more tokens per query"
        />
      </SettingsSection>

      <SettingsSection title="WhatsApp Cloud API">
        <div style={{ fontSize: 12, color: "#555", marginBottom: 14, lineHeight: 1.6 }}>
          For sending and receiving messages. Get Phone Number ID and token from Meta for Developers → WhatsApp → API Setup.
        </div>
        <Field
          label="Phone Number ID"
          value={config.whatsappPhoneNumberId || ""}
          onChange={v => setConfig({ ...config, whatsappPhoneNumberId: v })}
          placeholder="e.g. 123456789012345"
          help="From WhatsApp → API Setup in your Meta app"
        />
        <Field
          label="Access Token"
          value={config.whatsappAccessToken || ""}
          onChange={v => setConfig({ ...config, whatsappAccessToken: v })}
          type="password"
          placeholder="EAAxxxx..."
          help="System user or app token with whatsapp_business_messaging"
        />
      </SettingsSection>

      <SettingsSection title="Vapi.ai (Phone Calls)">
        <div style={{ fontSize: 12, color: "#555", marginBottom: 14, lineHeight: 1.6 }}>
          For making outbound AI phone calls. Sign up at vapi.ai → buy a US phone number (~$2/mo) → copy the API Key and Phone Number ID from the dashboard.
        </div>
        <Field
          label="API Key"
          value={config.vapiApiKey || ""}
          onChange={v => setConfig({ ...config, vapiApiKey: v })}
          type="password"
          placeholder="vapi_..."
          help="From vapi.ai → Dashboard → API Keys — use the Private Key"
        />
        <Field
          label="Phone Number ID"
          value={config.vapiPhoneNumberId || ""}
          onChange={v => setConfig({ ...config, vapiPhoneNumberId: v })}
          placeholder="e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6"
          help="From vapi.ai → Phone Numbers — the UUID of your outbound number"
        />
        <div style={{ fontSize: 12, color: "#555", lineHeight: 1.6, marginTop: 4, marginBottom: 12 }}>
          Inbound callbacks are handled automatically. If you change the Phone Number ID, click below to re-link the callback assistant to the new number.
        </div>
        <button
          onClick={async () => {
            setLinkStatus("linking");
            const res = await window.api.calls.syncCallback("");
            setLinkStatus(res.success ? "ok" : "err");
          }}
          disabled={linkStatus === "linking"}
          style={{
            padding: "6px 14px",
            background: linkStatus === "ok" ? "#166534" : linkStatus === "err" ? "#7f1d1d" : "#2a2a2a",
            border: "1px solid #333",
            borderRadius: 6,
            color: linkStatus === "ok" ? "#4ade80" : linkStatus === "err" ? "#f87171" : "#e0e0e0",
            cursor: linkStatus === "linking" ? "default" : "pointer",
            fontSize: 12,
          }}
        >
          {linkStatus === "linking" ? "Linking…" : linkStatus === "ok" ? "Linked ✓" : linkStatus === "err" ? "Failed ✗" : "Link Callback Assistant to Phone Number"}
        </button>
      </SettingsSection>

      <SettingsSection title="Telegram Bot">
        <div style={{ fontSize: 12, color: "#555", marginBottom: 14, lineHeight: 1.6 }}>
          Used for daily briefings, approval requests, and remote commands. Create a bot via @BotFather → copy the token.
        </div>
        <Field
          label="Bot Token"
          value={config.telegramBotToken || ""}
          onChange={v => setConfig({ ...config, telegramBotToken: v })}
          type="password"
          placeholder="your-bot-token"
          help="From @BotFather → /newbot or /token"
        />
        <Field
          label="Your Chat ID"
          value={config.telegramChatId || ""}
          onChange={v => setConfig({ ...config, telegramChatId: v })}
          placeholder="your-chat-id"
          help="Your personal Telegram user ID — message @userinfobot to find it"
        />
      </SettingsSection>

      <SettingsSection title="Executive Assistant">
        <div style={{ fontSize: 12, color: "#555", marginBottom: 14, lineHeight: 1.6 }}>
          Configuration for autonomous actions — calling, callbacks, and remote orchestration.
        </div>
        <Field
          label="Private SIM (Owner's number)"
          value={config.lukeyPrivateSim || ""}
          onChange={v => setConfig({ ...config, lukeyPrivateSim: v })}
          placeholder="+15555555555"
          help="Owner's private phone number — used for Vapi callbacks and call listen-in"
        />
        <Field
          label="Callback Assistant ID"
          value={config.callbackAssistantId || ""}
          onChange={v => setConfig({ ...config, callbackAssistantId: v })}
          placeholder="e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6"
          help="Vapi assistant ID that handles inbound callbacks to the owner's number"
        />
        <Field
          label="EC2 Base URL"
          value={config.ec2BaseUrl || ""}
          onChange={v => setConfig({ ...config, ec2BaseUrl: v })}
          placeholder="https://your-server.example.com:3001"
          help="SecondBrain backend server — handles Telegram commands and Vapi webhooks"
        />
      </SettingsSection>

      <SettingsSection title="Groq + News">
        <div style={{ fontSize: 12, color: "#555", marginBottom: 14, lineHeight: 1.6 }}>
          Groq is used for ultra-fast news summarization in daily briefings. NewsAPI provides headlines.
        </div>
        <Field
          label="Groq API Key"
          value={config.groqApiKey || ""}
          onChange={v => setConfig({ ...config, groqApiKey: v })}
          type="password"
          placeholder="gsk_..."
          help="From console.groq.com — free tier available"
        />
        <Field
          label="NewsAPI Key (optional)"
          value={config.newsApiKey || ""}
          onChange={v => setConfig({ ...config, newsApiKey: v })}
          type="password"
          placeholder="abc123..."
          help="From newsapi.org — free for 100 requests/day. Leave blank for RSS-only news."
        />
      </SettingsSection>

      <SettingsSection title="YouTube Upload">
        <div style={{ fontSize: 12, color: "#555", marginBottom: 14, lineHeight: 1.6 }}>
          OAuth credentials for uploading videos to YouTube via the Data API v3.
        </div>
        <Field
          label="OAuth Client ID"
          value={config.youtubeClientId || ""}
          onChange={v => setConfig({ ...config, youtubeClientId: v })}
          placeholder="123456789-abc.apps.googleusercontent.com"
          help="From Google Cloud Console → APIs & Services → Credentials"
        />
        <Field
          label="OAuth Client Secret"
          value={config.youtubeClientSecret || ""}
          onChange={v => setConfig({ ...config, youtubeClientSecret: v })}
          type="password"
          placeholder="GOCSPX-..."
        />
      </SettingsSection>

      <SettingsSection title="Storage">
        <div style={{
          fontSize: 12,
          color: "#555",
          background: "#141414",
          border: "1px solid #1e1e1e",
          borderRadius: 6,
          padding: "10px 14px",
          lineHeight: 1.7,
        }}>
          <div style={{ color: "#777", marginBottom: 2 }}>Data directory:</div>
          <code style={{ fontSize: 11, color: "#555", wordBreak: "break-all" }}>
            {config.dataDir}
          </code>
        </div>
      </SettingsSection>

      <button
        onClick={save}
        style={{
          padding: "10px 24px",
          background: saved ? "#059669" : "#7c3aed",
          border: "none",
          borderRadius: 8,
          color: "#fff",
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 600,
          transition: "background 0.2s",
        }}
      >
        {saved ? "✓ Saved" : "Save Settings"}
      </button>
    </div>
  );
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  contact:      { bg: "#0f1f2e", text: "#5aacf5", border: "#1a4a7a" },
  relationship: { bg: "#1a0f2e", text: "#a57cf5", border: "#3d1f7a" },
  preference:   { bg: "#0f2010", text: "#5ae57a", border: "#1a5a22" },
  note:         { bg: "#1e1a0f", text: "#d4b862", border: "#4a3a0f" },
};

function ProfileSection() {
  const [facts, setFacts] = useState<any[]>([]);
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (window.api as any).profile.list().then(setFacts);
  }, []);

  async function addFact() {
    const text = newText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const fact = await (window.api as any).profile.save({ text, category: "note", tags: [], source: "manual" });
      setFacts(prev => [...prev, fact]);
      setNewText("");
      inputRef.current?.focus();
    } finally {
      setAdding(false);
    }
  }

  async function removeFact(id: string) {
    await (window.api as any).profile.delete(id);
    setFacts(prev => prev.filter((f: any) => f.id !== id));
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: "#444",
        textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6,
      }}>
        About You
      </div>
      <div style={{ fontSize: 12, color: "#555", marginBottom: 14, lineHeight: 1.6 }}>
        Facts I've learned about you — used to resolve contacts ("call my wife") and personalize calls.
        I add to this automatically as we chat.
      </div>

      {/* Fact list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {facts.length === 0 && (
          <div style={{ fontSize: 12, color: "#333", fontStyle: "italic", padding: "8px 0" }}>
            No facts yet. They'll appear here as you chat, or add them manually below.
          </div>
        )}
        {facts.map((f: any) => {
          const colors = CATEGORY_COLORS[f.category] ?? CATEGORY_COLORS.note;
          return (
            <div key={f.id} style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              background: "#141414",
              border: "1px solid #1e1e1e",
              borderRadius: 6,
            }}>
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                padding: "2px 6px", borderRadius: 4,
                background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`,
                flexShrink: 0,
              }}>
                {f.category}
              </span>
              <span style={{ flex: 1, fontSize: 13, color: "#ccc", lineHeight: 1.4 }}>{f.text}</span>
              {f.phone && (
                <span style={{ fontSize: 11, color: "#5aacf5", background: "#0d1a26", border: "1px solid #1a3a5a", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>
                  {f.phone}
                </span>
              )}
              <span style={{ fontSize: 10, color: "#333", flexShrink: 0 }}>
                {f.source === "extracted" ? "auto" : "manual"}
              </span>
              <button
                onClick={() => removeFact(f.id)}
                title="Remove"
                style={{
                  background: "none", border: "none", color: "#333", cursor: "pointer",
                  fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0,
                }}
                onMouseEnter={e => (e.currentTarget.style.color = "#e07070")}
                onMouseLeave={e => (e.currentTarget.style.color = "#333")}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {/* Add new fact */}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={inputRef}
          type="text"
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") addFact(); }}
          placeholder='e.g. "My wife is Emily, her phone is +1 555 123 4567"'
          style={{
            flex: 1, padding: "8px 12px", background: "#1a1a1a",
            border: "1px solid #2a2a2a", borderRadius: 6,
            color: "#e0e0e0", fontSize: 13, outline: "none", fontFamily: "inherit",
          }}
          onFocus={e => (e.target.style.borderColor = "#7c3aed")}
          onBlur={e => (e.target.style.borderColor = "#2a2a2a")}
        />
        <button
          onClick={addFact}
          disabled={!newText.trim() || adding}
          style={{
            padding: "8px 16px",
            background: !newText.trim() || adding ? "#1a1a1a" : "#7c3aed",
            border: "1px solid " + (!newText.trim() || adding ? "#2a2a2a" : "#7c3aed"),
            borderRadius: 6, color: !newText.trim() || adding ? "#444" : "#fff",
            cursor: !newText.trim() || adding ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: "#444",
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginBottom: 14,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  help,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  help?: string;
  placeholder?: string;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, color: "#888", marginBottom: 6 }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          padding: "8px 12px",
          background: "#1a1a1a",
          border: "1px solid #2a2a2a",
          borderRadius: 6,
          color: "#e0e0e0",
          fontSize: 13,
          outline: "none",
          fontFamily: type === "password" ? "monospace" : "inherit",
        }}
      />
      {help && <div style={{ fontSize: 11, color: "#444", marginTop: 5, lineHeight: 1.5 }}>{help}</div>}
    </div>
  );
}
