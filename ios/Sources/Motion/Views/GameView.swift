//
//  GameView.swift
//  Motion
//
//  The v1 gameplay screen. Full-screen WKWebView hosting the web game, with a small
//  camera-preview inset overlaid in a corner, a Record toggle, and a minimal exit control.
//
//  ── LAYOUT FOR REPLAYKIT CAPTURE ─────────────────────────────────────────────────────
//  The camera inset is drawn ON TOP of the webview (later in the ZStack), so it is part of
//  the composited app window that ReplayKit records. That is the whole trick: the single
//  screen recording contains BOTH the game canvas (webview) AND the player (camera inset)
//  with no offline compositing. See ScreenRecorder for the capture risk + fallback plan.
//
//  The Record toggle + exit control are placed in a top overlay bar. They are UI chrome;
//  they WILL appear in the recording too (acceptable for v1 — the game + player are the
//  point). A future polish could hide chrome while `recorder.state == .recording`.
//

import SwiftUI

struct GameView: View {
    @Environment(AppModel.self) private var model
    let session: PoseSession

    /// URL presented in a share/preview sheet when the user opens their saved clip.
    @State private var shareURL: URL?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // 1. Full-screen web game (background of the capture).
            GameWebView(
                url: model.gameURL,
                fileReadAccessURL: model.gameFileReadAccessURL,
                onEvent: { model.bridge.handle(event: $0) },
                onCoordinator: { model.bridge.attach(coordinator: $0) }
            )
            .ignoresSafeArea()

            // 2. Camera-preview inset ON TOP — so ReplayKit captures the player with the
            //    game. Small, corner-anchored, mirrored (the preview layer handles that).
            VStack {
                HStack {
                    Spacer()
                    cameraInset
                }
                Spacer()
            }
            .padding(.top, 88)   // clear the top control bar
            .padding(.trailing, 16)

            // 3. Top control bar: exit + record toggle + status.
            VStack {
                controlBar
                Spacer()
            }
            .padding()
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onDisappear { model.bridge.detach() }
        .sheet(item: $shareURL) { url in ShareSheet(items: [url]) }
    }

    // MARK: - Camera inset

    private var cameraInset: some View {
        ZStack {
            CameraPreview(session: session.captureSession)
            // A faint readiness-tinted border so the player knows tracking is live.
            RoundedRectangle(cornerRadius: 14)
                .stroke(insetBorderColor.opacity(0.9), lineWidth: 3)
        }
        .frame(width: 108, height: 192) // ~9:16 portrait thumbnail
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(radius: 6)
        .overlay(alignment: .bottom) {
            // If tracking drops mid-game, nudge the player (game is already paused web-side).
            if model.tracking != .ok {
                Text(model.guidance)
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.black.opacity(0.6), in: Capsule())
                    .padding(.bottom, 6)
                    .frame(maxWidth: 180)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var insetBorderColor: Color {
        switch model.tracking {
        case .ok: return .green
        case .lost: return .red
        default: return .yellow
        }
    }

    // MARK: - Control bar

    private var controlBar: some View {
        HStack(spacing: 12) {
            // Exit back to setup.
            Button {
                model.exitGame()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.white.opacity(0.85))
            }

            Spacer()

            // Saved-clip quick open (after a game).
            if case .saved = model.recorder.state, let url = model.recorder.lastSavedURL {
                Button { shareURL = url } label: {
                    Label("Video", systemImage: "play.rectangle.fill")
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                }
                .buttonStyle(.bordered)
                .tint(.white)
            }

            // Record status text (compact).
            if let status = recordStatusText {
                Text(status)
                    .font(.caption.bold())
                    .foregroundStyle(recordStatusColor)
            }

            // Record toggle (arm/disarm).
            Button {
                model.recorder.toggle()
            } label: {
                Image(systemName: model.recorder.isArmed ? "record.circle.fill" : "record.circle")
                    .font(.title2)
                    .foregroundStyle(model.recorder.isArmed ? .red : .white)
            }
        }
        .padding(10)
        .background(.black.opacity(0.4), in: Capsule())
    }

    private var recordStatusText: String? {
        switch model.recorder.state {
        case .idle: return nil
        case .armed: return "Armed"
        case .recording: return "REC"
        case .saving: return "Saving…"
        case .saved: return "Saved"
        case .failed: return "Failed"
        }
    }

    private var recordStatusColor: Color {
        switch model.recorder.state {
        case .recording: return .red
        case .saved: return .green
        case .failed: return .orange
        default: return .white.opacity(0.85)
        }
    }
}
