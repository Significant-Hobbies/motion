//
//  AppModel.swift
//  Motion
//
//  App-wide observable state and the coordinator that wires the v1 (serverless,
//  single-device) pipeline together:
//
//      CameraController → PoseEstimator → SetupEvaluator ─┐
//                                    │                    ├→ AppModel (UI state)
//                                    └────────────────────┴→ PoseBridge → WKWebView game
//
//  In v1 the phone does everything: camera + Vision pose feed the web game hosted in a
//  full-screen WKWebView IN-PROCESS via a JS bridge (PoseBridge). There is NO relay
//  server, NO WebSocket, NO pairing. Screen capture (game + camera inset in one video) is
//  done by `ScreenRecorder` (ReplayKit). The user mirrors the phone to a TV via the OS.
//
//  Everything here runs on the main actor: it is the single UI-facing state holder.
//
//  v2 NOTE: the browser/relay path (RoomSocket, PairingView, CameraRecorder/ClipReceiver/
//  CompositeExporter/RecordingController) is PARKED — the files remain in the target but
//  nothing in the v1 path constructs or uses them. See each file's PARKED header.
//

import Foundation
import Observation

/// High-level screen the app should show. Drives `ContentView` routing.
enum Phase: Sendable, Equatable {
    case setup        // camera up, guiding the player into frame
    case calibration  // running the 5s calibration flow
    case game         // full-screen web game; pose streams in-process via PoseBridge
}

@MainActor
@Observable
final class AppModel {
    // MARK: - Dev server (v1 web-game source)

    /// Editable dev-server IP (the Mac running `npm --workspace web run dev`). Reuses the
    /// old PairingView host field, repurposed as a "dev server IP" input. Overrides
    /// `MAC_LAN_IP` at runtime. Ignored when `GameConfig.source == .bundled`.
    var devServerIP: String = MAC_LAN_IP

    /// The URL the WKWebView should load, derived from the current source + dev IP.
    var gameURL: URL? {
        switch GameConfig.source {
        case .devServer: return GameConfig.devServerURL(host: devServerIP)
        case .bundled:   return GameConfig.bundledIndexURL()
        }
    }

    /// Directory read-access for a bundled `file://` load (nil for the dev server).
    var gameFileReadAccessURL: URL? {
        GameConfig.source == .bundled ? GameConfig.bundledReadAccessURL() : nil
    }

    // MARK: - Tracking / calibration

    var tracking: TrackingState = .lost
    /// Human guidance string for the readiness UI ("Step back", "Raise the phone"…).
    var guidance: String = "Point the camera at your whole body."
    /// True once the setup has been continuously good long enough to proceed.
    var readyToCalibrate: Bool = false

    var calibrationStage: CalibMessage.Stage = .neutral
    var calibrationProgress: Double = 0

    /// Latest smoothed, mirror-corrected joints (top-left origin, 0..1) for the overlay.
    var joints: Joints?
    /// Aggregate confidence 0..1 of the latest frame.
    var quality: Double = 0

    /// The current UI phase. Views observe changes to route.
    var phase: Phase = .setup

    // MARK: - Recording + bridge (v1)

    /// ReplayKit screen recorder: captures the whole screen (web game + camera inset) as
    /// one video. Always present so the UI can bind; only active once armed + the game
    /// drives it via `gameStart`/`gameOver`.
    let recorder = ScreenRecorder()

    /// In-process link from the pose pipeline into the WKWebView game.
    let bridge: PoseBridge

    // MARK: - Collaborators

    private var lastSentTracking: TrackingState?

    init() {
        bridge = PoseBridge(recorder: recorder)
    }

    // MARK: - Pipeline ingest (called from the vision layer, main actor)

    /// Feed a freshly estimated frame. Updates tracking and, while in `.game`, forwards
    /// pose + tracking into the web game via `PoseBridge`.
    /// - Parameters:
    ///   - joints: smoothed, mirror-corrected joints (nil if no body found this frame)
    ///   - quality: aggregate confidence 0..1
    ///   - tracking: setup verdict from `SetupEvaluator`
    ///   - guidance: matching human guidance string
    ///   - ready: whether setup has been good long enough
    func ingest(joints: Joints?, quality: Double, tracking: TrackingState,
                guidance: String, ready: Bool) {
        self.joints = joints
        self.quality = quality
        self.tracking = tracking
        self.guidance = guidance
        self.readyToCalibrate = ready

        // While playing, forward pose + tracking into the web game in-process. PoseBridge
        // handles change-detection for tracking and the ~30 Hz throttle for pose.
        if phase == .game {
            bridge.pushLivePose(joints: joints, quality: quality, tracking: tracking)
        }
    }

    // MARK: - Calibration bridge

    /// Called by `CalibrationController` as it advances stages.
    func calibrationDidAdvance(stage: CalibMessage.Stage, progress: Double) {
        calibrationStage = stage
        calibrationProgress = progress
        if stage == .done {
            phase = .game
            // Tell the web game calibration is done (it may gate on this).
            bridge.calibrationDidFinish()
        }
    }

    /// Enter the calibration phase (from setup, once ready).
    func beginCalibration() {
        guard phase == .setup else { return }
        phase = .calibration
        calibrationStage = .neutral
        calibrationProgress = 0
    }

    /// Leave the game and return to setup (the minimal in-game exit control).
    func exitGame() {
        guard phase == .game else { return }
        recorder.disarm()
        bridge.detach()
        phase = .setup
        readyToCalibrate = false
    }
}
