//
//  ScreenRecorder.swift
//  Motion
//
//  ═══════════════════════════════════════════════════════════════════════════════════
//  KEY ON-DEVICE RISK — READ BEFORE TRUSTING THIS RECORDER
//  ═══════════════════════════════════════════════════════════════════════════════════
//  This is the v1 recorder. It uses ReplayKit in-app capture
//  (`RPScreenRecorder.shared().startCapture`) to record the WHOLE APP SCREEN — the
//  full-screen WKWebView game AND the small camera-preview inset overlaid on top — into
//  ONE mp4 via AVAssetWriter, then saves it to Photos. That gives "person + gameplay
//  together" with NO compositing.
//
//  The risk that MUST be verified on a physical device:
//    1. Does ReplayKit's screen capture actually include WKWebView WEB CONTENT? WKWebView
//       renders out-of-process (the WebContent process), and some system screen-capture
//       paths have historically shown other apps' out-of-process/secure surfaces as blank.
//       In-app ReplayKit generally DOES capture WKWebView, but this has NOT been proven on
//       THIS project's device/OS yet — confirm the game canvas appears in the saved video.
//    2. Does the capture include the `AVCaptureVideoPreviewLayer` camera inset? Preview
//       layers are backed by the render server; ReplayKit captures the composited UIWindow,
//       so the inset SHOULD appear — but confirm it's not blank/black.
//
//  DOCUMENTED FALLBACK if the webview shows blank in the recording on-device:
//    • Render the camera inset + a NATIVE score/HUD overlay (SwiftUI) and accept that the
//      game canvas won't be in the video, OR
//    • Switch GameConfig.source to `.bundled` (a file:// load): a same-process/local origin
//      is more reliably captured than a remote dev-server origin in some configurations.
//  See the TODO at the bottom of this file. Do NOT silently assume capture works.
//  ═══════════════════════════════════════════════════════════════════════════════════
//
//  Bracketing: the recorder is ARMED by the on-screen Record toggle, then started by the
//  web `gameStart` event and stopped by `gameOver` (both routed via PoseBridge). Capture
//  is VIDEO ONLY (no microphone) to keep permissions minimal — only the existing
//  `NSPhotoLibraryAddUsageDescription` (for the Photos save) is needed.
//
//  Threading: `ScreenRecorder` is `@MainActor @Observable` for UI-facing state. All
//  AVAssetWriter work lives in `ScreenWriter`, a Sendable helper that runs entirely on its
//  own serial queue (ReplayKit delivers sample buffers on an arbitrary queue). The main
//  actor never touches writer internals; it only awaits results.
//

import AVFoundation
import Foundation
import Observation
import Photos
import ReplayKit

@MainActor
@Observable
final class ScreenRecorder {

    /// Coarse state surfaced to the UI.
    enum State: Sendable, Equatable {
        case idle           // not recording; not armed
        case armed          // user opted in; waiting for the game to start
        case recording      // ReplayKit capture running, writing to the mp4
        case saving         // capture stopped; finalizing + saving to Photos
        case saved          // saved to Photos
        case failed(String) // something went wrong (message for the UI)
    }

    private(set) var state: State = .idle
    /// URL of the last successfully saved video (for an "open" button).
    private(set) var lastSavedURL: URL?

    /// Whether recording is opted-in / in-flight (drives the toggle's on state). Terminal
    /// states (`saved`/`failed`) read as OFF so the toggle resets cleanly.
    var isArmed: Bool {
        switch state {
        case .armed, .recording, .saving: return true
        case .idle, .saved, .failed: return false
        }
    }

    private let recorder = RPScreenRecorder.shared()
    /// Off-actor writer; nil between sessions.
    private var writer: ScreenWriter?

    init() {}

    // MARK: - Arm / disarm (user toggle)

    /// Toggle the Record opt-in. From a resting state this arms; from any active state it
    /// disarms (and stops capture if it was running).
    func toggle() {
        if isArmed { disarm() } else { arm() }
    }

    /// Arm: opt in to recording the next game. Actual capture starts on `gameStart`.
    func arm() {
        // From any resting state (idle/saved/failed) → armed.
        switch state {
        case .idle, .saved, .failed: state = .armed
        default: break
        }
    }

    /// Disarm / cancel. Stops capture if running (discarding the file) and resets to idle.
    func disarm() {
        switch state {
        case .recording:
            let writer = self.writer
            recorder.stopCapture { _ in
                writer?.discard()
            }
            self.writer = nil
            state = .idle
        case .armed, .saving, .idle, .saved, .failed:
            self.writer?.discard()
            self.writer = nil
            state = .idle
        }
    }

    // MARK: - Game lifecycle (from PoseBridge)

    /// Called on the web `gameStart` event. Starts ReplayKit capture IF armed.
    func gameDidStart() {
        guard case .armed = state else { return }
        startCapture()
    }

    /// Called on the web `gameOver` event. Stops capture + saves IF we were recording.
    func gameDidEnd() {
        guard case .recording = state else { return }
        stopCaptureAndSave()
    }

    // MARK: - Capture

    private func startCapture() {
        guard recorder.isAvailable else {
            state = .failed("Screen recording isn't available on this device.")
            return
        }
        // Video only — no mic — so we need no microphone permission.
        recorder.isMicrophoneEnabled = false

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("motion-screen-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: url)
        let writer = ScreenWriter(outputURL: url)
        self.writer = writer

        // `startCapture` delivers sample buffers of type .video (screen), .audioApp, and
        // .audioMic. We only keep .video. The sample handler is called on an arbitrary
        // queue; `ScreenWriter` hops it onto its own serial queue.
        recorder.startCapture { sampleBuffer, bufferType, error in
            guard error == nil, bufferType == .video else { return }
            writer.append(sampleBuffer)
        } completionHandler: { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.writer?.discard()
                    self.writer = nil
                    self.state = .failed("Couldn't start recording: \(error.localizedDescription)")
                } else {
                    self.state = .recording
                }
            }
        }
    }

    private func stopCaptureAndSave() {
        state = .saving
        recorder.stopCapture { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.writer?.discard()
                    self.writer = nil
                    self.state = .failed("Recording failed: \(error.localizedDescription)")
                    return
                }
                await self.finishAndSave()
            }
        }
    }

    private func finishAndSave() async {
        guard let writer else {
            state = .failed("Recording produced no video.")
            return
        }
        let url = await writer.finish()
        self.writer = nil
        guard let url else {
            state = .failed("Recording produced no video.")
            return
        }
        await save(url: url)
    }

    // MARK: - Save

    /// Save a finished mp4 to Photos (add-only authorization).
    private func save(url: URL) async {
        let status = await requestPhotosAddPermission()
        guard status == .authorized || status == .limited else {
            state = .failed("Photos access denied — enable it in Settings to save your clip.")
            return
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let req = PHAssetCreationRequest.forAsset()
                req.addResource(with: .video, fileURL: url, options: nil)
            }
            lastSavedURL = url
            state = .saved
        } catch {
            state = .failed("Couldn't save to Photos: \(error.localizedDescription)")
        }
    }

    private func requestPhotosAddPermission() async -> PHAuthorizationStatus {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if current == .notDetermined {
            return await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        }
        return current
    }

    // TODO(on-device verify): confirm ReplayKit capture includes the WKWebView game canvas
    // AND the AVCaptureVideoPreviewLayer camera inset in the SAVED video. If the game canvas
    // is blank, switch GameConfig.source to .bundled (file:// load) and/or fall back to a
    // native camera-inset + HUD overlay (drop the webview from the captured frame). See the
    // header block above for the full fallback plan.
}

// MARK: - Off-actor asset writer

/// Owns the `AVAssetWriter` for a single screen-capture session. All state is touched only
/// on `queue`, so the type is safely `@unchecked Sendable`. ReplayKit's sample-buffer
/// callback (any queue) calls `append`; the main actor awaits `finish` or fires `discard`.
private final class ScreenWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.motion.screenrecorder.writer")
    private let outputURL: URL

    // Touched only on `queue`.
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var sessionStarted = false

    init(outputURL: URL) {
        self.outputURL = outputURL
    }

    /// Append one screen video sample buffer. Lazily builds the writer sized to the first
    /// frame's real dimensions, then starts the writer session at that frame's PTS.
    func append(_ sampleBuffer: CMSampleBuffer) {
        // Retain across the async hop — the capture pipeline recycles the backing memory
        // once the callback returns.
        let retained = sampleBuffer
        queue.async { [weak self] in
            guard let self else { return }
            guard CMSampleBufferDataIsReady(retained) else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(retained)
            guard pts.isValid else { return }

            if self.writer == nil {
                guard let pixelBuffer = CMSampleBufferGetImageBuffer(retained) else { return }
                let width = CVPixelBufferGetWidth(pixelBuffer)
                let height = CVPixelBufferGetHeight(pixelBuffer)
                guard self.buildWriter(width: width, height: height) else { return }
            }
            guard let writer = self.writer, let input = self.videoInput,
                  writer.status != .failed else { return }

            if !self.sessionStarted {
                writer.startSession(atSourceTime: pts)
                self.sessionStarted = true
            }
            guard input.isReadyForMoreMediaData else { return } // drop rather than block
            input.append(retained)
        }
    }

    /// Finalize the mp4. Returns the output URL on success, or nil if nothing usable was
    /// written / the writer failed.
    func finish() async -> URL? {
        await withCheckedContinuation { (cont: CheckedContinuation<URL?, Never>) in
            queue.async { [weak self] in
                guard let self, let writer = self.writer, let input = self.videoInput,
                      self.sessionStarted, writer.status == .writing else {
                    cont.resume(returning: nil)
                    return
                }
                input.markAsFinished()
                writer.finishWriting {
                    cont.resume(returning: writer.status == .completed ? self.outputURL : nil)
                }
            }
        }
    }

    /// Abort without saving (cancel / failure), removing the temp file.
    func discard() {
        queue.async { [weak self] in
            guard let self else { return }
            if let writer = self.writer, writer.status == .writing {
                self.videoInput?.markAsFinished()
                writer.cancelWriting()
            }
            try? FileManager.default.removeItem(at: self.outputURL)
            self.writer = nil
            self.videoInput = nil
            self.sessionStarted = false
        }
    }

    /// Create the writer + a real-time video input sized to the screen. Runs on `queue`.
    private func buildWriter(width: Int, height: Int) -> Bool {
        guard let w = try? AVAssetWriter(outputURL: outputURL, fileType: .mp4) else { return false }
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 10_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard w.canAdd(input) else { return false }
        w.add(input)
        guard w.startWriting() else { return false }
        writer = w
        videoInput = input
        return true
    }
}
