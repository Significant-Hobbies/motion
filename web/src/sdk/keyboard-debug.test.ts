import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeyboardDebugController } from "./keyboard-debug";

/** A 200×100 target at (0, 0); Node's EventTarget delivers the synthetic events. */
class FakeTarget extends EventTarget {
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 200, height: 100 };
  }
}

function event<T extends object>(type: string, fields: T): Event & T {
  return Object.assign(new Event(type), fields);
}

function settle(controller: KeyboardDebugController, frames = 120): void {
  for (let f = 1; f <= frames; f++) controller.tick(f * 16);
}

describe("KeyboardDebugController", () => {
  let target: FakeTarget;
  let win: EventTarget;
  let controller: KeyboardDebugController;

  beforeEach(() => {
    target = new FakeTarget();
    win = new EventTarget();
    vi.stubGlobal("window", win);
    controller = new KeyboardDebugController(target as unknown as HTMLElement);
  });

  afterEach(() => {
    controller.dispose();
    vi.unstubAllGlobals();
  });

  it("reports no signal until the pointer moves", () => {
    settle(controller, 2);
    expect(controller.health).toBe("no_signal");
    expect(controller.hasRequiredJoints).toBe(false);
    expect(controller.leftFingertip).toBeUndefined();

    target.dispatchEvent(event("mousemove", { clientX: 100, clientY: 50 }));
    settle(controller, 2);
    expect(controller.health).toBe("ok");
    expect(controller.hasRequiredJoints).toBe(true);
    expect(controller.trackingQuality).toBe(1);
  });

  it("mirrors both hands around the cursor", () => {
    target.dispatchEvent(event("mousemove", { clientX: 100, clientY: 25 }));
    settle(controller);
    expect(controller.joints.leftHand[0]).toBeCloseTo(0.38);
    expect(controller.joints.rightHand[0]).toBeCloseTo(0.62);
    expect(controller.joints.leftHand[1]).toBeCloseTo(0.25);
    expect(controller.leftFingertip?.[0]).toBeCloseTo(0.38);

    target.dispatchEvent(
      event("touchmove", { touches: [{ clientX: 0, clientY: 100 }] })
    );
    settle(controller);
    expect(controller.joints.leftHand[0]).toBeCloseTo(0);
    expect(controller.joints.rightHand[1]).toBeCloseTo(1);
  });

  it("ramps lean and squat from held keys and releases them", () => {
    win.dispatchEvent(event("keydown", { key: "ArrowLeft" }));
    win.dispatchEvent(event("keydown", { key: "s" }));
    settle(controller);
    expect(controller.leanAmount).toBeCloseTo(-1);
    expect(controller.squatAmount).toBeCloseTo(1);
    expect(controller.joints.torso[0]).toBeLessThan(0.3);

    // Opposing lean keys cancel out.
    win.dispatchEvent(event("keydown", { key: "d" }));
    win.dispatchEvent(event("keyup", { key: "s" }));
    settle(controller);
    expect(controller.leanAmount).toBeCloseTo(0);
    expect(controller.squatAmount).toBeCloseTo(0);
  });

  it("closes both hands while the left button or space is held", () => {
    target.dispatchEvent(event("mousedown", { button: 2 })); // right button: ignored
    settle(controller);
    expect(controller.leftHandOpen).toBeCloseTo(1);

    target.dispatchEvent(event("mousedown", { button: 0 }));
    settle(controller);
    expect(controller.leftHandOpen).toBeCloseTo(0);
    expect(controller.rightHandOpen).toBeCloseTo(0);

    win.dispatchEvent(event("mouseup", { button: 0 }));
    win.dispatchEvent(event("keydown", { key: " " }));
    settle(controller);
    expect(controller.leftHandOpen).toBeCloseTo(0);

    win.dispatchEvent(event("keyup", { key: " " }));
    settle(controller);
    expect(controller.leftHandOpen).toBeCloseTo(1);
  });

  it("stops listening after dispose", () => {
    controller.dispose();
    win.dispatchEvent(event("keydown", { key: "ArrowRight" }));
    settle(controller);
    expect(controller.leanAmount).toBeCloseTo(0);
  });
});
