// PARKED for v2 (browser/relay path) — not used in v1.
//
//  PairingView.swift
//  Motion
//
//  Room-code entry: a large 6-box segmented field, a host field (LAN IP of the Mac
//  running the server), a Connect button, and live connection status.
//
//  Excluded from the v1 build: it drives the parked socket/pairing AppModel API
//  (partyHost / connect() / connection) which v1's AppModel no longer exposes. Kept in the
//  target (behind the MOTION_V2 flag) so the v2 browser/relay path is preserved intact.
//

#if MOTION_V2

import SwiftUI

struct PairingView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var codeFocused: Bool

    var body: some View {
        @Bindable var model = model

        VStack(spacing: 28) {
            Spacer(minLength: 12)

            VStack(spacing: 6) {
                Text("Motion")
                    .font(.largeTitle.bold())
                Text("Turn your device into a motion controller")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // Six-box code display driven by a hidden text field.
            codeBoxes
                .onTapGesture { codeFocused = true }

            // Hidden field that actually captures input.
            TextField("", text: Binding(
                get: { model.roomCode },
                set: { model.roomCode = sanitize($0) }
            ))
            .keyboardType(.asciiCapable)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .focused($codeFocused)
            .frame(width: 1, height: 1)
            .opacity(0.01)

            VStack(alignment: .leading, spacing: 6) {
                Text("Server host")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("192.168.x.x", text: $model.partyHost)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }
            .padding(.horizontal, 24)

            Button(action: { model.connect() }) {
                Text("Connect")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!isValidRoomCode(model.roomCode))
            .padding(.horizontal, 24)

            statusLine

            Spacer()
        }
        .onAppear { codeFocused = true }
    }

    // MARK: - Pieces

    private var codeBoxes: some View {
        HStack(spacing: 10) {
            ForEach(0..<CODE_LENGTH, id: \.self) { i in
                let chars = Array(model.roomCode)
                let ch = i < chars.count ? String(chars[i]) : ""
                Text(ch)
                    .font(.system(size: 32, weight: .bold, design: .monospaced))
                    .frame(width: 44, height: 56)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Color(.secondarySystemBackground))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(i == model.roomCode.count ? Color.accentColor : Color.clear,
                                    lineWidth: 2)
                    )
            }
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        switch model.connection {
        case .idle:
            if let err = model.lastError {
                Label(err, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }
        case .connecting:
            ProgressView("Connecting…")
        case .reconnecting(let attempt):
            ProgressView("Reconnecting… (\(attempt))")
        case .connected:
            Label("Connected", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed(let reason):
            Label(reason, systemImage: "xmark.octagon")
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }

    /// Keep only alphabet chars, uppercase, clamp to code length.
    private func sanitize(_ s: String) -> String {
        let up = s.uppercased()
        let filtered = up.filter { CODE_ALPHABET.contains($0) }
        return String(filtered.prefix(CODE_LENGTH))
    }
}

#endif // MOTION_V2
