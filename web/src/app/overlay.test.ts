import { describe, expect, it, vi } from "vitest";

import { Overlay } from "./overlay";

/** Only the two interactive slots are modeled; assertions inspect actual emitted HTML. */
class RootDouble {
  private html = "";
  private slots = new Map<string, EventTarget & { checked: boolean }>();
  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    this.slots.clear();
    for (const id of ["rec-toggle", "play-again"]) {
      if (value.includes(`id="${id}"`))
        this.slots.set(
          `#${id}`,
          Object.assign(new EventTarget(), {
            checked: /type="checkbox" checked/.test(value),
          })
        );
    }
  }
  querySelector(selector: string) {
    return this.slots.get(selector) ?? null;
  }
}

describe("overlay screen controls", () => {
  it("renders connection states, escapes host text, and binds only the current recording toggle", () => {
    const root = new RootDouble();
    const overlay = new Overlay(root as unknown as HTMLElement);
    const onToggleRecord = vi.fn();
    const base = {
      code: "BCDFGH",
      host: '<relay & "host">',
      debug: false,
      recordOn: false,
      onToggleRecord,
    };
    for (const [conn, label] of [
      ["connecting", "connecting…"],
      ["open", "connected to relay"],
      ["closed", "reconnecting…"],
    ] as const) {
      overlay.pairing({ ...base, conn });
      expect(root.innerHTML).toContain(label);
      expect(root.innerHTML).toContain("B C D F G H");
      expect(root.innerHTML).toContain("&lt;relay &amp; &quot;host&quot;&gt;");
      expect(root.innerHTML).not.toContain(base.host);
      expect(root.innerHTML).not.toContain("DEBUG MODE");
    }
    overlay.pairing({ ...base, conn: "open", debug: true, recordOn: true });
    const toggle = root.querySelector("#rec-toggle")!;
    expect(toggle.checked).toBe(true);
    expect(root.innerHTML).toContain("browser download in debug");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(onToggleRecord).toHaveBeenCalledExactlyOnceWith(false);
    overlay.pairing({ ...base, conn: "open" });
    const replacement = root.querySelector("#rec-toggle")!;
    expect(replacement).not.toBe(toggle);
    replacement.checked = true;
    replacement.dispatchEvent(new Event("change"));
    expect(onToggleRecord.mock.calls).toEqual([[false], [true]]);
    overlay.clear();
    expect(root.innerHTML).toBe("");
    expect(root.querySelector("#rec-toggle")).toBeNull();
  });

  it("shows readiness progress and recovery states, then escapes result stats and binds replay", () => {
    const root = new RootDouble();
    const overlay = new Overlay(root as unknown as HTMLElement);
    const state = {
      peer: false,
      joints: true,
      quality: false,
      calibrated: false,
      ready: false,
      qualityHold: 0.375,
    };
    overlay.readiness(state, false);
    expect(root.innerHTML).toContain("holding 38%");
    expect(root.innerHTML).toContain("Complete the checklist");
    overlay.readiness(
      { ...state, peer: true, quality: true, calibrated: true, ready: true },
      true
    );
    expect(root.innerHTML).toContain("Debug controller active");
    expect(root.innerHTML).toContain("Ready! Starting…");
    expect(root.innerHTML).not.toContain("holding");
    overlay.mirror();
    expect(root.innerHTML).toContain("Mirror test");
    overlay.trackingLost();
    expect(root.innerHTML).toContain("Game paused — it resumes automatically");
    overlay.reconnecting();
    expect(root.innerHTML).toContain("Holding your room");
    const replay = vi.fn();
    overlay.results(
      {
        score: 42,
        stats: [{ label: '<img & "label">', value: '<script & "value">' }],
      },
      replay
    );
    expect(root.innerHTML).toContain("&lt;img &amp; &quot;label&quot;&gt;");
    expect(root.innerHTML).toContain("&lt;script &amp; &quot;value&quot;&gt;");
    expect(root.innerHTML).not.toContain("<script");
    root.querySelector("#play-again")!.dispatchEvent(new Event("click"));
    expect(replay).toHaveBeenCalledOnce();
    overlay.clear();
    expect(root.querySelector("#play-again")).toBeNull();
  });
});
