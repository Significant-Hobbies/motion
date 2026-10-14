import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebcamController } from "./webcam";

const mp = vi.hoisted(() => ({ fileset: vi.fn(), create: vi.fn() }));
vi.mock(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm",
  () => ({
    FilesetResolver: { forVisionTasks: mp.fileset },
    HandLandmarker: { createFromOptions: mp.create },
  })
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("webcam orchestration with local media doubles", () => {
  let controller: WebcamController | undefined;
  let children: Set<object>;
  let status: {
    textContent: string;
    style: Record<string, string>;
    remove: () => void;
  };
  let video: {
    style: Record<string, string>;
    currentTime: number;
    readyState: number;
    srcObject: unknown;
    play: ReturnType<typeof vi.fn>;
    remove: () => void;
  };
  let tracks: { stop: ReturnType<typeof vi.fn> }[];
  let stream: MediaStream;
  let getMedia: ReturnType<typeof vi.fn>;
  let model: {
    detectForVideo: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  async function settle() {
    await vi.dynamicImportSettled();
  }

  beforeEach(() => {
    children = new Set();
    status = {
      textContent: "",
      style: {},
      remove: () => children.delete(status),
    };
    video = {
      style: {},
      currentTime: 0,
      readyState: 2,
      srcObject: null,
      play: vi.fn().mockResolvedValue(undefined),
      remove: () => children.delete(video),
    };
    tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    stream = { getTracks: () => tracks } as unknown as MediaStream;
    getMedia = vi.fn().mockResolvedValue(stream);
    model = {
      detectForVideo: vi.fn().mockReturnValue({ landmarks: [] }),
      close: vi.fn(),
    };
    mp.fileset.mockResolvedValue({ fixture: true });
    mp.create.mockResolvedValue(model);
    vi.stubGlobal("document", {
      createElement: (tag: string) => (tag === "video" ? video : status),
      body: { appendChild: (element: object) => children.add(element) },
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: getMedia } });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    controller?.dispose();
    controller = undefined;
    expect(children.size).toBe(0);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mp.fileset.mockReset();
    mp.create.mockReset();
  });

  it("falls back to CPU, gates fresh frames, keeps hand assignment stable and ages out dropped detection", async () => {
    mp.create
      .mockRejectedValueOnce(new Error("no GPU"))
      .mockResolvedValueOnce(model);
    controller = new WebcamController();
    await settle();
    expect(
      mp.create.mock.calls.map(([, options]) => options.baseOptions.delegate)
    ).toEqual(["GPU", "CPU"]);
    expect(getMedia).toHaveBeenCalledExactlyOnceWith({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
      audio: false,
    });
    expect(video).toMatchObject({
      muted: true,
      playsInline: true,
      srcObject: stream,
    });
    expect(children.has(video)).toBe(true);
    expect(status.style.display).toBe("none");
    const hand = (x: number) =>
      Array.from({ length: 21 }, (_, i) => ({
        x,
        y: i === 0 ? 0.6 : 0.45,
        z: 0,
      }));
    const left = hand(0.7),
      right = hand(0.3);
    model.detectForVideo.mockReturnValue({ landmarks: [left, right] });
    controller.tick(0);
    expect(controller.joints.leftHand[0]).toBeCloseTo(0.15);
    expect(controller.joints.rightHand[0]).toBeCloseTo(0.85);
    expect(controller.leftFingertip?.[0]).toBeCloseTo(0.15);
    expect(controller.leftHandOpen).toBe(0.5);
    expect(controller.health).toBe("ok");
    controller.tick(20); // Same camera frame: no duplicate inference.
    video.currentTime = 1;
    controller.tick(10); // A fresh frame still observes the minimum interval.
    expect(model.detectForVideo).toHaveBeenCalledOnce();
    model.detectForVideo.mockReturnValue({ landmarks: [right, left] });
    controller.tick(20);
    expect(controller.joints.leftHand[0]).toBeCloseTo(0.15);
    expect(controller.joints.rightHand[0]).toBeCloseTo(0.85);
    model.detectForVideo.mockImplementation(() => {
      throw new Error("dropped frame");
    });
    video.currentTime = 2;
    controller.tick(40);
    expect(controller.health).toBe("ok");
    controller.tick(270);
    expect(controller.leftHandActive).toBe(false);
    expect(controller.rightHandActive).toBe(false);
    controller.tick(321);
    expect(controller.health).toBe("stale");
    expect(controller.hasRequiredJoints).toBe(false);
    controller.dispose();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(model.close).toHaveBeenCalledOnce();
    const detections = model.detectForVideo.mock.calls.length;
    controller.tick(400);
    expect(model.detectForVideo).toHaveBeenCalledTimes(detections);
  });

  it.each(["model", "permission", "play"])(
    "releases acquired resources on %s failure without installing a preview",
    async (phase) => {
      if (phase === "model")
        mp.create.mockRejectedValue(new Error("model unavailable"));
      if (phase === "permission")
        getMedia.mockRejectedValue(new Error("permission denied"));
      if (phase === "play")
        video.play.mockRejectedValue(new Error("play rejected"));
      controller = new WebcamController();
      await settle();
      expect(status.textContent).toContain("Camera unavailable:");
      expect(children.has(video)).toBe(false);
      expect(model.close).toHaveBeenCalledTimes(phase === "model" ? 0 : 1);
      for (const track of tracks)
        expect(track.stop).toHaveBeenCalledTimes(phase === "play" ? 1 : 0);
      controller.tick(1000);
      expect(controller.health).toBe("no_signal");
      expect(model.detectForVideo).not.toHaveBeenCalled();
    }
  );

  it.each(["import", "fileset", "model", "media", "play"])(
    "cancels a pending %s stage and disposes late resources exactly once",
    async (phase) => {
      const gate = deferred<unknown>();
      if (phase === "fileset") mp.fileset.mockReturnValue(gate.promise);
      if (phase === "model") mp.create.mockReturnValue(gate.promise);
      if (phase === "media") getMedia.mockReturnValue(gate.promise);
      if (phase === "play") video.play.mockReturnValue(gate.promise);
      controller = new WebcamController();
      if (phase !== "import") await settle();
      controller.dispose();
      gate.resolve(
        phase === "fileset"
          ? {}
          : phase === "model"
            ? model
            : phase === "media"
              ? stream
              : undefined
      );
      await settle();
      expect(children.size).toBe(0);
      if (phase === "import" || phase === "fileset")
        expect(mp.create).not.toHaveBeenCalled();
      if (phase === "import" || phase === "fileset" || phase === "model")
        expect(getMedia).not.toHaveBeenCalled();
      expect(model.close).toHaveBeenCalledTimes(
        phase === "import" || phase === "fileset" ? 0 : 1
      );
      for (const track of tracks)
        expect(track.stop).toHaveBeenCalledTimes(
          phase === "media" || phase === "play" ? 1 : 0
        );
      controller.dispose();
      expect(model.close).toHaveBeenCalledTimes(
        phase === "import" || phase === "fileset" ? 0 : 1
      );
      controller.tick(1000);
      expect(model.detectForVideo).not.toHaveBeenCalled();
    }
  );
});
