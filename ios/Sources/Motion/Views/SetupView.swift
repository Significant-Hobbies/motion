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
    let session: PoseSession

    @State private var calibration: CalibrationController?
    @State private var showDevField = false

    var body: some View {
        ZStack {
            // Camera + overlay fill the screen.
            CameraPreview(session: session.captureSession)
                .ignoresSafeArea()
            PoseOverlay(joints: model.joints, tracking: model.tracking)
                .ignoresSafeArea()

            VStack {
                topBar
                Spacer()
                bottomPanel
            }
            .padding()
        }
        .onDisappear { calibration?.cancel() }
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
        if model.peerConnected { return .green }
        switch model.streamConnection {
        case .connected: return .green
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
            }

            switch model.phase {
            case .setup:
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
