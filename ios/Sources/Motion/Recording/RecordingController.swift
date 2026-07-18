// PARKED for v2 (browser/relay path) — not used in v1 (v1 uses Recording/ScreenRecorder.swift).
//
//  RecordingController.swift
//  Motion
//
//  Orchestrates the on-device "person + gameplay" recording flow:
//
//    1. User toggles "Record" → we ARM (tell the display, wire the camera tap).
//    2. Display sends `rec start` (bracketed to when its own canvas recorder starts) →
//       we start the local `CameraRecorder`.
//    3. Display sends `rec stop` → we stop the camera recorder, then wait for the
//       gameplay clip to arrive as `recmeta` + `recchunk`s (driven into `ClipReceiver`).
//    4. Once both the camera file and the gameplay clip are in hand, run
//       `CompositeExporter` (PiP, or WebM camera-only fallback), then save to Photos.
//
//  All UI-facing state lives here (@Observable/@MainActor). The heavy camera-writer and
//  export work happens off the main actor inside the recorder/exporter.
//
//  PRIVACY: the camera file is local-only; only the FINISHED gameplay clip is received.
//  We never send camera frames anywhere.
//

import Foundation
import Observation
import Photos

@MainActor
@Observable
final class RecordingController {

    /// Coarse state machine surfaced to the UI.
    enum State: Sendable, Equatable {
        case idle              // not recording
        case armed             // user opted in; waiting for the display to start
        case recording         // camera recording locally, gameplay in progress
        case receiving(Double) // gameplay clip transferring (0..1 progress)
        case compositing       // building the PiP video / exporting
        case saved             // saved to Photos
        case failed(String)    // something went wrong (message for the UI)
    }

    private(set) var state: State = .idle
    /// Whether recording is currently opted-in / in-flight (drives the toggle's on state).
    /// Terminal states (`saved`/`failed`) read as OFF so the toggle resets cleanly.
    var isArmed: Bool {
        switch state {
        case .armed, .recording, .receiving, .compositing: return true
        case .idle, .saved, .failed: return false
        }
    }

    /// URL of the last successfully saved composite/camera video (for the "open" button).
    private(set) var lastSavedURL: URL?
    /// A user-facing note (e.g. the WebM fallback explanation), cleared on the next run.
    private(set) var note: String?

    // Collaborators.
    private let camera: CameraRecorder
    private let clipReceiver = ClipReceiver()
    /// Weak back-references wired by AppModel so we can send control frames + tap frames.
    private weak var socketSender: RecControlSender?
    private weak var cameraTapHost: CameraTapHost?

    // In-flight session bookkeeping.
    private var sessionId: String?
    private var sessionAnchorMs: Double?
    private var cameraRecording: CameraRecording?

    init(camera: CameraRecorder = CameraRecorder()) {
        self.camera = camera
    }

    /// Wire the controller to the socket (to send `rec` frames) and the camera (to tap
    /// its sample buffers). Called by AppModel once a `PoseSession` exists.
    func attach(sender: RecControlSender, tapHost: CameraTapHost) {
        self.socketSender = sender
        self.cameraTapHost = tapHost
    }

    // MARK: - User actions

    /// Toggle the "Record" opt-in. From a resting state (idle/saved/failed) this arms and
    /// tells the display; from any active state it disarms + cancels.
    func toggle() {
        if isArmed { disarm() } else { arm() }
    }

    /// Arm: install the camera tap and tell the display we want to record this game.
    private func arm() {
        let sid = UUID().uuidString
        let anchor = Self.nowWallMs()
        sessionId = sid
        sessionAnchorMs = anchor
        note = nil
        lastSavedURL = nil
        clipReceiver.reset()
        cameraRecording = nil

        // Install the tap so the recorder receives buffers once it starts writing.
        cameraTapHost?.setSampleBufferTap(camera)
        socketSender?.sendRecControl(.init(action: .arm, sessionId: sid, anchorMs: anchor))
        state = .armed
    }

    /// Disarm / cancel: stop everything, remove the tap, tell the display.
    func disarm() {
        if let sid = sessionId {
            socketSender?.sendRecControl(.init(action: .cancel, sessionId: sid, anchorMs: Self.nowWallMs()))
        }
        camera.cancel()
        cameraTapHost?.setSampleBufferTap(nil)
        clipReceiver.reset()
        sessionId = nil
        sessionAnchorMs = nil
        cameraRecording = nil
        state = .idle
    }

    // MARK: - Inbound control (from the display, via AppModel/RoomSocket)

    /// React to a `rec` control frame relayed from the display.
    func handle(control: RecControlMessage) {
        switch control.action {
        case .arm:
            // Display can also initiate arming. Adopt its session id + anchor if we're idle.
            if case .idle = state {
                sessionId = control.sessionId
                sessionAnchorMs = control.anchorMs
                clipReceiver.reset()
                cameraTapHost?.setSampleBufferTap(camera)
                state = .armed
            }
        case .start:
            startRecording(sessionId: control.sessionId, anchorMs: control.anchorMs)
        case .stop:
            Task { await stopRecording() }
        case .cancel:
            disarm()
        }
    }

    /// Feed a gameplay-clip header. Allocates the reassembly buffer.
    func handle(meta: RecMetaMessage) {
        // A zero-chunk clip completes immediately; capture that finalized clip.
        // ClipReceiver only returns the clip on a completing chunk, so for the (rare)
        // zero-chunk case we simply mark receiving; maybeComposite tolerates a nil clip.
        clipReceiver.handle(meta: meta, expectedSession: sessionId)
        if case .compositing = state { return }
        state = .receiving(clipReceiver.progress ?? 0)
        maybeComposite()
    }

    /// Feed one gameplay-clip chunk. Kicks off compositing when the clip completes.
    func handle(chunk: RecChunkMessage) {
        if let clip = clipReceiver.handle(chunk: chunk) {
            completedClip = clip
        }
        if case .compositing = state { return }
        state = .receiving(clipReceiver.progress ?? 0)
        if completedClip != nil { maybeComposite() }
    }

    // MARK: - Recording lifecycle

    private func startRecording(sessionId sid: String, anchorMs: Double) {
        // Only start if this matches our armed session (or adopt if the display drives it).
        if sessionId == nil { sessionId = sid; sessionAnchorMs = anchorMs }
        guard sessionId == sid else { return }
        camera.start()
        state = .recording
    }

    private func stopRecording() async {
        guard case .recording = state else { return }
        let recording = await camera.finish()
        cameraRecording = recording
        // The gameplay clip may already have fully arrived, or may still be transferring.
        if recording == nil {
            state = .failed("Camera recording produced no video.")
            cameraTapHost?.setSampleBufferTap(nil)
            return
        }
        // Transition to receiving/compositing depending on clip readiness.
        state = .receiving(clipReceiver.progress ?? 0)
        maybeComposite()
    }

    // MARK: - Composite + save

    /// Run the composite once BOTH the camera recording and the full gameplay clip exist.
    /// Idempotent + order-independent: called after the camera finishes AND after each
    /// clip chunk, so whichever completes last actually triggers the export.
    private func maybeComposite() {
        if case .compositing = state { return }            // already running
        guard let cameraRecording else { return }          // camera not finished yet
        guard clipReceiver.isComplete else { return }       // clip still arriving
        guard let clip = completedClip else { return }      // finalized clip in hand
        guard let anchor = sessionAnchorMs else { return }

        state = .compositing
        cameraTapHost?.setSampleBufferTap(nil) // no longer need the tap

        Task { [weak self] in
            let result = await CompositeExporter.export(
                camera: cameraRecording, clip: clip, sessionAnchorMs: anchor)
            await self?.finish(with: result)
        }
    }

    /// Stash the finalized clip so `maybeComposite` can use it regardless of arrival order.
    private var completedClip: ReceivedClip?

    private func finish(with result: CompositeResult) async {
        switch result {
        case .composited(let url):
            await save(url: url, note: nil)
        case .cameraOnlyFallback(let url, let message):
            await save(url: url, note: message)
        case .failed(let message):
            state = .failed(message)
            cleanupSession()
        }
    }

    /// Save a finished video to the Photos library, requesting add-only permission first.
    private func save(url: URL, note: String?) async {
        self.note = note
        let status = await requestPhotosAddPermission()
        guard status == .authorized || status == .limited else {
            state = .failed("Photos access denied — enable it in Settings to save your clip.")
            cleanupSession()
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
        cleanupSession()
    }

    /// Request ADD-ONLY Photos authorization (matches `NSPhotoLibraryAddUsageDescription`).
    private func requestPhotosAddPermission() async -> PHAuthorizationStatus {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if current == .notDetermined {
            return await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        }
        return current
    }

    /// Clear per-session scratch state but keep `lastSavedURL`/`note` for the UI.
    private func cleanupSession() {
        camera.cancel()
        clipReceiver.reset()
        completedClip = nil
        sessionId = nil
        sessionAnchorMs = nil
        cameraRecording = nil
    }

    // MARK: - Time

    /// Wall-clock ms since epoch — same basis as the display's `Date.now()` anchors.
    static func nowWallMs() -> Double { Date().timeIntervalSince1970 * 1000.0 }
}

// MARK: - Collaborator protocols (kept here so Recording/ is self-contained)

/// Lets the controller send `rec` control frames without importing RoomSocket internals.
@MainActor
protocol RecControlSender: AnyObject {
    func sendRecControl(_ message: RecControlMessage)
}

/// Lets the controller install/remove the camera sample-buffer tap.
@MainActor
protocol CameraTapHost: AnyObject {
    func setSampleBufferTap(_ tap: CameraSampleBufferTap?)
}
