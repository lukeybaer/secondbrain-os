// OnboardingWizard.tsx
//
// First-run experience for fresh forks. Triggers when config.onboarding.completedAt
// is null. Walks the user through:
//
//   1. Welcome
//   2-7. Six-step feature tour (memory, hooks, briefing, calls, time machine, content)
//   8. Choose which briefing sections they want
//   9. Add API secrets (or defer with "remind me later")
//   10. Done summary
//
// Each step is at most 3 short paragraphs. The user can click "Next" to advance
// or scroll to read everything. "Skip tour" is always available.
//
// Persists state to AppConfig.onboarding so the user can quit mid-wizard and
// resume on next launch.

import React, { useState, useEffect } from 'react';

declare global {
  interface Window { api: any }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SecretField {
  key: string;       // AppConfig key
  label: string;     // Visible label
  hint: string;      // 1-line description of what this unlocks
  required: boolean; // Required for the EA to function at all
}

interface SectionToggle {
  key: string;   // Matches DEFAULT_BRIEFING_SECTIONS key
  title: string; // Visible label
  why: string;   // 1-line "what this section gives you"
}

interface FeatureSlide {
  title: string;
  paragraphs: string[]; // 1 to 3 short paragraphs (under 80 words each)
  docsLink?: string;    // Optional link to a docs/ guide for the curious
}

// ── Content (the actual onboarding copy) ─────────────────────────────────────

const FEATURE_TOUR: FeatureSlide[] = [
  {
    title: 'Memory: how it remembers you across sessions',
    paragraphs: [
      'Most LLMs forget you the moment a conversation ends. SecondBrain solves this with a four-tier memory layout: a small pointer file that loads every session, per-topic files loaded on demand, an append-only archive, and an optional knowledge graph layered on top.',
      'You write your facts once. The framework loads what it needs, when it needs it. Token cost stays low even when your memory has thousands of entries.',
      'Hooks update memory automatically when new data arrives (Otter transcripts, Gmail threads, calls, WhatsApp). You don\'t maintain it by hand after the first setup.',
    ],
    docsLink: 'docs/MEMORY_LAYERS.md',
  },
  {
    title: 'Hooks: how rules stick mechanically',
    paragraphs: [
      'A correction in chat is forgotten by next session. A hook is a shell script that runs every time the relevant event fires. Hashtag commands like #learn and #gap save lessons to memory and write regression tests, in one transaction.',
      'Ingest hooks are the other side: when an Otter transcript lands, the hook matches participants to your contact files and appends what was said. Your contact memory updates while you sleep.',
      'The prevention hierarchy is the framework rule: if a behavior matters, push it from a memory file up to a hook or a test. Tests fail loud. Hooks fire deterministically. Memory files rely on the AI noticing.',
    ],
    docsLink: 'docs/HOOKS_GUIDE.md',
  },
  {
    title: 'Daily briefing: what shows up before you wake up',
    paragraphs: [
      'A scheduled task fires before you wake up, builds a briefing from your data sources, and delivers it to Telegram and Gmail. The top is always decisions you need to make today, never status. Status goes at the bottom.',
      'Every section is verifiable. No hardcoded numbers, no fabricated counts. If a data source breaks, the section says so explicitly instead of inventing a value.',
      'You\'ll choose which sections you want in a couple of steps. Local-first by default; you can move it to AWS later if you want it to keep firing while your laptop is closed.',
    ],
    docsLink: 'docs/DAILY_BRIEFING_TEMPLATE.md',
  },
  {
    title: 'AI phone calls (Vapi)',
    paragraphs: [
      'The Calls page lets the EA make outbound calls on your behalf. You give it a target phone number and an instruction. It dials, follows the script, navigates phone trees, and records the transcript.',
      'Listen-in is on by default the first few calls so you can hear how it handles itself. Turn it off once you trust the script.',
      'Inbound is also supported: port your real number to Twilio, route through Vapi, and the EA screens calls. Important calls bridge to you live; routine ones get handled and summarized in the next briefing.',
    ],
  },
  {
    title: 'Time Machine: searchable screen + audio',
    paragraphs: [
      'Continuous screenshot capture every few seconds plus system audio recording. Everything gets OCR\'d and indexed in SQLite full-text search. You can scroll a visual timeline of your day and search by text that appeared on your screen.',
      'Local first, with optional S3 archival for older days. Privacy stays in your hands; nothing leaves your machine unless you point it somewhere.',
      'Useful for "what was I doing when X happened" or "find that snippet I saw three weeks ago". Less spying, more memory.',
    ],
  },
  {
    title: 'Content pipeline + the rest',
    paragraphs: [
      'If you produce content (videos, posts, threads), the pipeline keeps a review queue. Generated content lands as pending; you approve or reject with feedback; rejected items regenerate with your notes incorporated; approved ones queue for upload.',
      'Other pages: Projects (workflow tracking), Personas (configure AI voice personalities), Settings (API keys), Backups (the 6-tier snapshot retention), Studio (audio/video editing for content).',
      'Each page is independent. Use what you want, ignore the rest. Nothing forces you to adopt every feature on day one.',
    ],
  },
];

const BRIEFING_SECTIONS: SectionToggle[] = [
  { key: 'header', title: 'Header', why: 'Date and a one-line greeting at the top.' },
  { key: 'topDecisions', title: 'Top decisions', why: 'Things waiting on you. The most important section.' },
  { key: 'calendarToday', title: "Today's schedule", why: "Pulls from your calendar API. Skipped if you don't have one wired." },
  { key: 'pendingApprovals', title: 'Pending approvals', why: "Drafts the EA wants to send, calls it wants to make. Click to approve." },
  { key: 'people', title: 'People', why: 'Birthdays, going-cold contacts, recent LinkedIn moves.' },
  { key: 'communicationsSummary', title: 'Communications summary', why: 'Aggregated from Gmail, WhatsApp, SMS. Replies needed at the top.' },
  { key: 'projectsDoneTogether', title: 'Projects done together', why: 'What you and the EA shipped yesterday. Builds confidence.' },
  { key: 'contentPipeline', title: 'Content pipeline', why: 'Approval queue state. Skipped if empty.' },
  { key: 'news', title: 'News', why: 'Curated, AI-summarized, real citations. Three paragraphs each.' },
  { key: 'systemHealth', title: 'System health', why: 'Operational status of backups, EC2, tests. RED items get expanded.' },
  { key: 'tokenUsageYesterday', title: 'Token usage', why: 'Confirms the free-tier claim is still true. Goes red on paid usage.' },
  { key: 'awsCosts', title: 'AWS costs', why: 'Last 30 days. Only useful if you run the AWS companion.' },
  { key: 'footerLinks', title: 'Footer links', why: 'Dashboard and repo URLs.' },
];

const SECRET_FIELDS: SecretField[] = [
  { key: 'anthropicApiKey', label: 'Anthropic API key', hint: 'For Claude direct calls (reflections, summaries). Optional if you only use Claude Code.', required: false },
  { key: 'openaiApiKey', label: 'OpenAI API key', hint: 'For Vapi voice synthesis and Graphiti embeddings. Required for phone calls.', required: false },
  { key: 'vapiApiKey', label: 'Vapi API key', hint: 'For outbound and inbound AI phone calls.', required: false },
  { key: 'vapiPhoneNumberId', label: 'Vapi phone number ID', hint: 'The caller ID for outbound calls.', required: false },
  { key: 'telegramBotToken', label: 'Telegram bot token', hint: 'Get from @BotFather. Powers daily briefing delivery and approval flow.', required: false },
  { key: 'telegramChatId', label: 'Telegram chat ID', hint: 'Your personal Telegram user ID (a number).', required: false },
  { key: 'twilioAccountSid', label: 'Twilio Account SID', hint: 'For SMS and inbound call routing.', required: false },
  { key: 'twilioAuthToken', label: 'Twilio Auth Token', hint: 'Pairs with the SID.', required: false },
  { key: 'newsApiKey', label: 'NewsAPI.org key', hint: 'For curated news in the daily briefing. Optional.', required: false },
];

// ── Step definitions ─────────────────────────────────────────────────────────

type StepId = 'welcome' | 'tour' | 'sections' | 'secrets' | 'done';

const TOTAL_STEPS = 1 + FEATURE_TOUR.length + 1 + 1 + 1; // welcome + 6 tour + sections + secrets + done

// ── Main component ───────────────────────────────────────────────────────────

interface OnboardingWizardProps {
  initialStep: number;
  initialBriefingSections: Record<string, boolean>;
  onComplete: (state: { briefingSections: Record<string, boolean>; secretsDeferred: string[] }) => Promise<void>;
  onSkipTour: () => Promise<void>;
  onSavePartial: (currentStep: number) => Promise<void>;
}

export default function OnboardingWizard(props: OnboardingWizardProps) {
  const [step, setStep] = useState(props.initialStep);
  const [briefingSections, setBriefingSections] = useState<Record<string, boolean>>(props.initialBriefingSections);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretsDeferred, setSecretsDeferred] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Persist current step every time it changes so a quit mid-wizard resumes here.
  useEffect(() => {
    props.onSavePartial(step).catch(() => { /* swallow */ });
  }, [step]);

  function next() { setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1)); }
  function back() { setStep((s) => Math.max(0, s - 1)); }
  async function skipTour() {
    await props.onSkipTour();
    // Jump straight to briefing sections step (after welcome + 6 tour)
    setStep(1 + FEATURE_TOUR.length);
  }
  async function finish() {
    setSaving(true);
    try {
      // Save any secret values they typed in
      const filledSecrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(secretValues)) {
        if (v && v.trim()) filledSecrets[k] = v.trim();
      }
      if (Object.keys(filledSecrets).length > 0) {
        await window.api.config.save(filledSecrets);
      }
      await props.onComplete({ briefingSections, secretsDeferred });
    } finally {
      setSaving(false);
    }
  }

  // Resolve which slide to render based on step number.
  let body: React.ReactNode;
  if (step === 0) body = <WelcomeStep onNext={next} onSkip={skipTour} />;
  else if (step >= 1 && step <= FEATURE_TOUR.length) {
    body = <TourStep slide={FEATURE_TOUR[step - 1]} onNext={next} onBack={back} onSkip={skipTour} />;
  } else if (step === 1 + FEATURE_TOUR.length) {
    body = <SectionsStep sections={briefingSections} onChange={setBriefingSections} onNext={next} onBack={back} />;
  } else if (step === 2 + FEATURE_TOUR.length) {
    body = (
      <SecretsStep
        values={secretValues}
        onChange={setSecretValues}
        deferred={secretsDeferred}
        onDefer={setSecretsDeferred}
        onNext={next}
        onBack={back}
      />
    );
  } else {
    body = <DoneStep briefingSections={briefingSections} secretsDeferred={secretsDeferred} onFinish={finish} saving={saving} />;
  }

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <ProgressBar step={step} total={TOTAL_STEPS} />
        <div style={contentStyle}>{body}</div>
      </div>
    </div>
  );
}

// ── Sub-components for each step ─────────────────────────────────────────────

function WelcomeStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div>
      <h1 style={h1Style}>Welcome to SecondBrain</h1>
      <p style={paraStyle}>
        Your desktop now runs an autonomous executive assistant. It makes phone calls,
        remembers people you talk to, summarizes your inbox, and ships you a daily
        briefing every morning. All on your existing Claude Pro or Max subscription.
      </p>
      <p style={paraStyle}>
        This setup takes about 5 minutes. We'll walk through the major features (one
        page each, click to advance), then you'll pick which briefing sections you
        want and optionally add your API keys.
      </p>
      <p style={paraStyle}>
        You can skip the tour at any point and add secrets later. Nothing here is
        a hard requirement; the EA degrades gracefully when an integration is missing.
      </p>
      <div style={buttonRowStyle}>
        <button style={secondaryButtonStyle} onClick={onSkip}>Skip tour</button>
        <button style={primaryButtonStyle} onClick={onNext}>Start the tour</button>
      </div>
    </div>
  );
}

function TourStep({ slide, onNext, onBack, onSkip }: { slide: FeatureSlide; onNext: () => void; onBack: () => void; onSkip: () => void }) {
  return (
    <div>
      <h1 style={h1Style}>{slide.title}</h1>
      {slide.paragraphs.map((p, i) => (
        <p key={i} style={paraStyle}>{p}</p>
      ))}
      {slide.docsLink && (
        <p style={{ ...paraStyle, fontSize: 13, color: '#888' }}>
          More: <code style={codeStyle}>{slide.docsLink}</code>
        </p>
      )}
      <div style={buttonRowStyle}>
        <button style={secondaryButtonStyle} onClick={onBack}>Back</button>
        <button style={secondaryButtonStyle} onClick={onSkip}>Skip tour</button>
        <button style={primaryButtonStyle} onClick={onNext}>Next</button>
      </div>
    </div>
  );
}

function SectionsStep({
  sections,
  onChange,
  onNext,
  onBack,
}: {
  sections: Record<string, boolean>;
  onChange: (s: Record<string, boolean>) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  function toggle(key: string) {
    onChange({ ...sections, [key]: !sections[key] });
  }
  return (
    <div>
      <h1 style={h1Style}>Choose your briefing sections</h1>
      <p style={paraStyle}>
        Your daily briefing has 13 sections. Pick the ones that matter to you. You can
        always change this later in Settings. Sections you turn off are skipped entirely;
        they don't render as "no data" filler.
      </p>
      <div style={{ marginTop: 18, marginBottom: 18 }}>
        {BRIEFING_SECTIONS.map((s) => (
          <label
            key={s.key}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              padding: '10px 12px',
              marginBottom: 4,
              cursor: 'pointer',
              borderRadius: 4,
              background: sections[s.key] ? '#1a1a2e' : 'transparent',
              border: `1px solid ${sections[s.key] ? '#7c3aed' : '#222'}`,
            }}
          >
            <input
              type="checkbox"
              checked={!!sections[s.key]}
              onChange={() => toggle(s.key)}
              style={{ marginTop: 3, marginRight: 12 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ color: '#e0e0e0', fontSize: 14, fontWeight: 500 }}>{s.title}</div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>{s.why}</div>
            </div>
          </label>
        ))}
      </div>
      <div style={buttonRowStyle}>
        <button style={secondaryButtonStyle} onClick={onBack}>Back</button>
        <button style={primaryButtonStyle} onClick={onNext}>Next</button>
      </div>
    </div>
  );
}

function SecretsStep({
  values,
  onChange,
  deferred,
  onDefer,
  onNext,
  onBack,
}: {
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  deferred: string[];
  onDefer: (d: string[]) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  function toggleDefer(key: string) {
    if (deferred.includes(key)) onDefer(deferred.filter((k) => k !== key));
    else onDefer([...deferred, key]);
  }
  function setValue(key: string, value: string) {
    onChange({ ...values, [key]: value });
  }
  return (
    <div>
      <h1 style={h1Style}>API keys</h1>
      <p style={paraStyle}>
        Add the keys you have now. For ones you don't have yet, click "Remind me later"
        and we'll surface a banner on the dashboard once a week until you've added them.
        You can also add or change any of these from Settings at any time.
      </p>
      <p style={{ ...paraStyle, fontSize: 13, color: '#888' }}>
        Skipping all of them is fine. The app runs without external integrations,
        you just lose the features that depend on them.
      </p>
      <div style={{ marginTop: 18, marginBottom: 18, maxHeight: 360, overflowY: 'auto' }}>
        {SECRET_FIELDS.map((s) => {
          const isDeferred = deferred.includes(s.key);
          return (
            <div
              key={s.key}
              style={{
                padding: '10px 12px',
                marginBottom: 6,
                borderRadius: 4,
                background: isDeferred ? '#2a1a0f' : '#181818',
                border: `1px solid ${isDeferred ? '#a05a25' : '#222'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ color: '#e0e0e0', fontSize: 14, fontWeight: 500 }}>{s.label}</div>
                  <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>{s.hint}</div>
                </div>
                <button
                  onClick={() => toggleDefer(s.key)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    background: isDeferred ? '#a05a25' : 'transparent',
                    color: isDeferred ? '#fff' : '#888',
                    border: '1px solid #555',
                    borderRadius: 3,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isDeferred ? 'Reminding later' : 'Remind me later'}
                </button>
              </div>
              {!isDeferred && (
                <input
                  type="password"
                  value={values[s.key] || ''}
                  onChange={(e) => setValue(s.key, e.target.value)}
                  placeholder={`paste ${s.label} here`}
                  style={{
                    marginTop: 8,
                    width: '100%',
                    padding: '6px 10px',
                    background: '#0f0f0f',
                    border: '1px solid #333',
                    borderRadius: 3,
                    color: '#e0e0e0',
                    fontSize: 13,
                    fontFamily: 'monospace',
                    boxSizing: 'border-box',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div style={buttonRowStyle}>
        <button style={secondaryButtonStyle} onClick={onBack}>Back</button>
        <button style={primaryButtonStyle} onClick={onNext}>Next</button>
      </div>
    </div>
  );
}

function DoneStep({
  briefingSections,
  secretsDeferred,
  onFinish,
  saving,
}: {
  briefingSections: Record<string, boolean>;
  secretsDeferred: string[];
  onFinish: () => void;
  saving: boolean;
}) {
  const enabledCount = Object.values(briefingSections).filter(Boolean).length;
  const disabledCount = Object.values(briefingSections).filter((v) => !v).length;
  const deferredCount = secretsDeferred.length;
  return (
    <div>
      <h1 style={h1Style}>Setup complete</h1>
      <p style={paraStyle}>
        Here's what we set up:
      </p>
      <ul style={{ ...paraStyle, paddingLeft: 22 }}>
        <li><strong>{enabledCount}</strong> briefing section{enabledCount !== 1 ? 's' : ''} enabled, {disabledCount} skipped.</li>
        <li>
          {deferredCount === 0
            ? 'All API keys configured (or skipped silently).'
            : `${deferredCount} API key${deferredCount !== 1 ? 's' : ''} deferred. We'll remind you on the dashboard once a week.`}
        </li>
        <li>You can change any of this anytime from Settings.</li>
      </ul>
      <p style={paraStyle}>
        Next: open the Briefing tab to generate your first briefing on demand, or wait
        for the scheduled task to fire on its own (5:30 AM by default, configurable in
        Settings).
      </p>
      <p style={{ ...paraStyle, fontSize: 13, color: '#888' }}>
        Architecture details: <code style={codeStyle}>docs/MEMORY_LAYERS.md</code>,{' '}
        <code style={codeStyle}>docs/HOOKS_GUIDE.md</code>,{' '}
        <code style={codeStyle}>docs/DAILY_BRIEFING_TEMPLATE.md</code>.
      </p>
      <div style={buttonRowStyle}>
        <button style={primaryButtonStyle} onClick={onFinish} disabled={saving}>
          {saving ? 'Saving...' : 'Take me to the app'}
        </button>
      </div>
    </div>
  );
}

function ProgressBar({ step, total }: { step: number; total: number }) {
  const pct = ((step + 1) / total) * 100;
  return (
    <div style={{ height: 4, background: '#1a1a1a', borderRadius: 2, marginBottom: 24 }}>
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: '#7c3aed',
          borderRadius: 2,
          transition: 'width 0.2s',
        }}
      />
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100vw',
  height: '100vh',
  background: 'rgba(0, 0, 0, 0.85)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
};

const modalStyle: React.CSSProperties = {
  background: '#0f0f0f',
  border: '1px solid #2a2a2a',
  borderRadius: 8,
  padding: '32px 40px',
  width: 720,
  maxWidth: '90vw',
  maxHeight: '90vh',
  overflowY: 'auto',
  boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
};

const contentStyle: React.CSSProperties = {
  color: '#e0e0e0',
};

const h1Style: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  color: '#fff',
  marginTop: 0,
  marginBottom: 16,
  letterSpacing: -0.3,
};

const paraStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  color: '#bbb',
  marginTop: 0,
  marginBottom: 14,
};

const codeStyle: React.CSSProperties = {
  background: '#1a1a1a',
  padding: '2px 6px',
  borderRadius: 3,
  fontSize: 12,
  fontFamily: 'monospace',
  color: '#7c3aed',
};

const buttonRowStyle: React.CSSProperties = {
  marginTop: 24,
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '10px 20px',
  background: '#7c3aed',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '10px 20px',
  background: 'transparent',
  color: '#999',
  border: '1px solid #333',
  borderRadius: 4,
  fontSize: 14,
  cursor: 'pointer',
};
