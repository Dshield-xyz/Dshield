"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { useToast, type Tone } from "@/components/ui/Toast";
import { friendlyError } from "@/lib/errors";

interface NotifyContextValue {
  /** Display a toast with an inferred or explicit tone. */
  notify: (message: string, tone?: Tone) => void;
  /** Convert an error with `friendlyError` and display it as an error toast. */
  notifyError: (err: unknown, fallback?: string) => void;
  /** Convenience wrapper for success toasts. */
  notifySuccess: (message: string) => void;
}

const NotifyCtx = createContext<NotifyContextValue>({
  notify: () => {},
  notifyError: () => {},
  notifySuccess: () => {},
});

/**
 * Wraps the existing ToastProvider + `friendlyError` into a single
 * `useNotify()` contract so every page/component surfaces errors through
 * the same unified path.
 *
 * Must be rendered **inside** `<ToastProvider>` (it calls `useToast()`).
 */
export function NotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { toast } = useToast();

  const notify = useCallback(
    (message: string, tone?: Tone) => {
      toast(message, tone);
    },
    [toast],
  );

  const notifyError = useCallback(
    (err: unknown, fallback?: string) => {
      toast(friendlyError(err, fallback), "error");
    },
    [toast],
  );

  const notifySuccess = useCallback(
    (message: string) => {
      toast(message, "success");
    },
    [toast],
  );

  const value = useMemo(
    () => ({ notify, notifyError, notifySuccess }),
    [notify, notifyError, notifySuccess],
  );

  return <NotifyCtx.Provider value={value}>{children}</NotifyCtx.Provider>;
}

export function useNotify(): NotifyContextValue {
  return useContext(NotifyCtx);
}