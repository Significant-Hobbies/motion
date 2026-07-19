//
//  SyntheticPoseDriver.swift
//  Motion
//
//  A TEST-ONLY pose source that fabricates an animated body so the whole native loop
//  (setup → game → PoseBridge → WKWebView game render) can run WITHOUT a camera — e.g.
//  in the iOS Simulator, where there is no camera and no way to feed real Vision pose.
//
//  This exists so the app can be self-verified off-device: build for the Simulator, launch
//  with `--synthetic-pose` (or env `MOTION_SYNTHETIC=1`), and screenshot the running game
//  instead of hand-testing every build on a physical phone. It is INERT in normal builds —
//  nothing constructs it unless the flag is present (see `PoseSession.start()`), so device
//  and production behavior is unchanged.
//
//  It feeds `AppModel.ingest(...)` ~30×/s with moving hands + oscillating openness (so grab
//  and release fire) and a bent arm chain (so elbows render), reports tracking `.ok`, and
//  auto-advances into the game after ~1s so the WKWebView actually loads the bundled build.
//

import Foundation

@MainActor
final class SyntheticPoseDriver {
    /// True when the app was launched to run on fabricated pose (Simulator self-test).
    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--synthetic-pose")
            || ProcessInfo.processInfo.environment["MOTION_SYNTHETIC"] == "1"
    }

    private weak var model: AppModel?
    private var timer: Timer?
    private var t: Double = 0
    private var frame = 0
    private var startedGame = false

    init(model: AppModel) { self.model = model }

    func start() {
        stop()
        t = 0
        frame = 0
        startedGame = false
        let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard let model else { return }
        t += 1.0 / 30.0
        frame += 1

        // Hands drift in gentle loops around chest height so the avatar visibly moves and
        // the hands pass over the floating objects.
        let lx = 0.36 + 0.06 * sin(t * 1.3)
        let ly = 0.5 + 0.16 * sin(t * 0.9)
        let rx = 0.64 + 0.06 * cos(t * 1.1)
        let ry = 0.5 + 0.16 * cos(t * 1.0)

        // Openness oscillates 0..1 (fist ⇄ open palm), out of phase per hand, so the
        // deliberate open→close grab gesture fires on its own.
        let openL = 0.5 + 0.5 * sin(t * 0.7)
        let openR = 0.5 + 0.5 * sin(t * 0.7 + 1.6)

        let map: [JointName: Point2] = [
            .head: [0.5, 0.2],
            .leftHand: [lx, ly],
            .rightHand: [rx, ry],
            .torso: [0.5, 0.5],
            .leftKnee: [0.42, 0.72],
            .rightKnee: [0.58, 0.72],
            .leftFoot: [0.42, 0.95],
            .rightFoot: [0.58, 0.95],
        ]
        // Bent arm chain so shoulder→elbow→hand renders with a real elbow.
        let arms: [ArmJointName: Point2] = [
            .leftShoulder: [0.42, 0.34],
            .rightShoulder: [0.58, 0.34],
            .leftElbow: [(0.42 + lx) / 2 - 0.05, (0.34 + ly) / 2 + 0.02],
            .rightElbow: [(0.58 + rx) / 2 + 0.05, (0.34 + ry) / 2 + 0.02],
        ]

        model.ingest(
            joints: Joints(from: map, arms: arms),
            quality: 0.9,
            tracking: .ok,
            guidance: "Synthetic test pose",
            ready: true,
            hands: HandState(left: openL, right: openR),
            fingertips: nil
        )

        // Enter the game once, after ~1s, so the WKWebView loads the bundled build and we
        // can observe the actual game render (the whole point of the harness).
        if !startedGame, frame > 30 {
            startedGame = true
            model.startGame()
        }
    }
}
