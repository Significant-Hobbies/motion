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

/// Which physical camera the session is capturing from.
///
/// Both facings are normalized to the SAME output convention downstream (top-left origin,
/// mirror-corrected — the user's real right hand appears on the on-screen avatar's right).
/// We achieve that by mirroring BOTH connections in hardware/software (`isVideoMirrored =
/// true`), so Vision always sees a mirror-flipped buffer and the PoseEstimator mapping —
/// which mirror-corrects and swaps left/right — stays valid UNCHANGED for either camera.
/// See `configure(session:)` and the mirroring note there.
enum CameraFacing: Sendable, Equatable {
    /// The front TrueDepth/wide-angle selfie camera (default). User sees themselves; tighter
    /// FOV; hardware is already presented mirror-like and we keep `isVideoMirrored = true`.
    case front
    /// The rear ULTRA-WIDE camera (falls back to the rear wide-angle if ultra-wide is
    /// unavailable). Much wider FOV so the whole body fits from close in a normal room. The
    /// physical rear camera is NOT mirror-flipped, so we mirror it IN SOFTWARE
    /// (`isVideoMirrored = true`) to match the front's mirror-corrected output convention.
    case wideRear
}

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

    // MARK: - Camera selection

    /// The camera currently feeding the session. Change via `switchCamera(to:)`, which
    /// reconfigures the session live. Read on `sessionQueue`; the last-requested value is
    /// also cached so a `start()` after a switch picks the right camera on first configure.
    private var currentFacing: CameraFacing = .front

    /// The active video input, retained so a switch can remove exactly it before adding the
    /// new one. `nil` until the first successful `configure`.
    private var currentInput: AVCaptureDeviceInput?

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

    // MARK: - Camera selection (live switch)

    /// Switch the active camera at runtime. Reconfigures the session in place: removes the old
    /// input, adds the new camera's input, re-applies mirroring, and re-points the
    /// RotationCoordinator at the new device. Safe: if the requested camera can't be built the
    /// session is left on the current camera (never torn down into a black/empty state).
    ///
    /// Does NOT stop/start the session — reconfiguring between `beginConfiguration()` /
    /// `commitConfiguration()` on a running session is the supported live-switch path and does
    /// not freeze it. No-op if already on `facing` (and configured).
    func switchCamera(to facing: CameraFacing) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            // No-op if we're configured and already on this camera (avoids a needless
            // reconfigure/flicker). Before the first configure we still record the request so
            // `configure()` picks the right camera.
            if self.isConfigured, self.currentFacing == facing, self.currentInput != nil {
                return
            }
            self.currentFacing = facing
            // If we haven't configured yet, the pending `currentFacing` is enough — the first
            // `configure()` (via `start()`) will pick it up.
            guard self.isConfigured else { return }
            self.reconfigureInput(for: facing)
        }
    }

    // MARK: - Configuration

    /// First-time session build: output + the initially-selected camera's input + rotation.
    private func configure() {
        session.beginConfiguration()
        // 720p is plenty for body-pose and keeps Vision fast; the display never sees pixels.
        session.sessionPreset = .hd1280x720

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
        session.commitConfiguration()

        // Add the initially-selected camera's input (default `.front`) and wire rotation.
        reconfigureInput(for: currentFacing)
    }

    /// Add (or swap to) the input for `facing`, re-apply mirroring, and re-point the
    /// RotationCoordinator. Shared by the first configure and every live `switchCamera`.
    ///
    /// If the target device can't be resolved OR its input can't be added, we leave the
    /// existing input untouched (add it back if we had already removed it) so a failed switch
    /// never blacks out the preview.
    private func reconfigureInput(for facing: CameraFacing) {
        guard let device = Self.device(for: facing) else {
            // No such camera on this device — stay on whatever we have.
            return
        }
        guard let newInput = try? AVCaptureDeviceInput(device: device) else { return }

        session.beginConfiguration()

        let previousInput = currentInput
        if let previousInput {
            session.removeInput(previousInput)
        }

        guard session.canAddInput(newInput) else {
            // Roll back to the previous input so we don't end up with zero inputs.
            if let previousInput, session.canAddInput(previousInput) {
                session.addInput(previousInput)
            }
            session.commitConfiguration()
            return
        }
        session.addInput(newInput)
        currentInput = newInput

        // MIRRORING — the crux of the "identical output convention" requirement.
        // We mirror BOTH cameras (`isVideoMirrored = true`). The front camera is naturally
        // mirror-like; the rear camera is NOT, so mirroring the rear connection IN SOFTWARE
        // makes Vision see the same mirror-flipped buffer for both. That means the
        // PoseEstimator's mapping (keep x, `y = 1 - y`, swap left/right) is correct for BOTH
        // cameras with ZERO branching downstream. Adding an input resets the connection, so we
        // re-apply this every reconfigure. We disable auto-adjust so iOS can't turn it off on
        // the rear connection. `isVideoMirroringSupported` is checked because a device could,
        // in principle, refuse mirroring the rear data-output; if it ever does, the buffer
        // would be un-mirrored and pose would appear left/right-swapped on the rear camera —
        // that's the #1 rear-camera on-device verify item.
        if let connection = videoOutput.connection(with: .video),
           connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = true
        }

        session.commitConfiguration()

        // Re-point the RotationCoordinator at the NOW-active device so horizon-level angles
        // track the new camera. (A coordinator is bound to one device; switching cameras needs
        // a fresh one.) This re-applies the current capture + preview angles immediately.
        installRotationCoordinator(for: device)
    }

    /// Resolve the `AVCaptureDevice` for a facing, with graceful fallback.
    ///   • `.front`    → the front wide-angle sensor (present on all supported phones).
    ///   • `.wideRear` → the rear ULTRA-WIDE (`.builtInUltraWideCamera`) for the widest FOV;
    ///                    falls back to the rear wide-angle if ultra-wide isn't present; if
    ///                    neither rear camera exists, falls back to the front so we never
    ///                    return nil for a phone that has a front camera.
    private static func device(for facing: CameraFacing) -> AVCaptureDevice? {
        switch facing {
        case .front:
            return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
        case .wideRear:
            let discovery = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera],
                mediaType: .video,
                position: .back
            )
            // DiscoverySession returns devices in the order we listed the types, so the
            // ultra-wide (widest FOV — our goal) comes first when present.
            if let rear = discovery.devices.first { return rear }
            // No rear camera at all — degrade to front so the caller still gets a usable camera.
            return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
        }
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
        // Tear down any prior observations first — this runs again on every camera switch, and
        // a RotationCoordinator is bound to a single device, so we replace it wholesale. Without
        // invalidating the old KVO the stale coordinator would keep pushing angles.
        captureAngleObservation?.invalidate()
        previewAngleObservation?.invalidate()
        captureAngleObservation = nil
        previewAngleObservation = nil

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
        // `installRotationCoordinator`) and ALWAYS mirrored (both front and wide-rear cameras
        // set `isVideoMirrored = true`), so the delivered buffer is ALWAYS display-upright AND
        // mirror-flipped regardless of which camera is active — tall in portrait, wide in
        // landscape. Vision therefore treats it as `.up` in BOTH orientations, and the
        // PoseEstimator's top-left/mirror mapping (with left/right swap) stays correct for
        // EITHER camera with no branching. See PoseEstimator for how coordinates are handled.
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
