//
//  RecordingView.swift
//  Motion
//
//  Compact recording affordance bound to the v1 `ScreenRecorder`. GameView already
//  embeds its own compact record controls in the top bar, so this standalone panel is
//  kept for reuse (e.g. a settings/debug surface) and repointed from the parked
//  `RecordingController` to the new `ScreenRecorder`.
//
//    • a "Record" toggle (opt-in for the on-device screen recording),
//    • live status (armed / recording / saving / saved / failed),
//    • an "Open last video" button once a clip is saved to Photos.
//
//  v1 recording captures the WHOLE SCREEN (web game + camera inset) as one video via
//  ReplayKit — no relay, no compositing. See Recording/ScreenRecorder.swift.
//

import SaaSMakerUI
import SwiftUI

struct RecordingView: View {
    @Environment(AppModel.self) private var model

    /// Optional hook the parent supplies to open the saved video (share sheet / player).
    var onOpenSaved: ((URL) -> Void)?

    var body: some View {
        let rec = model.recorder

        SMCard(padding: 16) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: rec.isArmed ? "record.circle.fill" : "record.circle")
                        .foregroundStyle(rec.isArmed ? .red : .white)
                        .font(.title3)
                    SMSectionHeader("record my play", size: 17)
                    Spacer()
                    Toggle(
                        "",
                        isOn: Binding(
                            get: { rec.isArmed },
                            set: { _ in rec.toggle() }
                        )
                    )
                    .labelsHidden()
                    .accessibilityLabel("Record my play")
                    .tint(Design.palette.destructive)
                }

                if let status = statusText(for: rec.state) {
                    HStack(spacing: 8) {
                        if case .saving = rec.state { ProgressView().controlSize(.small) }
                        SMStatusPill(status, tone: statusTone(for: rec.state))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if case .saved = rec.state, let url = rec.lastSavedURL {
                    Button {
                        onOpenSaved?(url)
                    } label: {
                        Label("open saved video", systemImage: "play.rectangle.fill")
                            .font(Design.caption.weight(.semibold))
                    }
                    .buttonStyle(.smOutline)
                    .accessibilityLabel("Open saved video")
                }

                Text("Records this device's screen — the game and your camera together — on-device only.")
                    .font(Design.detail)
                    .foregroundStyle(.white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Status formatting

    private func statusText(for state: ScreenRecorder.State) -> String? {
        switch state {
        case .idle: return nil
        case .armed: return "Armed — waiting for the game to start."
        case .recording: return "Recording your screen…"
        case .saving: return "Saving to Photos…"
        case .saved: return "Saved to Photos."
        case .failed(let msg): return msg
        }
    }

    private func statusTone(for state: ScreenRecorder.State) -> SMStatusPill.Tone {
        switch state {
        case .failed: return .warning
        case .saved: return .success
        case .recording: return .danger
        default: return .neutral
        }
    }
}
