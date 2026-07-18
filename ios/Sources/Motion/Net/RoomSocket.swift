//
//  RoomSocket.swift
//  Motion
//
//  Thin wrapper around `URLSessionWebSocketTask` that speaks the Motion protocol.
//
//  Responsibilities:
//    • Build the room URL `ws://<host>:1999/parties/main/<CODE>` and connect.
//    • Send the `join` handshake immediately on connect (we are always a controller).
//    • Send pose / status / calib / ping frames as compact JSON text.
//    • Run a receive loop that decodes server messages and hands them to a delegate.
//    • Auto-reconnect with capped exponential backoff on drop/error.
//    • Ping every 2s and compute RTT from the matching pong.
//
//  Threading: the socket task and receive loop run off the main actor; all state
//  handed back to the app (via `RoomSocketDelegate`) is delivered ON the main actor,
//  so the AppModel never has to hop threads.
//

import Foundation

/// Default PartyKit host. Point this at your Mac's LAN IP so a physical phone on the
/// same Wi-Fi can reach the dev server (localhost won't resolve from the device).
/// Override at runtime via `AppModel.partyHost`.
let PARTY_HOST = "192.168.1.10"

/// Port PartyKit's local dev server listens on.
let PARTY_PORT = 1999

/// Where the socket is in its lifecycle. Surfaced to the UI via the delegate.
enum ConnectionState: Sendable, Equatable {
    case idle
    case connecting
    case connected
    case reconnecting(attempt: Int)
    case failed(reason: String)
}

/// Main-actor callbacks the socket uses to publish state and inbound messages.
@MainActor
protocol RoomSocketDelegate: AnyObject {
    func roomSocket(_ socket: RoomSocket, didChangeState state: ConnectionState)
    func roomSocket(_ socket: RoomSocket, didReceive message: IncomingMessage)
    /// Fresh round-trip time in milliseconds, from a ping/pong pair.
    func roomSocket(_ socket: RoomSocket, didMeasureRTT rttMS: Double)
}

/// A single-room WebSocket client. Not thread-safe by itself; drive it from the main actor.
@MainActor
final class RoomSocket {
    weak var delegate: RoomSocketDelegate?

    private let host: String
    private let code: String
    private let session: URLSession

    private var task: URLSessionWebSocketTask?
    private var isRunning = false          // user wants a connection to exist
    private var reconnectAttempt = 0
    private var pingTimer: Task<Void, Never>?
    private var receiveActive = false

    /// Optional display name to advertise in the join handshake.
    var playerName: String?

    // Backoff schedule (seconds), capped. Index clamps to the last entry.
    private let backoff: [UInt64] = [1, 2, 4, 8, 15, 30]

    init(host: String = PARTY_HOST, code: String, session: URLSession = .shared) {
        self.host = host
        self.code = code.uppercased()
        self.session = session
    }

    /// The `ws://<host>:1999/parties/main/<CODE>` URL. Accepts a host that may
    /// arrive as a bare IP, `host:port`, or an `http(s)://` URL and normalizes it.
    var url: URL? {
        var h = host.trimmingCharacters(in: .whitespaces)
        // Strip any scheme the caller pasted in (web config uses http://…).
        for prefix in ["https://", "http://", "wss://", "ws://"] {
            if h.hasPrefix(prefix) { h = String(h.dropFirst(prefix.count)) }
        }
        // Strip trailing slash.
        while h.hasSuffix("/") { h = String(h.dropLast()) }
        // If the host already carries a port, keep it; otherwise add the default.
        let hostPort = h.contains(":") ? h : "\(h):\(PARTY_PORT)"
        return URL(string: "ws://\(hostPort)/parties/main/\(code)")
    }

    // MARK: - Lifecycle

    /// Open the connection (idempotent). Kicks off receive + ping loops on success.
    func connect() {
        guard !isRunning else { return }
        isRunning = true
        reconnectAttempt = 0
        openTask()
    }

    /// Tear everything down. No further reconnects until `connect()` is called again.
    func disconnect() {
        isRunning = false
        pingTimer?.cancel()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        receiveActive = false
        delegate?.roomSocket(self, didChangeState: .idle)
    }

    private func openTask() {
        guard let url else {
            delegate?.roomSocket(self, didChangeState: .failed(reason: "Invalid room URL."))
            return
        }
        delegate?.roomSocket(self, didChangeState:
            reconnectAttempt == 0 ? .connecting : .reconnecting(attempt: reconnectAttempt))

        let ws = session.webSocketTask(with: url)
        task = ws
        receiveActive = true
        ws.resume()

        // Send the join handshake first thing. If the socket is dead, the send
        // failure will surface through the receive loop's error path.
        sendJoin()
        startReceiveLoop()
        startPingLoop()
    }

    // MARK: - Sending

    private func sendJoin() {
        send(JoinMessage(role: .controller, name: playerName))
    }

    func send(_ pose: PosePacket)    { send(encodable: pose) }
    func send(_ status: StatusMessage) { send(encodable: status) }
    func send(_ calib: CalibMessage)   { send(encodable: calib) }
    /// Send a recording control frame (arm/start/stop/cancel) to the display.
    func send(_ rec: RecControlMessage) { send(encodable: rec) }
    private func send(_ join: JoinMessage) { send(encodable: join) }

    /// Encode any outbound message and push it as a text frame. Failures trigger a reconnect.
    private func send<T: Encodable>(encodable value: T) {
        guard let task else { return }
        let text: String
        do {
            text = try WireCoder.encodeToString(value)
        } catch {
            // Encoding should never fail for our fixed shapes; drop the frame.
            return
        }
        task.send(.string(text)) { [weak self] error in
            guard let self, error != nil else { return }
            Task { @MainActor in self.handleFailure() }
        }
    }

    // MARK: - Receive loop

    private func startReceiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in self.handleReceive(result) }
        }
    }

    private func handleReceive(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        guard receiveActive else { return }
        switch result {
        case .failure:
            handleFailure()
        case .success(let message):
            switch message {
            case .string(let text):
                decodeAndDispatch(Data(text.utf8))
            case .data(let data):
                decodeAndDispatch(data)
            @unknown default:
                break
            }
            // Re-arm for the next frame; `receive` fires exactly once per call.
            startReceiveLoop()
        }
    }

    private func decodeAndDispatch(_ data: Data) {
        guard let message = IncomingMessage.decode(from: data) else { return }

        // A successful decode means we have a live, healthy connection.
        if reconnectAttempt != 0 {
            reconnectAttempt = 0
        }
        delegate?.roomSocket(self, didChangeState: .connected)

        switch message {
        case .pong(let pong):
            let rtt = nowMS() - pong.t
            if rtt >= 0 { delegate?.roomSocket(self, didMeasureRTT: rtt) }
        default:
            delegate?.roomSocket(self, didReceive: message)
        }
    }

    // MARK: - Ping loop (RTT + keepalive)

    private func startPingLoop() {
        pingTimer?.cancel()
        pingTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000) // 2s
                guard let self, self.isRunning else { return }
                await MainActor.run {
                    self.send(encodable: PingMessage(t: self.nowMS()))
                }
            }
        }
    }

    // MARK: - Reconnect

    private func handleFailure() {
        guard isRunning else { return }
        receiveActive = false
        pingTimer?.cancel()
        pingTimer = nil
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil

        reconnectAttempt += 1
        let idx = min(reconnectAttempt - 1, backoff.count - 1)
        let delay = backoff[idx]
        delegate?.roomSocket(self, didChangeState: .reconnecting(attempt: reconnectAttempt))

        Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            guard let self, self.isRunning else { return }
            await MainActor.run { self.openTask() }
        }
    }

    // MARK: - Time

    /// Monotonic-ish clock in milliseconds. `sentAt` in packets and ping `t` use this;
    /// only differences (RTT) are meaningful, so an epoch base is fine.
    private func nowMS() -> Double {
        ProcessInfo.processInfo.systemUptime * 1000.0
    }
}
