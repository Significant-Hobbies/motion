import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Joints, PosePacket } from "../../../protocol/protocol";
import {
  BridgeController,
  type BridgeHostCallbacks,
  hasNativeBridge,
  type MotionNativeApi,
  NativeBridge,
} from "./bridge";

const joints: Joints = {
  head: [0.5, 0.2],
  leftHand: [0.3, 0.5],
  rightHand: [0.7, 0.5],
  torso: [0.5, 0.5],
  leftKnee: [0.4, 0.7],
  rightKnee: [0.6, 0.7],
  leftFoot: [0.4, 0.9],
  rightFoot: [0.6, 0.9],
};

function packet(seq: number): PosePacket {
  return { v: 1, type: "pose", seq, sentAt: 0, quality: 0.9, joints };
}

type FakeWindow = {
  webkit?: { messageHandlers?: { motion?: { postMessage(m: unknown): void } } };
  __motion?: MotionNativeApi;
};

function callbacks(): BridgeHostCallbacks {
  return {
    onStart: vi.fn(),
    onStop: vi.fn(),
    onCalibrated: vi.fn(),
    onTracking: vi.fn(),
  };
}

describe("BridgeController", () => {
  it("reuses pose smoothing and lets native force a tracking loss", () => {
    const controller = new BridgeController();
    controller.pushPose(packet(1));
    controller.tick(10);
    expect(controller.health).toBe("ok");

    controller.setTracking("lost");
    controller.tick(20);
    expect(controller.health).toBe("stale");

    // A fresh frame clears the native loss flag.
    controller.pushPose(packet(2));
    controller.tick(30);
    expect(controller.health).toBe("ok");
  });
});

describe("NativeBridge", () => {
  let win: FakeWindow;

  beforeEach(() => {
    win = {};
    vi.stubGlobal("window", win);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects the WKWebView message handler", () => {
    expect(hasNativeBridge()).toBe(false);
    win.webkit = { messageHandlers: { motion: { postMessage: vi.fn() } } };
    expect(hasNativeBridge()).toBe(true);
  });

  it("installs window.__motion and routes native calls to the host", () => {
    const controller = new BridgeController();
    const host = callbacks();
    const bridge = new NativeBridge(controller, host);
    const api = win.__motion;
    if (!api) throw new Error("bridge did not install window.__motion");

    api.start();
    api.stop();
    api.calibrated();
    api.setTracking("too_far");
    expect(host.onStart).toHaveBeenCalledOnce();
    expect(host.onStop).toHaveBeenCalledOnce();
    expect(host.onCalibrated).toHaveBeenCalledOnce();
    expect(host.onTracking).toHaveBeenCalledWith("too_far");

    bridge.dispose();
    expect(win.__motion).toBeUndefined();
  });

  it("accepts pose frames as objects or JSON and drops junk", () => {
    const controller = new BridgeController();
    const ingest = vi.spyOn(controller, "pushPose");
    const bridge = new NativeBridge(controller, callbacks());
    const api = win.__motion as MotionNativeApi;

    api.pushPose(packet(1));
    api.pushPose(JSON.stringify(packet(2)));
    api.pushPose("{not json");
    api.pushPose(JSON.stringify({ type: "status" }));

    expect(ingest.mock.calls.map(([p]) => p.seq)).toEqual([1, 2]);
    bridge.dispose();
  });

  it("emits lifecycle events only when a native host is present", () => {
    const bridge = new NativeBridge(new BridgeController(), callbacks());
    expect(() => bridge.emit({ event: "ready" })).not.toThrow();

    const postMessage = vi.fn();
    win.webkit = { messageHandlers: { motion: { postMessage } } };
    bridge.emit({ event: "score", value: 7 });
    expect(postMessage).toHaveBeenCalledWith({ event: "score", value: 7 });
  });
});
