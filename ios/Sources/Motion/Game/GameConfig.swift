//
//  GameConfig.swift
//  Motion
//
//  Where the WKWebView loads the web game from, for the v1 serverless / single-device
//  architecture. The phone hosts the web game in-process and drives it via the JS bridge
//  (see GameWebView / PoseBridge); there is NO relay server and NO pairing in v1.
//
//  Two source modes:
//
//    • DEV SERVER (default) — the Vite dev server running on your Mac:
//          http://<MAC_LAN_IP>:5173/?transport=bridge
//      Fast edit/reload loop while iterating on the web game. The phone and Mac must be
//      on the same Wi-Fi. `MAC_LAN_IP` below is the obvious editable constant; it is also
//      overridable at runtime (the old PairingView host field is repurposed as a
//      "dev-server IP" field bound to `AppModel.devServerIP`).
//
//      NOTE: bridge mode does NOT call getUserMedia / MediaRecorder inside the webview
//      (the phone owns the camera + recording), so an INSECURE http:// dev-server origin
//      is fine — WKWebView imposes no secure-context requirement for what the game does.
//
//    • BUNDLED ("pure app" finish) — a production web build copied into the app bundle as
//      a `webgame` folder, loaded from disk via `loadFileURL`. No Mac / network needed.
//      To produce it:
//          npm --workspace web run build      # emits web/dist
//      then in Xcode drag `web/dist` into the app target as a FOLDER REFERENCE named
//      `webgame` ("Create folder references", NOT "Create groups") so it ships as a
//      real directory. The loader looks for `webgame/index.html` in the bundle.
//
//  v1 default is the dev server; flip `GameConfig.source` to `.bundled` for the pure app.
//

import Foundation

/// Mac LAN IP the Vite dev server listens on. EDIT THIS to your Mac's Wi-Fi IP
/// (System Settings → Wi-Fi → Details), or override it at runtime in the app.
let MAC_LAN_IP = "192.168.1.10"

/// Port the Vite dev server listens on (`npm --workspace web run dev`).
let VITE_DEV_PORT = 5173

enum GameConfig {
    /// Which source the WKWebView loads. Default to the dev server for the fast loop.
    enum Source {
        case devServer
        case bundled
    }

    static let source: Source = .devServer

    /// Query string that forces the web app into bridge transport. The web app also
    /// auto-selects bridge mode when `window.webkit.messageHandlers.motion` exists
    /// (which our WKWebView always injects), but we pass this to be explicit.
    static let bridgeQuery = "transport=bridge"

    /// Build the dev-server URL for a given host (bare IP, `host:port`, or a full URL).
    /// Normalizes whatever the user typed into `http://<host>:<port>/?transport=bridge`.
    static func devServerURL(host: String) -> URL? {
        var h = host.trimmingCharacters(in: .whitespaces)
        // Strip any scheme the user pasted.
        for prefix in ["https://", "http://", "wss://", "ws://"] {
            if h.hasPrefix(prefix) { h = String(h.dropFirst(prefix.count)) }
        }
        // Strip a trailing path/slash.
        while h.hasSuffix("/") { h = String(h.dropLast()) }
        guard !h.isEmpty else { return nil }
        // Keep an explicit port if present; otherwise add the Vite default.
        let hostPort = h.contains(":") ? h : "\(h):\(VITE_DEV_PORT)"
        return URL(string: "http://\(hostPort)/?\(bridgeQuery)")
    }

    /// The bundled `webgame/index.html` file URL, if a build was copied into the app.
    /// Loaded with `loadFileURL(_:allowingReadAccessTo:)` so relative asset paths resolve.
    static func bundledIndexURL() -> URL? {
        // Folder reference: `webgame` is a real directory in the bundle.
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "webgame") {
            return url
        }
        return nil
    }

    /// Directory read access the bundled load must be granted (the `webgame` folder).
    static func bundledReadAccessURL() -> URL? {
        bundledIndexURL()?.deletingLastPathComponent()
    }
}
