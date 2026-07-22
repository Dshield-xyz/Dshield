"use client";

import { useState, useRef, useCallback, KeyboardEvent, ClipboardEvent } from "react";
import { parseNote, type ShieldedNote } from "@/lib/notes";
import { truncateMiddle } from "@/lib/format";
import { useToast } from "./Toast";
import { Card } from "./Card";

interface Tag {
  note: ShieldedNote;
}

export function NoteImport({
  onImport,
  disabled,
  title = "Import Shielded Notes",
}: {
  onImport: (notes: ShieldedNote[]) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  function parseNotesFromText(text: string): ShieldedNote[] {
    return text
      .split(/[\n\r\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("dshield-v1-"))
      .map(parseNote)
      .filter((n): n is ShieldedNote => n !== null);
  }

  function isDuplicate(note: ShieldedNote) {
    return tags.some((t) => t.note.commitment === note.commitment);
  }

  function commitInput(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;

    const note = parseNote(trimmed);
    if (!note) {
      if (trimmed.startsWith("dshield")) {
        toast("Couldn't read that note — paste the complete dshield-v1-… string.", "error");
      }
      return false;
    }

    if (isDuplicate(note)) {
      toast("That note is already added.", "error");
      return false;
    }

    setTags((prev) => [...prev, { note }]);
    onImport([note]);
    return true;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (commitInput(inputValue)) setInputValue("");
      return;
    }
    if (e.key === "Backspace" && inputValue === "" && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    const notes = parseNotesFromText(text);
    if (notes.length === 0) return; // let default paste handle it

    e.preventDefault();
    const fresh = notes.filter((n) => !isDuplicate(n));
    if (fresh.length === 0) {
      toast("All pasted notes are already added.", "error");
      return;
    }
    setTags((prev) => [...prev, ...fresh.map((note) => ({ note }))]);
    onImport(fresh);
    toast(
      fresh.length === 1 ? "Note added." : `${fresh.length} notes added.`,
      "success",
    );
    setInputValue("");
  }

  function removeTag(index: number) {
    setTags((prev) => prev.filter((_, i) => i !== index));
  }

  function handleFileRead(text: string) {
    const notes = parseNotesFromText(text);
    if (notes.length === 0) {
      toast("No valid notes found in that file.", "error");
      return;
    }
    const fresh = notes.filter((n) => !isDuplicate(n));
    const dupes = notes.length - fresh.length;
    setTags((prev) => [...prev, ...fresh.map((note) => ({ note }))]);
    if (fresh.length > 0) onImport(fresh);
    toast(
      [
        fresh.length > 0 && `${fresh.length} note${fresh.length > 1 ? "s" : ""} added`,
        dupes > 0 && `${dupes} already added`,
      ]
        .filter(Boolean)
        .join(", ") + ".",
      fresh.length > 0 ? "success" : "error",
    );
  }

  function handleFile(file: File) {
    if (!file.name.endsWith(".txt") && file.type !== "text/plain") {
      toast("Please select a .txt backup file.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => handleFileRead((e.target?.result as string) ?? "");
    reader.readAsText(file);
  }

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [disabled], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <Card
      className={dragging ? "border-brand-500/60 bg-brand-950/20" : ""}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <h3 className="text-sm font-medium text-zinc-400">{title}</h3>
      <p className="mt-1 text-xs text-zinc-500">
        Paste a <code className="text-zinc-400">dshield-v1-…</code> note and press{" "}
        <kbd className="rounded border border-zinc-700 px-1 text-[10px] text-zinc-400">Enter</kbd>{" "}
        to tag it. Add as many as you need, or upload a backup file.
      </p>

      {/* Tag input box */}
      <div
        className="mt-3 flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2 transition-colors focus-within:border-brand-500/50"
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag, i) => (
          <span
            key={tag.note.commitment}
            className="flex items-center gap-1 rounded-md border border-brand-500/30 bg-brand-950/40 px-2 py-0.5 font-mono text-[11px] text-brand-300"
          >
            {truncateMiddle(tag.note.commitment, 8, 6)}
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); removeTag(i); }}
              className="ml-0.5 text-brand-400/60 transition-colors hover:text-red-400 disabled:pointer-events-none"
              aria-label="Remove note"
            >
              ×
            </button>
          </span>
        ))}

        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
          placeholder={tags.length === 0 ? "dshield-v1-â€¦ (paste & Enter)" : "Add anotherâ€¦"}
          className="min-w-[200px] flex-1 bg-transparent font-mono text-xs text-zinc-300 outline-none placeholder-zinc-600 disabled:opacity-50"
        />
      </div>
      {/* File picker */}
      <input
        ref={fileRef}
        type="file"
        accept=".txt,text/plain"
        aria-label="Import notes from a text file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => fileRef.current?.click()}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-xs text-zinc-500 transition-colors hover:border-zinc-500 hover:text-zinc-300 disabled:pointer-events-none disabled:opacity-50"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        {dragging ? "Drop file here" : "Upload backup file (.txt)"}
      </button>
    </Card>
  );
}
