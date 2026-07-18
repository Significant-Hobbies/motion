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

        // Lock the connection to portrait-up video orientation and mirror the FRONT
        // camera so the preview reads like a mirror. NOTE: mirroring the connection
        // flips the *preview*; the pixel buffer we hand Vision is also mirrored, which
        // is exactly what we want since our joint mapping mirror-corrects to match.
        if let connection = videoOutput.connection(with: .video) {
            if connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90 // portrait
            }
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = true
            }
        }

        session.commitConfiguration()
    }
}

// MARK: - Sample buffer delegate

extension CameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        // The connection is already portrait + mirrored, so Vision should treat the
        // buffer as upright (.up). See PoseEstimator for how coordinates are handled.
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
