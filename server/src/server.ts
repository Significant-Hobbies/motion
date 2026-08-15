// Motion relay server — a dumb PartyKit room.
//
// One room per session. The PartyKit room id IS the 6-char room code (the display
// generates it client-side with `makeRoomCode` and connects to
// `/parties/main/<CODE>`; the controller joins the same room id).
//
// This server holds NO game state. It only:
//   1. tags each connection with a role after a `join` handshake,
//   2. enforces one `display` + one `controller` per room,
//   3. broadcasts presence so each side knows if its peer is here,
//   4. relays pose/status/calib controller→display and start display→controller,
//   5. answers ping with pong (for latency math),
//   6. rate-limits pose packets to protect the display.
//
// Ephemerality: when a room drops to zero connections PartyKit hibernates it and
// any in-memory state below (the per-connection rate buckets) is discarded. That
// is fine — rooms carry no durable state, so a fresh room is a clean room. We do
// NOT persist anything or set a manual TTL.

import type * as Party from "partykit/server";
import {
  PROTOCOL_VERSION,
  isPosePacket,
  parseMessage,
  type Role,
  type AnyMessage,
  type JoinMessage,
  type PeerMessage,
  type ErrorMessage,
  type PongMessage,
  type ServerMessage,
} from "../../protocol/protocol";

/** The two roles, used to find the "other" side when relaying/broadcasting. */
const ROLES: Role[] = ["display", "controller"];

/** State we attach to each connection once it has completed the join handshake. */
type ConnState = { role: Role };

/** Max sustained pose packets per second from a controller before we drop excess. */
const POSE_RATE_LIMIT = 40;

/** A tiny per-second counter used to throttle a chatty controller. */
type RateBucket = { windowStart: number; count: number };

export default class MotionServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  /**
   * Per-connection pose rate buckets, keyed by connection id. In-memory only;
   * reset on hibernation (see file header). Cleaned up on close.
   */
  private readonly rate = new Map<string, RateBucket>();

  // ── Connection lifecycle ────────────────────────────────────────────────────

  onConnect(_conn: Party.Connection<ConnState>) {
    // We intentionally do nothing here: a socket is anonymous until it sends a
    // valid `join`. Presence + role enforcement happen in onMessage once we know
    // which role it claims. This keeps a half-open TCP connection from occupying
    // a role slot.
  }

  onClose(conn: Party.Connection<ConnState>) {
    this.rate.delete(conn.id);
    if (!conn.state?.role) return; // never finished joining.
    // Re-broadcast authoritative presence, excluding the connection that's leaving.
    this.syncPresence(conn.id);
  }

  onError(conn: Party.Connection<ConnState>, _err: Error) {
    // Treat a transport error like a close for presence purposes.
    this.rate.delete(conn.id);
    if (conn.state?.role) this.syncPresence(conn.id);
  }

  // ── Message handling ─────────────────────────────────────────────────────────

  onMessage(raw: string | ArrayBuffer, conn: Party.Connection<ConnState>) {
    // Never throw out of this handler; malformed input is dropped or answered
    // with a structured error.
    if (typeof raw !== "string") return; // protocol is JSON text only.

    const msg = parseMessage(raw);
    if (!msg) {
      this.sendError(conn, "bad_message", "Malformed or non-JSON message.");
      return;
    }

    // Until a connection has joined, the ONLY message we accept is `join`.
    if (!conn.state?.role) {
      if (msg.type === "join") this.handleJoin(msg, conn);
      else this.sendError(conn, "bad_message", "Send a `join` message first.");
      return;
    }

    this.route(msg, raw, conn, conn.state.role);
  }

  /** Route a message from an already-joined connection. `raw` is the original
   * serialized payload, relayed verbatim to the peer to avoid re-stringifying. */
  private route(
    msg: AnyMessage,
    raw: string,
    conn: Party.Connection<ConnState>,
    role: Role
  ) {
    switch (msg.type) {
      case "join":
        // Already joined; ignore duplicate joins silently.
        return;

      case "ping":
        // Answer directly with a pong echoing `t`. Never relayed to the peer.
        this.sendTo(conn, {
          v: PROTOCOL_VERSION,
          type: "pong",
          t: msg.t,
        } as PongMessage);
        return;

      case "pong":
        // Clients don't need our pongs relayed; ignore.
        return;

      case "pose":
        // Controller → display only. Validate, rate-limit, then relay.
        this.routePose(msg, raw, conn, role);
        return;

      case "status":
      case "calib":
        // Controller → display.
        if (role !== "controller") return;
        this.relayTo("display", raw);
        return;

      case "start":
        // Display → controller.
        if (role !== "display") return;
        this.relayTo("controller", raw);
        return;

      case "rec":
        // Recording control is bidirectional: either side may arm/start/stop a
        // session. Relay to the peer so both recorders stay bracketed together.
        this.relayTo(otherRole(role), raw);
        return;

      case "recmeta":
      case "recchunk":
        // The finished gameplay clip flows display → controller only. These can be
        // large (base64); we don't validate the payload, just pass it through.
        if (role !== "display") return;
        this.relayTo("controller", raw);
        return;

      default:
        // Unknown but well-formed type: ignore rather than error, so future
        // protocol additions from a newer client don't get punished here.
        return;
    }
  }

  /** Validate, rate-limit, and relay a pose packet from the controller. */
  private routePose(
    msg: AnyMessage,
    raw: string,
    conn: Party.Connection<ConnState>,
    role: Role
  ) {
    if (role !== "controller") return;
    if (!isPosePacket(msg)) return; // drop junk silently.
    if (!this.allowPose(conn.id)) return; // over budget → silent drop.
    this.relayTo("display", raw);
    this.debugPose(raw); // throttled dev log so we can watch the stream server-side.
  }

  // ── Join handshake + role enforcement ────────────────────────────────────────

  private handleJoin(msg: JoinMessage, conn: Party.Connection<ConnState>) {
    if (msg.v !== PROTOCOL_VERSION) {
      this.sendError(
        conn,
        "version_mismatch",
        `Server speaks protocol v${PROTOCOL_VERSION}, client sent v${String(msg.v)}.`
      );
      conn.close();
      return;
    }

    const role = msg.role;
    if (role !== "display" && role !== "controller") {
      this.sendError(
        conn,
        "bad_role",
        "Role must be 'display' or 'controller'."
      );
      conn.close();
      return;
    }

    // One connection per role. If the slot is taken:
    //  • controller → LAST-WINS: a reconnecting phone whose old socket hasn't timed
    //    out yet should reclaim the slot immediately (fixes flaky reconnects). Evict
    //    the stale one. There's only ever one phone, so no eviction war.
    //  • display → reject the extra (e.g. a duplicate browser tab), so two live tabs
    //    don't endlessly evict each other.
    if (this.roleTaken(role, conn.id)) {
      if (role === "controller") {
        console.log(
          `[${this.room.id}] controller reconnect — evicting stale controller`
        );
        this.evictRole("controller", conn.id);
      } else {
        console.log(
          `[${this.room.id}] REJECTED ${role} (room_full — a ${role} is already here)`
        );
        this.sendError(
          conn,
          "room_full",
          `A ${role} is already connected to this room.`
        );
        conn.close();
        return;
      }
    }

    // Tag the connection with its role — this is what marks it "joined".
    conn.setState({ role });
    console.log(
      `[${this.room.id}] JOINED ${role}  (conns now: ${[...this.room.getConnections()].length})`
    );

    // Broadcast authoritative presence to BOTH roles. Every side gets the TRUE current
    // state (not an incremental event that can be missed during reconnect churn), so the
    // phone and the laptop always agree on whether their peer is connected.
    this.syncPresence();
  }

  /**
   * Send every connected client the current presence of its counterpart role. This is
   * the single source of truth for peer status — called on every join/close/evict so
   * the two sides never disagree. `excludeId` drops a connection that is mid-close.
   */
  private syncPresence(excludeId = "") {
    let hasDisplay = false;
    let hasController = false;
    for (const c of this.room.getConnections<ConnState>()) {
      if (c.id === excludeId) continue;
      if (c.state?.role === "display") hasDisplay = true;
      else if (c.state?.role === "controller") hasController = true;
    }
    for (const c of this.room.getConnections<ConnState>()) {
      if (c.id === excludeId) continue;
      const r = c.state?.role;
      if (r === "display")
        this.safeSend(c, JSON.stringify(peerMsg("controller", hasController)));
      else if (r === "controller")
        this.safeSend(c, JSON.stringify(peerMsg("display", hasDisplay)));
    }
  }

  // Dev diagnostic: count poses and log throttled so we can confirm, from the
  // server side alone, that a controller is streaming and whether a display exists.
  private poseCount = 0;
  private debugPose(raw: string) {
    this.poseCount++;
    if (this.poseCount === 1 || this.poseCount % 30 === 0) {
      const hasDisplay = this.roleTaken("display", "");
      // Cheap field-presence check tells us if the phone is on the NEW build:
      // new build streams fingertips + elbows; old build has neither.
      const fingertips = raw.includes('"fingertips"');
      const elbows =
        raw.includes('"leftElbow"') || raw.includes('"rightElbow"');
      console.log(
        `[${this.room.id}] pose #${this.poseCount} — display:${hasDisplay} fingertips:${fingertips} elbows:${elbows}`
      );
    }
  }

  /** True if some OTHER live connection has already claimed `role`. */
  private roleTaken(role: Role, exceptId: string): boolean {
    for (const c of this.room.getConnections<ConnState>()) {
      if (c.id === exceptId) continue;
      if (c.state?.role === role) return true;
    }
    return false;
  }

  /** Close every OTHER connection holding `role` (last-connection-wins). */
  private evictRole(role: Role, exceptId: string) {
    for (const c of this.room.getConnections<ConnState>()) {
      if (c.id === exceptId) continue;
      if (c.state?.role === role)
        c.close(1000, "replaced by a newer connection");
    }
  }

  // ── Relay + presence helpers ─────────────────────────────────────────────────

  /**
   * Send that never throws. A peer can close between our `getConnections` snapshot
   * and the `send`, and PartyKit throws "Can't call send() after close()". During
   * reconnect churn that error would otherwise escape a message handler and disrupt
   * the room, so we swallow it — a dropped frame on a dying socket is harmless.
   */
  private safeSend(conn: Party.Connection<ConnState>, payload: string) {
    try {
      conn.send(payload);
    } catch {
      // socket already closed / closing — ignore.
    }
  }

  /** Send a raw (already-serialized) payload to every connection of a role. */
  private relayTo(role: Role, payload: string) {
    for (const c of this.room.getConnections<ConnState>()) {
      if (c.state?.role === role) this.safeSend(c, payload);
    }
  }

  private sendTo(conn: Party.Connection<ConnState>, msg: ServerMessage) {
    this.safeSend(conn, JSON.stringify(msg));
  }

  private sendError(
    conn: Party.Connection<ConnState>,
    code: ErrorMessage["code"],
    message: string
  ) {
    this.sendTo(conn, { v: PROTOCOL_VERSION, type: "error", code, message });
  }

  // ── Pose rate limiting (per-second counter) ──────────────────────────────────

  /**
   * Simple fixed-window counter: allow up to POSE_RATE_LIMIT poses per rolling
   * 1-second window per controller. Excess is dropped silently (we never
   * disconnect a chatty controller — a momentary burst shouldn't kill the room).
   */
  private allowPose(connId: string): boolean {
    const now = Date.now();
    let bucket = this.rate.get(connId);
    if (!bucket || now - bucket.windowStart >= 1000) {
      bucket = { windowStart: now, count: 0 };
      this.rate.set(connId, bucket);
    }
    if (bucket.count >= POSE_RATE_LIMIT) return false;
    bucket.count++;
    return true;
  }
}

// ── Free helpers ───────────────────────────────────────────────────────────────

function otherRole(role: Role): Role {
  return role === "display" ? "controller" : "display";
}

function peerMsg(role: Role, connected: boolean): PeerMessage {
  return { v: PROTOCOL_VERSION, type: "peer", role, connected };
}
