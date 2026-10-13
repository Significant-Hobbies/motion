import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasRecorder } from "./recording";
import type { Room } from "./room";
import type {
  RecChunkMessage,
  RecControlMessage,
  RecMetaMessage,
} from "../../../protocol/protocol";

type RecordingMessage = RecControlMessage | RecMetaMessage | RecChunkMessage;

function fixture(bytes: Uint8Array) {
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
  class RecorderDouble {
    static isTypeSupported = (mime: string) => mime === "video/mp4";
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", RecorderDouble);
  const messages: RecordingMessage[] = [];
  const room = {
    peerConnected: true,
    isOpen: true,
    bufferedAmount: 0,
    sendRec: (message: RecordingMessage) => messages.push(message),
  };
  const captureStream = vi.fn(() => stream);
  const onPhase = vi.fn();
  const recorder = new CanvasRecorder({
    room: room as unknown as Room,
    canvas: { captureStream } as unknown as HTMLCanvasElement,
    onPhase,
  });
  return { recorder, room, messages, stopTrack, captureStream, onPhase };
}

describe("recording transfer boundaries", () => {
  let recorder: CanvasRecorder | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:transfer-fixture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    recorder?.dispose();
    recorder = undefined;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reconstructs a multi-chunk clip exactly and waits for backpressure before the next chunk", async () => {
    const bytes = Uint8Array.from(
      { length: 500 * 1024 + 3 },
      (_, i) => i % 256
    );
    const f = fixture(bytes);
    recorder = f.recorder;
    const sessionId = recorder.start();
    expect(recorder.start()).toBe(sessionId);
    expect(f.captureStream).toHaveBeenCalledOnce();
    vi.setSystemTime(12_000);
    f.room.bufferedAmount = 1_000_001;
    const stopped = recorder.stop();
    // Blob conversion uses a promise; advance only the first polling interval.
    await vi.advanceTimersByTimeAsync(16);
    expect(recorder.phase).toBe("transferring");
    expect(recorder.start()).toBe(sessionId);
    expect(f.captureStream).toHaveBeenCalledOnce();
    expect(f.messages.map((message) => message.type)).toEqual([
      "rec",
      "rec",
      "recmeta",
      "recchunk",
    ]);
    expect(f.messages[2]).toEqual({
      v: 1,
      type: "recmeta",
      sessionId,
      mime: "video/mp4",
      totalBytes: bytes.length,
      chunks: 2,
      durationMs: 2000,
      startOffsetMs: 2000,
    });
    expect(f.stopTrack).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(160);
    expect(f.messages).toHaveLength(4);
    f.room.bufferedAmount = 1_000_000;
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(7);
    expect(f.messages).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.messages).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(8);
    await stopped;

    const chunks = f.messages.filter(
      (message): message is RecChunkMessage => message.type === "recchunk"
    );
    expect(chunks.map(({ i, sessionId: id }) => [i, id])).toEqual([
      [0, sessionId],
      [1, sessionId],
    ]);
    const decoded = chunks.map(({ data }) =>
      Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    );
    expect(decoded.map((chunk) => chunk.length)).toEqual([500 * 1024, 3]);
    expect(new Uint8Array([...decoded[0]!, ...decoded[1]!])).toEqual(bytes);
    expect(recorder.phase).toBe("done");
    expect(f.onPhase).toHaveBeenLastCalledWith(
      "done",
      "Transferred 2 chunk(s), 512003B"
    );
  });

  it("reports a disconnect during draining and does not send the remaining chunk", async () => {
    const f = fixture(new Uint8Array(500 * 1024 + 1));
    recorder = f.recorder;
    recorder.start();
    f.room.bufferedAmount = 1_000_001;
    const stopped = recorder.stop();
    await vi.advanceTimersByTimeAsync(16);
    expect(
      f.messages.filter((message) => message.type === "recchunk")
    ).toHaveLength(1);
    f.room.isOpen = false;
    await vi.advanceTimersByTimeAsync(24);
    await stopped;
    expect(f.onPhase).toHaveBeenLastCalledWith(
      "error",
      "Socket closed mid-transfer"
    );
    expect(
      f.messages.filter((message) => message.type === "recchunk")
    ).toHaveLength(1);
    expect(recorder.downloadUrl).toBe("blob:transfer-fixture");
    expect(f.stopTrack).toHaveBeenCalledOnce();
  });

  it("bounds high-water waiting to 200 polls and transfers an empty clip as one empty chunk", async () => {
    const f = fixture(new Uint8Array());
    recorder = f.recorder;
    const sessionId = recorder.start();
    f.room.bufferedAmount = 1_000_001;
    const stopped = recorder.stop();
    await vi.advanceTimersByTimeAsync(3199);
    expect(recorder.phase).toBe("transferring");
    await vi.advanceTimersByTimeAsync(9);
    await stopped;
    expect(f.messages[2]).toMatchObject({
      totalBytes: 0,
      chunks: 1,
      startOffsetMs: 0,
    });
    expect(f.messages[3]).toEqual({
      v: 1,
      type: "recchunk",
      sessionId,
      i: 0,
      data: "",
    });
    expect(f.onPhase).toHaveBeenLastCalledWith(
      "done",
      "Transferred 1 chunk(s), 0B"
    );
    expect(f.stopTrack).toHaveBeenCalledOnce();
  });
});
