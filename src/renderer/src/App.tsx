import React, { useState, useEffect } from 'react';
import Chat from './pages/Chat';
import Import from './pages/Import';
import Conversations from './pages/Conversations';
import Messages from './pages/Messages';
import WhatsApp from './pages/WhatsApp';
import Calls from './pages/Calls';
import Personas from './pages/Personas';
import Projects from './pages/Projects';
import Settings from './pages/Settings';
import ContentPipeline from './pages/ContentPipeline';
import Todos from './pages/Todos';
import Backups from './pages/Backups';
import Studio from './pages/Studio';
import TimeMachine from './pages/TimeMachine';
import ClaudeChatOverlay from './components/ClaudeChatOverlay';
import ToastProvider, { useToast } from './components/ToastProvider';

// Error boundary to catch and display React render errors instead of white screen
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            color: '#f87171',
            background: '#0f0f0f',
            fontFamily: 'monospace',
            fontSize: 13,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>React Error</div>
          <div style={{ marginBottom: 8 }}>{this.state.error.message}</div>
          <pre style={{ color: '#888', whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 12,
              padding: '6px 14px',
              background: '#333',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

type Page =
  | 'chat'
  | 'import'
  | 'conversations'
  | 'messages'
  | 'whatsapp'
  | 'calls'
  | 'projects'
  | 'todos'
  | 'personas'
  | 'content-pipeline'
  | 'studio'
  | 'timemachine'
  | 'backups'
  | 'settings';

const NAV_ITEMS: { id: Page; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Ask your meetings anything' },
  { id: 'import', label: 'Import', hint: 'Fetch & process from Otter.ai' },
  { id: 'conversations', label: 'Conversations', hint: 'Browse your library' },
  { id: 'messages', label: 'SMS', hint: 'SMS messages' },
  { id: 'whatsapp', label: 'WhatsApp', hint: 'Personal WhatsApp account' },
  { id: 'calls', label: 'Phone Calls', hint: 'Make AI-powered outbound calls' },
  { id: 'projects', label: 'Projects', hint: 'Manage workflows and task queues' },
  { id: 'todos', label: 'To-Dos', hint: 'Tasks and reminders' },
  { id: 'personas', label: 'Personas', hint: 'Configure AI personas for calls' },
  {
    id: 'content-pipeline',
    label: 'Content Pipeline',
    hint: 'Review and approve videos for upload',
  },
  { id: 'studio', label: 'Studio', hint: 'Multi-camera recording and AI video editing' },
  {
    id: 'timemachine',
    label: 'Time Machine',
    hint: 'Continuous screen & audio capture with search',
  },
  { id: 'backups', label: 'Backups', hint: 'Snapshots, restore, and time-travel' },
  { id: 'settings', label: 'Settings', hint: 'API keys & preferences' },
];

interface PendingCall {
  phoneNumber: string;
  instructions: string;
  listenIn?: boolean;
  personaId?: string;
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ErrorBoundary>
  );
}

function AppContent() {
  const [page, setPage] = useState<Page>('import');
  const [convCount, setConvCount] = useState(0);
  const [pendingCall, setPendingCall] = useState<PendingCall | null>(null);
  const [autoListen, setAutoListen] = useState(false);
  const { addToast } = useToast();

  function handleCallNow(phoneNumber: string, instructions: string, personaId?: string) {
    setPendingCall({ phoneNumber, instructions, listenIn: true, personaId });
    setPage('calls');
  }

  useEffect(() => {
    refreshCount();
    // Listen for inbound SMS → toast notification
    window.api.sms.onInbound((msg: any) => {
      const preview = msg.body?.length > 80 ? msg.body.slice(0, 80) + '...' : msg.body;
      addToast(`SMS from ${msg.contactName || msg.from}: ${preview}`, {
        type: 'info',
        duration: 3000,
        onClick: () => setPage('messages'),
      });
    });
    return () => {
      window.api.sms.offInbound();
    };
  }, []);

  async function refreshCount() {
    try {
      const list = await window.api.conversations.list();
      setConvCount(list.length);
    } catch {}
  }

  function show(id: Page): React.CSSProperties {
    return {
      display: page === id ? 'flex' : 'none',
      flex: 1,
      flexDirection: 'column',
      overflow: 'hidden',
    };
  }

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0f0f0f' }}>
      {/* Sidebar */}
      <div
        style={{
          width: 200,
          background: '#111',
          borderRight: '1px solid #1e1e1e',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div style={{ padding: '18px 18px 14px', borderBottom: '1px solid #1e1e1e' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: -0.3 }}>
            🧠 SecondBrain
          </div>
          <div style={{ fontSize: 11, color: '#444', marginTop: 3 }}>
            {convCount} conversation{convCount !== 1 ? 's' : ''} imported
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px 0' }}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              title={item.hint}
              style={{
                display: 'block',
                width: '100%',
                padding: '9px 18px',
                background: 'none',
                border: 'none',
                borderLeft: `3px solid ${page === item.id ? '#7c3aed' : 'transparent'}`,
                color: page === item.id ? '#e0e0e0' : '#555',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: page === item.id ? 600 : 400,
                transition: 'color 0.1s, border-color 0.1s',
              }}
              onMouseEnter={(e) => {
                if (page !== item.id) (e.currentTarget as HTMLElement).style.color = '#999';
              }}
              onMouseLeave={(e) => {
                if (page !== item.id) (e.currentTarget as HTMLElement).style.color = '#555';
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ padding: '10px 18px 14px', borderTop: '1px solid #1e1e1e' }}>
          <div style={{ fontSize: 10, color: '#333', lineHeight: 1.5 }}>
            Data stored locally.
            <br />
            Chat uses OpenAI API.
          </div>
        </div>
      </div>

      {/* Main — all pages always mounted, only one visible */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        <div style={show('chat')}>
          <Chat onConversationSaved={refreshCount} />
        </div>
        <div style={show('import')}>
          <Import onImported={refreshCount} />
        </div>
        <div style={show('conversations')}>
          <Conversations onCountChange={refreshCount} />
        </div>
        <div style={show('messages')}>
          <Messages onCountChange={refreshCount} />
        </div>
        <div style={show('whatsapp')}>
          <WhatsApp />
        </div>
        <div style={show('calls')}>
          <Calls active={page === 'calls'} pendingCall={pendingCall} autoListen={autoListen} />
        </div>
        <div style={show('projects')}>
          <Projects
            onCallNow={handleCallNow}
            onNavigateTo={(p) => setPage(p as any)}
            onSetAutoListen={setAutoListen}
          />
        </div>
        <div style={show('todos')}>
          <Todos />
        </div>
        <div style={show('personas')}>
          <Personas active={page === 'personas'} />
        </div>
        <div style={show('content-pipeline')}>
          <ContentPipeline />
        </div>
        <div style={show('studio')}>
          <Studio />
        </div>
        <div style={show('timemachine')}>
          <TimeMachine />
        </div>
        <div style={show('backups')}>
          <Backups />
        </div>
        <div style={show('settings')}>
          <Settings />
        </div>
      </div>

      {/* Claude Code floating overlay — lives on top of every page */}
      <ClaudeChatOverlay currentPage={page} />
    </div>
  );
}
