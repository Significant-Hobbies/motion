//
//  PoseBridge.swift
//  Motion
//
//  The v1 in-process link between the phone's live pose pipeline and the web game hosted
//  in the WKWebView. Replaces the RoomSocket: instead of streaming pose packets over a
//  WebSocket to a browser display, it pushes them straight into
//  `window.__motion.pushPose(...)` on the same device.
//
//  Data flow (v1):
//
//      CameraController → PoseEstimator → SetupEvaluator ─┐
//                                    │                    ├→ AppModel (UI state)
//                                    └────────────────────┴→ PoseBridge
//                                                                │
//                        window.__motion.pushPose / setTracking │  (evaluateJavaScript)
//                                                                ▼
//                                                     GameWebView.Coordinator → web game
//
//  Responsibilities:
//    • Take the SAME smoothed `Joints` + quality the app already computes (via
//      `AppModel.ingest(...)` → `pushLivePose(...)`) and forward them to the webview at
//      ~30 Hz as a `PosePacket` (reusing Net/Protocol.swift's PosePacket + WireCoder).
//    • Push `setTracking` whenever the SetupEvaluator's tracking state changes.
//    • On the web `ready` event, call `start()`; route `gameStart`/`gameOver` to the
//      `ScreenRecorder`; expose the latest score / result to the UI.
//
//  Throttling: the pose pipeline already emits at ~20 Hz (see PoseEstimator), which is at
//  or under our 30 Hz ceiling, so we forward every frame but guard with a min interval so
//  a faster pipeline can't flood `evaluateJavaScript`.
//

import Foundation
import Observation

@MainActor
@Observable
final class PoseBridge {
    // MARK: - UI-facing state

    /// Latest final score reported by the game (`{ event: 'score', value }`).
    private(set) var lastScore: Double?
    /// Raw JSON of the last `gameOver` result, if any (surfaced for the UI / debugging).
    private(set) var lastResultJSON: String?
    /// True between `gameStart` and `gameOver` — the game is actively being played.
    private(set) var isPlaying = false

    // MARK: - Collaborators

    /// The live webview bridge. Set once `GameWebView` hands us its coordinator.
    private weak var coordinator: GameWebView.Coordinator?
    /// The v1 screen recorder; bracketed by gameStart/gameOver when armed.
    private let recorder: ScreenRecorder

    // MARK: - Send cadence

    /// Max pose push rate. The pipeline runs ~20 Hz; this caps a faster source at 30 Hz.
    private let minPushInterval: TimeInterval = 1.0 / 30.0
    private var lastPushTime: TimeInterval = 0
    private var poseSeq = 0
    /// Only push `setTracking` when the state actually changes.
    private var lastSentTracking: TrackingState?

    init(recorder: ScreenRecorder) {
        self.recorder = recorder
    }

    /// Bind the live webview coordinator. Called by the game view once the WKWebView is up.
    /// Idempotent; resets per-session send state so a fresh game starts clean.
    func attach(coordinator: GameWebView.Coordinator) {
        self.coordinator = coordinator
        poseSeq = 0
        lastPushTime = 0
        lastSentTracking = nil
    }

    /// Detach when leaving the game (webview torn down). Stops further pushes.
    func detach() {
        coordinator = nil
    }

    // MARK: - Pose ingest (from AppModel, main actor)

    /// Forward a freshly evaluated frame into the web game. Called from `AppModel.ingest`
    /// only while the app is in the `.game` phase.
    /// - Parameters:
    ///   - joints: smoothed, mirror-corrected joints (nil if no body this frame)
    ///   - quality: aggregate confidence 0..1
    ///   - tracking: setup verdict from `SetupEvaluator`
    ///   - hands: latest per-hand openness 0..1 (nil if never detected), carried in the packet
    ///   - fingertips: latest precise index-fingertips (nil if never detected), carried too
    func pushLivePose(joints: Joints?, quality: Double, tracking: TrackingState,
                      hands: HandState? = nil, fingertips: Fingertips? = nil) {
        guard let coordinator else { return }

        // Tracking transitions are cheap and important (they pause/resume the game), so
        // always forward them on change regardless of the pose throttle.
        if tracking != lastSentTracking {
            lastSentTracking = tracking
            coordinator.setTracking(tracking.rawValue)
        }

        // Only stream pose while tracking is usable and we actually have joints.
        guard tracking == .ok, let joints else { return }

        // Throttle to <= 30 Hz.
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastPushTime >= minPushInterval else { return }
        lastPushTime = now

        poseSeq += 1
        let packet = PosePacket(
            seq: poseSeq,
            // Monotonic clock (ms). Only differences matter to the web latency math.
            sentAt: now * 1000.0,
            quality: quality,
            joints: joints,
            hands: hands,
            fingertips: fingertips
        )
        // Encode to a compact JSON string and hand it to pushPose (the web bridge
        // JSON.parses string payloads). Encoding our fixed shape never fails in practice.
        guard let json = try? WireCoder.encodeToString(packet) else { return }
        coordinator.pushPose(jsonString: json)
    }

    // MARK: - Calibration

    /// Tell the web game calibration finished on the phone.
    func calibrationDidFinish() {
        coordinator?.calibrated()
    }

    // MARK: - Web → native lifecycle events

    /// Route a `GameEvent` from the webview. Wired by the game view's `onEvent` closure.
    func handle(event: GameEvent) {
        switch event {
        case .ready:
            // Web canvas is up and the bridge global exists — begin the game. The phone
            // has already passed its own readiness/calibration gate before we got here.
            coordinator?.start()
        case .gameStart:
            isPlaying = true
            // Start ReplayKit capture IF the user armed recording. No-op otherwise.
            recorder.gameDidStart()
        case .score(let value):
            lastScore = value
        case .gameOver(let resultJSON):
            isPlaying = false
            lastResultJSON = resultJSON
            // Stop + save the screen recording (whole screen = game + camera inset).
            recorder.gameDidEnd()
        case .restart:
            // A replay is starting; treat like a fresh play for recording purposes.
            isPlaying = true
        }
    }
}
