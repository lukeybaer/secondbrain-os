import React, { createContext, useContext, useState, useCallback, useRef } from "react";

interface Toast {
  id: number;
  message: string;
  type: "info" | "success" | "error";
  duration: number;
  onClick?: () => void;
}

interface ToastOptions {
  type?: "info" | "success" | "error";
  duration?: number;
  onClick?: () => void;
}

interface ToastContextValue {
  addToast: (message: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({ addToast: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const MAX_TOASTS = 3;

const BORDER_COLOR: Record<string, string> = {
  info: "#60a5fa",
  success: "#4ade80",
  error: "#f87171",
};

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, options?: ToastOptions) => {
    const id = nextId.current++;
    const duration = options?.duration ?? 2500;
    const toast: Toast = {
      id,
      message,
      type: options?.type ?? "info",
      duration,
      onClick: options?.onClick,
    };

    setToasts(prev => {
      const next = [...prev, toast];
      // Trim to MAX_TOASTS (remove oldest)
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });

    setTimeout(() => removeToast(id), duration);
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast container — bottom-right, stacks upward */}
      <div style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column-reverse",
        gap: 8,
        pointerEvents: "none",
      }}>
        {toasts.map(toast => (
          <div
            key={toast.id}
            onClick={() => {
              toast.onClick?.();
              removeToast(toast.id);
            }}
            style={{
              pointerEvents: "auto",
              background: "#1a1a1a",
              border: "1px solid #2a2a2a",
              borderLeft: `3px solid ${BORDER_COLOR[toast.type]}`,
              borderRadius: 8,
              padding: "12px 16px",
              color: "#e0e0e0",
              fontSize: 13,
              maxWidth: 340,
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
              cursor: toast.onClick ? "pointer" : "default",
              animation: "toast-slide-in 0.2s ease-out",
            }}
          >
            {toast.message}
          </div>
        ))}
      </div>
      {/* Inline keyframes — no CSS file needed */}
      <style>{`
        @keyframes toast-slide-in {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </ToastContext.Provider>
  );
}
