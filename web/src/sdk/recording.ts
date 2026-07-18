// Recording — the gameplay half of Motion's co-op replay.
//
// Division of labor (see protocol.ts "Recording" section): the PHONE records
// its own camera locally and composites picture-in-picture offline; the BROWSER
// records only the game canvas and ships the finished clip to the phone. This
// module owns exactly that browser job. It is fully game-agnostic — it knows a
// canvas and a Room, nothing about any particular game.
//
// CRITICAL codec note: iOS AVFoundation cannot decode WebM/VP8/VP9. For the
// phone to composite the two clips into one MP4, the gameplay clip must be
// H.264/MP4. We probe `MediaRecorder.isTypeSupported` and prefer MP4; if only
// WebM is available we still transfer (the phone falls back to saving two
// separate clips) but warn loudly so the caveat is visible.

import type { Room } from "./room";
import type {
  RecControlMessage,
  RecMetaMessage,
  RecChunkMessage,
} from "../../../protocol/protocol";

/** Probe order: MP4/H.264 first (phone can composite), WebM only as a fallback. */
const MIME_CANDIDATES = [
  "video/mp4;codecs=h264",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm",
] as const;

/** Raw byte payload per RecChunkMessage before base64 (base64 inflates ~4/3). */
const CHUNK_BYTES = 500 * 1024; // 500KB raw → ~667KB base64, under the ~700KB cap
/** Await a tick of the microtask/socket buffer between chunk sends. */
const SEND_GAP_MS = 8;
/** If the socket send buffer climbs past this, pause before queuing more. */
const BUFFER_HIGH_WATER = 1_000_000; // 1MB

export type RecordingPhase =
  | "idle"
  | "recording"
  | "transferring"
  | "done"
  | "error";

/** Pick the best supported recording mime, or null if none work. */
export function pickRecordingMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // isTypeSupported can throw on some engines; treat as unsupported.
    }
  }
  return null;
}

/** True if the chosen mime is an MP4 the phone can composite on-device. */
export function isCompositable(mime: string | null): boolean {
  return !!mime && mime.startsWith("video/mp4");
}

export interface RecorderOptions {
  /** Where control/meta/chunk messages go. */
  room: Room;
  /** The game canvas to capture. */
  canvas: HTMLCanvasElement;
  /** Called on any phase change (drives UI/diagnostics). */
  onPhase?: (phase: RecordingPhase, detail?: string) => void;
  /** Frames per second for the captured stream. */
  fps?: number;
}

/**
 * Records the game canvas for one session and transfers it to the phone.
 *
 * Lifecycle, driven by the GameHost:
 *   start()  → mint sessionId, anchor wall-clock, send `rec {start}`, begin
 *              MediaRecorder, track `startOffsetMs` (anchor → first frame).
 *   stop()   → stop recorder, assemble the Blob, send `rec {stop}`, then
 *              `recmeta`, then base64 `recchunk`s (chunked + backpressured).
 *   cancel() → tear down without transferring.
 *
 * When no controller peer is connected (debug/no-phone), stop() still assembles
 * the clip and — via `downloadUrl` — offers a browser-side download so it's
 * testable without a phone.
 */
export class CanvasRecorder {
  private room: Room;
  private canvas: HTMLCanvasElement;
  private onPhase: (phase: RecordingPhase, detail?: string) => void;
  private fps: number;

  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private mime: string | null = null;

  private sessionId = "";
  private anchorMs = 0;
  private startWallMs = 0;
  private startOffsetMs = 0;
  private firstFrameSeen = false;

  phase: RecordingPhase = "idle";
  /** Object URL for the last finished clip (debug/no-phone download), or null. */
  downloadUrl: string | null = null;
  /** The mime chosen at last start (for diagnostics). */
  lastMime: string | null = null;
  /** True if last start's mime cannot be composited by the phone (WebM). */
  needsMp4Warning = false;

  constructor(opts: RecorderOptions) {
    this.room = opts.room;
    this.canvas = opts.canvas;
    this.onPhase = opts.onPhase ?? (() => {});
    this.fps = opts.fps ?? 30;
  }

  /** True if the environment can record at all. */
  static get supported(): boolean {
    return typeof MediaRecorder !== "undefined" && pickRecordingMime() !== null;
  }

  private setPhase(p: RecordingPhase, detail?: string): void {
    this.phase = p;
    this.onPhase(p, detail);
  }

  /** Begin recording the canvas for a fresh session. Returns the sessionId. */
  start(): string | null {
    if (this.phase === "recording" || this.phase === "transferring") {
      return this.sessionId;
    }
    this.revokeUrl();

    const mime = pickRecordingMime();
    this.mime = mime;
    this.lastMime = mime;
    if (!mime) {
      this.setPhase("error", "MediaRecorder unsupported in this browser");
      return null;
    }

    this.needsMp4Warning = !isCompositable(mime);
    if (this.needsMp4Warning) {
      console.warn(
        `[motion] Recording as ${mime} — iOS cannot composite WebM. ` +
          `Use a browser with MP4/H.264 MediaRecorder support for on-device ` +
          `picture-in-picture; otherwise the phone saves two separate clips.`,
      );
    }

    let stream: MediaStream;
    try {
      stream = this.canvas.captureStream(this.fps);
    } catch (err) {
      this.setPhase("error", `captureStream failed: ${String(err)}`);
      return null;
    }
    this.stream = stream;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch (err) {
      this.setPhase("error", `MediaRecorder init failed: ${String(err)}`);
      return null;
    }
    this.recorder = recorder;
    this.chunks = [];
    this.firstFrameSeen = false;

    this.sessionId = crypto.randomUUID();
    this.anchorMs = Date.now();
    this.startWallMs = 0;
    this.startOffsetMs = 0;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) {
        if (!this.firstFrameSeen) {
          this.firstFrameSeen = true;
          // First data marks the first recorded frame → offset from anchor.
          this.startOffsetMs = Math.max(0, Date.now() - this.anchorMs);
        }
        this.chunks.push(e.data);
      }
    };

    // Announce to the controller so both recorders bracket the same session.
    const ctrl: RecControlMessage = {
      v: 1,
      type: "rec",
      action: "start",
      sessionId: this.sessionId,
      anchorMs: this.anchorMs,
    };
    this.room.sendRec(ctrl);

    // Timeslice so `dataavailable` fires periodically and offset is captured
    // near the true start even if the game runs long.
    recorder.start(1000);
    this.startWallMs = Date.now();
    // Fallback: if no data fires before stop, offset ≈ 0 (recorder.start ~= now).
    this.startOffsetMs = Math.max(0, this.startWallMs - this.anchorMs);
    this.setPhase("recording", mime);
    return this.sessionId;
  }

  /**
   * Stop recording and transfer the clip. Resolves when transfer completes (or
   * when the browser-side download is ready if no peer is connected).
   */
  async stop(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || this.phase !== "recording") return;

    const durationMs = Math.max(0, Date.now() - this.startWallMs);
    const blob = await this.finalizeBlob(recorder);
    this.teardownStream();

    const mime = this.mime ?? "video/webm";

    // Tell the controller to stop its own recorder.
    const stopMsg: RecControlMessage = {
      v: 1,
      type: "rec",
      action: "stop",
      sessionId: this.sessionId,
      anchorMs: Date.now(),
    };
    this.room.sendRec(stopMsg);

    // Always offer a browser-side download (essential for no-phone testing).
    this.downloadUrl = URL.createObjectURL(blob);

    if (!this.room.peerConnected) {
      this.setPhase(
        "done",
        `No phone connected — clip available as browser download (${mime}).`,
      );
      return;
    }

    await this.transfer(blob, mime, durationMs);
  }

  /** Cancel the current recording without transferring anything. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.teardownStream();
    if (this.sessionId) {
      const msg: RecControlMessage = {
        v: 1,
        type: "rec",
        action: "cancel",
        sessionId: this.sessionId,
        anchorMs: Date.now(),
      };
      this.room.sendRec(msg);
    }
    this.recorder = null;
    this.chunks = [];
    this.setPhase("idle");
  }

  /** Free the last download URL. Call on dispose or before a new recording. */
  revokeUrl(): void {
    if (this.downloadUrl) {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
  }

  dispose(): void {
    this.cancel();
    this.revokeUrl();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private finalizeBlob(recorder: MediaRecorder): Promise<Blob> {
    return new Promise((resolve) => {
      const done = () => {
        const type = this.mime ?? "video/webm";
        resolve(new Blob(this.chunks, { type }));
      };
      recorder.onstop = done;
      if (recorder.state === "inactive") {
        done();
      } else {
        try {
          recorder.stop();
        } catch {
          done();
        }
      }
    });
  }

  private teardownStream(): void {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  /** Send recmeta + base64 recchunks, chunked and backpressure-aware. */
  private async transfer(
    blob: Blob,
    mime: string,
    durationMs: number,
  ): Promise<void> {
    this.setPhase("transferring");

    const buf = new Uint8Array(await blob.arrayBuffer());
    const totalBytes = buf.byteLength;
    const chunkCount = Math.max(1, Math.ceil(totalBytes / CHUNK_BYTES));

    const meta: RecMetaMessage = {
      v: 1,
      type: "recmeta",
      sessionId: this.sessionId,
      mime,
      totalBytes,
      chunks: chunkCount,
      durationMs,
      startOffsetMs: this.startOffsetMs,
    };
    this.room.sendRec(meta);

    for (let i = 0; i < chunkCount; i++) {
      if (!this.room.isOpen) {
        this.setPhase("error", "Socket closed mid-transfer");
        return;
      }
      const start = i * CHUNK_BYTES;
      const end = Math.min(totalBytes, start + CHUNK_BYTES);
      const slice = buf.subarray(start, end);
      const data = base64FromBytes(slice);
      const chunk: RecChunkMessage = {
        v: 1,
        type: "recchunk",
        sessionId: this.sessionId,
        i,
        data,
      };
      this.room.sendRec(chunk);

      // Respect socket backpressure: drain before piling on more.
      await drainBuffer(this.room);
      await sleep(SEND_GAP_MS);
    }

    this.setPhase("done", `Transferred ${chunkCount} chunk(s), ${totalBytes}B`);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Base64-encode raw bytes without blowing the call stack on large slices. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000; // 32KB windows keep String.fromCharCode arg count sane
  for (let i = 0; i < bytes.length; i += step) {
    const sub = bytes.subarray(i, Math.min(bytes.length, i + step));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for the socket send buffer to fall below the high-water mark. */
async function drainBuffer(room: Room): Promise<void> {
  let guard = 0;
  while (room.isOpen && room.bufferedAmount > BUFFER_HIGH_WATER && guard < 200) {
    await sleep(16);
    guard++;
  }
}
