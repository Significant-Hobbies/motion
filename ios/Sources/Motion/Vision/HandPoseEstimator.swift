//
//  HandPoseEstimator.swift
//  Motion
//
//  Turns Apple Vision hand-pose observations into a per-hand openness value in 0..1
//  (0 = closed fist, 1 = open palm) and assigns each detected hand to the PLAYER's
//  left/right so the result lines up with the body `Joints`.
//
//  It does NOT own a camera or a request loop: `PoseEstimator` runs
//  `VNDetectHumanHandPoseRequest` alongside the body request on the SAME
//  `VNImageRequestHandler` per frame (one Vision pass, one camera output), then hands
//  the resulting observations here together with the frame's mirror-corrected body
//  wrists. That keeps the hand work on the same background queue as the body work and
//  avoids a second camera output contending for the sensor.
//
//  COORDINATE NOTES (match PoseEstimator.swift):
//    • Vision returns normalized points in [0,1], origin BOTTOM-LEFT, y up.
//    • The FRONT camera connection is already mirrored (see CameraController), so the
//      buffer Vision sees is in mirror space: x is kept as-is, y is flipped (y' = 1 - y)
//      to reach the protocol's top-left origin. This is exactly what PoseEstimator does
//      for the body, so hand wrist points and body wrist points share one coordinate
//      frame and can be compared directly for the left/right assignment below.
//
//  OPENNESS MATH (per hand):
//    Take the four NON-THUMB fingertips — .indexTip, .middleTip, .ringTip, .littleTip —
//    and the .wrist. Mean fingertip→wrist distance grows as the hand opens and shrinks
//    to a fist. To make it scale-invariant (hand nearer/farther from camera), normalize
//    by a hand-scale reference: the wrist→.middleMCP distance (the length of the palm),
//    which barely changes with finger flexion. So:
//
//        ratio = mean(dist(fingertipᵢ, wrist)) / dist(middleMCP, wrist)
//
//    A closed fist curls the fingertips back toward the palm/wrist, so the mean tip→wrist
//    distance is close to the palm length → ratio ≈ 1. A fully open hand extends the
//    fingers to roughly twice the palm length → ratio ≈ 2. We map that empirical band
//    [OPEN_RATIO_MIN … OPEN_RATIO_MAX] = [1.1 … 2.0] onto 0..1 and clamp. Low-confidence
//    landmarks are ignored; if too few usable points remain the reading is dropped.
//

import CoreGraphics
import Foundation
import Vision

/// Stateless-per-call analyzer for a single frame's hand observations. The only state it
/// keeps is the exponential smoothing memory for each player hand, so open/close reads
/// smoothly instead of flickering frame to frame.
final class HandPoseEstimator: @unchecked Sendable {

    // MARK: - Tuning

    /// Landmarks below this confidence are treated as missing (matches the body threshold).
    var confidenceThreshold: Float = 0.3

    /// Exponential smoothing factor for openness: new = a*current + (1-a)*previous.
    /// Higher = snappier / noisier; lower = smoother / laggier.
    var smoothing: Double = 0.4

    /// Empirical ratio band mapped onto openness 0..1 (see the openness math above).
    /// ratio ≤ MIN → 0 (fist); ratio ≥ MAX → 1 (open palm).
    private let openRatioMin: Double = 1.1
    private let openRatioMax: Double = 2.0

    /// Neutral openness a hand decays toward when it stops being detected. 0.5 avoids a
    /// hard "grab" (0) or "release" (1) on a brief dropout; per the spec, a totally
    /// unseen hand defaults to open (see `handState(...)`).
    private let neutralOpenness: Double = 0.5

    // MARK: - Smoothing memory (touched only from the estimator's work queue)

    private var smoothedLeft: Double?
    private var smoothedRight: Double?

    /// Reset smoothing so a fresh detection doesn't lerp from a stale value.
    func reset() {
        smoothedLeft = nil
        smoothedRight = nil
    }

    // MARK: - Public entry

    /// Compute the player's `HandState` from this frame's hand observations.
    ///
    /// - Parameters:
    ///   - observations: results of `VNDetectHumanHandPoseRequest` for this frame.
    ///   - leftBodyHand: the player's LEFT wrist in protocol space (top-left origin,
    ///     mirror-corrected) from the body pose, if available — used to assign each
    ///     detected hand to left/right by nearest wrist.
    ///   - rightBodyHand: the player's RIGHT wrist in protocol space, if available.
    /// - Returns: a `HandState` with `left`/`right` in 0..1. Never nil: a hand that was
    ///   not detected this frame holds its smoothed value decaying toward neutral, and a
    ///   hand never seen at all defaults to OPEN (1.0) so it can't falsely "grab".
    func handState(
        from observations: [VNHumanHandPoseObservation],
        leftBodyHand: Point2?,
        rightBodyHand: Point2?
    ) -> HandState {
        // Measure openness + wrist location for each detected hand this frame.
        struct Measured { let openness: Double; let wrist: CGPoint }
        var measured: [Measured] = []
        for obs in observations.prefix(2) {
            guard
                let openness = openness(for: obs),
                let wrist = wristPoint(for: obs)
            else { continue }
            measured.append(Measured(openness: openness, wrist: wrist))
        }

        // ── Left/right assignment ────────────────────────────────────────────────────
        // Match each detected hand to the NEAREST body wrist. The body wrists are already
        // mirror-corrected and named by the player's real side (PoseEstimator swaps
        // Vision's chirality), and hand wrist points are converted into the same
        // top-left/mirror frame below, so nearest-wrist matching yields the player's own
        // left vs. right. When body wrists are missing (body lost), fall back to the raw
        // observation ordering as a best effort.
        var rawLeft: Double?
        var rawRight: Double?

        if let l = leftBodyHand, let r = rightBodyHand {
            let lp = CGPoint(x: l[0], y: l[1])
            let rp = CGPoint(x: r[0], y: r[1])
            for m in measured {
                let dl = sqDist(m.wrist, lp)
                let dr = sqDist(m.wrist, rp)
                if dl <= dr {
                    // Keep the closest hand if two map to the same side.
                    if rawLeft == nil { rawLeft = m.openness }
                } else {
                    if rawRight == nil { rawRight = m.openness }
                }
            }
        } else {
            // No body reference this frame: assign in observation order (index 0 → left).
            if measured.count > 0 { rawLeft = measured[0].openness }
            if measured.count > 1 { rawRight = measured[1].openness }
        }

        let left = smoothedValue(raw: rawLeft, previous: &smoothedLeft)
        let right = smoothedValue(raw: rawRight, previous: &smoothedRight)
        return HandState(left: left, right: right)
    }

    // MARK: - Openness for a single observation

    /// Openness 0..1 for one hand, or nil if too few reliable landmarks.
    private func openness(for obs: VNHumanHandPoseObservation) -> Double? {
        guard let points = try? obs.recognizedPoints(.all) else { return nil }

        // Pull a landmark only if it clears the confidence threshold.
        func p(_ name: VNHumanHandPoseObservation.JointName) -> CGPoint? {
            guard let pt = points[name], pt.confidence >= confidenceThreshold else { return nil }
            return pt.location // normalized; scale-invariant ratio below cancels the frame
        }

        guard let wrist = p(.wrist) else { return nil }

        // Hand-scale reference: palm length (wrist → middle-finger knuckle). Barely varies
        // with finger flexion, so it normalizes for how near/far the hand is.
        guard let middleMCP = p(.middleMCP) else { return nil }
        let scale = dist(wrist, middleMCP)
        guard scale > 1e-4 else { return nil }

        // Mean fingertip→wrist distance over the four non-thumb fingertips we can see.
        let tips: [VNHumanHandPoseObservation.JointName] = [.indexTip, .middleTip, .ringTip, .littleTip]
        var sum = 0.0
        var count = 0
        for tip in tips {
            if let t = p(tip) {
                sum += dist(t, wrist)
                count += 1
            }
        }
        // Need at least two fingertips to trust the reading.
        guard count >= 2 else { return nil }
        let meanTipDist = sum / Double(count)

        let ratio = meanTipDist / scale
        // Map the empirical [min…max] ratio band onto 0..1 and clamp.
        let openness = (ratio - openRatioMin) / (openRatioMax - openRatioMin)
        return min(1.0, max(0.0, openness))
    }

    /// The hand's wrist point in protocol space (top-left origin, mirror-corrected) so it
    /// can be compared to body wrists. Returns nil if the wrist is missing/low-confidence.
    private func wristPoint(for obs: VNHumanHandPoseObservation) -> CGPoint? {
        guard
            let points = try? obs.recognizedPoints(.all),
            let wrist = points[.wrist], wrist.confidence >= confidenceThreshold
        else { return nil }
        // x kept as-is (buffer already mirrored), y flipped bottom-left → top-left.
        return CGPoint(x: wrist.location.x, y: 1.0 - wrist.location.y)
    }

    // MARK: - Smoothing / decay

    /// Apply exponential smoothing to a fresh reading, or decay toward neutral when the
    /// hand wasn't detected this frame. A hand never seen at all (previous == nil and no
    /// reading) defaults to OPEN (1.0) so it can't falsely trigger a grab.
    private func smoothedValue(raw: Double?, previous: inout Double?) -> Double {
        if let raw {
            let a = smoothing
            let next = previous.map { a * raw + (1 - a) * $0 } ?? raw
            previous = next
            return next
        }
        // Not detected this frame.
        guard let prev = previous else { return 1.0 } // never seen → open, never grabs
        // Decay the held value toward neutral so a lost hand relaxes instead of sticking.
        let next = prev + (neutralOpenness - prev) * 0.1
        previous = next
        return next
    }

    // MARK: - Geometry

    private func dist(_ a: CGPoint, _ b: CGPoint) -> Double {
        Double(hypot(a.x - b.x, a.y - b.y))
    }

    private func sqDist(_ a: CGPoint, _ b: CGPoint) -> Double {
        let dx = Double(a.x - b.x), dy = Double(a.y - b.y)
        return dx * dx + dy * dy
    }
}
