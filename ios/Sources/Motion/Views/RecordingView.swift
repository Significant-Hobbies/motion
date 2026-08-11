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

import SwiftUI

struct RecordingView: View {
    @Environment(AppModel.self) private var model

    /// Optional hook the parent supplies to open the saved video (share sheet / player).
    var onOpenSaved: ((URL) -> Void)?

    var body: some View {
        let rec = model.recorder

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: rec.isArmed ? "record.circle.fill" : "record.circle")
                    .foregroundStyle(rec.isArmed ? .red : .white)
                    .font(.title3)
                Text("Record my play")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { rec.isArmed },
                    set: { _ in rec.toggle() }
                ))
                .labelsHidden()
                .tint(.red)
            }

            if let status = statusText(for: rec.state) {
                HStack(spacing: 8) {
                    if case .saving = rec.state { ProgressView().controlSize(.small) }
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(statusColor(for: rec.state))
                }
            }

            if case .saved = rec.state, let url = rec.lastSavedURL {
                Button {
                    onOpenSaved?(url)
                } label: {
                    Label("Open saved video", systemImage: "play.rectangle.fill")
                        .font(.caption.bold())
                }
                .buttonStyle(.bordered)
                .tint(.white)
            }

            Text("Records this device's screen — the game and your camera together — on-device only.")
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.6))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding()
        .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 16))
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

    private func statusColor(for state: ScreenRecorder.State) -> Color {
        switch state {
        case .failed: return .orange
        case .saved: return .green
        case .recording: return .red
        default: return .white.opacity(0.85)
        }
    }
}
