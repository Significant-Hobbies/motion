//
//  PoseMath.swift
//  Motion
//
//  The pure parts of `PoseEstimator`: joint mapping (y flip + mirrored left/right
//  swap), exponential smoothing, quality, ROI geometry and ROI→full-image lifting.
//  Nothing here runs a Vision request or touches a pixel buffer, so it is covered by
//  `MotionTests/PoseMathTests.swift` without a camera. See PoseEstimator's header for
//  why each convention holds; those comments are the source of truth.
//

import CoreGraphics
import Vision

/// A converted point (top-left origin, mirror space) and its Vision confidence.
typealias PoseReading = (point: Point2, confidence: Double)

/// The body wrists handed to the hand pass. A confidence of 0 marks a position carried
/// over from a dropout, which is too stale to crop around or to assign hands by.
struct WristReadings {
    let left: Point2?
    let leftConfidence: Double?
    let right: Point2?
    let rightConfidence: Double?

    /// The left wrist only when it was detected this frame (confidence > 0).
    var freshLeft: Point2? { (leftConfidence ?? 0) > 0 ? left : nil }
    /// The right wrist only when it was detected this frame (confidence > 0).
    var freshRight: Point2? { (rightConfidence ?? 0) > 0 ? right : nil }
}

enum PoseMath {
    typealias BodyLookup = (VNHumanBodyPoseObservation.JointName) -> PoseReading?

    /// Vision's bottom-left normalized point → the protocol's top-left. x is already in
    /// mirror space (the connection mirrors the buffer), so only y flips.
    static func topLeft(x: Double, y: Double) -> Point2 {
        [x, 1.0 - y]
    }

    /// Midpoint of two optional readings (needs both). Confidence = min of the two.
    static func midpoint(_ a: PoseReading?, _ b: PoseReading?) -> PoseReading? {
        guard let a, let b else { return nil }
        return ([(a.point[0] + b.point[0]) / 2, (a.point[1] + b.point[1]) / 2], min(a.confidence, b.confidence))
    }

    /// The 8 protocol joints from thresholded Vision points. Sides are SWAPPED because the
    /// mirrored buffer puts Vision's LEFT on the player's RIGHT. Missing joints are absent.
    static func bodyJoints(_ pt: BodyLookup) -> [JointName: PoseReading] {
        var raw: [JointName: PoseReading] = [:]
        // HEAD: prefer the nose; fall back to neck if the face is turned/occluded.
        raw[.head] = pt(.nose) ?? pt(.neck)
        raw[.rightHand] = pt(.leftWrist)
        raw[.leftHand] = pt(.rightWrist)
        // TORSO: `.root` is the pelvis; then the shoulder midpoint, then the hip midpoint.
        raw[.torso] =
            pt(.root)
            ?? midpoint(pt(.leftShoulder), pt(.rightShoulder))
            ?? midpoint(pt(.leftHip), pt(.rightHip))
        raw[.rightKnee] = pt(.leftKnee)
        raw[.leftKnee] = pt(.rightKnee)
        // FEET: the 2D body model has no toe joint, so ankle == foot.
        raw[.rightFoot] = pt(.leftAnkle)
        raw[.leftFoot] = pt(.rightAnkle)
        return raw
    }

    /// The optional arm chain (shoulders + elbows), swapped exactly like `bodyJoints`.
    static func armJoints(_ pt: BodyLookup) -> [ArmJointName: PoseReading] {
        var raw: [ArmJointName: PoseReading] = [:]
        raw[.rightShoulder] = pt(.leftShoulder)
        raw[.leftShoulder] = pt(.rightShoulder)
        raw[.rightElbow] = pt(.leftElbow)
        raw[.leftElbow] = pt(.rightElbow)
        return raw
    }

    /// Exponential smoothing per joint: new = alpha*current + (1-alpha)*previous. A joint
    /// seen for the first time adopts its value; a joint missing this frame reuses its last
    /// smoothed value with confidence 0; a joint never seen stays absent.
    static func smooth<Key: Hashable & CaseIterable>(
        _ raw: [Key: PoseReading],
        previous: inout [Key: Point2],
        alpha a: Double
    ) -> (points: [Key: Point2], confidences: [Key: Double]) {
        var points: [Key: Point2] = [:]
        var confidences: [Key: Double] = [:]
        for name in Key.allCases {
            if let (p, conf) = raw[name] {
                if let prev = previous[name] {
                    let sx = a * p[0] + (1 - a) * prev[0]
                    let sy = a * p[1] + (1 - a) * prev[1]
                    points[name] = [sx, sy]
                    previous[name] = [sx, sy]
                } else {
                    points[name] = p
                    previous[name] = p
                }
                confidences[name] = conf
            } else if let prev = previous[name] {
                points[name] = prev
                confidences[name] = 0
            }
        }
        return (points, confidences)
    }

    /// Aggregate confidence over ALL protocol joints (absent joints count as 0).
    static func quality(_ confidences: [JointName: Double]) -> Double {
        confidences.values.isEmpty
            ? 0
            : confidences.values.reduce(0, +) / Double(JointName.allCases.count)
    }

    /// A `size`×`size` Vision ROI (bottom-left origin) centered on a top-left wrist, with the
    /// center clamped so the whole box stays inside [0,1] (Vision rejects an overflowing ROI).
    static func roi(aroundTopLeftWrist wrist: Point2, size: CGFloat) -> CGRect {
        let cx = CGFloat(wrist[0])  // mirror-space x, same as Vision
        let cy = 1.0 - CGFloat(wrist[1])  // top-left y → Vision bottom-left y
        let half = size / 2
        let clampedCx = min(max(cx, half), 1 - half)
        let clampedCy = min(max(cy, half), 1 - half)
        return CGRect(x: clampedCx - half, y: clampedCy - half, width: size, height: size)
    }

    /// Lift an ROI-relative hand landmark (confirmed on device: Vision returns hand points
    /// relative to the crop) into the full image, then flip to top-left. A full-frame ROI
    /// is an identity apart from the flip.
    static func liftFromROI(_ location: CGPoint, roi: CGRect) -> Point2 {
        let fullX = Double(roi.minX + location.x * roi.width)  // full-image, mirror-space
        let fullYBottomLeft = Double(roi.minY + location.y * roi.height)
        return [fullX, 1.0 - fullYBottomLeft]  // bottom-left → top-left
    }

    /// Fingertips for the packet: omitted entirely only when BOTH sides are nil.
    static func fingertips(left: Point2?, right: Point2?) -> Fingertips? {
        (left == nil && right == nil) ? nil : Fingertips(left: left, right: right)
    }
}
