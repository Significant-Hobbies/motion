//
//  GameWebView.swift
//  Motion
//
//  A full-screen `WKWebView` that hosts the Motion web game for the v1 single-device
//  architecture. The native side pushes pose in-process via the JS bridge and receives
//  game lifecycle events back through a `WKScriptMessageHandler` named `motion`.
//
//  The exact bridge contract (mirrors web/src/sdk/bridge.ts):
//
//    Native → web (evaluateJavaScript on `window.__motion`):
//      pushPose(json)      json = a PosePacket; object or JSON string accepted.
//      setTracking(state)  'ok'|'lost'|'partial'|'too_close'|'too_far'|'raise_phone'|'low_light'
//      start()             begin/restart the game (phone already passed its readiness gate)
//      stop()              end/abort
//      calibrated()        calibration finished on the phone
//
//    Web → native (window.webkit.messageHandlers.motion.postMessage(obj)):
//      { event: 'ready' }              web canvas up — NOW is when to call start()
//      { event: 'gameStart' }          → start ReplayKit recording (if armed)
//      { event: 'score', value }       final score
//      { event: 'gameOver', result }   → stop ReplayKit recording + save
//      { event: 'restart' }            replay starting
//
//  The web app auto-selects bridge mode because we inject the `motion` message handler;
//  we also load the URL with `?transport=bridge` to be explicit.
//
//  Threading: everything here is main-actor (WKWebView is main-actor-only). The
//  coordinator queues a `start()` call until the web app reports `ready` so we never
//  invoke `window.__motion.start()` before the bridge global exists.
//

import SwiftUI
import WebKit

/// Lifecycle events the web game emits back to native. Decoded from the message body.
enum GameEvent: Sendable, Equatable {
    case ready
    case gameStart
    case gameOver(resultJSON: String?)
    case score(Double)
    case restart
}

/// SwiftUI wrapper around a full-screen WKWebView. The parent supplies the source URL and
/// an `onEvent` closure; it grabs the live `Coordinator` via `onCoordinator` so it can
/// push pose / tracking / lifecycle calls into the running game.
struct GameWebView: UIViewRepresentable {
    /// The URL to load (dev-server or bundled file URL). `nil` shows a black screen.
    let url: URL?
    /// For bundled `file://` loads, the directory read access must be granted.
    var fileReadAccessURL: URL?
    /// Called on the main actor for every web → native lifecycle event.
    let onEvent: (GameEvent) -> Void
    /// Handed the coordinator once the view is made, so callers can drive the bridge.
    let onCoordinator: (Coordinator) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onEvent: onEvent)
    }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        // Web → native channel. `add(_:name:)` installs
        // window.webkit.messageHandlers.motion.postMessage(...).
        contentController.add(context.coordinator, name: "motion")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        // Games auto-play canvas/audio; allow inline (not full-screen native) playback.
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        // Opaque black — the game canvas fills the screen; no white flash on load.
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        // No scrolling / bounce — this is a fixed full-screen game surface.
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false

        context.coordinator.webView = webView
        onCoordinator(context.coordinator)

        load(into: webView, coordinator: context.coordinator)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // If the URL changed (e.g. the user edited the dev-server IP), reload.
        if context.coordinator.loadedURL != url {
            load(into: webView, coordinator: context.coordinator)
        }
    }

    private func load(into webView: WKWebView, coordinator: Coordinator) {
        guard let url else { return }
        coordinator.loadedURL = url
        coordinator.resetReady()
        if url.isFileURL {
            let access = fileReadAccessURL ?? url.deletingLastPathComponent()
            webView.loadFileURL(url, allowingReadAccessTo: access)
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    /// Dismantle: WKUserContentController retains message handlers strongly, so removing
    /// the handler here avoids a retain cycle (coordinator → webView → controller →
    /// coordinator) when the view goes away.
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "motion")
        webView.navigationDelegate = nil
    }

    // MARK: - Coordinator

    /// Bridges native ⇄ web. Owns the `evaluateJavaScript` calls (native → web) and
    /// receives the `motion` postMessage events (web → native).
    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?
        /// The URL currently (or last) loaded, so `updateUIView` can detect changes.
        var loadedURL: URL?
        /// True once the web app posted `{ event: 'ready' }` — the bridge global exists.
        private(set) var ready = false {
            didSet {
                if ready, pendingStart {
                    pendingStart = false
                    start()
                }
            }
        }
        /// A `start()` requested before the web app was ready; flushed on `ready`.
        private var pendingStart = false

        /// Reset readiness on a (re)load — the new document hasn't posted `ready` yet.
        /// Internal helper so the `private(set)` setter stays private to the Coordinator.
        func resetReady() {
            ready = false
            pendingStart = false
        }

        private let onEvent: (GameEvent) -> Void

        init(onEvent: @escaping (GameEvent) -> Void) {
            self.onEvent = onEvent
        }

        // MARK: Native → web

        /// Push one pose packet into `window.__motion.pushPose(...)`. The pose is passed
        /// as a JSON STRING (the web bridge JSON.parses strings), which sidesteps any JS
        /// object-literal escaping concerns — we only have to escape the JSON string once.
        func pushPose(jsonString: String) {
            guard ready else { return } // no bridge yet; poses before start are dropped
            let js = "window.__motion && window.__motion.pushPose(\(Self.jsStringLiteral(jsonString)));"
            eval(js)
        }

        /// Report tracking state. Anything ≠ 'ok' pauses the game on the web side.
        func setTracking(_ state: String) {
            guard ready else { return }
            let js = "window.__motion && window.__motion.setTracking(\(Self.jsStringLiteral(state)));"
            eval(js)
        }

        /// Begin / restart the game. If the web app isn't `ready` yet, this is queued and
        /// fired the moment the `ready` event arrives.
        func start() {
            guard ready else { pendingStart = true; return }
            eval("window.__motion && window.__motion.start();")
        }

        func stop() {
            guard ready else { pendingStart = false; return }
            eval("window.__motion && window.__motion.stop();")
        }

        func calibrated() {
            guard ready else { return }
            eval("window.__motion && window.__motion.calibrated();")
        }

        private func eval(_ js: String) {
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }

        /// Encode a Swift string as a safe JS string literal (double-quoted, escaped).
        /// Uses JSONSerialization so control chars / quotes / backslashes / unicode are
        /// all handled correctly — the result is a valid JS/JSON string expression.
        static func jsStringLiteral(_ s: String) -> String {
            if let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
               let arr = String(data: data, encoding: .utf8),
               arr.hasPrefix("["), arr.hasSuffix("]") {
                // arr == `["...escaped..."]`; strip the array brackets to get the literal.
                return String(arr.dropFirst().dropLast())
            }
            // Fallback: minimal manual escaping (should never be hit for our inputs).
            let escaped = s
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
            return "\"\(escaped)\""
        }

        // MARK: Web → native (WKScriptMessageHandler)

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "motion" else { return }
            guard let event = Self.decodeEvent(message.body) else { return }
            if case .ready = event { ready = true }
            onEvent(event)
        }

        /// Decode a `{ event: ..., ... }` message body (a JS object → NSDictionary).
        private static func decodeEvent(_ body: Any) -> GameEvent? {
            guard let dict = body as? [String: Any],
                  let event = dict["event"] as? String else { return nil }
            switch event {
            case "ready":     return .ready
            case "gameStart": return .gameStart
            case "restart":   return .restart
            case "score":
                let value = (dict["value"] as? NSNumber)?.doubleValue ?? 0
                return .score(value)
            case "gameOver":
                // `result` is arbitrary JSON; re-serialize it to a string for the UI.
                var resultJSON: String?
                if let result = dict["result"],
                   JSONSerialization.isValidJSONObject(result),
                   let data = try? JSONSerialization.data(withJSONObject: result),
                   let str = String(data: data, encoding: .utf8) {
                    resultJSON = str
                }
                return .gameOver(resultJSON: resultJSON)
            default:
                return nil
            }
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            // Surfaced as a black screen; the ContentView shows a dev-server hint on failure.
            onEvent(.gameOver(resultJSON: nil))
        }
    }
}
