// PARKED for v2 (browser/relay path) — not used in v1 (v1 captures game + camera as one video via ReplayKit; no compositing).
//
//  CompositeExporter.swift
//  Motion
//
//  Composites the on-device camera `.mov` and the received gameplay clip into ONE
//  picture-in-picture video via `AVMutableComposition` + `AVMutableVideoComposition`,
//  then exports H.264/mp4 with `AVAssetExportSession`.
//
//  Layout (default): gameplay fills the frame; the player's camera is inset in a corner.
//  Configurable via `PiPLayout`.
//
//  ── CRITICAL: WebM FALLBACK ──────────────────────────────────────────────────────
//  AVFoundation CANNOT decode WebM/VP8/VP9. Browsers using MediaRecorder often produce
//  `video/webm`. If the received clip's mime is WebM we DO NOT attempt to load or
//  decode it (that would fail deep inside AVAsset with an opaque error). Instead we
//  fall back to exporting the CAMERA clip alone and surface a clear message telling the
//  user to use a display that records MP4. This fallback path is isolated below and
//  well-commented so it's obvious why it exists.
//
//  ── Time alignment ──────────────────────────────────────────────────────────────
//  Two independent recorders started at slightly different wall-clock instants. We
//  align them on a shared timeline anchored at the session's `RecControlMessage.anchorMs`:
//
//     cameraStartMsFromAnchor  = camera.firstFrameWallClockMs − sessionAnchorMs
//     gameplayStartMsFromAnchor = clip.startOffsetMs           (already anchor-relative)
//
//  Whichever started LATER defines t=0 of the composite; the earlier clip is trimmed at
//  its head by the difference so both are in phase. We then trim the tail to the shorter
//  of the two remaining durations so neither track outlives the other.
//

import AVFoundation
import CoreMedia
import Foundation

/// Where the camera inset sits and how big it is (fraction of the output width).
struct PiPLayout: Sendable {
    enum Corner: Sendable { case topLeading, topTrailing, bottomLeading, bottomTrailing }
    var corner: Corner = .bottomTrailing
    /// Inset width as a fraction of the full output width (height scales to keep aspect).
    var widthFraction: CGFloat = 0.28
    /// Margin from the edges, in output points.
    var margin: CGFloat = 32
    /// Corner-radius-like feel is skipped (layer instructions can't round-clip cheaply);
    /// we keep a hard rectangle for the MVP.

    static let `default` = PiPLayout()
}

/// Result of a composite/export attempt.
enum CompositeResult: Sendable {
    /// Full PiP composite succeeded; `url` is an mp4 in temp.
    case composited(url: URL)
    /// Gameplay was WebM (undecodable); we exported the CAMERA clip alone instead.
    /// `url` is that mp4; `message` explains the degraded result to the user.
    case cameraOnlyFallback(url: URL, message: String)
    /// Export failed.
    case failed(message: String)
}

enum CompositeExporter {

    /// True if AVFoundation can be expected to decode this container. WebM/VP8/VP9 → false.
    static func isDecodableByAVFoundation(mime: String) -> Bool {
        let m = mime.lowercased()
        if m.contains("webm") { return false }
        if m.contains("vp8") || m.contains("vp9") { return false }
        // mp4 / quicktime / h264 / hevc are all fine.
        return true
    }

    /// Composite camera + gameplay into one PiP mp4, or fall back to camera-only for WebM.
    ///
    /// - Parameters:
    ///   - camera: the finished on-device camera recording (always AVFoundation-friendly).
    ///   - clip: the reassembled gameplay clip (mime may be WebM).
    ///   - sessionAnchorMs: the `RecControlMessage.anchorMs` shared by both recorders.
    ///   - layout: PiP layout for the camera inset.
    static func export(
        camera: CameraRecording,
        clip: ReceivedClip,
        sessionAnchorMs: Double,
        layout: PiPLayout = .default
    ) async -> CompositeResult {

        // ── WebM fallback (isolated) ─────────────────────────────────────────────
        // Do NOT touch the WebM file with AVAsset — decode WILL fail. Export the camera
        // clip alone so the user still gets their performance, and tell them why.
        guard isDecodableByAVFoundation(mime: clip.mime) else {
            let message = "Gameplay clip was WebM; on-device compositing needs an MP4 " +
                "recording — use a Safari/Chrome display that records MP4. Saved your " +
                "camera clip on its own."
            if let url = await exportCameraOnly(camera: camera) {
                return .cameraOnlyFallback(url: url, message: message)
            }
            return .failed(message: message)
        }

        // ── Normal PiP composite ─────────────────────────────────────────────────
        let cameraAsset = AVURLAsset(url: camera.url)
        let gameplayAsset = AVURLAsset(url: clip.url)

        // Load video tracks (async — modern AVFoundation).
        guard
            let cameraTrack = await firstVideoTrack(of: cameraAsset),
            let gameplayTrack = await firstVideoTrack(of: gameplayAsset)
        else {
            // If the "MP4" turned out to be undecodable after all, degrade to camera-only.
            if let url = await exportCameraOnly(camera: camera) {
                return .cameraOnlyFallback(
                    url: url,
                    message: "Couldn't read the gameplay clip; saved your camera clip alone."
                )
            }
            return .failed(message: "Couldn't read either video track.")
        }

        // Natural sizes/transforms.
        let cameraNatural = await naturalSize(of: cameraTrack)
        let gameplayNatural = await naturalSize(of: gameplayTrack)
        let cameraTransform = await preferredTransform(of: cameraTrack)
        let gameplayTransform = await preferredTransform(of: gameplayTrack)
        let cameraDuration = (try? await cameraAsset.load(.duration)) ?? .zero
        let gameplayDuration = (try? await gameplayAsset.load(.duration)) ?? .zero

        // ── Alignment math ───────────────────────────────────────────────────────
        // Both offsets are measured in ms from the shared session anchor.
        let cameraStartMs = camera.firstFrameWallClockMs - sessionAnchorMs
        let gameplayStartMs = clip.startOffsetMs

        // The later start defines t=0; trim the earlier track's head by the difference.
        let cameraHeadTrimMs = max(0, gameplayStartMs - cameraStartMs)
        let gameplayHeadTrimMs = max(0, cameraStartMs - gameplayStartMs)

        let cameraHeadTrim = CMTime(seconds: cameraHeadTrimMs / 1000.0, preferredTimescale: 600)
        let gameplayHeadTrim = CMTime(seconds: gameplayHeadTrimMs / 1000.0, preferredTimescale: 600)

        // Remaining playable duration of each after the head trim.
        let cameraRemaining = CMTimeSubtract(cameraDuration, cameraHeadTrim)
        let gameplayRemaining = CMTimeSubtract(gameplayDuration, gameplayHeadTrim)
        // Overlap is the shorter of the two remaining spans (and must be positive).
        let overlap = CMTimeMinimum(cameraRemaining, gameplayRemaining)
        guard overlap.isValid, overlap.seconds > 0.05 else {
            // No meaningful overlap (clocks too far apart / one clip empty) → camera only.
            if let url = await exportCameraOnly(camera: camera) {
                return .cameraOnlyFallback(
                    url: url,
                    message: "Clips didn't overlap in time; saved your camera clip alone."
                )
            }
            return .failed(message: "Recordings didn't overlap in time.")
        }

        let composition = AVMutableComposition()
        guard
            let compCamera = composition.addMutableTrack(
                withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
            let compGameplay = composition.addMutableTrack(
                withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
        else {
            return .failed(message: "Couldn't build the composition.")
        }

        // Insert both trimmed ranges at composition t=0.
        do {
            try compGameplay.insertTimeRange(
                CMTimeRange(start: gameplayHeadTrim, duration: overlap),
                of: gameplayTrack, at: .zero)
            try compCamera.insertTimeRange(
                CMTimeRange(start: cameraHeadTrim, duration: overlap),
                of: cameraTrack, at: .zero)
        } catch {
            return .failed(message: "Couldn't assemble the composite timeline.")
        }

        // Optionally carry the gameplay audio if present (game SFX/music).
        if let gameplayAudio = await firstAudioTrack(of: gameplayAsset),
           let compAudio = composition.addMutableTrack(
                withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            try? compAudio.insertTimeRange(
                CMTimeRange(start: gameplayHeadTrim, duration: overlap),
                of: gameplayAudio, at: .zero)
        }

        // ── Render sizes (apply preferredTransform so rotated sources render upright) ──
        let gameplayRenderSize = applyingTransformSize(gameplayNatural, gameplayTransform)
        let cameraRenderSize = applyingTransformSize(cameraNatural, cameraTransform)

        // Output frame = gameplay's upright size (full-frame background).
        let outputSize = CGSize(
            width: abs(gameplayRenderSize.width).rounded(),
            height: abs(gameplayRenderSize.height).rounded())
        guard outputSize.width > 0, outputSize.height > 0 else {
            return .failed(message: "Gameplay clip had zero dimensions.")
        }

        // Gameplay layer instruction: apply its own transform so it renders upright,
        // full-frame at the origin.
        let gameplayLayer = AVMutableVideoCompositionLayerInstruction(assetTrack: compGameplay)
        gameplayLayer.setTransform(gameplayTransform, at: .zero)

        // Camera inset transform: start from the camera's upright transform, then scale
        // down to the inset width and translate into the chosen corner.
        let insetWidth = outputSize.width * layout.widthFraction
        let cameraUprightW = abs(cameraRenderSize.width)
        let cameraUprightH = abs(cameraRenderSize.height)
        let scale = cameraUprightW > 0 ? insetWidth / cameraUprightW : 1
        let insetHeight = cameraUprightH * scale

        let (tx, ty) = insetTranslation(
            corner: layout.corner, margin: layout.margin,
            outputSize: outputSize, insetWidth: insetWidth, insetHeight: insetHeight)

        // Compose: cameraTransform (upright) → scale → translate to corner.
        // Order matters: we scale in the upright space, THEN translate, THEN prepend the
        // upright-correcting transform so rotation happens first.
        var cameraFinal = cameraTransform
        cameraFinal = cameraFinal.concatenating(CGAffineTransform(scaleX: scale, y: scale))
        cameraFinal = cameraFinal.concatenating(CGAffineTransform(translationX: tx, y: ty))

        let cameraLayer = AVMutableVideoCompositionLayerInstruction(assetTrack: compCamera)
        cameraLayer.setTransform(cameraFinal, at: .zero)

        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: overlap)
        // Camera drawn ON TOP of gameplay → camera layer must come FIRST in the array
        // (AVFoundation renders layer instructions front-to-back by array order).
        instruction.layerInstructions = [cameraLayer, gameplayLayer]

        let videoComposition = AVMutableVideoComposition()
        videoComposition.instructions = [instruction]
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30) // 30 fps output
        videoComposition.renderSize = outputSize

        // ── Export ───────────────────────────────────────────────────────────────
        let outURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("motion-composite-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: outURL)

        guard let export = AVAssetExportSession(
            asset: composition, presetName: AVAssetExportPresetHighestQuality)
        else {
            return .failed(message: "Couldn't create the exporter.")
        }
        export.outputURL = outURL
        export.outputFileType = .mp4
        export.videoComposition = videoComposition
        export.shouldOptimizeForNetworkUse = true

        await runExport(export)
        switch export.status {
        case .completed:
            return .composited(url: outURL)
        default:
            let reason = export.error?.localizedDescription ?? "Unknown export error."
            return .failed(message: "Composite export failed: \(reason)")
        }
    }

    /// Run an export to completion. Uses the completion-handler API (available on iOS 17)
    /// bridged to async, so we don't depend on the iOS 18-only `export()` async method.
    private static func runExport(_ session: AVAssetExportSession) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { cont.resume() }
        }
    }

    // MARK: - Camera-only fallback export

    /// Re-encode the camera clip alone to an mp4 (Photos-friendly, and normalizes the
    /// container). Used for the WebM path and any degraded case.
    private static func exportCameraOnly(camera: CameraRecording) async -> URL? {
        let asset = AVURLAsset(url: camera.url)
        let outURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("motion-cam-only-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: outURL)

        guard let export = AVAssetExportSession(
            asset: asset, presetName: AVAssetExportPresetHighestQuality)
        else { return nil }
        export.outputURL = outURL
        export.outputFileType = .mp4
        await runExport(export)
        return export.status == .completed ? outURL : nil
    }

    // MARK: - Track helpers (async AVFoundation loading)

    private static func firstVideoTrack(of asset: AVAsset) async -> AVAssetTrack? {
        (try? await asset.loadTracks(withMediaType: .video))?.first
    }

    private static func firstAudioTrack(of asset: AVAsset) async -> AVAssetTrack? {
        (try? await asset.loadTracks(withMediaType: .audio))?.first
    }

    private static func naturalSize(of track: AVAssetTrack) async -> CGSize {
        (try? await track.load(.naturalSize)) ?? .zero
    }

    private static func preferredTransform(of track: AVAssetTrack) async -> CGAffineTransform {
        (try? await track.load(.preferredTransform)) ?? .identity
    }

    /// Size of a track's frame after its preferred transform (rotations swap w/h).
    private static func applyingTransformSize(_ size: CGSize, _ t: CGAffineTransform) -> CGSize {
        let rect = CGRect(origin: .zero, size: size).applying(t)
        return CGSize(width: rect.width, height: rect.height)
    }

    /// Translation to place an inset of `insetWidth`×`insetHeight` into a corner, in the
    /// output coordinate space (origin top-left in the video composition's convention).
    private static func insetTranslation(
        corner: PiPLayout.Corner, margin: CGFloat, outputSize: CGSize,
        insetWidth: CGFloat, insetHeight: CGFloat
    ) -> (CGFloat, CGFloat) {
        switch corner {
        case .topLeading:
            return (margin, margin)
        case .topTrailing:
            return (outputSize.width - insetWidth - margin, margin)
        case .bottomLeading:
            return (margin, outputSize.height - insetHeight - margin)
        case .bottomTrailing:
            return (outputSize.width - insetWidth - margin,
                    outputSize.height - insetHeight - margin)
        }
    }
}
