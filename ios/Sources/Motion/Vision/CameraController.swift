//
//  CameraController.swift
//  Motion
//
//  AVFoundation front-camera capture. Owns an `AVCaptureSession` wired to a video
//  data output whose sample buffers are delivered on a background queue. Each frame's
//  `CVPixelBuffer` is handed to a callback (the pose estimator) and then discarded.
//
//  PRIVACY: frames are never written to disk, never uploaded, never buffered beyond
//  the current callback. Only normalized joint coordinates leave the device.
//
//  We expose the `AVCaptureSession` so `CameraPreviewView` can attach an
//  `AVCaptureVideoPreviewLayer` for the live preview.
//

import AVFoundation
import CoreVideo
import Foundation
import ImageIO

/// Delivers pixel buffers off the capture queue. Implementations must be cheap and
/// non-blocking (Vision work should be dispatched, not run inline on this queue).
protocol CameraFrameConsumer: AnyObject, Sendable {
    /// Called on the capture queue for every front-camera frame.
    /// - Parameters:
    ///   - pixelBuffer: the frame; do not retain it beyond this call.
    ///   - orientation: the CGImagePropertyOrientation to hand Vision for this frame.
    func consume(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation)
}

/// Optional secondary tap on the SAME `CMSampleBuffer`s the camera already produces.
///
/// The on-device recorder (see `Recording/CameraRecorder.swift`) implements this to
/// append frames to an `AVAssetWriter`. We deliberately reuse the existing single
/// `AVCaptureVideoDataOutput` rather than adding a second output: two outputs on the
/// same connection would contend for the sensor and can starve the Vision path. The
/// recorder needs the full `CMSampleBuffer` (not just the pixel buffer) because it
/// carries the presentation timestamp the asset writer keys frames on.
///
/// PRIVACY: this tap exists ONLY to write frames to a LOCAL temp file. Nothing here
/// ever transmits or uploads pixels.
protocol CameraSampleBufferTap: AnyObject, Sendable {
    /// Called on the capture queue for every front-camera frame, before the buffer is
    /// released. Must be cheap and non-blocking (asset-writer appends are fast).
    func tap(sampleBuffer: CMSampleBuffer)
}

final class CameraController: NSObject, @unchecked Sendable {
    /// The capture session, exposed for the preview layer. Configure/start via this class.
    let session = AVCaptureSession()

    /// Where frames are delivered. Set before `start()`.
    weak var consumer: CameraFrameConsumer?

    /// Optional recorder tap on the raw sample buffers. Set/cleared from any thread;
    /// `sampleTapQueue`-synchronized so the capture queue always reads a consistent
    /// reference. When nil (the default), zero recording overhead is incurred.
    var sampleBufferTap: CameraSampleBufferTap? {
        get { sampleTapQueue.sync { _sampleBufferTap } }
        set { sampleTapQueue.sync { _sampleBufferTap = newValue } }
    }
    private var _sampleBufferTap: CameraSampleBufferTap?
    private let sampleTapQueue = DispatchQueue(label: "com.motion.camera.tap")

    /// Serial queue for session configuration and sample-buffer delivery.
    private let sessionQueue = DispatchQueue(label: "com.motion.camera.session")
    private let videoOutput = AVCaptureVideoDataOutput()

    private var isConfigured = false

    // MARK: - Orientation (iOS 17+ RotationCoordinator)

    /// Drives horizon-level rotation angles for BOTH the video-data-output connection
    /// (what Vision sees) and the preview layer (what the player sees), so the frame is
    /// display-upright in EVERY device orientation — a tall frame in portrait, a wide
    /// frame in landscape, but always upright. This is what lets the PoseEstimator's
    /// mapping (mirror x, `y = 1 - y`) stay correct in both orientations: it only ever
    /// needs the buffer to be display-upright, and this coordinator guarantees that.
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?

    /// The preview layer whose connection we keep horizon-level. Set by the preview view
    /// via `attachPreviewLayer(_:)` once it exists. Weak: the view owns it.
    private weak var previewLayer: AVCaptureVideoPreviewLayer?

    /// KVO observers on the coordinator's angle properties. Retained for their lifetime.
    private var captureAngleObservation: NSKeyValueObservation?
    private var previewAngleObservation: NSKeyValueObservation?

    // MARK: - Permission

    /// Request camera authorization. Returns true if granted.
    static func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .video)
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }

    // MARK: - Lifecycle

    /// Configure (once) and start the session. Safe to call repeatedly.
    func start() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if !self.isConfigured {
                self.configure()
                self.isConfigured = true
            }
            if !self.session.isRunning { self.session.startRunning() }
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    // MARK: - Configuration

    private func configure() {
        session.beginConfiguration()
        // 720p is plenty for body-pose and keeps Vision fast; the display never sees pixels.
        session.sessionPreset = .hd1280x720

        // Front camera. Prefer the wide-angle front sensor available on all supported phones.
        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            session.commitConfiguration()
            return
        }
        session.addInput(input)
        let captureDevice = device

        // BGRA output — the format Vision and Core Image handle directly.
        videoOutput.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
        ]
        // Drop late frames instead of queueing — we only ever want the freshest one.
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: sessionQueue)

        guard session.canAddOutput(videoOutput) else {
            session.commitConfiguration()
            return
        }
        session.addOutput(videoOutput)

        // Mirror the FRONT camera so the preview (and the buffer Vision sees) reads like a
        // mirror. Mirroring the connection flips both the preview AND the pixel buffer we
        // hand Vision, which is exactly what we want since our joint mapping mirror-corrects
        // to match. We keep mirroring FIXED (front camera, always); only the *rotation* is
        // made orientation-aware below via the RotationCoordinator.
        if let connection = videoOutput.connection(with: .video),
           connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = true
        }

        session.commitConfiguration()

        // Orientation-aware rotation. The coordinator publishes horizon-level angles that
        // change as the device rotates; we push them onto the capture + preview connections
        // via KVO so the buffer handed to Vision is ALWAYS display-upright (tall in portrait,
        // wide in landscape). See `installRotationCoordinator`.
        installRotationCoordinator(for: captureDevice)
    }

    // MARK: - Orientation wiring

    /// Attach the live preview layer so its connection can be kept horizon-level. Called by
    /// the preview view once its `AVCaptureVideoPreviewLayer` exists. Applies the current
    /// angle immediately and future angles arrive via KVO.
    func attachPreviewLayer(_ layer: AVCaptureVideoPreviewLayer) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.previewLayer = layer
            if let angle = self.rotationCoordinator?.videoRotationAngleForHorizonLevelPreview {
                self.applyPreviewAngle(angle)
            }
        }
    }

    /// Build the `RotationCoordinator` for the front camera and start observing both of its
    /// horizon-level angle properties. `videoRotationAngleForHorizonLevelCapture` drives the
    /// video-data-output connection (the buffer Vision sees); `...ForHorizonLevelPreview`
    /// drives the preview layer. KVO keeps both current as the device rotates — no manual
    /// UIDevice orientation math, and it stays correct even when the UI is orientation-locked.
    private func installRotationCoordinator(for device: AVCaptureDevice) {
        let coordinator = AVCaptureDevice.RotationCoordinator(
            device: device,
            previewLayer: previewLayer
        )
        rotationCoordinator = coordinator

        // Apply the initial angles synchronously so the very first frames are already upright.
        applyCaptureAngle(coordinator.videoRotationAngleForHorizonLevelCapture)
        applyPreviewAngle(coordinator.videoRotationAngleForHorizonLevelPreview)

        captureAngleObservation = coordinator.observe(
            \.videoRotationAngleForHorizonLevelCapture,
            options: [.new]
        ) { [weak self] _, change in
            guard let self, let angle = change.newValue else { return }
            self.sessionQueue.async { self.applyCaptureAngle(angle) }
        }

        previewAngleObservation = coordinator.observe(
            \.videoRotationAngleForHorizonLevelPreview,
            options: [.new]
        ) { [weak self] _, change in
            guard let self, let angle = change.newValue else { return }
            self.sessionQueue.async { self.applyPreviewAngle(angle) }
        }
    }

    /// Push a horizon-level angle onto the video-data-output connection. This rotates the
    /// delivered `CVPixelBuffer` so it is display-upright for the current device orientation,
    /// which is the invariant PoseEstimator's coordinate mapping depends on.
    private func applyCaptureAngle(_ angle: CGFloat) {
        guard let connection = videoOutput.connection(with: .video),
              connection.isVideoRotationAngleSupported(angle) else { return }
        connection.videoRotationAngle = angle
    }

    /// Push a horizon-level angle onto the preview layer's connection so the on-screen
    /// preview stays upright too. Must touch the layer on the main thread.
    private func applyPreviewAngle(_ angle: CGFloat) {
        DispatchQueue.main.async { [weak self] in
            guard let connection = self?.previewLayer?.connection,
                  connection.isVideoRotationAngleSupported(angle) else { return }
            connection.videoRotationAngle = angle
        }
    }
}

// MARK: - Sample buffer delegate

extension CameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        // The connection is kept horizon-level by the RotationCoordinator (see
        // `installRotationCoordinator`) and mirrored, so the delivered buffer is ALWAYS
        // display-upright for the current device orientation — tall in portrait, wide in
        // landscape. Vision therefore treats it as `.up` in BOTH orientations, and the
        // PoseEstimator's top-left/mirror mapping stays correct because it only depends on
        // the buffer being display-upright. See PoseEstimator for how coordinates are handled.
        consumer?.consume(pixelBuffer: pixelBuffer, orientation: .up)
        // pixelBuffer is not retained past this call — nothing is persisted by Vision.

        // Recorder tap on the SAME buffer. Reads the reference under the tap queue so a
        // concurrent set/clear can't tear. The recorder is responsible for only
        // appending while its writer session is active; it writes to a LOCAL temp file
        // and never transmits. This is additive — the Vision path above is untouched.
        if let tap = sampleTapQueue.sync(execute: { _sampleBufferTap }) {
            tap.tap(sampleBuffer: sampleBuffer)
        }
    }
}
