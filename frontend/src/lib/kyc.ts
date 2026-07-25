import { withStorageLock, onStorageChange } from "./storageLock";

const KYC_KEY = "dshield_kyc";
const LOCK_KEY = "dshield_kyc_lock";

export interface KycRecord {
  preimage: string;
  hash: string;
  registeredOnChain: boolean;
  createdAt: number;
}

export function saveKyc(record: KycRecord): void {
  withStorageLock(LOCK_KEY, () => {
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
  withStorageLock(LOCK_KEY, () => {
    localStorage.removeItem(KYC_KEY);
  });
}

/** Subscribe to cross-tab/window KYC updates via storage events. */
export function onKycChange(
  callback: (record: KycRecord | null) => void,
): () => void {
  return onStorageChange(KYC_KEY, () => {
    callback(getKyc());
  });
}
