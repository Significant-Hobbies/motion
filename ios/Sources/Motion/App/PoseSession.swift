//
//  PoseSession.swift
//  Motion
//
//  The vision pipeline coordinator. Owns the camera, pose estimator, and setup
//  evaluator, and forwards results into the `AppModel`. In v1 a single instance is kept
//  live across setup / calibration / game (the game feeds pose into the WKWebView via
//  PoseBridge, not a socket).
//
//  The `setSampleBufferTap` / `CameraTapHost` hook below is PARKED (v2): it fed the old
//  socket-path CameraRecorder. v1 recording uses ReplayKit (ScreenRecorder), so nothing
//  installs a tap — the hook stays only so the parked files keep compiling.
//
//      CameraController ──frames──▶ PoseEstimator ──PoseFrame──▶ SetupEvaluator
//                                                       │              │
//                                                       └──────────────┴──▶ AppModel.ingest(...)
//

import AVFoundation
import CoreVideo
import Foundation
import ImageIO

@MainActor
@Observable
final class PoseSession {
    /// Exposed so the preview view can attach a preview layer to the live session.
    var captureSession: AVCaptureSession { camera.session }

    /// True once camera permission is granted and the session is running.
    private(set) var cameraAuthorized = false
    private(set) var running = false

    private let model: AppModel
    private let camera = CameraController()
    private let estimator = PoseEstimator()
    private let evaluator = SetupEvaluator()
    /// Nonisolated bridge that forwards camera frames to the estimator off the main actor.
    private let frameBridge: FrameBridge

    init(model: AppModel) {
        self.model = model
        self.frameBridge = FrameBridge(estimator: estimator)
        camera.consumer = frameBridge
        estimator.delegate = self
    }

    /// Ask for camera access and start capture. Idempotent.
    func start() async {
        guard !running else { return }
        cameraAuthorized = await CameraController.requestAccess()
        guard cameraAuthorized else {
            model.guidance = "Camera access is required. Enable it in Settings."
            model.tracking = .lost
            return
        }
        camera.start()
        running = true
    }

    func stop() {
        guard running else { return }
        camera.stop()
        running = false
    }

    /// Install or remove the recorder's tap on the live camera's sample buffers. This is
    /// how the on-device `CameraRecorder` receives frames without adding a second capture
    /// output (which would contend with the Vision path). Pass nil to detach.
    func setSampleBufferTap(_ tap: CameraSampleBufferTap?) {
        camera.sampleBufferTap = tap
    }
}

// MARK: - CameraTapHost

/// Lets `RecordingController` attach/detach the camera-buffer tap through the session.
extension PoseSession: CameraTapHost {}

/// A tiny Sendable adapter so the camera (which delivers frames on a background queue)
/// can push into the estimator without touching any main-actor-isolated state.
private final class FrameBridge: CameraFrameConsumer, @unchecked Sendable {
    private let estimator: PoseEstimator
    init(estimator: PoseEstimator) { self.estimator = estimator }
    func consume(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) {
        estimator.process(pixelBuffer: pixelBuffer, orientation: orientation)
    }
}

// MARK: - Estimator → evaluator → model

extension PoseSession: PoseEstimatorDelegate {
    func poseEstimator(_ estimator: PoseEstimator, didProduce frame: PoseFrame) {
        let verdict = evaluator.evaluate(frame: frame)
        model.ingest(
            joints: Joints(from: frame.joints),
            quality: frame.quality,
            tracking: verdict.tracking,
            guidance: verdict.guidance,
            ready: verdict.ready,
            hands: frame.hands
        )
    }

    func poseEstimatorDidLoseTracking(_ estimator: PoseEstimator) {
        let verdict = evaluator.evaluateLost()
        model.ingest(
            joints: nil,
            quality: 0,
            tracking: verdict.tracking,
            guidance: verdict.guidance,
            ready: verdict.ready,
            hands: nil
        )
    }
}
