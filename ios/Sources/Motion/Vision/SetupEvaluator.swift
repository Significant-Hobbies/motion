//
//  SetupEvaluator.swift
//  Motion
//
//  Turns a `PoseFrame` (or the absence of one) into a `TrackingState` plus a short
//  human guidance string, and computes a debounced "ready" flag (green for ≥1.5s).
//
//  The heuristics are deliberately simple and tuned for a phone propped up a few feet
//  away framing a standing player. All thresholds are in normalized [0,1] frame space
//  with TOP-LEFT origin (y grows downward), matching the protocol.
//

import Foundation

/// The debounced verdict the setup UI renders.
struct SetupVerdict: Sendable, Equatable {
    let tracking: TrackingState
    let guidance: String
    /// True once tracking has been continuously `.ok` for the readiness hold time.
    let ready: Bool
}

@MainActor
final class SetupEvaluator {
    /// How long tracking must stay good before we call the setup "ready".
    var readyHold: TimeInterval = 1.5

    /// Joints that must be present for gameplay to be meaningful.
    private let required: [JointName] = [.head, .torso, .leftFoot, .rightFoot]

    /// When continuous-good tracking started; nil while not good.
    private var goodSince: TimeInterval?

    /// Evaluate a produced frame.
    func evaluate(frame: PoseFrame, brightnessHint: Double? = nil) -> SetupVerdict {
        let present = Set(frame.joints.keys.filter { (frame.confidences[$0] ?? 0) > 0 })

        // Low light: Vision confidence collapses in the dark. If we have a brightness
        // signal use it; otherwise infer from very low aggregate quality with a body.
        if let b = brightnessHint, b < 0.12 {
            return verdict(.lowLight, "Too dark — turn on more light.")
        }

        // Whole body check: need head, torso, and both feet.
        let missing = required.filter { !present.contains($0) }
        if missing.contains(.head), missing.contains(.torso) {
            return verdict(.lost, "Step into the frame so the camera can see you.")
        }
        if missing.contains(.leftFoot) || missing.contains(.rightFoot) {
            // Feet cut off at the bottom → phone too low or player too close.
            return verdict(.raisePhone, "Prop the phone higher so your feet show.")
        }
        if missing.contains(.head) {
            return verdict(.raisePhone, "Tilt the phone up — your head is out of frame.")
        }
        if !missing.isEmpty {
            return verdict(.partial, "Get your whole body in the frame.")
        }

        // Distance from head→feet span in frame. Too tall a span = too close;
        // too short = too far.
        if let head = frame.joints[.head],
           let lf = frame.joints[.leftFoot],
           let rf = frame.joints[.rightFoot] {
            let footY = max(lf[1], rf[1])
            let bodySpan = footY - head[1] // both top-left origin, feet below head
            if bodySpan > 0.95 {
                return verdict(.tooClose, "Step back a little.")
            }
            if bodySpan < 0.45 {
                return verdict(.tooFar, "Come a bit closer.")
            }
        }

        // Everything good.
        return verdict(.ok, "Looking good — hold still.")
    }

    /// Evaluate a lost frame (no body detected at all).
    func evaluateLost() -> SetupVerdict {
        goodSince = nil
        return SetupVerdict(tracking: .lost,
                            guidance: "No one in view. Point the camera at your body.",
                            ready: false)
    }

    // MARK: - Debounce

    private func verdict(_ state: TrackingState, _ guidance: String) -> SetupVerdict {
        let now = ProcessInfo.processInfo.systemUptime
        if state == .ok {
            if goodSince == nil { goodSince = now }
            let ready = (now - (goodSince ?? now)) >= readyHold
            return SetupVerdict(tracking: .ok, guidance: guidance, ready: ready)
        } else {
            goodSince = nil
            return SetupVerdict(tracking: state, guidance: guidance, ready: false)
        }
    }
}
