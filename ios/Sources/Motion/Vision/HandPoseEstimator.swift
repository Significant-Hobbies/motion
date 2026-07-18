//
//  HandPoseEstimator.swift
//  Motion
//
//  Turns Apple Vision hand-pose observations into a per-hand openness value in 0..1
//  (0 = closed fist, 1 = open palm) PLUS a precise index-fingertip position per hand,
//  keyed to the PLAYER's left/right so the result lines up with the body `Joints`.
//
//  It does NOT own a camera or a request loop. `PoseEstimator` now runs TWO ROI-cropped
//  `VNDetectHumanHandPoseRequest`s per frame — one per body wrist — so each hand request
//  is DETERMINISTICALLY tied to the player's left or right side (no nearest-wrist
//  guessing). It hands the resulting single observation for each side here via
//  `analyzeSide(...)`; this file computes openness + fingertip and smooths per side.
//  When a side has no ROI observation (wrist missing / low-confidence / ROI empty), the
//  caller passes `nil` and the openness decays toward neutral just like before.
//
//  COORDINATE NOTES (match PoseEstimator.swift):
//    • Vision returns normalized points in [0,1], origin BOTTOM-LEFT, y up.
//    • The FRONT camera connection is already mirrored (see CameraController), so the
//      buffer Vision sees is in mirror space: x is kept as-is, y is flipped (y' = 1 - y)
//      to reach the protocol's top-left origin. This matches what PoseEstimator does for
//      the body, so fingertip points share one coordinate frame with the body joints.
//    • ROI coordinate mapping (the #1 on-device verify item) is handled by PoseEstimator
//      before it calls us: the (x, y) it hands us for each landmark is ALREADY in
//      full-image normalized space. We do NOT re-map for the ROI here — see
//      PoseEstimator.mapRecognizedPoint(...) for the single, clearly-commented conversion.
//      Because that mapping is centralized there, this file only ever sees full-image
//      normalized landmark coordinates and never has to know an ROI was used.
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
//    NOTE: With ROI-cropped ("zoomed") tracking each hand fills the request's input
//    resolution, so the landmarks are far more precise than the old full-frame pass — the
//    ratio band and thresholds are unchanged, they just operate on cleaner points.
//

import CoreGraphics
import Foundation
import Vision

/// Which player hand a single ROI observation belongs to. The caller (PoseEstimator)
/// knows this deterministically because it built the ROI around a specific body wrist.
enum HandSide {
    case left
    case right
}

/// One side's analyzed result: openness (already computed here on the raw observation) and
/// the raw index fingertip in FULL-IMAGE, top-left, mirror-corrected space, if confident.
struct HandSideReading {
    let openness: Double?
    /// Index fingertip `[x, y]` in protocol space (top-left, 0..1, mirror-corrected), or nil.
    let indexTip: Point2?
}

/// Stateless-per-call analyzer for a single frame's hand observations. The only state it
/// keeps is the exponential smoothing memory for each player hand (openness AND fingertip),
/// so both read smoothly instead of flickering frame to frame.
final class HandPoseEstimator: @unchecked Sendable {

    // MARK: - Tuning

    /// Landmarks below this confidence are treated as missing (matches the body threshold).
    var confidenceThreshold: Float = 0.3

    /// Exponential smoothing factor for openness: new = a*current + (1-a)*previous.
    /// Higher = snappier / noisier; lower = smoother / laggier.
    var smoothing: Double = 0.4

    /// Lighter smoothing for the fingertip position (a cursor should feel responsive but
    /// not jittery). new = a*current + (1-a)*previous, per axis.
    var fingertipSmoothing: Double = 0.5

    /// Empirical ratio band mapped onto openness 0..1 (see the openness math above).
    /// ratio ≤ MIN → 0 (fist); ratio ≥ MAX → 1 (open palm).
    private let openRatioMin: Double = 1.1
    private let openRatioMax: Double = 2.0

    /// Neutral openness a hand decays toward when it stops being detected. 0.5 avoids a
    /// hard "grab" (0) or "release" (1) on a brief dropout; per the spec, a totally
    /// unseen hand defaults to open (see `smoothedOpenness(...)`).
    private let neutralOpenness: Double = 0.5

    // MARK: - Smoothing memory (touched only from the estimator's work queue)

    private var smoothedLeft: Double?
    private var smoothedRight: Double?
    private var tipLeft: Point2?
    private var tipRight: Point2?

    /// True once ANY hand has been analyzed since the last reset. Lets the caller decide
    /// whether to emit a (decaying) `HandState` on a frame with no fresh detection, vs. omit
    /// the field entirely because no hand has ever been seen.
    private(set) var hasEverSeenHand = false

    /// Reset smoothing so a fresh detection doesn't lerp from a stale value.
    func reset() {
        smoothedLeft = nil
        smoothedRight = nil
        tipLeft = nil
        tipRight = nil
        hasEverSeenHand = false
    }

    // MARK: - Public entry

    /// Analyze ONE side's ROI hand observation (or nil if that side had no usable ROI hand
    /// this frame) and return the smoothed openness + smoothed index fingertip for that side.
    ///
    /// - Parameters:
    ///   - observation: the single hand observation from that side's ROI request, or nil.
    ///   - side: which player hand this is (deterministic — the ROI was built on this wrist).
    ///   - mapPoint: converts a raw `VNRecognizedPoint` to FULL-IMAGE top-left mirror-
    ///     corrected `[x, y]`. Supplied by PoseEstimator so the ROI↔full-image mapping lives
    ///     in exactly one clearly-commented place (the #1 on-device verify item).
    /// - Returns: openness in 0..1 (never nil — decays toward neutral, defaults OPEN when
    ///   never seen) and the fingertip `[x, y]` (nil until first confidently detected).
    func analyzeSide(
        observation: VNHumanHandPoseObservation?,
        side: HandSide,
        mapPoint: (VNRecognizedPoint) -> Point2
    ) -> (openness: Double, indexTip: Point2?) {
        if observation != nil { hasEverSeenHand = true }
        let reading = observation.map { measure(observation: $0, mapPoint: mapPoint) }
            ?? HandSideReading(openness: nil, indexTip: nil)

        switch side {
        case .left:
            let o = smoothedOpenness(raw: reading.openness, previous: &smoothedLeft)
            let t = smoothedTip(raw: reading.indexTip, previous: &tipLeft)
            return (o, t)
        case .right:
            let o = smoothedOpenness(raw: reading.openness, previous: &smoothedRight)
            let t = smoothedTip(raw: reading.indexTip, previous: &tipRight)
            return (o, t)
        }
    }

    // MARK: - Per-observation measurement

    /// Measure openness + index fingertip for a single hand observation. `mapPoint` turns a
    /// raw Vision recognized point into FULL-IMAGE, top-left, mirror-corrected `[x, y]`.
    private func measure(
        observation obs: VNHumanHandPoseObservation,
        mapPoint: (VNRecognizedPoint) -> Point2
    ) -> HandSideReading {
        guard let points = try? obs.recognizedPoints(.all) else {
            return HandSideReading(openness: nil, indexTip: nil)
        }

        // Openness uses RAW normalized locations directly: it's a ratio of distances within
        // one hand, so any consistent linear coordinate frame (raw or mapped) cancels out.
        // We keep it on raw locations to stay identical to the previous behavior's math.
        func rawLoc(_ name: VNHumanHandPoseObservation.JointName) -> CGPoint? {
            guard let pt = points[name], pt.confidence >= confidenceThreshold else { return nil }
            return pt.location
        }

        let openness = computeOpenness(rawLoc)

        // Index fingertip → mapped into full-image protocol space (top-left, mirror).
        var indexTip: Point2?
        if let tip = points[.indexTip], tip.confidence >= confidenceThreshold {
            indexTip = mapPoint(tip)
        }

        return HandSideReading(openness: openness, indexTip: indexTip)
    }

    /// Openness 0..1 for one hand, or nil if too few reliable landmarks. `p` yields a raw
    /// normalized location for a joint (or nil if below confidence).
    private func computeOpenness(_ p: (VNHumanHandPoseObservation.JointName) -> CGPoint?) -> Double? {
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

    // MARK: - Smoothing / decay

    /// Apply exponential smoothing to a fresh openness reading, or decay toward neutral when
    /// the hand wasn't detected this frame. A hand never seen at all (previous == nil and no
    /// reading) defaults to OPEN (1.0) so it can't falsely trigger a grab.
    private func smoothedOpenness(raw: Double?, previous: inout Double?) -> Double {
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

    /// Light exponential smoothing of the fingertip. Absent this frame → return the last
    /// smoothed value (so a brief dropout doesn't blank a cursor); never seen → nil (omitted).
    private func smoothedTip(raw: Point2?, previous: inout Point2?) -> Point2? {
        guard let raw else { return previous }
        let a = fingertipSmoothing
        guard let prev = previous, prev.count == 2 else {
            previous = raw
            return raw
        }
        let sx = a * raw[0] + (1 - a) * prev[0]
        let sy = a * raw[1] + (1 - a) * prev[1]
        let next: Point2 = [sx, sy]
        previous = next
        return next
    }

    // MARK: - Geometry

    private func dist(_ a: CGPoint, _ b: CGPoint) -> Double {
        Double(hypot(a.x - b.x, a.y - b.y))
    }
}
