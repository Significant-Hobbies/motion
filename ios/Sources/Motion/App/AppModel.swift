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
#if canImport(UIKit)
import UIKit
#endif

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
    /// Latest per-hand openness 0..1 (0 = fist, 1 = open palm), for the outgoing packet and
    /// an optional on-screen debug readout. `nil` until hands are first detected.
    var hands: HandState?
    /// Latest precise index-fingertips (top-left, mirror-corrected, 0..1) from the ROI-zoomed
    /// hand pass, for the outgoing packet / a cursor. `nil` until first detected.
    var fingertips: Fingertips?

    /// The current UI phase. Views observe changes to route.
    var phase: Phase = .setup

    // MARK: - Stream to website (relay path)

    /// Fixed default room code the browser display should open. Editable in the UI.
    /// Uppercased on use; the relay room id IS this code.
    var roomCode: String = "MOTION"

    /// When on, every evaluated pose (with hands) is also streamed to the relay so a
    /// browser at `ws://<devServerIP>:1999/parties/main/<roomCode>` can render it live.
    /// Toggling this creates / tears down `roomSocket`. Independent of the local game.
    var streamToWebsite: Bool = false {
        didSet {
            guard streamToWebsite != oldValue else { return }
            if streamToWebsite { startStreaming() } else { stopStreaming() }
        }
    }

    /// Socket lifecycle state for the streaming UI (connecting / streaming / …).
    private(set) var streamConnection: ConnectionState = .idle
    /// True once the browser `display` peer has joined the room (from a `peer` message).
    private(set) var peerConnected: Bool = false

    /// Live relay socket while `streamToWebsite` is on; nil otherwise.
    private var roomSocket: RoomSocket?
    /// Monotonic-ish sequence for streamed packets (separate from the bridge's).
    private var streamSeq = 0

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
                guidance: String, ready: Bool, hands: HandState?, fingertips: Fingertips? = nil) {
        self.joints = joints
        self.quality = quality
        self.tracking = tracking
        self.guidance = guidance
        self.readyToCalibrate = ready
        // Hold the last known hands so a body-only frame doesn't blank the readout; the
        // packet still only carries hands when we have a value.
        if let hands { self.hands = hands }
        // Same hold-last behavior for fingertips so a brief dropout doesn't blank a cursor.
        if let fingertips { self.fingertips = fingertips }

        // While playing, forward pose + tracking (with hands + fingertips) into the web game
        // in-process. PoseBridge handles change-detection for tracking and the ~30 Hz throttle.
        if phase == .game {
            bridge.pushLivePose(joints: joints, quality: quality, tracking: tracking,
                                hands: self.hands, fingertips: self.fingertips)
        }

        // Stream to the browser relay IN ADDITION to (and independent of) the local game.
        // Runs straight from setup — no calibration/webview required. We stream whenever
        // Vision detected ANY body this frame (`joints` present) and tracking isn't fully
        // lost — deliberately NOT gated on full-body `.ok`, so a desk / upper-body-only
        // pose still streams (the motion-maker is upper-body friendly). The display infers
        // loss from the packet gap.
        if streamToWebsite, let socket = roomSocket, tracking != .lost, let joints {
            streamSeq += 1
            let packet = PosePacket(
                seq: streamSeq,
                sentAt: ProcessInfo.processInfo.systemUptime * 1000.0,
                quality: quality,
                joints: joints,
                hands: self.hands,
                fingertips: self.fingertips
            )
            socket.send(packet)
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

    // MARK: - Streaming lifecycle

    /// Open a relay socket to `ws://<devServerIP>:1999/parties/main/<roomCode>` and begin
    /// streaming poses (see `ingest`). The relay is on the SAME Mac as the dev server, so we
    /// reuse `devServerIP` as the host. Idempotent-ish: replaces any existing socket.
    private func startStreaming() {
        stopStreaming()                     // clear any stale socket first
        let code = roomCode.trimmingCharacters(in: .whitespaces).uppercased()
        guard !code.isEmpty else {
            streamToWebsite = false
            streamConnection = .failed(reason: "Enter a room code.")
            return
        }
        streamSeq = 0
        peerConnected = false
        let socket = RoomSocket(host: devServerIP, code: code)
        socket.delegate = self
        roomSocket = socket
        socket.connect()

        // Keep the screen awake while streaming: auto-lock (or the display sleeping) would
        // background the app and drop the relay socket. This does NOT stop iOS suspending a
        // fully-backgrounded app, but it prevents the common idle auto-lock disconnect.
        #if canImport(UIKit)
        UIApplication.shared.isIdleTimerDisabled = true
        #endif
    }

    /// Tear down the relay socket and reset streaming UI state. Safe to call when idle.
    private func stopStreaming() {
        roomSocket?.disconnect()
        roomSocket = nil
        peerConnected = false
        streamConnection = .idle

        // Re-enable auto-lock now that we're no longer streaming, so the phone can sleep
        // normally when idle. Paired with the enable in `startStreaming()`.
        #if canImport(UIKit)
        UIApplication.shared.isIdleTimerDisabled = false
        #endif
    }
}

// MARK: - RoomSocketDelegate (streaming status → UI)

extension AppModel: RoomSocketDelegate {
    func roomSocket(_ socket: RoomSocket, didChangeState state: ConnectionState) {
        streamConnection = state
        // Disarm on a hard disconnect so the UI toggle reflects reality.
        if case .idle = state { peerConnected = false }
    }

    func roomSocket(_ socket: RoomSocket, didReceive message: IncomingMessage) {
        // Track the browser display's presence so the UI can show "peer connected".
        if case .peer(let peer) = message, peer.role == .display {
            peerConnected = peer.connected
        }
    }

    func roomSocket(_ socket: RoomSocket, didMeasureRTT rttMS: Double) {
        // RTT is not surfaced in the streaming UI yet; ignore.
    }
}
