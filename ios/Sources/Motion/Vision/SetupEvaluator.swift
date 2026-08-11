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

/// Which part of the body the setup is framing for. ORIENTATION IS THE MODE: portrait (a
/// tall frame) means full-body; landscape (a wide frame) means upper-body only. The mode
/// changes which joints are required, the distance heuristics, and the guidance copy.
enum FramingMode: String, Sendable, Equatable, CaseIterable {
    /// Portrait / tall frame: expect head-to-feet (games that use legs / squats).
    case fullBody
    /// Landscape / wide frame: expect head, arms, hands only (desk / hand-focused). Making
    /// the hands bigger in a wide frame also improves hand tracking.
    case upperBody

    /// A short, user-facing label for the mode chip.
    var label: String {
        switch self {
        case .fullBody: return "Full-body"
        case .upperBody: return "Upper-body"
        }
    }
}

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

    /// The active framing mode. Drives the required-joint set + guidance + distance checks.
    /// Set from the device orientation (see `AppModel`). Defaults to full-body (portrait).
    var mode: FramingMode = .fullBody

    /// Joints that must be present for gameplay to be meaningful, per mode.
    ///   • fullBody: head, torso, both knees, both feet (a whole standing body).
    ///   • upperBody: head, torso, and BOTH hands — NO knees/feet (desk / hand-focused).
    ///     Shoulders/elbows are nice-to-have (they live in the optional arm chain, not here).
    private func requiredJoints(for mode: FramingMode) -> [JointName] {
        switch mode {
        case .fullBody:
            return [.head, .torso, .leftKnee, .rightKnee, .leftFoot, .rightFoot]
        case .upperBody:
            return [.head, .torso, .leftHand, .rightHand]
        }
    }

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

        switch mode {
        case .fullBody: return evaluateFullBody(present: present, frame: frame)
        case .upperBody: return evaluateUpperBody(present: present, frame: frame)
        }
    }

    /// Portrait / tall frame: require the whole standing body (head, torso, knees, feet).
    private func evaluateFullBody(present: Set<JointName>, frame: PoseFrame) -> SetupVerdict {
        let missing = requiredJoints(for: .fullBody).filter { !present.contains($0) }
        if missing.contains(.head), missing.contains(.torso) {
            return verdict(.lost, "Step into the frame so the camera can see you.")
        }
        if missing.contains(.leftFoot) || missing.contains(.rightFoot) {
            // Feet cut off at the bottom → phone too low or player too close.
            return verdict(.raisePhone, "Prop your device higher so your feet show.")
        }
        if missing.contains(.head) {
            return verdict(.raisePhone, "Tilt your device up — your head is out of frame.")
        }
        if !missing.isEmpty {
            return verdict(.partial, "Step back so your whole body fits.")
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

        return verdict(.ok, "Looking good — hold still.")
    }

    /// Landscape / wide frame: require head, torso, and BOTH hands. Legs are deliberately
    /// NOT required — this mode is for desk / hand-focused play, so readiness must go green
    /// with no knees/feet in frame at all.
    private func evaluateUpperBody(present: Set<JointName>, frame: PoseFrame) -> SetupVerdict {
        let missing = requiredJoints(for: .upperBody).filter { !present.contains($0) }
        if missing.contains(.head), missing.contains(.torso) {
            return verdict(.lost, "Step into the frame so the camera can see you.")
        }
        if missing.contains(.head) {
            return verdict(.raisePhone, "Tilt your device so your head is in frame.")
        }
        if missing.contains(.leftHand) || missing.contains(.rightHand) {
            return verdict(.partial, "Frame your head, arms, and hands.")
        }
        if !missing.isEmpty {
            return verdict(.partial, "Frame your head, arms, and hands.")
        }

        // Distance: use the head→hands vertical reach as a rough "am I close enough" gauge.
        // Too small a reach means the player is far away and the hands will be tiny; too
        // large means they're cropping themselves. These are loose — the point of this mode
        // is bigger hands, so we err toward "come closer".
        if let head = frame.joints[.head] {
            let hy = [frame.joints[.leftHand]?[1], frame.joints[.rightHand]?[1]].compactMap { $0 }
            if let lowestHand = hy.max() {
                let reach = abs(lowestHand - head[1])
                if reach < 0.12 {
                    return verdict(.tooFar, "Come closer so your hands fill the frame.")
                }
            }
        }

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
