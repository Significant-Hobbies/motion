// Motion wire protocol — v1
//
// One relay room per session. A `display` (browser) creates the room and shows a
// six-character code; a `controller` (iPhone) joins with that code. The server is a
// dumb relay: it tracks the two roles, forwards pose packets controller→display, and
// broadcasts presence. All game state lives on the display.
//
// This file is the single source of truth for the protocol. The web client and the
// PartyKit server both import it directly. The iOS app mirrors the `PosePacket` and
// `JoinMessage` shapes in Swift (see ios/Sources/Motion/Net/Protocol.swift) — keep
// the two in sync when bumping PROTOCOL_VERSION.

export const PROTOCOL_VERSION = 1;

/** Roles a socket can claim in a room. */
export type Role = "display" | "controller";

/** Normalized, mirror-corrected body joints. Each is [x, y] in 0..1, origin top-left. */
export interface Joints {
  head: [number, number];
  leftHand: [number, number];
  rightHand: [number, number];
  torso: [number, number];
  leftKnee: [number, number];
  rightKnee: [number, number];
  leftFoot: [number, number];
  rightFoot: [number, number];
}

/** Every joint name, handy for iteration/validation. */
export const JOINT_NAMES: (keyof Joints)[] = [
  "head",
  "leftHand",
  "rightHand",
  "torso",
  "leftKnee",
  "rightKnee",
  "leftFoot",
  "rightFoot",
];

/** Reason the controller has paused sending usable input. */
export type TrackingState =
  | "ok"
  | "lost" // body not detected / confidence collapsed
  | "partial" // some required joints missing
  | "too_close"
  | "too_far"
  | "raise_phone"
  | "low_light";

// ── Controller → server → display ───────────────────────────────────────────

/**
 * Per-hand openness, from Vision hand-pose detection on the phone.
 * 0 = closed fist … 1 = fully open palm. Used for grab/release interaction.
 * `left`/`right` are the player's own hands (already mirror-corrected, matching
 * `joints.leftHand`/`rightHand`).
 */
export interface HandState {
  left: number;
  right: number;
}

/** ~20/s. `sentAt` is the controller's monotonic clock (ms) for latency math. */
export interface PosePacket {
  v: 1;
  type: "pose";
  seq: number;
  sentAt: number;
  quality: number; // 0..1 aggregate confidence
  joints: Joints;
  /** Optional hand open/close (added v1.1, backward-compatible). Absent = unknown. */
  hands?: HandState;
}

/** Controller setup/tracking status, driving the display's readiness UI. */
export interface StatusMessage {
  v: 1;
  type: "status";
  tracking: TrackingState;
  message?: string;
}

/** Emitted as the controller walks the 5-second calibration. */
export interface CalibMessage {
  v: 1;
  type: "calib";
  stage: "neutral" | "arms" | "squat" | "done";
  progress: number; // 0..1 within the whole calibration
}

// ── Display → server ─────────────────────────────────────────────────────────

/** Display asks the display-owned game to begin (relayed to controller as a cue). */
export interface StartMessage {
  v: 1;
  type: "start";
}

// ── Recording (co-op replay: person + gameplay in one on-device video) ────────
//
// Design: the CONTROLLER (phone) records its own camera locally — those frames
// NEVER leave the device. The DISPLAY records the game canvas. At game-over the
// display ships the finished gameplay clip to the phone, which composites the two
// (picture-in-picture) offline via AVFoundation and saves one video to Photos.
// The relay is a dumb passthrough for these messages — no backend involved.
//
// `RecControlMessage` brackets both recorders with a shared session id + a wall-
// clock anchor so the two clips can be aligned at compositing time. The gameplay
// clip is transferred as base64 chunks (simple + relay-friendly for LAN/MVP; can
// move to a WebRTC DataChannel later without touching game code).

/** Arm/start/stop a recording session. Sent by whichever side initiates. */
export interface RecControlMessage {
  v: 1;
  type: "rec";
  action: "arm" | "start" | "stop" | "cancel";
  sessionId: string;
  /** Sender's Date.now() when this action fired — the sync anchor. */
  anchorMs: number;
}

/** Header preceding a chunked gameplay-clip transfer (display → controller). */
export interface RecMetaMessage {
  v: 1;
  type: "recmeta";
  sessionId: string;
  mime: string; // e.g. "video/webm;codecs=vp9"
  totalBytes: number;
  chunks: number; // number of RecChunkMessages to expect
  durationMs: number; // gameplay clip duration
  /** ms from the session anchor to the first recorded gameplay frame (for sync). */
  startOffsetMs: number;
}

/** One base64 slice of the gameplay clip (display → controller). */
export interface RecChunkMessage {
  v: 1;
  type: "recchunk";
  sessionId: string;
  i: number; // 0-based chunk index
  data: string; // base64 of this slice
}

// ── Either side → server ─────────────────────────────────────────────────────

export interface JoinMessage {
  v: 1;
  type: "join";
  role: Role;
  name?: string;
}

export interface PingMessage {
  v: 1;
  type: "ping";
  t: number;
}
export interface PongMessage {
  v: 1;
  type: "pong";
  t: number;
}

// ── Server → clients ─────────────────────────────────────────────────────────

/** Presence: the peer of a given role connected or dropped. */
export interface PeerMessage {
  v: 1;
  type: "peer";
  role: Role;
  connected: boolean;
}

/** Room-level errors (e.g. a second controller tried to join). */
export interface ErrorMessage {
  v: 1;
  type: "error";
  code: "room_full" | "bad_role" | "bad_message" | "version_mismatch";
  message: string;
}

// ── Unions ───────────────────────────────────────────────────────────────────

export type ControllerMessage =
  | JoinMessage
  | PosePacket
  | StatusMessage
  | CalibMessage
  | RecControlMessage
  | PingMessage
  | PongMessage;

export type DisplayMessage =
  | JoinMessage
  | StartMessage
  | RecControlMessage
  | RecMetaMessage
  | RecChunkMessage
  | PingMessage
  | PongMessage;

export type ServerMessage =
  | PeerMessage
  | PosePacket
  | StatusMessage
  | CalibMessage
  | StartMessage
  | RecControlMessage
  | RecMetaMessage
  | RecChunkMessage
  | ErrorMessage
  | PingMessage
  | PongMessage;

export type AnyMessage = ControllerMessage | DisplayMessage | ServerMessage;

// ── Room codes ───────────────────────────────────────────────────────────────

// No vowels or easily-confused chars (0/O, 1/I) so codes are unambiguous on a TV.
const CODE_ALPHABET = "23456789BCDFGHJKLMNPQRSTVWXYZ";
export const CODE_LENGTH = 6;

/** Generate a six-character room code. Pass a rng for testability. */
export function makeRoomCode(rng: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  }
  return out;
}

/** True if a string is a syntactically valid room code (case-insensitive). */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  const up = code.toUpperCase();
  for (const ch of up) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

// ── Validation ───────────────────────────────────────────────────────────────

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isPoint(x: unknown): x is [number, number] {
  return Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1]);
}

/** Narrowing validator for an inbound pose packet. Guards the relay against junk. */
export function isPosePacket(msg: unknown): msg is PosePacket {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== "pose" || m.v !== 1) return false;
  if (!isNum(m.seq) || !isNum(m.sentAt) || !isNum(m.quality)) return false;
  const j = m.joints as Record<string, unknown> | undefined;
  if (!j || typeof j !== "object") return false;
  for (const name of JOINT_NAMES) if (!isPoint(j[name])) return false;
  return true;
}

/** Best-effort parse of any inbound message; returns null on malformed JSON/shape. */
export function parseMessage(raw: string): AnyMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.type !== "string") return null;
  return parsed as AnyMessage;
}
