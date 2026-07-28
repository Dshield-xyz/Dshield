const [selectedTier, setSelectedTier] = useState<PoolTier | null>(() => {
  const t = getPoolTiers();
  return t.length > 0 ? t[0] : null;
});

// New UI state for confirmation step
const [showConfirm, setShowConfirm] = useState(false);
const [estimatedFee, setEstimatedFee] = useState<string>("");
const [pendingTx, setPendingTx] = useState<StellarSdk.Transaction | null>(null);
const pendingNotesRef = useRef<ShieldedNote[]>([]);
const [confirmNoteCount, setConfirmNoteCount] = useState(0);setEstimatedFee(tx.fee.toString());
setPendingTx(tx);
pendingNotesRef.current = pending;
setConfirmNoteCount(total);
setShowConfirm(true);const pending: ShieldedNote[] = pendingNotesRef.current;finally {
  setIsLoading(false);
  setShowConfirm(false);
  setPendingTx(null);
  pendingNotesRef.current = [];
  setCustomAmount("");
}