//
//  SetupView.swift
//  Motion
//
//  The camera screen shown before the game starts (v1 flow):
//    • live camera preview + pose overlay + framing guide,
//    • a minimal top bar (dev-server IP field + tracking dot),
//    • live guidance text + a readiness indicator,
//    • a single "Start" button (enabled once you're in frame).
//
//  Tapping Start (or clapping when far away) flips `AppModel.phase` to `.game` and
//  `ContentView` swaps in `GameView` (the full-screen web game). There is no calibration
//  step — the web game captures its own baseline on its first frame.
//

import SaaSMakerUI
import SwiftUI

struct SetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.verticalSizeClass) private var vSizeClass
    let session: PoseSession

    @State private var showDevField = false

    /// Bumped when a clap fires the CTA, to drive a brief button pulse (nice-to-have feedback
    /// so a far-away user sees their clap registered). Reset by the animation.
    @State private var clapPulse = false

    /// Landscape when the vertical size class is compact (wide, short window). Used to keep
    /// the chrome reachable and the panels from eating the whole short axis in landscape.
    private var isLandscape: Bool { vSizeClass == .compact }

    var body: some View {
        ZStack {
            // Camera + overlay fill the screen — `.resizeAspectFill` keeps the (now upright)
            // preview filling both a tall portrait and a wide landscape window.
            CameraPreview(session: session)
                .ignoresSafeArea()
            PoseOverlay(joints: model.joints, tracking: model.tracking)
                .ignoresSafeArea()

            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 16) {
                        topBar
                        Spacer(minLength: 16)
                        bottomPanel
                            .frame(maxWidth: isLandscape ? 520 : .infinity)
                    }
                    .frame(minHeight: max(0, geometry.size.height - 32))
                    .padding()
                }
            }
        }
        // Clap → primary CTA. This view owns the setup CTA, so it maps the clap to its own
        // button: a clap acts exactly like tapping "Start", but ONLY when that button is
        // actually enabled (setup phase + ready). Anything else (not ready) ignores the clap
        // so a far-away user can't trigger a disabled/absent action.
        .onChange(of: model.clapCount) { _, _ in
            guard model.phase == .setup, model.readyToStart else { return }
            triggerClapPulse()
            model.startGame()
        }
    }

    /// Briefly flash the CTA so a clap from across the room gives visible confirmation.
    private func triggerClapPulse() {
        withAnimation(.easeOut(duration: 0.12)) { clapPulse = true }
        withAnimation(.easeIn(duration: 0.28).delay(0.12)) { clapPulse = false }
    }

    // MARK: - Top bar

    private var topBar: some View {
        SMCard(padding: 10) {
            VStack(spacing: 8) {
                HStack(spacing: 12) {
                    SMStatusPill(trackingText, tone: readinessTone)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    // Camera flip: front (selfie) ⇄ wide-rear (ultra-wide, fits the whole body
                    // from close). Switches the live session in place — no freeze — and both
                    // cameras emit the same mirror-corrected joints, so pose/games are unaffected.
                    cameraFlipButton
                    // Dev-server IP editor (repurposed old "server host" field). Only relevant
                    // when loading the game from the Vite dev server; hidden by default.
                    Button {
                        withAnimation { showDevField.toggle() }
                    } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.title3)
                            .foregroundStyle(.white.opacity(0.8))
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.smLink)
                    .accessibilityLabel("Settings")
                }
                // Compact status pill for the relay stream, always visible when streaming so
                // the user can glance at connection health without opening the panel.
                if model.streamToWebsite {
                    streamStatusPill
                }
                if showDevField {
                    settingsPanel
                }
            }
        }
    }

    /// A small camera-flip button on the preview chrome. Shows the CURRENT camera and toggles
    /// to the other on tap: front (selfie, tighter FOV) ⇄ wide-rear (ultra-wide, whole body
    /// fits from close). Tapping updates `model.cameraFacing` and switches the live session.
    private var cameraFlipButton: some View {
        Button {
            let next: CameraFacing = model.cameraFacing == .front ? .wideRear : .front
            model.cameraFacing = next
            session.switchCamera(to: next)
        } label: {
            Image(
                systemName: model.cameraFacing == .front
                    ? "arrow.triangle.2.circlepath.camera.fill"  // on front → tap to go wide-rear
                    : "camera.fill"
            )  // on wide-rear → tap to go front
            .font(.title3)
            .foregroundStyle(.white.opacity(0.8))
            .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.smLink)
        .accessibilityLabel(
            model.cameraFacing == .front
                ? "Switch to wide rear camera"
                : "Switch to front camera")
    }

    /// Expanded settings: Mac LAN IP (used for BOTH the game and the relay), the "Stream
    /// to website" toggle, the room code, and a small hand-openness debug readout.
    private var settingsPanel: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("mac LAN IP (dev server + website relay)")
                    .font(Design.detail)
                    .foregroundStyle(.white.opacity(0.7))
                TextField("192.168.x.x", text: $model.devServerIP)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }

            Divider().overlay(.white.opacity(0.2))

            Toggle(isOn: $model.streamToWebsite) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("stream to website")
                        .font(Design.heading)
                        .foregroundStyle(.white)
                    Text("Send your motion + hands to a laptop browser")
                        .font(Design.detail)
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
            .tint(Design.palette.brand)
            .accessibilityLabel("Stream to website")

            VStack(alignment: .leading, spacing: 4) {
                Text("room code (open this on the laptop)")
                    .font(Design.detail)
                    .foregroundStyle(.white.opacity(0.7))
                TextField("MOTION", text: $model.roomCode)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.characters)
            }

            if model.streamToWebsite {
                streamStatusPill
            }

            Divider().overlay(.white.opacity(0.2))

            HStack(spacing: 20) {
                Link("privacy", destination: URL(string: "https://motion.significanthobbies.com/privacy")!)
                    .accessibilityLabel("Privacy")
                Link("support", destination: URL(string: "https://motion.significanthobbies.com")!)
                    .accessibilityLabel("Support")
            }
            .font(Design.caption.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, alignment: .leading)

            // Live hand-openness debug so the user can confirm open/close is detected.
            if let hands = model.hands {
                Text(String(format: "Hands  L %.2f   R %.2f", hands.left, hands.right))
                    .font(Design.mono)
                    .foregroundStyle(.white.opacity(0.85))
            }
        }
    }

    /// A single-line connection status for the relay stream.
    private var streamStatusPill: some View {
        SMStatusPill(streamStatusText, tone: streamStatusTone)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var streamStatusText: String {
        if model.peerConnected { return "laptop connected" }
        switch model.streamConnection {
        case .idle: return "off"
        case .connecting: return "connecting…"
        case .connected: return "streaming (waiting for laptop)"
        case .reconnecting(let n): return "reconnecting (\(n))…"
        case .failed(let reason): return reason
        }
    }

    private var streamStatusTone: SMStatusPill.Tone {
        // GREEN means the end-to-end link is up — i.e. the laptop peer is actually
        // connected. Relay-connected-but-no-laptop is amber ("waiting"), so the phone
        // never shows green while the laptop shows nothing. Keeps the two coherent.
        if model.peerConnected { return .success }
        switch model.streamConnection {
        case .connected: return .warning  // on the relay, but the laptop isn't here yet
        case .connecting, .reconnecting: return .warning
        case .failed: return .danger
        case .idle: return .neutral
        }
    }

    private var trackingText: String {
        switch model.tracking {
        case .ok: return "tracking you"
        case .lost: return "no one in view"
        default: return "adjusting…"
        }
    }

    // MARK: - Bottom panel

    @ViewBuilder
    private var bottomPanel: some View {
        SMCard(padding: 16) {
            VStack(spacing: 14) {
                SMSectionHeader(model.guidance, size: 20)
                modeChip

                switch model.phase {
                case .setup:
                    VStack(spacing: 6) {
                        Button {
                            model.startGame()
                        } label: {
                            Text(model.readyToStart ? "start" : "get in frame to start")
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                        }
                        .buttonStyle(.smBrand)
                        .accessibilityLabel(model.readyToStart ? "Start" : "Get in frame to start")
                        .disabled(!model.readyToStart)
                        .opacity(model.readyToStart ? 1 : 0.45)
                        // Brief pulse when a clap fires the button, so a far-away user sees it land.
                        .scaleEffect(clapPulse ? 1.04 : 1.0)

                        // Discoverability: once the button is clap-triggerable (ready) AND the user
                        // is likely far from the phone (full-body mode = standing back), hint that a
                        // clap works as a remote press. Quiet + consistent with the panel style.
                        if model.readyToStart && model.framingMode == .fullBody {
                            Text("👏 or clap to start")
                                .font(Design.caption)
                                .foregroundStyle(.white.opacity(0.75))
                        }
                    }

                case .game:
                    EmptyView()
                }
            }
        }
    }

    /// A quiet status pill showing the active framing mode; context, not a control.
    private var modeChip: some View {
        SMStatusPill(model.framingMode.label.lowercased())
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(model.framingMode.label)
    }

    private var readinessTone: SMStatusPill.Tone {
        switch model.tracking {
        case .ok: return .success
        case .lost: return .danger
        default: return .warning
        }
    }
}

// MARK: - Share sheet

/// Make `URL` usable with `.sheet(item:)`. Its absolute string is a stable identity.
extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// Thin `UIActivityViewController` wrapper so the user can preview/share/save the saved
/// screen recording (the video is already in Photos; this offers quick preview + share).
/// Shared by `SetupView` and `GameView`.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
