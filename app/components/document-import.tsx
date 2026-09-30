"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DOCUMENT_ACCEPT, documentFileError, documentMime, formatDocumentPages, type DocumentReference, type DocumentTranscript } from "@/lib/domain/document-import";
import { loadSourceDocument, saveSourceDocument } from "@/lib/document-storage";

export function DocumentPreview({ blob, name, page }: { blob: Blob; name: string; page?: number }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <div className="document-preview">
    {blob.type === "application/pdf"
      ? <iframe title={`Original document: ${name}`} src={`${url}#page=${page ?? 1}`} />
      // Blob URLs are local originals, not remote images needing optimization.
      // eslint-disable-next-line @next/next/no-img-element
      : <img src={url} alt={`Original document: ${name}`} />}
    <a href={url} download={name}>Download original</a>
  </div>;
}

function StoredDocument({ source }: { source: DocumentReference }) {
  const [blob, setBlob] = useState<Blob>();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadSourceDocument(source.id).then((file) => {
      if (!cancelled) { setBlob(file); setMissing(!file); }
    }).catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, [source.id]);
  return blob
    ? <DocumentPreview blob={blob} name={source.name} page={source.pages[0]} />
    : <p>{missing ? "The original file is only available in the browser where it was uploaded. The extracted source quote is still shown below." : "Loading original…"}</p>;
}

export function TaskDocumentSource({ source }: { source: DocumentReference }) {
  const [open, setOpen] = useState(false);
  return <details className="source-document" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Original: {source.name} · imported page{source.pages.length === 1 ? "" : "s"} {source.pages.join(", ")}</summary>
    {open && <StoredDocument key={source.id} source={source} />}
  </details>;
}

export function DocumentImport({ onReady, onBusy, onReset, disabled }: {
  onReady: (text: string, source: DocumentReference) => void;
  onBusy: (busy: boolean) => void;
  onReset: () => void;
  disabled: boolean;
}) {
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<DocumentTranscript>();
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const sourceId = useRef<string>("");
  const selectionVersion = useRef(0);
  useEffect(() => () => controller.current?.abort(), []);

  async function stageFile(chosen: Blob, suggestedName?: string) {
    if (busy || disabled) return;
    const version = ++selectionVersion.current;
    const preliminaryError = documentFileError({ name: suggestedName || "screenshot.png", size: chosen.size });
    if (preliminaryError) { setError(preliminaryError); return; }
    try {
    const bytes = new Uint8Array(await chosen.slice(0, 12).arrayBuffer());
    if (version !== selectionVersion.current) return;
    const mime = documentMime(bytes);
    if (!mime) { setError("The file contents are not a supported PDF or image."); return; }
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : "pdf";
    const name = suggestedName || `screenshot-${new Date().toISOString().replaceAll(":", "-")}.${extension}`;
    const candidate = new File([chosen], name, { type: mime });
    const invalid = documentFileError(candidate);
    if (invalid) { setError(invalid); return; }
    setFile(candidate);
    setResult(undefined); setSelected([]); setError(undefined);
    sourceId.current = crypto.randomUUID();
    onReset();
    } catch {
      if (version === selectionVersion.current) setError("This file could not be opened. Please choose it again.");
    }
  }

  async function read() {
    if (!file || busy) return;
    const requestController = new AbortController();
    controller.current = requestController;
    const timer = setTimeout(() => requestController.abort(), 70_000);
    setBusy(true); onBusy(true); setError(undefined);
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/api/import-document", { method: "POST", body: form, signal: requestController.signal });
      const body = await response.json() as DocumentTranscript & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not read this document.");
      const transcript = body as DocumentTranscript;
      await saveSourceDocument(sourceId.current, file);
      if (requestController.signal.aborted) return;
      setResult(transcript);
      setSelected(transcript.pages.map(({ page }) => page));
      onReady(formatDocumentPages(transcript.pages), { id: sourceId.current, name: file.name, pages: transcript.pages.map(({ page }) => page) });
    } catch (cause) {
      if (!requestController.signal.aborted) setError(cause instanceof Error ? cause.message : "Document reading failed.");
      else setError("Document reading was stopped. You can retry.");
    } finally {
      clearTimeout(timer); setBusy(false); onBusy(false);
    }
  }

  return <div className="document-import">
    <div className="file-drop" tabIndex={busy || disabled ? -1 : 0}
      role="group" aria-label="Screenshot and PDF upload area"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => {
        event.preventDefault();
        if (event.dataTransfer.files.length > 1) { setError("Choose one document at a time."); return; }
        const dropped = event.dataTransfer.files[0];
        if (dropped) void stageFile(dropped, dropped.name);
      }}
      onPaste={(event) => {
        const pasted = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"))?.getAsFile();
        if (pasted) { event.preventDefault(); void stageFile(pasted); }
      }}
    >
      <strong>Choose a screenshot or PDF</strong>
      <span>Focus this area and press Ctrl+V to paste a screenshot, or drop a file here.</span>
      <span>PDF, PNG, JPG, WebP · up to 5 MB · reads at most 10 pages</span>
      <input aria-label="Choose a screenshot or PDF" type="file" accept={DOCUMENT_ACCEPT} disabled={busy || disabled}
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (!chosen) return;
          void stageFile(chosen, chosen.name);
        }} />
    </div>
    {file && <>
      <p><strong>{file.name}</strong> · {(file.size / 1024).toFixed(0)} KB</p>
      <DocumentPreview blob={file} name={file.name} />
      <button className="button button-secondary button-md" type="button" onClick={read} disabled={busy || disabled}>
        {busy ? "Reading document…" : result ? "Read again" : "Read document"}
      </button>
      {busy && <button type="button" onClick={() => controller.current?.abort()}>Cancel reading</button>}
      <p className="document-help">Reading sends this file to OpenAI. The original is stored in this browser for review. Check the transcript below before interpreting tasks.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    {result && <>
      {result.warnings.map((warning, index) => <p role="note" key={index}>{warning}</p>)}
      <fieldset disabled={busy || disabled} className="document-pages">
        <legend>Pages to import</legend>
        {result.pages.map(({ page }) => <label key={page}>
          <input type="checkbox" checked={selected.includes(page)} disabled={selected.length === 1 && selected.includes(page)} onChange={(event) => {
            const next = event.target.checked ? [...selected, page].sort((a, b) => a - b) : selected.filter((item) => item !== page);
            setSelected(next);
            const pages = result.pages.filter((item) => next.includes(item.page));
            onReady(formatDocumentPages(pages), { id: sourceId.current, name: file!.name, pages: next });
          }} /> Page {page}
        </label>)}
      </fieldset>
      <small>Changing page selection replaces the transcript. Select a shorter section if it exceeds the import limit.</small>
    </>}
  </div>;
}
