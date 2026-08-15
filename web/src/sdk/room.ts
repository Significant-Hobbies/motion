// Room networking: wraps PartySocket as the DISPLAY side of a Motion room.
//
// - Generates a 6-char code (the PartyKit room id) or uses a forced one.
// - Connects, joins as `display`, and exposes typed send + subscribe.
// - Runs a 2s ping loop and tracks RTT + best-effort clock skew from pong.
// - Tracks peer (controller) connected state and the last inbound pose.
//
// The socket auto-reconnects (partysocket). The room code stays stable across
// reconnects because it is the room id we opened with.

import { PartySocket } from "partysocket";
import {
  makeRoomCode,
  parseMessage,
  isPosePacket,
  type PosePacket,
  type StatusMessage,
  type CalibMessage,
  type PeerMessage,
  type ErrorMessage,
  type JoinMessage,
  type StartMessage,
  type PingMessage,
  type RecControlMessage,
  type RecMetaMessage,
  type RecChunkMessage,
} from "../../../protocol/protocol";

export type ConnState = "connecting" | "open" | "closed";

export interface RoomEvents {
  pose: (p: PosePacket) => void;
  status: (s: StatusMessage) => void;
  calib: (c: CalibMessage) => void;
  peer: (p: PeerMessage) => void;
  error: (e: ErrorMessage) => void;
  /** Fired on connect/reconnect/close, so screens can restore themselves. */
  conn: (state: ConnState) => void;
}

type Listener<K extends keyof RoomEvents> = RoomEvents[K];

export class Room {
  readonly code: string;
  private socket: PartySocket;
  private listeners: { [K in keyof RoomEvents]: Set<Listener<K>> } = {
    pose: new Set(),
    status: new Set(),
    calib: new Set(),
    peer: new Set(),
    error: new Set(),
    conn: new Set(),
  };

  private pingTimer: number | null = null;
  private connState: ConnState = "connecting";

  /** Round-trip time in ms from the most recent pong (−1 until first pong). */
  rtt = -1;
  /** Estimated (controllerClock − displayClock) in ms; best-effort, for latency math. */
  clockSkew = 0;
  /** True once the controller peer has announced itself present. */
  peerConnected = false;
  /** Most recent inbound pose packet, or null. */
  lastPose: PosePacket | null = null;

  constructor(host: string, code?: string) {
    this.code = code ?? makeRoomCode();
    this.socket = new PartySocket({
      host: hostFrom(host),
      room: this.code,
    });
    this.wire();
  }

  private wire(): void {
    this.socket.addEventListener("open", () => {
      this.setConn("open");
      this.join();
      this.startPingLoop();
    });
    this.socket.addEventListener("close", () => {
      this.setConn("closed");
      this.stopPingLoop();
      // partysocket will auto-reconnect and re-fire "open".
    });
    this.socket.addEventListener("error", () => {
      // Surface as a transient closed state; reconnect is automatic.
      this.setConn("connecting");
    });
    this.socket.addEventListener("message", (ev: MessageEvent) => {
      this.onRaw(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
  }

  private setConn(s: ConnState): void {
    this.connState = s;
    this.emit("conn", s);
  }

  get connectionState(): ConnState {
    return this.connState;
  }

  private onRaw(raw: string): void {
    const msg = parseMessage(raw);
    if (!msg) return;

    // Pose is the hot path; validate strictly.
    if (isPosePacket(msg)) {
      this.lastPose = msg;
      this.emit("pose", msg);
      return;
    }

    switch (msg.type) {
      case "status":
        this.emit("status", msg as StatusMessage);
        break;
      case "calib":
        this.emit("calib", msg as CalibMessage);
        break;
      case "peer": {
        const p = msg as PeerMessage;
        if (p.role === "controller") this.peerConnected = p.connected;
        this.emit("peer", p);
        break;
      }
      case "pong": {
        const p = msg as { t: number };
        const now = performance.now();
        // We stashed send-time in `t` on the way out; server echoes it back.
        this.rtt = Math.max(0, now - p.t);
        break;
      }
      case "error":
        this.emit("error", msg as ErrorMessage);
        break;
      default:
        break;
    }
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  private sendRaw(
    m:
      | JoinMessage
      | StartMessage
      | PingMessage
      | RecControlMessage
      | RecMetaMessage
      | RecChunkMessage
  ): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(m));
    }
  }

  /** True when the socket is open and ready to accept sends. */
  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** Current outbound WebSocket buffer size in bytes (for backpressure). */
  get bufferedAmount(): number {
    return this.socket.bufferedAmount ?? 0;
  }

  /** Send a display→controller recording message (control/meta/chunk). */
  sendRec(m: RecControlMessage | RecMetaMessage | RecChunkMessage): void {
    this.sendRaw(m);
  }

  private join(): void {
    const m: JoinMessage = {
      v: 1,
      type: "join",
      role: "display",
    };
    this.sendRaw(m);
  }

  /** Cue the controller that the game is starting. */
  start(): void {
    const m: StartMessage = { v: 1, type: "start" };
    this.sendRaw(m);
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    const tick = () => {
      const m: PingMessage = { v: 1, type: "ping", t: performance.now() };
      this.sendRaw(m);
    };
    tick();
    this.pingTimer = window.setInterval(tick, 2000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Subscription ─────────────────────────────────────────────────────────────

  on<K extends keyof RoomEvents>(event: K, fn: RoomEvents[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  private emit<K extends keyof RoomEvents>(
    event: K,
    ...args: Parameters<RoomEvents[K]>
  ): void {
    for (const fn of this.listeners[event]) {
      (fn as (...a: Parameters<RoomEvents[K]>) => void)(...args);
    }
  }

  close(): void {
    this.stopPingLoop();
    this.socket.close();
  }
}

/** Normalize a PartyKit host into a bare host:port PartySocket accepts. */
function hostFrom(url: string): string {
  return url
    .replace(/^wss?:\/\//, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}
