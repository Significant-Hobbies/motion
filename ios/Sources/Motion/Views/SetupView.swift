//
//  SetupView.swift
//  Motion
//
//  The camera screen used across the setup / calibration phases of the v1 flow:
//    • live camera preview + pose overlay + framing guide,
//    • a minimal top bar (dev-server IP field + tracking dot),
//    • live guidance text + a readiness indicator,
//    • a calibration prompt (setup) or calibration progress (calibration).
//
//  Once calibration completes, `AppModel.phase` flips to `.game` and `ContentView` swaps
//  in `GameView` (the full-screen web game). This view owns the shared `PoseSession` and a
//  `CalibrationController` it starts when the player taps "Calibrate".
//

import SwiftUI

struct SetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @Environment(\.verticalSizeClass) private var vSizeClass
    let session: PoseSession

    @State private var calibration: CalibrationController?
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

            VStack {
                topBar
                Spacer()
                // In landscape the window is short; constrain the bottom panel so it doesn't
                // grow full-width and swallow the (already small) vertical space. In portrait
                // it spans naturally.
                bottomPanel
                    .frame(maxWidth: isLandscape ? 520 : .infinity)
            }
            .padding()
        }
        .onDisappear { calibration?.cancel() }
        // Clap → primary CTA. This view owns the setup CTA, so it maps the clap to its own
        // button: a clap acts exactly like tapping "Calibrate", but ONLY when that button is
        // actually enabled (setup phase + ready). Anything else (not ready, mid-calibration)
        // ignores the clap so a far-away user can't trigger a disabled/absent action.
        .onChange(of: model.clapCount) { _, _ in
            guard model.phase == .setup, model.readyToCalibrate else { return }
            triggerClapPulse()
            startCalibration()
        }
    }

    /// Briefly flash the CTA so a clap from across the room gives visible confirmation.
    private func triggerClapPulse() {
        withAnimation(.easeOut(duration: 0.12)) { clapPulse = true }
        withAnimation(.easeIn(duration: 0.28).delay(0.12)) { clapPulse = false }
    }

    // MARK: - Top bar

    private var topBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Label(trackingText, systemImage: "circle.fill")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .labelStyle(ChipLabelStyle(dotColor: readinessColor))
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
                }
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
        .padding(10)
        .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 16))
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
            Image(systemName: model.cameraFacing == .front
                  ? "arrow.triangle.2.circlepath.camera.fill"   // on front → tap to go wide-rear
                  : "camera.fill")                               // on wide-rear → tap to go front
                .font(.title3)
                .foregroundStyle(.white.opacity(0.8))
        }
        .accessibilityLabel(model.cameraFacing == .front
                            ? "Switch to wide rear camera"
                            : "Switch to front camera")
    }

    /// Expanded settings: Mac LAN IP (used for BOTH the game and the relay), the "Stream
    /// to website" toggle, the room code, and a small hand-openness debug readout.
    private var settingsPanel: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Mac LAN IP (dev server + website relay)")
                    .font(.caption2)
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
                    Text("Stream to website")
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)
                    Text("Send your motion + hands to a laptop browser")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
            .tint(.green)

            VStack(alignment: .leading, spacing: 4) {
                Text("Room code (open this on the laptop)")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.7))
                TextField("MOTION", text: $model.roomCode)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.characters)
            }

            if model.streamToWebsite {
                streamStatusPill
            }

            // Live hand-openness debug so the user can confirm open/close is detected.
            if let hands = model.hands {
                Text(String(format: "Hands  L %.2f   R %.2f", hands.left, hands.right))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.white.opacity(0.85))
            }
        }
    }

    /// A single-line connection status for the relay stream.
    private var streamStatusPill: some View {
        HStack(spacing: 6) {
            Circle().fill(streamStatusColor).frame(width: 8, height: 8)
            Text(streamStatusText)
                .font(.caption2.bold())
                .foregroundStyle(.white)
        }
    }

    private var streamStatusText: String {
        if model.peerConnected { return "Laptop connected" }
        switch model.streamConnection {
        case .idle: return "Off"
        case .connecting: return "Connecting…"
        case .connected: return "Streaming (waiting for laptop)"
        case .reconnecting(let n): return "Reconnecting (\(n))…"
        case .failed(let reason): return reason
        }
    }

    private var streamStatusColor: Color {
        // GREEN means the end-to-end link is up — i.e. the laptop peer is actually
        // connected. Relay-connected-but-no-laptop is amber ("waiting"), so the phone
        // never shows green while the laptop shows nothing. Keeps the two coherent.
        if model.peerConnected { return .green }
        switch model.streamConnection {
        case .connected: return .yellow   // on the relay, but the laptop isn't here yet
        case .connecting, .reconnecting: return .yellow
        case .failed: return .red
        case .idle: return .gray
        }
    }

    private var trackingText: String {
        switch model.tracking {
        case .ok: return "Tracking you"
        case .lost: return "No one in view"
        default: return "Adjusting…"
        }
    }

    // MARK: - Bottom panel

    @ViewBuilder
    private var bottomPanel: some View {
        VStack(spacing: 14) {
            HStack(spacing: 10) {
                Circle()
                    .fill(readinessColor)
                    .frame(width: 14, height: 14)
                Text(model.guidance)
                    .font(.headline)
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.leading)
                Spacer()
                // Subtle current-mode chip so the player knows why the guidance differs
                // (full-body in portrait vs upper-body in landscape).
                modeChip
            }

            switch model.phase {
            case .setup:
                VStack(spacing: 6) {
                    Button {
                        startCalibration()
                    } label: {
                        Text(model.readyToCalibrate ? "Calibrate" : "Get in frame to calibrate")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.readyToCalibrate)
                    // Brief pulse when a clap fires the button, so a far-away user sees it land.
                    .scaleEffect(clapPulse ? 1.04 : 1.0)

                    // Discoverability: once the button is clap-triggerable (ready) AND the user
                    // is likely far from the phone (full-body mode = standing back), hint that a
                    // clap works as a remote press. Quiet + consistent with the panel style.
                    if model.readyToCalibrate && model.framingMode == .fullBody {
                        Text("👏 or clap to continue")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.75))
                    }
                }

            case .calibration:
                VStack(spacing: 8) {
                    Text(calibrationPrompt)
                        .font(.title3.bold())
                        .foregroundStyle(.white)
                    ProgressView(value: model.calibrationProgress)
                        .tint(.green)
                }

            case .game:
                EmptyView()
            }
        }
        .padding()
        .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 20))
    }

    /// A small pill showing the active framing mode ("Full-body" / "Upper-body"), with an
    /// orientation-suggestive icon. Deliberately quiet — it's context, not a control.
    private var modeChip: some View {
        HStack(spacing: 4) {
            Image(systemName: model.framingMode == .fullBody
                  ? "figure.stand"
                  : "hand.raised.fill")
                .font(.caption2)
            Text(model.framingMode.label)
                .font(.caption2.bold())
        }
        .foregroundStyle(.white.opacity(0.85))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.white.opacity(0.12), in: Capsule())
    }

    private var calibrationPrompt: String {
        switch model.calibrationStage {
        case .neutral: return "Stand still, arms relaxed"
        case .arms: return "Stretch your arms out wide"
        case .squat: return "Do a small squat"
        case .done: return "All set!"
        }
    }

    private var readinessColor: Color {
        switch model.tracking {
        case .ok: return .green
        case .lost: return .red
        default: return .yellow
        }
    }

    private func startCalibration() {
        model.beginCalibration()
        let c = CalibrationController(model: model)
        calibration = c
        c.start()
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

/// Renders the label's leading dot in a role-specific color while keeping white text.
struct ChipLabelStyle: LabelStyle {
    let dotColor: Color
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.foregroundStyle(dotColor).font(.system(size: 8))
            configuration.title
        }
    }
}
