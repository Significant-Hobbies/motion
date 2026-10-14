import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../sdk", () => ({ createSession: sdk.create }));

describe("app bootstrap and recording UI lifecycle", () => {
  let nodes: Map<string, ElementDouble>;
  let overlay: ElementDouble;
  let session: {
    on: ReturnType<typeof vi.fn>;
    lastClipUrl: string | null;
    recorderNeedsMp4Warning: boolean;
    controller: object;
  };
  let win: {
    motion?: { session: object; controller: object };
    webkit?: object;
  };
  let recordEvent: (phase: string) => void;

  class ElementDouble {
    id = "";
    href = "";
    download = "";
    textContent = "";
    style = {};
    readonly children = new Set<ElementDouble>();
    appendChild(child: ElementDouble) {
      this.children.add(child);
      nodes.set(child.id, child);
    }
    remove() {
      overlay.children.delete(this);
      nodes.delete(this.id);
    }
  }

  beforeEach(() => {
    vi.resetModules();
    nodes = new Map();
    overlay = new ElementDouble();
    nodes.set("overlay", overlay);
    nodes.set("game-canvas", new ElementDouble());
    win = {};
    vi.stubGlobal("window", win);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", {
      getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => new ElementDouble(),
    });
    vi.stubEnv("VITE_PARTY_HOST", undefined);
    session = {
      controller: {},
      lastClipUrl: null,
      recorderNeedsMp4Warning: false,
      on: vi.fn((event, callback) => {
        expect(event).toBe("recording");
        recordEvent = callback;
      }),
    };
    sdk.create.mockReset().mockReturnValue(session);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ["", false, "reach-dodge", false, "socket"],
    ["?transport=bridge", false, "slice", true, "bridge"],
    ["?game=motion-maker", false, "motion-maker", true, "socket"],
    ["?game=reach-dodge&camera=1", false, "reach-dodge", true, "socket"],
    ["?game=unknown&room=motion", false, "slice", true, "socket"],
    ["?transport=unknown", true, "slice", true, "bridge"],
    ["?transport=socket&game=slice", true, "slice", true, "socket"],
  ])(
    "selects the documented game/transport for %s (native=%s)",
    async (search, native, id, skipReadiness, transport) => {
      vi.stubGlobal("location", { search });
      if (native)
        win.webkit = { messageHandlers: { motion: { postMessage: vi.fn() } } };
      await import("./main");
      expect(sdk.create).toHaveBeenCalledOnce();
      const args = sdk.create.mock.calls[0]![0];
      expect(args.game.id).toBe(id);
      expect(args.mount).toEqual({ canvas: nodes.get("game-canvas"), overlay });
      expect(args.options).toMatchObject({
        transport,
        skipReadiness,
        camera: search.includes("camera=1"),
        partyHost: "http://127.0.0.1:1999",
      });
      expect(session.on).toHaveBeenCalledOnce();
      expect(win.motion?.session).toBe(session);
      const nextController = {};
      session.controller = nextController;
      expect(win.motion?.controller).toBe(nextController);
    }
  );

  it("honors explicit config over environment and only enables opt-in flags", async () => {
    vi.stubEnv("VITE_PARTY_HOST", "https://env.invalid");
    vi.stubGlobal("location", {
      search:
        "?room=abc123&server=https%3A%2F%2Foverride.invalid&debug=1&record=1",
    });
    await import("./main");
    expect(sdk.create.mock.calls[0]![0].options).toMatchObject({
      partyHost: "https://override.invalid",
      forcedRoom: "ABC123",
      debug: true,
      record: true,
      camera: false,
    });
  });

  it("uses the configured environment host without interpreting other flag values as opt-in", async () => {
    vi.stubEnv("VITE_PARTY_HOST", "https://env.invalid");
    vi.stubGlobal("location", {
      search: "?debug=true&record=0&camera=false&room=",
    });
    await import("./main");
    expect(sdk.create.mock.calls[0]![0].options).toEqual({
      partyHost: "https://env.invalid",
      transport: "socket",
      debug: false,
      record: false,
      camera: false,
      skipReadiness: false,
    });
  });

  it("replaces the owned download link only for completed clips and preserves the correct codec extension", async () => {
    await import("./main");
    recordEvent("done");
    expect(overlay.children.size).toBe(0);
    session.lastClipUrl = "blob:first";
    recordEvent("error");
    recordEvent("transferring");
    expect(overlay.children.size).toBe(0);
    recordEvent("done");
    const first = nodes.get("clip-download")!;
    expect(first).toMatchObject({
      href: "blob:first",
      download: "motion-clip.mp4",
      textContent: "⬇ Download gameplay clip",
    });
    session.lastClipUrl = "blob:second";
    session.recorderNeedsMp4Warning = true;
    recordEvent("done");
    expect(overlay.children.size).toBe(1);
    expect(overlay.children.has(first)).toBe(false);
    expect(nodes.get("clip-download")).toMatchObject({
      href: "blob:second",
      download: "motion-clip.webm",
    });
    expect(nodes.get("clip-download")!.textContent).toContain(
      "MP4 needed for device compositing"
    );
  });

  it("does not publish a debug session or subscribe to recording when session construction fails", async () => {
    sdk.create.mockImplementationOnce(() => {
      throw new Error("canvas unavailable");
    });
    await expect(import("./main")).rejects.toThrow("canvas unavailable");
    expect(win.motion).toBeUndefined();
    expect(session.on).not.toHaveBeenCalled();
    expect(overlay.children.size).toBe(0);
  });
});
