import { afterEach, describe, expect, it, vi } from "vitest";

import { CanvasRecorder, pickRecordingMime } from "./recording";
import type { Room } from "./room";

function capture() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { tracks, stream };
}

class FakeRecorder {
  static isTypeSupported = (mime: string) => mime === "video/mp4";
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["game frames"]) });
    this.onstop?.();
  }
}

function fixture(captureStream = vi.fn()) {
  const room = { sendRec: vi.fn(), peerConnected: false };
  const onPhase = vi.fn();
  const recorder = new CanvasRecorder({
    canvas: { captureStream } as unknown as HTMLCanvasElement,
    room: room as unknown as Room,
    onPhase,
  });
  return { recorder, room, onPhase, captureStream };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canvas recording resources", () => {
  it("stops every captured track when construction fails, then permits a clean retry", () => {
    const first = capture();
    const retry = capture();
    const captureStream = vi
      .fn()
      .mockReturnValueOnce(first.stream)
      .mockReturnValueOnce(retry.stream);
    const { recorder, room, onPhase } = fixture(captureStream);
    class UnavailableRecorder extends FakeRecorder {
      constructor() {
        super();
        throw new Error("encoder unavailable");
      }
    }
    vi.stubGlobal("MediaRecorder", UnavailableRecorder);

    expect(recorder.start()).toBeNull();
    expect(onPhase).toHaveBeenLastCalledWith(
      "error",
      "MediaRecorder init failed: Error: encoder unavailable"
    );
    expect(room.sendRec).not.toHaveBeenCalled();
    for (const track of first.tracks) expect(track.stop).toHaveBeenCalledOnce();

    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const sessionId = recorder.start();
    expect(sessionId).toEqual(expect.any(String));
    expect(recorder.phase).toBe("recording");
    expect(captureStream).toHaveBeenNthCalledWith(2, 30);
    expect(room.sendRec).toHaveBeenCalledWith(
      expect.objectContaining({ action: "start", sessionId })
    );
    recorder.cancel();
    for (const track of [...first.tracks, ...retry.tracks])
      expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder.phase).toBe("idle");
  });

  it("stops tracks after a successful local recording and releases its download on dispose", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { stream, tracks } = capture();
    const { recorder, room } = fixture(vi.fn().mockReturnValue(stream));
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:owned-game");
    const revokeUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const sessionId = recorder.start();
    await recorder.stop();

    expect(recorder.phase).toBe("done");
    expect(createUrl.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(createUrl.mock.calls[0]?.[0]).toHaveProperty("type", "video/mp4");
    expect(room.sendRec.mock.calls.map(([message]) => message.action)).toEqual([
      "start",
      "stop",
    ]);
    expect(room.sendRec).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId, action: "stop" })
    );
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    recorder.dispose();
    expect(revokeUrl).toHaveBeenCalledWith("blob:owned-game");
    expect(recorder.downloadUrl).toBeNull();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("does not capture a stream when the browser has no recording support", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const { recorder, captureStream } = fixture();
    expect(pickRecordingMime()).toBeNull();
    expect(recorder.start()).toBeNull();
    expect(captureStream).not.toHaveBeenCalled();
    expect(recorder.phase).toBe("error");
  });
});
