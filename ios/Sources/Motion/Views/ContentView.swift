//
//  ContentView.swift
//  Motion
//
//  Top-level router for the v1 (serverless, single-device) flow. Chooses a screen from
//  `AppModel.phase`:
//      setup       → SetupView (camera preview + readiness guidance)
//      calibration → SetupView (with the calibration overlay)
//      game        → GameView (full-screen WKWebView + camera-preview inset + Record)
//
//  A single `PoseSession` is created once (the camera is needed in every phase) and shared
//  across setup / calibration / game so the camera is never torn down between phases. The
//  same pipeline that guides setup also feeds pose into the web game via `PoseBridge`.
//

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var session: PoseSession?

    var body: some View {
        Group {
            if let session {
                switch model.phase {
                case .setup, .calibration:
                    SetupView(session: session)
                case .game:
                    GameView(session: session)
                }
            } else {
                // Brief placeholder while the camera session spins up.
                ProgressView("Starting camera…")
            }
        }
        .animation(.default, value: model.phase)
        // ORIENTATION IS THE MODE. Feed the current interface orientation into the model so
        // it can pick full-body (portrait) vs upper-body (landscape). We read the window
        // scene's `interfaceOrientation` (authoritative + already de-noised, unlike raw
        // device motion which reports face-up/down) and refresh it on every orientation
        // change notification. This also drives the initial mode on first appearance.
        .onReceive(NotificationCenter.default.publisher(
            for: UIDevice.orientationDidChangeNotification)) { _ in
            refreshOrientation()
        }
        .task {
            // Ensure orientation-change notifications are actually generated (they are only
            // posted while generation is enabled). We observe them purely as a trigger to
            // re-read the authoritative window-scene interface orientation.
            UIDevice.current.beginGeneratingDeviceOrientationNotifications()

            // Spin the camera up once, on first appearance, and keep it for the app's life.
            if session == nil {
                let s = PoseSession(model: model)
                session = s
                await s.start()
            }
            refreshOrientation()
        }
        .onDisappear {
            UIDevice.current.endGeneratingDeviceOrientationNotifications()
        }
    }

    /// Resolve the current interface orientation from the active window scene and push
    /// landscape-ness into the model. Falls back to portrait when no scene is available.
    private func refreshOrientation() {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let isLandscape = scene?.interfaceOrientation.isLandscape ?? false
        model.updateOrientation(isLandscape: isLandscape)
    }
}
