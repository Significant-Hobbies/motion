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
        .task {
            // Spin the camera up once, on first appearance, and keep it for the app's life.
            if session == nil {
                let s = PoseSession(model: model)
                session = s
                await s.start()
            }
        }
    }
}
