// SecretsReminderBanner.tsx
//
// Dashboard banner that surfaces when the user said "remind me later" for one
// or more API secrets during onboarding. Shows at the top of every page until
// they either add the secrets or dismiss the banner for the week.
//
// Throttling: persists `lastReminderShownAt` in config so the banner shows
// at most once per 7 days. The user can also dismiss it manually for the
// current session.

import React, { useEffect, useState } from 'react';

declare global {
  interface Window { api: any }
}

interface SecretsReminderBannerProps {
  deferredKeys: string[];
  lastShownAt: string | null;
  onOpenSettings: () => void;
  onDismissForWeek: () => Promise<void>;
}

const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SECRET_LABELS: Record<string, string> = {
  anthropicApiKey: 'Anthropic',
  openaiApiKey: 'OpenAI',
  vapiApiKey: 'Vapi',
  vapiPhoneNumberId: 'Vapi phone',
  telegramBotToken: 'Telegram bot',
  telegramChatId: 'Telegram chat',
  twilioAccountSid: 'Twilio',
  twilioAuthToken: 'Twilio auth',
  newsApiKey: 'NewsAPI',
};

export default function SecretsReminderBanner(props: SecretsReminderBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  // Hide if no deferred keys, or if dismissed this session, or if we showed it recently.
  if (props.deferredKeys.length === 0) return null;
  if (dismissed) return null;
  if (props.lastShownAt) {
    const shownAt = Date.parse(props.lastShownAt);
    if (Date.now() - shownAt < REMINDER_INTERVAL_MS) return null;
  }

  const labels = props.deferredKeys
    .map((k) => SECRET_LABELS[k] || k)
    .slice(0, 4);
  const more = props.deferredKeys.length - labels.length;
  const labelText = labels.join(', ') + (more > 0 ? `, +${more} more` : '');

  async function handleDismiss() {
    setDismissed(true);
    await props.onDismissForWeek();
  }

  return (
    <div
      style={{
        background: '#2a1a0f',
        border: '1px solid #a05a25',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}
    >
      <div style={{ color: '#e0e0e0', fontSize: 13 }}>
        <strong>{props.deferredKeys.length}</strong> API key{props.deferredKeys.length !== 1 ? 's' : ''} pending: <span style={{ color: '#aaa' }}>{labelText}</span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={props.onOpenSettings}
          style={{
            padding: '5px 14px',
            background: '#a05a25',
            color: '#fff',
            border: 'none',
            borderRadius: 3,
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Add now
        </button>
        <button
          onClick={handleDismiss}
          style={{
            padding: '5px 14px',
            background: 'transparent',
            color: '#888',
            border: '1px solid #555',
            borderRadius: 3,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Remind me next week
        </button>
      </div>
    </div>
  );
}
