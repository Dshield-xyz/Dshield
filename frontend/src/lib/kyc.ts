const KYC_KEY = "dshield_kyc";
const KYC_LOCK_KEY = "dshield_kyc_lock";
const LOCK_TIMEOUT_MS = 5000;

export interface KycRecord {
  preimage: string;
  hash: string;
  registeredOnChain: boolean;
  createdAt: number;
}

/**
 * Acquire a simple advisory lock to serialize cross-tab writes.
 * Prevents concurrent KYC updates from different tabs/windows.
 */
async function acquireLock(): Promise<() => void> {
  const lockId = Date.now().toString() + Math.random().toString(36);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const currentLock = localStorage.getItem(KYC_LOCK_KEY);
    if (!currentLock) {
      const lockData = JSON.stringify({ id: lockId, timestamp: Date.now() });
      localStorage.setItem(KYC_LOCK_KEY, lockData);
      const verifyLock = localStorage.getItem(KYC_LOCK_KEY);
      if (verifyLock) {
        try {
          const parsed = JSON.parse(verifyLock);
          if (parsed.id === lockId) {
            return () => {
              const currentData = localStorage.getItem(KYC_LOCK_KEY);
              if (currentData) {
                try {
                  const current = JSON.parse(currentData);
                  if (current.id === lockId) {
                    localStorage.removeItem(KYC_LOCK_KEY);
                  }
                } catch {
                  localStorage.removeItem(KYC_LOCK_KEY);
                }
              }
            };
          }
        } catch {
          // Invalid JSON, try again
        }
      }
    } else {
      try {
        const lockData = JSON.parse(currentLock);
        if (lockData.timestamp && Date.now() - lockData.timestamp > LOCK_TIMEOUT_MS) {
          localStorage.removeItem(KYC_LOCK_KEY);
        }
      } catch {
        // Invalid lock data without timestamp, don't clear immediately
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Failed to acquire KYC storage lock after timeout");
}

async function withLock<T>(fn: () => T): Promise<T> {
  const release = await acquireLock();
  try {
    return fn();
  } finally {
    release();
  }
}

export async function saveKyc(record: KycRecord): Promise<void> {
  return withLock(() => {
    localStorage.setItem(KYC_KEY, JSON.stringify(record));
  });
}

export function getKyc(): KycRecord | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KYC_KEY);
  if (!raw) return null;
  return JSON.parse(raw);
}

export function clearKyc(): void {
  localStorage.removeItem(KYC_KEY);
}
