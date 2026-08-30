"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";

type Tone = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
}

interface ToastContextValue {
  toast: (message: string, tone?: Tone) => void;
}

const ToastCtx = createContext<ToastContextValue>({ toast: () => {} });

export function inferTone(message: string): Tone {
  if (message.startsWith("Error")) return "error";
  if (
    message.includes("successful") ||
    message.includes("complete") ||
    message.includes("Done") ||
    message.includes("loaded") ||
    message.includes("verified")
  )
    return "success";
  return "info";
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback((message: string, tone?: Tone) => {
    const id = ++seq.current;
    const resolved = tone ?? inferTone(message);
    setToasts((prev) => [...prev, { id, message, tone: resolved }]);
    const delay =
      resolved === "error" ? 8000 : resolved === "success" ? 5000 : 3500;
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      delay,
    );
  }, []);

  function dismiss(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div
        aria-live="polite"
        className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "flex animate-[fade-up_0.3s_cubic-bezier(0.16,1,0.3,1)_both] items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl with-backdrop-blur-sm",
              t.tone === "error" &&
                "border-red-500/40 bg-red-950/90 text-red-200",
              t.tone === "success" &&
                "border-green-500/40 bg-green-950/85 text-green-200",
              t.tone === "info" &&
                "border-zinc-700 bg-zinc-900/95 text-zinc-200",
            )}
          >
            <span className="leading-relaxed">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  dismiss(t.id);
                }
              }}
              aria-label="Dismiss"
              className="focus-ring mt-0.5 shrink-0 rounded opacity-50 transition-opacity hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
