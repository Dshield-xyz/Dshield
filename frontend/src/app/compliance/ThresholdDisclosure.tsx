import { useState } from "react";
import { ShieldedNote } from "@/lib/notes";
import { generateThresholdProof } from "@/lib/prover";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

interface Props {
  notes: ShieldedNote[];
}

export default function ThresholdDisclosure({ notes }: Props) {
  const [selectedNote, setSelectedNote] = useState<ShieldedNote | null>(null);
  const [threshold, setThreshold] = useState<string>("");
  const [proof, setProof] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleGenerate() {
    if (!selectedNote || !threshold) return;
    setLoading(true);
    try {
      const result = await generateThresholdProof(selectedNote, threshold);
      setProof(JSON.stringify(result, null, 2));
      toast("Threshold proof generated", "success");
    } catch (e) {
      toast(`Error: ${e}`, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-4 glassmorphism rounded-xl backdrop-blur-sm">
      <h2 className="mb-4 text-xl font-semibold">Threshold Disclosure</h2>
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">Select Note</label>
        <select
          className="w-full rounded border p-2"
          value={selectedNote?.commitment ?? ""}
          onChange={(e) => {
            const note = notes.find((n) => n.commitment === e.target.value);
            setSelectedNote(note ?? null);
          }}
        >
          <option value="">-- Choose a note --</option>
          {notes.map((note) => (
            <option key={note.commitment} value={note.commitment}>
              {note.commitment.slice(0, 12)}…
            </option>
          ))}
        </select>
      </div>
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">Threshold (e.g., 1000)</label>
        <input
          type="text"
          className="w-full rounded border p-2"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        />
      </div>
      <Button onClick={handleGenerate} disabled={loading || !selectedNote || !threshold}>
        {loading ? "Generating…" : "Generate Proof"}
      </Button>
      {proof && (
        <pre className="mt-4 max-h-64 overflow-auto rounded bg-zinc-900 p-2 text-xs text-green-400">
          {proof}
        </pre>
      )}
    </div>
  );
}
