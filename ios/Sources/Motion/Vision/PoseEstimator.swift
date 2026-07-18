//
//  PoseEstimator.swift
//  Motion
//
//  Runs Apple Vision 2D human body-pose detection on each camera frame and produces
//  the protocol's 8 normalized joints. No custom ML model — `VNDetectHumanBodyPoseRequest`.
//
//  COORDINATE PIPELINE (read carefully — there is no compiler to catch a flip):
//    • Vision returns normalized points in [0,1] with origin BOTTOM-LEFT, y up.
//    • The protocol wants origin TOP-LEFT, y down: so  y' = 1 - y.
//    • The FRONT camera connection is configured with `isVideoMirrored = true`
//      (see CameraController), so the pixel buffer Vision sees is ALREADY mirrored
//      like a mirror. Therefore Vision's x is already in mirror space and we DO NOT
//      flip x again here. (If you ever disable connection mirroring, flip x here:
//      x' = 1 - x.)
//    • Because the buffer is mirrored, Vision's `.leftWrist` visually sits on the
//      player's RIGHT and vice-versa. We name our protocol joints by the player's
//      real body side, so we SWAP left/right when mapping (Vision.left → protocol.right).
//      This is the single most important thing to verify on-device.
//
//  Output is exponentially smoothed per joint and emitted at ~20 Hz (throttled).
//

import CoreVideo
import Foundation
import ImageIO
import Vision

/// The result of estimating one frame.
struct PoseFrame: Sendable {
    /// Mirror-corrected, top-left-origin joints keyed by protocol name. Missing joints absent.
    let joints: [JointName: Point2]
    /// Aggregate confidence 0..1 across the joints we found.
    let quality: Double
    /// Per-joint confidence (post-threshold) for the setup evaluator / overlay dimming.
    let confidences: [JointName: Double]
}

/// Receives estimated frames on the main actor.
@MainActor
protocol PoseEstimatorDelegate: AnyObject {
    func poseEstimator(_ estimator: PoseEstimator, didProduce frame: PoseFrame)
    /// Called when a frame yields no usable body (below threshold / not detected).
    func poseEstimatorDidLoseTracking(_ estimator: PoseEstimator)
}

final class PoseEstimator: @unchecked Sendable {
    weak var delegate: PoseEstimatorDelegate?

    /// Points below this confidence are treated as missing.
    var confidenceThreshold: Float = 0.3

    /// Exponential smoothing factor: new = a*current + (1-a)*previous. Higher = snappier.
    var smoothing: Double = 0.5

    /// Minimum interval between emitted frames (~20 Hz). Vision may run faster; we throttle.
    private let minEmitInterval: TimeInterval = 1.0 / 20.0
    private var lastEmit: TimeInterval = 0

    /// Reused request. Vision requests are cheap to reuse and hold no per-frame state.
    private let request: VNDetectHumanBodyPoseRequest

    /// Serial queue so smoothing state (`smoothed`) is only touched from one thread.
    private let workQueue = DispatchQueue(label: "com.motion.pose")
    /// Previous smoothed joints, for the exponential filter.
    private var smoothed: [JointName: Point2] = [:]

    init() {
        request = VNDetectHumanBodyPoseRequest()
    }

    /// Run detection on a frame. Call from the camera queue; work is dispatched internally.
    func process(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) {
        workQueue.async { [weak self] in
            guard let self else { return }

            // Throttle to ~20 Hz regardless of camera frame rate.
            let now = ProcessInfo.processInfo.systemUptime
            guard now - self.lastEmit >= self.minEmitInterval else { return }

            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer,
                                                orientation: orientation,
                                                options: [:])
            do {
                try handler.perform([self.request])
            } catch {
                self.emitLost()
                return
            }

            guard
                let observation = self.request.results?.first,
                let points = try? observation.recognizedPoints(.all)
            else {
                self.emitLost()
                return
            }

            self.lastEmit = now
            self.buildAndEmit(from: points)
        }
    }

    // MARK: - Mapping

    /// Map Vision's recognized points to the 8 protocol joints, applying coordinate
    /// flip, left/right swap, smoothing, and confidence thresholding.
    private func buildAndEmit(from points: [VNHumanBodyPoseObservation.JointName: VNRecognizedPoint]) {
        // Pull a Vision point if it clears the confidence threshold, converting to
        // top-left origin. x is kept as-is (buffer already mirrored); y is flipped.
        func pt(_ name: VNHumanBodyPoseObservation.JointName) -> (Point2, Double)? {
            guard let p = points[name], p.confidence >= confidenceThreshold else { return nil }
            let x = Double(p.location.x)              // already mirror-space
            let y = 1.0 - Double(p.location.y)        // bottom-left → top-left
            return ([x, y], Double(p.confidence))
        }

        /// Midpoint of two optional points (needs both). Confidence = min of the two.
        func mid(_ a: (Point2, Double)?, _ b: (Point2, Double)?) -> (Point2, Double)? {
            guard let a, let b else { return nil }
            return ([(a.0[0] + b.0[0]) / 2, (a.0[1] + b.0[1]) / 2], min(a.1, b.1))
        }

        var raw: [JointName: (Point2, Double)] = [:]

        // HEAD: prefer the nose; fall back to neck if the face is turned/occluded.
        raw[.head] = pt(.nose) ?? pt(.neck)

        // HANDS: wrists. SWAP because the mirrored buffer flips visual sides —
        // Vision's LEFT wrist is the player's RIGHT hand, and vice-versa.
        raw[.rightHand] = pt(.leftWrist)
        raw[.leftHand]  = pt(.rightWrist)

        // TORSO: Vision's `.root` is the pelvis/hip center. Fall back to the midpoint
        // of the shoulders if root is missing, then to the midpoint of the hips.
        raw[.torso] = pt(.root)
            ?? mid(pt(.leftShoulder), pt(.rightShoulder))
            ?? mid(pt(.leftHip), pt(.rightHip))

        // KNEES (swapped, same reason as hands).
        raw[.rightKnee] = pt(.leftKnee)
        raw[.leftKnee]  = pt(.rightKnee)

        // FEET: ankles are the lowest reliable body-pose joint (no toe joint in the
        // 2D body model), so ankle == foot. (Swapped.)
        raw[.rightFoot] = pt(.leftAnkle)
        raw[.leftFoot]  = pt(.rightAnkle)

        // Nothing usable this frame.
        guard !raw.isEmpty else { emitLost(); return }

        // Exponential smoothing per joint. A joint that was absent adopts the new
        // value directly; a joint absent this frame keeps its previous smoothed value
        // so brief dropouts don't jitter the overlay.
        var outJoints: [JointName: Point2] = [:]
        var confidences: [JointName: Double] = [:]
        let a = smoothing
        for name in JointName.allCases {
            if let (p, conf) = raw[name] {
                if let prev = smoothed[name] {
                    let sx = a * p[0] + (1 - a) * prev[0]
                    let sy = a * p[1] + (1 - a) * prev[1]
                    outJoints[name] = [sx, sy]
                    smoothed[name] = [sx, sy]
                } else {
                    outJoints[name] = p
                    smoothed[name] = p
                }
                confidences[name] = conf
            } else if let prev = smoothed[name] {
                // Missing this frame: reuse last known position, mark low confidence.
                outJoints[name] = prev
                confidences[name] = 0
            }
        }

        let quality = confidences.values.isEmpty ? 0
            : confidences.values.reduce(0, +) / Double(JointName.allCases.count)

        let frame = PoseFrame(joints: outJoints, quality: quality, confidences: confidences)
        Task { @MainActor in self.delegate?.poseEstimator(self, didProduce: frame) }
    }

    private func emitLost() {
        // Decay smoothing state so a fresh detection doesn't lerp from a stale pose.
        smoothed.removeAll()
        Task { @MainActor in self.delegate?.poseEstimatorDidLoseTracking(self) }
    }
}
