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

import SaaSMakerUI
import SwiftUI

struct GameView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.verticalSizeClass) private var vSizeClass
    @Environment(\.smPalette) private var palette
    let session: PoseSession

    /// URL presented in a share/preview sheet when the user opens their saved clip.
    @State private var shareURL: URL?

    /// Landscape → short window. Used to size the camera inset so it stays visible and its
    /// aspect roughly matches the (now wide) upright preview instead of a tall portrait box.
    private var isLandscape: Bool { vSizeClass == .compact }

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

            // Native chrome clears the camera inset even as text grows.
            VStack(spacing: 12) {
                controlBar
                HStack {
                    Spacer()
                    cameraInset
                }
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
            CameraPreview(session: session)
            // A faint readiness-tinted border so the player knows tracking is live.
            RoundedRectangle(cornerRadius: 14)
                .stroke(insetBorderColor.opacity(0.9), lineWidth: 3)
        }
        // Portrait: a tall 9:16 thumbnail. Landscape / upper-body: a wide 16:9 thumbnail so
        // the (upright, wide) preview isn't letter-boxed and the hands stay readable. Either
        // way the inset stays corner-anchored and visible.
        .frame(width: insetSize.width, height: insetSize.height)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(radius: 6)
        .overlay(alignment: .bottom) {
            // If tracking drops mid-game, nudge the player (game is already paused web-side).
            if model.tracking != .ok {
                Text(model.guidance)
                    .font(Design.detail.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.black.opacity(0.6), in: Capsule())
                    .padding(.bottom, 6)
                    .frame(maxWidth: insetSize.width)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Camera-inset dimensions per orientation: tall in portrait, wide in landscape so the
    /// upright preview fills it in both. Upper-body mode (landscape) benefits from the wider
    /// box since hands span horizontally.
    private var insetSize: CGSize {
        isLandscape ? CGSize(width: 192, height: 108) : CGSize(width: 108, height: 192)
    }

    private var insetBorderColor: Color {
        switch model.tracking {
        case .ok: return palette.success
        case .lost: return palette.destructive
        default: return palette.warning
        }
    }

    // MARK: - Control bar

    private var controlBar: some View {
        SMCard(padding: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    exitButton
                    Spacer(minLength: 0)
                    videoButton
                    recordStatus
                    recordButton
                }
                VStack(spacing: 8) {
                    HStack {
                        exitButton
                        Spacer()
                        recordButton
                    }
                    recordStatus
                    videoButton
                }
            }
        }
    }

    private var exitButton: some View {
        Button {
            model.exitGame()
        } label: {
            Image(systemName: "xmark.circle.fill")
                .font(.title2)
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.smLink)
        .accessibilityLabel("Back to setup")
    }

    @ViewBuilder
    private var videoButton: some View {
        if case .saved = model.recorder.state, let url = model.recorder.lastSavedURL {
            Button {
                shareURL = url
            } label: {
                Label("video", systemImage: "play.rectangle.fill")
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(.smOutline)
            .accessibilityLabel("Video")
        }
    }

    @ViewBuilder
    private var recordStatus: some View {
        if let status = recordStatusText {
            SMStatusPill(status, tone: recordStatusTone)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var recordButton: some View {
        Button {
            model.recorder.toggle()
        } label: {
            Image(systemName: model.recorder.isArmed ? "record.circle.fill" : "record.circle")
                .font(.title2)
                .foregroundStyle(model.recorder.isArmed ? palette.destructive : palette.foreground)
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.smLink)
        .accessibilityLabel(model.recorder.isArmed ? "Disarm recording" : "Arm recording")
    }

    private var recordStatusText: String? {
        switch model.recorder.state {
        case .idle: return nil
        case .armed: return "armed"
        case .recording: return "rec"
        case .saving: return "saving…"
        case .saved: return "saved"
        case .failed: return "failed"
        }
    }

    private var recordStatusTone: SMStatusPill.Tone {
        switch model.recorder.state {
        case .recording: return .danger
        case .saved: return .success
        case .failed: return .warning
        default: return .neutral
        }
    }
}
