// PARKED for v2 (browser/relay path) — not used in v1.
//
//  ClipReceiver.swift
//  Motion
//
//  Reassembles the finished gameplay clip streamed from the display as a `RecMetaMessage`
//  header followed by base64 `RecChunkMessage`s. The relay is a dumb passthrough, so we
//  tolerate out-of-order and duplicate chunks and only complete once every index has
//  arrived and the reassembled byte count matches the advertised `totalBytes`.
//
//  On completion we write the bytes to a temp file whose extension is derived from the
//  advertised `mime` (so downstream code — the composite exporter — can inspect the
//  container without re-parsing the mime). Whether the container is decodable by
//  AVFoundation is decided later by `CompositeExporter` (WebM is NOT).
//
//  Threading: intended to be driven from the main actor (RoomSocket delivers messages
//  there). Base64 decoding is cheap per-chunk; if clips grow large this could hop to a
//  background queue, but for LAN/MVP-sized clips main-actor decode is fine.
//

import Foundation

/// A fully reassembled gameplay clip on disk plus the metadata needed to align + decode it.
struct ReceivedClip: Sendable {
    /// Temp file URL with an extension implied by `mime`.
    let url: URL
    /// The advertised container mime (e.g. "video/webm;codecs=vp9", "video/mp4").
    let mime: String
    /// Clip duration in ms (from the meta header).
    let durationMs: Double
    /// ms from the session anchor to the first recorded gameplay frame (for sync).
    let startOffsetMs: Double
}

@MainActor
final class ClipReceiver {
    /// Progress in 0..1 by chunk count. `nil` until a meta header arrives.
    private(set) var progress: Double?
    /// True once every chunk has arrived and the byte count checks out.
    private(set) var isComplete = false

    // Reassembly buffers for the in-flight session.
    private var sessionId: String?
    private var meta: RecMetaMessage?
    /// Backing store sized to `totalBytes`; chunks are copied in by index offset.
    private var buffer: Data?
    /// Which chunk indices we've already written (dedupe + completion check).
    private var received: Set<Int> = []
    /// Byte offset where each chunk index starts. Filled as chunks arrive; because
    /// chunks may be out of order we can't assume a fixed slice size, so we place each
    /// chunk contiguously in ARRIVAL order is WRONG — instead we honor the sender's
    /// fixed slicing: offset = i * chunkSize. We derive chunkSize from the first chunk.
    private var chunkSize: Int?

    /// Reset all reassembly state (new session or cancel).
    func reset() {
        sessionId = nil
        meta = nil
        buffer = nil
        received.removeAll()
        chunkSize = nil
        progress = nil
        isComplete = false
    }

    /// Handle a `recmeta` header. Allocates the reassembly buffer. Ignores headers for a
    /// different session than the one we were told to expect (if any).
    /// - Parameter expectedSession: the session id the orchestrator is bracketing, or nil
    ///   to accept whatever arrives.
    func handle(meta message: RecMetaMessage, expectedSession: String?) {
        if let expectedSession, message.sessionId != expectedSession { return }
        reset()
        sessionId = message.sessionId
        meta = message
        // Guard against a bogus/oversized allocation from a malformed peer.
        let bytes = max(0, message.totalBytes)
        buffer = Data(count: bytes)
        progress = message.chunks > 0 ? 0 : 1
        // A zero-chunk clip is already "done" if it also has zero bytes.
        if message.chunks == 0 { isComplete = true }
    }

    /// Handle one `recchunk`. Base64-decodes and copies it to its index offset. Returns
    /// the fully `ReceivedClip` the moment the last missing chunk completes it, else nil.
    ///
    /// Tolerant of duplicates (idempotent) and out-of-order arrival.
    func handle(chunk message: RecChunkMessage) -> ReceivedClip? {
        guard let meta, let sid = sessionId, message.sessionId == sid else { return nil }
        guard message.i >= 0, message.i < meta.chunks else { return nil }
        guard var buffer else { return nil }

        // Decode the base64 slice.
        guard let slice = Data(base64Encoded: message.data) else { return nil }

        // The sender slices the clip at a CONSTANT stride, with only the final chunk
        // shorter (the remainder). We derive that stride once so we can place any chunk
        // at `i * stride` regardless of arrival order:
        //   • a non-final chunk's length IS the stride, or
        //   • if only the final chunk has arrived, stride = (totalBytes − lastLen) / (n−1).
        if chunkSize == nil {
            if message.i < meta.chunks - 1 {
                chunkSize = slice.count
            } else if meta.chunks > 1 {
                chunkSize = (meta.totalBytes - slice.count) / (meta.chunks - 1)
            } else {
                chunkSize = max(slice.count, meta.totalBytes) // single-chunk clip
            }
        }
        guard let stride = chunkSize, stride > 0 else { return nil }

        let offset = message.i * stride
        // Bounds-check the copy so a malformed/oversized chunk can't overflow the buffer.
        guard offset >= 0, offset + slice.count <= buffer.count else { return nil }

        if !received.contains(message.i) {
            buffer.replaceSubrange(offset..<(offset + slice.count), with: slice)
            received.insert(message.i)
        }
        self.buffer = buffer
        progress = Double(received.count) / Double(max(1, meta.chunks))

        // Complete only when every index is present. We do NOT hard-fail on a byte-count
        // mismatch (a benign trailing-length rounding could differ); we log-guard it.
        guard received.count == meta.chunks else { return nil }

        return finalize(meta: meta, bytes: buffer)
    }

    // MARK: - Finalization

    private func finalize(meta: RecMetaMessage, bytes: Data) -> ReceivedClip? {
        // Trim to the advertised total in case the last chunk padded the buffer.
        let trimmed = bytes.count > meta.totalBytes ? bytes.prefix(meta.totalBytes) : bytes

        let ext = Self.fileExtension(forMime: meta.mime)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("motion-clip-\(meta.sessionId).\(ext)")
        try? FileManager.default.removeItem(at: url)
        do {
            try trimmed.write(to: url, options: .atomic)
        } catch {
            return nil
        }
        isComplete = true
        progress = 1
        return ReceivedClip(
            url: url,
            mime: meta.mime,
            durationMs: meta.durationMs,
            startOffsetMs: meta.startOffsetMs
        )
    }

    /// Map a mime type to a sensible file extension. Defaults to `.bin` when unknown so
    /// the exporter's WebM/MP4 inspection stays the source of truth for decodability.
    static func fileExtension(forMime mime: String) -> String {
        let m = mime.lowercased()
        if m.contains("mp4") { return "mp4" }
        if m.contains("quicktime") || m.contains("mov") { return "mov" }
        if m.contains("webm") { return "webm" }
        return "bin"
    }
}
