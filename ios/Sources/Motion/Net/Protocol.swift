//
//  Protocol.swift
//  Motion
//
//  Swift mirror of the shared wire protocol. The single source of truth is
//  `protocol/protocol.ts`; this file must stay byte-compatible with it so the
//  PartyKit relay and the browser display accept our messages unchanged.
//
//  Encoding rules that keep us in sync with the TS shapes:
//    • `v` is always the literal `PROTOCOL_VERSION` (1). We encode it explicitly.
//    • `type` is a fixed string per message, encoded as-is.
//    • Joints encode as `[Double]` (a 2-element `[x, y]`) to match the TS tuple
//      `[number, number]` — NOT as a nested {x, y} object.
//    • Field order is irrelevant for JSON equality; key names must match exactly.
//
//  Incoming server messages are decoded by first peeking at the `type` discriminator,
//  then decoding into the concrete struct (see `IncomingMessage`).
//

import Foundation

/// Bump in lockstep with `PROTOCOL_VERSION` in protocol.ts.
let PROTOCOL_VERSION = 1

/// Length of a room code (see `CODE_LENGTH` in protocol.ts).
let CODE_LENGTH = 6

/// No vowels or easily-confused chars (0/O, 1/I) — matches `CODE_ALPHABET` in protocol.ts.
let CODE_ALPHABET = "23456789BCDFGHJKLMNPQRSTVWXYZ"

/// True if `code` is a syntactically valid room code (case-insensitive).
func isValidRoomCode(_ code: String) -> Bool {
    guard code.count == CODE_LENGTH else { return false }
    let up = code.uppercased()
    return up.allSatisfy { CODE_ALPHABET.contains($0) }
}

// MARK: - Roles

enum Role: String, Codable, Sendable {
    case display
    case controller
}

// MARK: - Tracking state

/// Reason the controller has paused sending usable input. Mirrors `TrackingState`.
enum TrackingState: String, Codable, Sendable, CaseIterable {
    case ok
    case lost          // body not detected / confidence collapsed
    case partial       // some required joints missing
    case tooClose      = "too_close"
    case tooFar        = "too_far"
    case raisePhone    = "raise_phone"
    case lowLight      = "low_light"
}

// MARK: - Joints

/// The eight protocol joints, in the canonical iteration order (mirrors `JOINT_NAMES`).
enum JointName: String, Codable, Sendable, CaseIterable {
    case head
    case leftHand
    case rightHand
    case torso
    case leftKnee
    case rightKnee
    case leftFoot
    case rightFoot
}

/// A single normalized, mirror-corrected joint: `[x, y]` in 0..1, origin top-left.
typealias Point2 = [Double]

/// Normalized body joints. Encodes as an object of 2-element arrays to match the
/// TS `Joints` interface exactly.
struct Joints: Codable, Sendable {
    var head: Point2
    var leftHand: Point2
    var rightHand: Point2
    var torso: Point2
    var leftKnee: Point2
    var rightKnee: Point2
    var leftFoot: Point2
    var rightFoot: Point2

    /// Build from a keyed dictionary; any missing joint falls back to `[0, 0]`.
    init(from map: [JointName: Point2]) {
        func p(_ n: JointName) -> Point2 { map[n] ?? [0, 0] }
        head = p(.head)
        leftHand = p(.leftHand)
        rightHand = p(.rightHand)
        torso = p(.torso)
        leftKnee = p(.leftKnee)
        rightKnee = p(.rightKnee)
        leftFoot = p(.leftFoot)
        rightFoot = p(.rightFoot)
    }

    /// Keyed view, handy for the preview overlay and calibration math.
    var asMap: [JointName: Point2] {
        [
            .head: head, .leftHand: leftHand, .rightHand: rightHand, .torso: torso,
            .leftKnee: leftKnee, .rightKnee: rightKnee, .leftFoot: leftFoot, .rightFoot: rightFoot,
        ]
    }
}

// MARK: - Outbound messages (controller → server)

/// ~20/s pose packet. `sentAt` is our monotonic clock (ms) for latency math.
struct PosePacket: Codable, Sendable {
    let v: Int
    let type: String
    let seq: Int
    let sentAt: Double
    let quality: Double
    let joints: Joints

    init(seq: Int, sentAt: Double, quality: Double, joints: Joints) {
        self.v = PROTOCOL_VERSION
        self.type = "pose"
        self.seq = seq
        self.sentAt = sentAt
        self.quality = quality
        self.joints = joints
    }
}

/// Controller setup/tracking status, driving the display's readiness UI.
struct StatusMessage: Codable, Sendable {
    let v: Int
    let type: String
    let tracking: TrackingState
    let message: String?

    init(tracking: TrackingState, message: String? = nil) {
        self.v = PROTOCOL_VERSION
        self.type = "status"
        self.tracking = tracking
        self.message = message
    }
}

/// Emitted as the controller walks the 5-second calibration.
struct CalibMessage: Codable, Sendable {
    enum Stage: String, Codable, Sendable {
        case neutral, arms, squat, done
    }
    let v: Int
    let type: String
    let stage: Stage
    let progress: Double // 0..1 within the whole calibration

    init(stage: Stage, progress: Double) {
        self.v = PROTOCOL_VERSION
        self.type = "calib"
        self.stage = stage
        self.progress = progress
    }
}

/// Join handshake. The iOS app is always the `controller`.
struct JoinMessage: Codable, Sendable {
    let v: Int
    let type: String
    let role: Role
    let name: String?

    init(role: Role = .controller, name: String? = nil) {
        self.v = PROTOCOL_VERSION
        self.type = "join"
        self.role = role
        self.name = name
    }
}

/// Latency probe. We send `ping`; the server answers `pong` echoing `t`.
struct PingMessage: Codable, Sendable {
    let v: Int
    let type: String
    let t: Double

    init(t: Double) {
        self.v = PROTOCOL_VERSION
        self.type = "ping"
        self.t = t
    }
}

struct PongMessage: Codable, Sendable {
    let v: Int
    let type: String
    let t: Double

    init(t: Double) {
        self.v = PROTOCOL_VERSION
        self.type = "pong"
        self.t = t
    }
}

// MARK: - Recording messages (both directions; relayed passthrough)
//
// See the "Recording" block in protocol.ts. The phone (controller) records its own
// camera locally and NEVER transmits those frames; only the finished gameplay clip
// travels display → controller as a `recmeta` header followed by base64 `recchunk`s.
// `rec` control messages bracket both recorders with a shared `sessionId` + wall-clock
// `anchorMs` so the two clips can be aligned when compositing.

/// Arm/start/stop a recording session. Byte-compatible with `RecControlMessage`.
struct RecControlMessage: Codable, Sendable {
    enum Action: String, Codable, Sendable {
        case arm, start, stop, cancel
    }
    let v: Int
    let type: String
    let action: Action
    let sessionId: String
    /// Sender's `Date.now()` when this action fired — the sync anchor (ms since epoch).
    let anchorMs: Double

    init(action: Action, sessionId: String, anchorMs: Double) {
        self.v = PROTOCOL_VERSION
        self.type = "rec"
        self.action = action
        self.sessionId = sessionId
        self.anchorMs = anchorMs
    }
}

/// Header preceding a chunked gameplay-clip transfer (display → controller).
/// Byte-compatible with `RecMetaMessage`.
struct RecMetaMessage: Codable, Sendable {
    let v: Int
    let type: String
    let sessionId: String
    let mime: String          // e.g. "video/webm;codecs=vp9" or "video/mp4"
    let totalBytes: Int
    let chunks: Int           // number of RecChunkMessages to expect
    let durationMs: Double    // gameplay clip duration
    /// ms from the session anchor to the first recorded gameplay frame (for sync).
    let startOffsetMs: Double
}

/// One base64 slice of the gameplay clip (display → controller).
/// Byte-compatible with `RecChunkMessage`.
struct RecChunkMessage: Codable, Sendable {
    let v: Int
    let type: String
    let sessionId: String
    let i: Int                // 0-based chunk index
    let data: String          // base64 of this slice
}

// MARK: - Inbound messages (server → controller)

/// Presence: the peer of a given role connected or dropped.
struct PeerMessage: Codable, Sendable {
    let v: Int
    let type: String
    let role: Role
    let connected: Bool
}

/// Display asks the game to begin (relayed to us as a cue to start streaming poses).
struct StartMessage: Codable, Sendable {
    let v: Int
    let type: String
}

/// Room-level errors (e.g. a second controller tried to join).
struct ErrorMessage: Codable, Sendable {
    enum Code: String, Codable, Sendable {
        case roomFull        = "room_full"
        case badRole         = "bad_role"
        case badMessage      = "bad_message"
        case versionMismatch = "version_mismatch"
    }
    let v: Int
    let type: String
    let code: Code
    let message: String
}

// MARK: - Inbound decoding

/// The subset of server → controller messages we act on. Decoded by peeking at `type`.
enum IncomingMessage: Sendable {
    case peer(PeerMessage)
    case start(StartMessage)
    case error(ErrorMessage)
    case pong(PongMessage)
    /// Display → controller recording control (arm/start/stop/cancel).
    case recControl(RecControlMessage)
    /// Display → controller: gameplay-clip transfer header.
    case recMeta(RecMetaMessage)
    /// Display → controller: one base64 slice of the gameplay clip.
    case recChunk(RecChunkMessage)
    /// Well-formed but not one we handle (e.g. a relayed status echo). Ignored.
    case unknown(type: String)

    /// Peek only at `type` so we can pick the right concrete decoder.
    private struct TypeProbe: Decodable { let type: String }

    /// Decode a raw JSON text frame into a known incoming message, or `nil` if malformed.
    static func decode(from data: Data) -> IncomingMessage? {
        let decoder = JSONDecoder()
        guard let probe = try? decoder.decode(TypeProbe.self, from: data) else { return nil }
        switch probe.type {
        case "peer":
            return (try? decoder.decode(PeerMessage.self, from: data)).map(IncomingMessage.peer)
        case "start":
            return (try? decoder.decode(StartMessage.self, from: data)).map(IncomingMessage.start)
        case "error":
            return (try? decoder.decode(ErrorMessage.self, from: data)).map(IncomingMessage.error)
        case "pong":
            return (try? decoder.decode(PongMessage.self, from: data)).map(IncomingMessage.pong)
        case "rec":
            return (try? decoder.decode(RecControlMessage.self, from: data)).map(IncomingMessage.recControl)
        case "recmeta":
            return (try? decoder.decode(RecMetaMessage.self, from: data)).map(IncomingMessage.recMeta)
        case "recchunk":
            return (try? decoder.decode(RecChunkMessage.self, from: data)).map(IncomingMessage.recChunk)
        default:
            return .unknown(type: probe.type)
        }
    }
}

// MARK: - Encoding helpers

enum WireCoder {
    /// A shared encoder. Default (non-sorted, non-pretty) output is the smallest and
    /// matches what the relay expects — key order does not affect JSON equality.
    static let encoder = JSONEncoder()

    /// Encode an outbound message to a compact JSON string suitable for a WebSocket text frame.
    static func encodeToString<T: Encodable>(_ value: T) throws -> String {
        let data = try encoder.encode(value)
        // The relay only accepts text frames; force UTF-8 (JSON is always UTF-8).
        return String(decoding: data, as: UTF8.self)
    }
}
