import React, { useState, useEffect } from "react";

interface Persona {
  id: string;
  name: string;
  instructions: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

const style = {
  page: { padding: 24, flex: 1, overflow: "auto" as const, color: "#e0e0e0" },
  title: { fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 8 },
  card: {
    background: "#141414",
    border: "1px solid #1e1e1e",
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  },
  input: {
    width: "100%",
    padding: "8px 12px",
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
    marginBottom: 8,
    boxSizing: "border-box" as const,
    fontFamily: "inherit",
  },
  textarea: {
    width: "100%",
    padding: "8px 12px",
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
    resize: "vertical" as const,
    marginBottom: 8,
    boxSizing: "border-box" as const,
    fontFamily: "inherit",
    lineHeight: 1.6,
  },
  btn: {
    padding: "8px 16px",
    background: "#7c3aed",
    border: "none",
    borderRadius: 6,
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  btnSmall: {
    padding: "4px 10px",
    background: "#2a2a2a",
    border: "1px solid #333",
    borderRadius: 5,
    color: "#e0e0e0",
    cursor: "pointer",
    fontSize: 12,
  },
  btnDanger: {
    padding: "4px 10px",
    background: "none",
    border: "1px solid #3a1a1a",
    borderRadius: 5,
    color: "#f87171",
    cursor: "pointer",
    fontSize: 12,
  },
  btnLink: {
    background: "none",
    border: "none",
    color: "#7c3aed",
    cursor: "pointer",
    fontSize: 12,
    padding: 0,
  },
};

function PersonaCard({
  persona,
  onSaved,
  onDeleted,
}: {
  persona: Persona;
  onSaved: (p: Persona) => void;
  onDeleted: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(persona.name);
  const [instructions, setInstructions] = useState(persona.instructions);
  const [summarizing, setSummarizing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Keep local edit state in sync when persona prop is updated externally (e.g. after summarize)
  useEffect(() => {
    if (!editing) {
      setName(persona.name);
      setInstructions(persona.instructions);
    }
  }, [persona.name, persona.instructions, persona.updatedAt]);

  async function handleSummarize() {
    setSummarizing(true);
    try {
      const res = await window.api.personas.summarize(persona.id);
      if (res.success && res.summary) {
        onSaved({ ...persona, summary: res.summary });
      }
    } finally {
      setSummarizing(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await window.api.personas.save({
        id: persona.id,
        name: name.trim(),
        instructions: instructions.trim(),
        summary: undefined, // clear stale summary when instructions change
      });
      onSaved(updated);
      setEditing(false);
      setExpanded(false);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setName(persona.name);
    setInstructions(persona.instructions);
    setEditing(false);
  }

  async function handleDelete() {
    if (!confirm(`Delete persona "${persona.name}"?`)) return;
    await window.api.personas.delete(persona.id);
    onDeleted(persona.id);
  }

  const displaySummary = persona.summary ?? null;

  return (
    <div style={style.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        {editing ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...style.input, marginBottom: 0, flex: 1, marginRight: 12, fontWeight: 600 }}
            autoFocus
          />
        ) : (
          <div style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>{persona.name}</div>
        )}
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {!editing && (
            <>
              <button style={style.btnSmall} onClick={() => { setEditing(true); setExpanded(true); }}>
                Edit
              </button>
              <button style={style.btnDanger} onClick={handleDelete}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={8}
            style={style.textarea}
            placeholder="Write the full instructions for this persona..."
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button style={style.btn} onClick={handleSave} disabled={saving || !name.trim() || !instructions.trim()}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button style={style.btnSmall} onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {displaySummary ? (
            <div style={{ fontSize: 13, color: "#aaa", lineHeight: 1.6, marginBottom: 8 }}>
              {displaySummary}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#444", fontStyle: "italic" as const, marginBottom: 8 }}>
              No summary yet.{" "}
              <button style={style.btnLink} onClick={handleSummarize} disabled={summarizing}>
                {summarizing ? "Generating…" : "Generate summary"}
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button style={style.btnLink} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Hide instructions" : "View full instructions"}
            </button>
            {displaySummary && (
              <button style={{ ...style.btnLink, color: "#555" }} onClick={handleSummarize} disabled={summarizing}>
                {summarizing ? "Regenerating…" : "Regenerate summary"}
              </button>
            )}
          </div>

          {expanded && (
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                background: "#0f0f0f",
                border: "1px solid #222",
                borderRadius: 6,
                fontSize: 12,
                color: "#ccc",
                whiteSpace: "pre-wrap" as const,
                lineHeight: 1.7,
                maxHeight: 320,
                overflow: "auto",
              }}
            >
              {persona.instructions}
            </div>
          )}
        </>
      )}

      <div style={{ fontSize: 10, color: "#333", marginTop: 10 }}>
        Updated {new Date(persona.updatedAt).toLocaleDateString()}
      </div>
    </div>
  );
}

export default function Personas({ active }: { active?: boolean }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newInstructions, setNewInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => { load(); }, []);
  useEffect(() => { if (active) load(); }, [active]);

  async function load() {
    setLoading(true);
    try {
      const list = await window.api.personas.list();
      setPersonas(list);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim() || !newInstructions.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      const created = await window.api.personas.save({
        name: newName.trim(),
        instructions: newInstructions.trim(),
      });
      if (!created || !created.id) {
        setSaveError("Save failed — try restarting the app.");
        return;
      }
      setPersonas((prev) => [...prev, created]);
      setNewName("");
      setNewInstructions("");
      setCreating(false);
    } catch (err: any) {
      setSaveError(err.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleSaved(updated: Persona) {
    setPersonas((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  function handleDeleted(id: string) {
    setPersonas((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div style={style.page}>
      <h1 style={style.title}>Personas</h1>
      <p style={{ fontSize: 12, color: "#555", marginBottom: 20, lineHeight: 1.5 }}>
        Pre-configured AI personalities for phone calls. Each persona defines how the AI behaves, speaks, and handles conversations. Select one when placing a call, then add call-specific instructions on top.
      </p>

      {creating ? (
        <div style={{ ...style.card, borderColor: "#2a1a4a" }}>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>New persona</div>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Persona name (e.g. Professional Assistant, Casual Friend)"
            style={style.input}
            autoFocus
          />
          <textarea
            value={newInstructions}
            onChange={(e) => setNewInstructions(e.target.value)}
            rows={8}
            style={style.textarea}
            placeholder={`Write the full instructions for this persona.\n\nExample:\nYou are a polite, professional assistant calling on behalf of Luke. You speak confidently and warmly. You introduce yourself as calling on Luke's behalf. You get to the point quickly but are never rude. If you reach voicemail, leave a brief friendly message and say Luke will follow up.`}
          />
          {saveError && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 8 }}>{saveError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ ...style.btn, opacity: saving || !newName.trim() || !newInstructions.trim() ? 0.5 : 1 }}
              onClick={handleCreate}
              disabled={saving || !newName.trim() || !newInstructions.trim()}
            >
              {saving ? "Saving…" : "Save persona"}
            </button>
            <button style={style.btnSmall} onClick={() => { setCreating(false); setNewName(""); setNewInstructions(""); setSaveError(""); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button style={{ ...style.btn, marginBottom: 20 }} onClick={() => setCreating(true)}>
          + New Persona
        </button>
      )}

      {loading ? (
        <div style={{ color: "#555", fontSize: 13 }}>Loading…</div>
      ) : personas.length === 0 && !creating ? (
        <div style={{ color: "#444", fontSize: 13, lineHeight: 1.7 }}>
          No personas yet. Create one above to get started.<br />
          <span style={{ color: "#333" }}>Example: "Professional Assistant", "Casual Buddy", "Formal Business Rep"</span>
        </div>
      ) : (
        personas.map((p) => (
          <PersonaCard key={p.id} persona={p} onSaved={handleSaved} onDeleted={handleDeleted} />
        ))
      )}
    </div>
  );
}
