// PARKED for v2 (browser/relay path) — not used in v1 (v1 uses Recording/ScreenRecorder.swift).
//
//  CameraRecorder.swift
//  Motion
//
//  Records the front camera to a LOCAL H.264 `.mov` using `AVAssetWriter`, fed from
//  the SAME `CMSampleBuffer`s the capture pipeline already produces (via the
//  `CameraSampleBufferTap` hook on `CameraController`). We do NOT add a second capture
//  output — that would contend with the Vision video-data-output. Instead we tap the
//  existing buffers, so pose streaming is completely undisturbed.
//
//  PRIVACY — THE WHOLE POINT: these frames are written only to a temp file on this
//  device and are NEVER uploaded or transmitted. The recorder exists so the phone can
//  later composite its own camera against the gameplay clip received from the display.
//
//  Sync: the first frame this recorder writes is the anchor point for aligning against
//  the gameplay clip. We capture BOTH:
//    • `firstFrameHostTimeMs` — wall-clock (`Date`) at the first appended frame, so we
//      can relate it to the session's `RecControlMessage.anchorMs`, and
//    • the first sample's presentation timestamp, which the composite uses to trim the
//      camera track relative to its own timeline.
//
//  Threading: all writer work happens on `writerQueue` (the capture queue calls in on
//  its own queue; we hand off cheaply). Public state is read atomically under a lock.
//

import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

/// The finished on-device camera recording plus the timing needed to align it.
struct CameraRecording: Sendable {
    /// Temp file URL of the H.264 `.mov`.
    let url: URL
    /// Wall-clock (ms since 1970) at the first written frame — pairs with the session
    /// anchor to align against the gameplay clip.
    let firstFrameWallClockMs: Double
    /// Presentation timestamp (seconds) of the first written frame, in the camera
    /// track's own timeline. The composite offsets against this so the visible track
    /// starts at t=0.
    let firstFramePTSSeconds: Double
    /// Total recorded duration in seconds (last PTS − first PTS + a frame).
    let durationSeconds: Double
}

/// Records front-camera sample buffers to a local `.mov`. Not an `@Observable`; the
/// orchestrator (`RecordingController`) owns UI state. This class is intentionally
/// UI-agnostic and safe to drive from a background context.
final class CameraRecorder: NSObject, CameraSampleBufferTap, @unchecked Sendable {

    /// Serializes writer setup/append/teardown. The capture queue hops here per frame.
    private let writerQueue = DispatchQueue(label: "com.motion.recorder.writer")

    // All fields below are touched only on `writerQueue` unless noted.
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var outputURL: URL?

    /// Set true once `startSession(atSourceTime:)` has been called with the first PTS.
    private var sessionStarted = false
    private var firstPTS: CMTime = .invalid
    private var lastPTS: CMTime = .invalid
    private var firstFrameWallClockMs: Double = 0

    /// `true` between `start()` and `finish()`. Read from the capture queue in `tap`,
    /// so guard it with the lock.
    private let stateLock = NSLock()
    private var _isRecording = false
    private var isRecording: Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return _isRecording
    }
    /// Synchronous setter for the recording flag. Kept as a non-async method so it can
    /// be called from `async` contexts (Swift 6 forbids `NSLock.lock()` directly there).
    private func setRecording(_ value: Bool) {
        stateLock.lock(); _isRecording = value; stateLock.unlock()
    }

    /// The video dimensions we configure the writer for. Front camera at 720p portrait
    /// yields 720×1280 after the connection's 90° rotation. We read the ACTUAL buffer
    /// dimensions from the first frame instead of hard-coding, so a preset change can't
    /// silently produce a stretched recording.
    private var configuredDimensions: CMVideoDimensions?

    // MARK: - Lifecycle

    /// Begin recording. Allocates a fresh temp URL and lazily builds the writer on the
    /// first frame (so we can size it to the real buffer). Safe to call once per session.
    func start() {
        writerQueue.async { [weak self] in
            guard let self else { return }
            // Reset any prior session state.
            self.writer = nil
            self.videoInput = nil
            self.sessionStarted = false
            self.firstPTS = .invalid
            self.lastPTS = .invalid
            self.configuredDimensions = nil

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("motion-cam-\(UUID().uuidString).mov")
            // Clear any stale file at this URL (UUID makes this near-impossible, but cheap).
            try? FileManager.default.removeItem(at: url)
            self.outputURL = url

            self.setRecording(true)
        }
    }

    /// Stop recording and finalize the file. Returns the finished recording, or nil if
    /// nothing usable was captured (no frames / writer failure).
    func finish() async -> CameraRecording? {
        // Flip the recording flag first so `tap` stops appending immediately.
        setRecording(false)

        return await withCheckedContinuation { (cont: CheckedContinuation<CameraRecording?, Never>) in
            writerQueue.async { [weak self] in
                guard
                    let self,
                    let writer = self.writer,
                    let input = self.videoInput,
                    let url = self.outputURL,
                    self.sessionStarted,
                    writer.status == .writing
                else {
                    cont.resume(returning: nil)
                    return
                }
                input.markAsFinished()
                writer.endSession(atSourceTime: self.lastPTS)
                writer.finishWriting {
                    guard writer.status == .completed else {
                        cont.resume(returning: nil)
                        return
                    }
                    let first = self.firstPTS.seconds
                    let last = self.lastPTS.seconds
                    let duration = max(0, last - first)
                    cont.resume(returning: CameraRecording(
                        url: url,
                        firstFrameWallClockMs: self.firstFrameWallClockMs,
                        firstFramePTSSeconds: first,
                        durationSeconds: duration
                    ))
                }
            }
        }
    }

    /// Abort without producing a file (e.g. session cancelled). Cleans up the temp file.
    func cancel() {
        setRecording(false)
        writerQueue.async { [weak self] in
            guard let self else { return }
            if let writer = self.writer, writer.status == .writing {
                self.videoInput?.markAsFinished()
                writer.cancelWriting()
            }
            if let url = self.outputURL { try? FileManager.default.removeItem(at: url) }
            self.writer = nil
            self.videoInput = nil
            self.outputURL = nil
            self.sessionStarted = false
        }
    }

    // MARK: - CameraSampleBufferTap

    /// Called on the capture queue for every frame while the camera runs. We append only
    /// while recording; otherwise this is a single atomic bool read and return.
    func tap(sampleBuffer: CMSampleBuffer) {
        guard isRecording else { return }
        // Retain the buffer across the async hop; CMSampleBuffer is a CF type and the
        // capture pipeline recycles the backing memory once this callback returns.
        let retained = sampleBuffer
        writerQueue.async { [weak self] in
            self?.append(retained)
        }
    }

    // MARK: - Writer

    /// Lazily build the writer sized to the first frame, then append. Runs on `writerQueue`.
    private func append(_ sampleBuffer: CMSampleBuffer) {
        guard isRecording else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard pts.isValid else { return }

        // First frame: build the writer at the real buffer size + start the session.
        if writer == nil {
            let width = CVPixelBufferGetWidth(pixelBuffer)
            let height = CVPixelBufferGetHeight(pixelBuffer)
            guard buildWriter(width: width, height: height) else { return }
        }
        guard
            let writer,
            let input = videoInput,
            writer.status != .failed
        else { return }

        if !sessionStarted {
            // Start the writer's timeline at this first PTS and record the anchors.
            writer.startSession(atSourceTime: pts)
            sessionStarted = true
            firstPTS = pts
            firstFrameWallClockMs = Date().timeIntervalSince1970 * 1000.0
        }

        guard input.isReadyForMoreMediaData else {
            // Drop this frame rather than block the capture pipeline. At ~20–30 fps the
            // writer keeps up; an occasional drop is invisible and never stalls Vision.
            return
        }
        if input.append(sampleBuffer) {
            lastPTS = pts
        }
    }

    /// Create the asset writer + a real-time video input. Returns false on failure.
    private func buildWriter(width: Int, height: Int) -> Bool {
        guard let url = outputURL else { return false }
        guard let w = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return false }

        // H.264 at the buffer's native dimensions. The capture connection already baked
        // in portrait rotation + front-camera mirroring, so the written pixels are
        // upright and mirrored exactly like the preview — no transform needed here, and
        // the composite treats the camera track as identity-oriented.
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 6_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        // We feed real-time capture buffers; expedite so the writer doesn't stall capture.
        input.expectsMediaDataInRealTime = true

        guard w.canAdd(input) else { return false }
        w.add(input)
        guard w.startWriting() else { return false }

        self.writer = w
        self.videoInput = input
        self.configuredDimensions = CMVideoDimensions(width: Int32(width), height: Int32(height))
        return true
    }
}
