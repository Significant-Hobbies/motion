//
//  PoseEstimator.swift
//  Motion
//
//  Runs Apple Vision 2D human body-pose detection on each camera frame and produces
//  the protocol's 8 normalized joints. No custom ML model — `VNDetectHumanBodyPoseRequest`.
//
//  TWO-PASS PER FRAME (accuracy fix for noisy hand open/close):
//    PASS 1 — BODY (full frame): find the wrists.
//    PASS 2 — HANDS (ROI-zoomed): for EACH wrist, run a `VNDetectHumanHandPoseRequest`
//      with `maximumHandCount = 1` and a `regionOfInterest` cropped tightly around that
//      wrist. Vision then processes just that region at the model's input resolution —
//      effectively ZOOMING the hand so it fills the frame, giving far more precise 21-point
//      landmarks than a whole-body frame (where each hand is only a few dozen pixels).
//      Because each ROI request is tied to a SPECIFIC wrist, left/right is deterministic
//      (no nearest-wrist guessing). A side whose wrist is missing this frame falls back to
//      a full-frame hand request so it degrades gracefully. See `computeHands(...)`.
//
//  COORDINATE PIPELINE (read carefully — there is no compiler to catch a flip):
//    • DEPENDS ON A DISPLAY-UPRIGHT BUFFER. The camera connection is kept horizon-level
//      by an `AVCaptureDevice.RotationCoordinator` (see CameraController), so the buffer
//      handed to Vision is ALWAYS display-upright for the current device orientation —
//      tall in portrait, wide in landscape, but never sideways. Because of that, the SAME
//      mapping below (mirror x kept, y flipped) is correct in BOTH orientations; nothing
//      here needs to branch on orientation. If you ever stop keeping the connection
//      horizon-level, this mapping breaks in landscape.
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
    /// Optional arm-chain joints (shoulders + elbows), same coordinate convention as `joints`
    /// (mirror-corrected, top-left origin, swapped left/right). A joint below confidence is
    /// simply absent from this map so the packet omits it rather than sending garbage.
    let armJoints: [ArmJointName: Point2]
    /// Aggregate confidence 0..1 across the joints we found.
    let quality: Double
    /// Per-joint confidence (post-threshold) for the setup evaluator / overlay dimming.
    let confidences: [JointName: Double]
    /// Per-hand openness 0..1 (0 = fist, 1 = open palm), computed from the SAME frame's
    /// hand-pose observations and assigned to the player's left/right. `nil` = not computed
    /// this frame (e.g. no hands detected and none ever seen); the packet then omits `hands`.
    let hands: HandState?
    /// Per-hand precise index-fingertip in the SAME coordinate convention as `joints`
    /// (top-left origin, mirror-corrected, 0..1), from the ROI-zoomed hand pass. `nil` = no
    /// fingertip confidently seen for either side this frame; the packet then omits
    /// `fingertips`. Each side inside may still be nil when only one hand is detected.
    let fingertips: Fingertips?
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

    /// Per-side ROI-cropped hand requests. Each is run on a small `regionOfInterest`
    /// centered on ONE body wrist so Vision processes just that region at the model's input
    /// resolution — effectively ZOOMING the hand so its 21 landmarks are far more precise
    /// than when the hand is only a few dozen pixels of a full-body frame. Because each
    /// request's ROI is tied to a specific wrist, left/right is DETERMINISTIC (no
    /// nearest-wrist guessing). `maximumHandCount = 1` since the ROI holds one hand.
    private let leftHandRequest: VNDetectHumanHandPoseRequest
    private let rightHandRequest: VNDetectHumanHandPoseRequest

    /// Fallback full-frame hand request (up to 2 hands). Used ONLY for a side whose body
    /// wrist is missing/low-confidence this frame, so the hand degrades gracefully instead
    /// of being lost entirely. Cheap when unused (we simply don't perform it).
    private let fallbackHandRequest: VNDetectHumanHandPoseRequest

    /// ROI edge length as a fraction of the (normalized) frame. Square in normalized space.
    /// ~0.30 gives a comfortable margin around the hand while still zooming it a lot.
    /// Tunable: larger = more context/safety-margin but less zoom; smaller = more zoom but
    /// risks clipping a fast-moving hand out of the box before the next frame.
    private let roiSize: CGFloat = 0.30

    /// Turns each side's ROI hand observation into smoothed openness + fingertip.
    private let handEstimator = HandPoseEstimator()

    /// Serial queue so smoothing state (`smoothed`) is only touched from one thread.
    private let workQueue = DispatchQueue(label: "com.motion.pose")
    /// Previous smoothed joints, for the exponential filter.
    private var smoothed: [JointName: Point2] = [:]
    /// Previous smoothed arm-chain joints (shoulders + elbows), same filter as `smoothed`.
    private var smoothedArms: [ArmJointName: Point2] = [:]

    init() {
        request = VNDetectHumanBodyPoseRequest()
        leftHandRequest = VNDetectHumanHandPoseRequest()
        leftHandRequest.maximumHandCount = 1
        rightHandRequest = VNDetectHumanHandPoseRequest()
        rightHandRequest.maximumHandCount = 1
        fallbackHandRequest = VNDetectHumanHandPoseRequest()
        fallbackHandRequest.maximumHandCount = 2
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

            // ── PASS 1: BODY (full frame) ────────────────────────────────────────────────
            // We need the wrist positions before we can build the per-hand ROIs, so the body
            // request runs first, alone, on the full frame.
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
            self.buildAndEmit(from: points, handler: handler)
        }
    }

    // MARK: - Mapping

    /// Map Vision's recognized points to the 8 protocol joints, applying coordinate
    /// flip, left/right swap, smoothing, and confidence thresholding.
    private func buildAndEmit(from points: [VNHumanBodyPoseObservation.JointName: VNRecognizedPoint],
                              handler: VNImageRequestHandler) {
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

        // ARM CHAIN (shoulders + elbows) — OPTIONAL. SWAPPED exactly like hands/knees/feet
        // above: the mirrored buffer flips visual sides, so Vision's LEFT is the player's
        // RIGHT. Same y-flip and confidence threshold (via `pt`). Below-threshold joints
        // stay absent here, so the packet omits them rather than sending garbage.
        var rawArms: [ArmJointName: (Point2, Double)] = [:]
        rawArms[.rightShoulder] = pt(.leftShoulder)
        rawArms[.leftShoulder]  = pt(.rightShoulder)
        rawArms[.rightElbow]    = pt(.leftElbow)
        rawArms[.leftElbow]     = pt(.rightElbow)

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

        // Arm-chain smoothing — same exponential filter (`a`) as the required joints above.
        // A joint present this frame is smoothed against its previous value (or adopts the
        // new value if fresh); a joint absent this frame reuses its last smoothed value so a
        // brief dropout doesn't make the arm snap. A joint never seen stays absent (omitted).
        var outArms: [ArmJointName: Point2] = [:]
        for name in ArmJointName.allCases {
            if let (p, _) = rawArms[name] {
                if let prev = smoothedArms[name] {
                    let sx = a * p[0] + (1 - a) * prev[0]
                    let sy = a * p[1] + (1 - a) * prev[1]
                    outArms[name] = [sx, sy]
                    smoothedArms[name] = [sx, sy]
                } else {
                    outArms[name] = p
                    smoothedArms[name] = p
                }
            } else if let prev = smoothedArms[name] {
                // Missing this frame: reuse last known position (kept in sync with the
                // required-joint dropout behavior above). Not fabricated from nothing.
                outArms[name] = prev
            }
            // else: never detected → leave absent so the packet omits this arm joint.
        }

        // ── PASS 2: ROI-ZOOMED HANDS ─────────────────────────────────────────────────────
        // For EACH player hand, run a hand-pose request cropped to a small ROI around that
        // wrist so Vision zooms the hand and returns precise landmarks. The ROI is centered
        // on the smoothed, mirror-corrected wrist we just computed (`outJoints[.leftHand]` /
        // `[.rightHand]`), and because each request is tied to a specific side, left/right is
        // deterministic. A side whose wrist is missing/low-confidence this frame falls back to
        // the full-frame request so the hand isn't lost.
        let (hands, fingertips) = self.computeHands(
            leftWrist: outJoints[.leftHand],
            leftWristConf: confidences[.leftHand],
            rightWrist: outJoints[.rightHand],
            rightWristConf: confidences[.rightHand],
            handler: handler
        )

        let frame = PoseFrame(joints: outJoints, armJoints: outArms, quality: quality,
                              confidences: confidences, hands: hands, fingertips: fingertips)
        Task { @MainActor in self.delegate?.poseEstimator(self, didProduce: frame) }
    }

    // MARK: - ROI-zoomed hands (pass 2)

    /// Run the per-wrist ROI hand requests, plus a full-frame fallback when a wrist is
    /// missing, and turn the results into openness (`HandState`) + index fingertips
    /// (`Fingertips`). Returns `nil` for a field when there is nothing meaningful to send.
    private func computeHands(
        leftWrist: Point2?, leftWristConf: Double?,
        rightWrist: Point2?, rightWristConf: Double?,
        handler: VNImageRequestHandler
    ) -> (HandState?, Fingertips?) {
        // A wrist is usable for an ROI only if it was actually detected this frame (conf > 0);
        // a value carried over from a dropout (conf == 0) is too stale to crop around.
        let haveLeft = (leftWristConf ?? 0) > 0 && leftWrist != nil
        let haveRight = (rightWristConf ?? 0) > 0 && rightWrist != nil

        // Build + perform each side's ROI request. Collect into per-side requests so results
        // stay attributed to the correct side no matter what.
        var toPerform: [VNDetectHumanHandPoseRequest] = []
        if haveLeft, let w = leftWrist {
            leftHandRequest.regionOfInterest = roi(aroundTopLeftWrist: w)
            toPerform.append(leftHandRequest)
        }
        if haveRight, let w = rightWrist {
            rightHandRequest.regionOfInterest = roi(aroundTopLeftWrist: w)
            toPerform.append(rightHandRequest)
        }

        // Fallback: if EITHER wrist is missing, run the full-frame request once so we can still
        // pick up that hand (best-effort — lower resolution, but better than losing it).
        let needFallback = !haveLeft || !haveRight
        if needFallback {
            fallbackHandRequest.regionOfInterest = CGRect(x: 0, y: 0, width: 1, height: 1)
            toPerform.append(fallbackHandRequest)
        }

        // Nothing to do (no wrists at all AND fallback found nothing is handled below).
        guard !toPerform.isEmpty else { return (nil, nil) }

        do {
            try handler.perform(toPerform)
        } catch {
            // ROI can still be rejected in edge cases; fail soft (no hands this frame).
            return (nil, nil)
        }

        // Resolve each side's single observation, preferring the ROI result and falling back
        // to the nearest full-frame observation by wrist when the ROI side was absent.
        let leftObs: VNHumanHandPoseObservation? = haveLeft
            ? leftHandRequest.results?.first
            : nearestFallbackObservation(toTopLeftWrist: leftWrist)
        let rightObs: VNHumanHandPoseObservation? = haveRight
            ? rightHandRequest.results?.first
            : nearestFallbackObservation(toTopLeftWrist: rightWrist)

        // If literally nothing was detected on either side and neither has ever been seen,
        // emit nothing so the packet omits `hands`/`fingertips`.
        if leftObs == nil && rightObs == nil && !handEstimator.hasEverSeenHand {
            return (nil, nil)
        }

        // Each side's points must be lifted out of ITS OWN ROI. When a side fell back to the
        // full-frame request, its ROI is the full frame (identity remap).
        let leftROI = haveLeft ? leftHandRequest.regionOfInterest : fullFrameROI
        let rightROI = haveRight ? rightHandRequest.regionOfInterest : fullFrameROI
        let leftReading = handEstimator.analyzeSide(observation: leftObs, side: .left,
                                                    mapPoint: { self.mapRecognizedPoint($0, roi: leftROI) })
        let rightReading = handEstimator.analyzeSide(observation: rightObs, side: .right,
                                                     mapPoint: { self.mapRecognizedPoint($0, roi: rightROI) })

        let hands = HandState(left: leftReading.openness, right: rightReading.openness)

        // Fingertips: omit the whole field only when BOTH sides are nil.
        let fingertips: Fingertips? = (leftReading.indexTip == nil && rightReading.indexTip == nil)
            ? nil
            : Fingertips(left: leftReading.indexTip, right: rightReading.indexTip)

        return (hands, fingertips)
    }

    /// Pick the full-frame (fallback) hand observation whose wrist is nearest the given
    /// body wrist (top-left space). Used only for a side that had no ROI observation.
    private func nearestFallbackObservation(toTopLeftWrist wrist: Point2?)
        -> VNHumanHandPoseObservation? {
        let candidates = fallbackHandRequest.results ?? []
        guard !candidates.isEmpty else { return nil }
        guard let wrist, wrist.count == 2 else { return candidates.first }
        let target = CGPoint(x: wrist[0], y: wrist[1])
        var best: VNHumanHandPoseObservation?
        var bestDist = Double.greatestFiniteMagnitude
        for obs in candidates {
            guard
                let pts = try? obs.recognizedPoints(.all),
                let w = pts[.wrist], w.confidence >= confidenceThreshold
            else { continue }
            // Map the fallback wrist into the same top-left/mirror frame for a fair compare.
            // Fallback observations are full-image, so use the full-frame (identity) ROI.
            let mapped = mapRecognizedPoint(w, roi: fullFrameROI)
            let dx = mapped[0] - Double(target.x), dy = mapped[1] - Double(target.y)
            let d = dx * dx + dy * dy
            if d < bestDist { bestDist = d; best = obs }
        }
        return best ?? candidates.first
    }

    // MARK: - ROI geometry + coordinate mapping (the #1 on-device verify item)

    /// Build a normalized `regionOfInterest` (Vision's BOTTOM-LEFT origin) centered on a
    /// wrist given in the protocol's TOP-LEFT, mirror-corrected space.
    ///
    /// CONVERSION (there is no compiler to catch a flip — verify on device):
    ///   • The wrist x is already in mirror space and matches Vision's x (the buffer is
    ///     already mirrored by the camera connection — see PoseEstimator's header), so ROI
    ///     x = wristX unchanged.
    ///   • The wrist y is TOP-LEFT (y down); Vision's ROI is BOTTOM-LEFT (y up), so
    ///     ROI y = 1 - wristY.
    ///   • We center a `roiSize`×`roiSize` square on that point, then CLAMP it fully inside
    ///     [0,1] (Vision REJECTS an ROI that exceeds the image — that would throw in
    ///     `perform` and we'd lose the hand).
    private func roi(aroundTopLeftWrist wrist: Point2) -> CGRect {
        let cx = CGFloat(wrist[0])                 // mirror-space x, same as Vision
        let cy = 1.0 - CGFloat(wrist[1])           // top-left y → Vision bottom-left y
        let half = roiSize / 2
        // Clamp the CENTER so a full-size box fits, then place the box. This keeps the box
        // exactly `roiSize` wide (rather than shrinking it) while staying inside [0,1].
        let minC = half
        let maxC = 1 - half
        let clampedCx = min(max(cx, minC), maxC)
        let clampedCy = min(max(cy, minC), maxC)
        return CGRect(x: clampedCx - half, y: clampedCy - half, width: roiSize, height: roiSize)
    }

    /// Map a raw hand `VNRecognizedPoint` to the protocol's TOP-LEFT, mirror-corrected,
    /// FULL-IMAGE `[x, y]` in 0..1.
    ///
    /// #1 ON-DEVICE VERIFY ITEM — ROI COORDINATE CONVENTION:
    ///   Apple documents that when `regionOfInterest` is set, Vision maps recognized-point
    ///   coordinates BACK to the FULL IMAGE (they are NOT ROI-relative). We rely on that
    ///   here: we take `point.location` as full-image normalized and only apply the same
    ///   top-left/mirror conversion the body uses (x kept, y flipped).
    ///
    ///   IF on-device testing shows the fingertip lands in the wrong place (e.g. the cursor
    ///   is squeezed into the top-left corner or clustered near the ROI), the points are
    ///   ROI-RELATIVE instead. To switch, un-comment the ROI-relative remap below and pass
    ///   the active ROI in. This is deliberately isolated to ONE helper so the flip is a
    ///   two-line change and nothing else needs to move.
    private func mapRecognizedPoint(_ point: VNRecognizedPoint, roi: CGRect) -> Point2 {
        // CONFIRMED ON DEVICE: Vision returns hand-landmark coords RELATIVE TO THE ROI
        // (0..1 within the crop), NOT remapped to the full image. So we lift them into
        // full-image space using the ROI rect (Vision bottom-left), then flip to top-left.
        // For the full-frame fallback (roi = 0,0,1,1) this is an identity — so both the
        // ROI-zoomed and fallback paths use the exact same helper.
        let fullX = Double(roi.minX + point.location.x * roi.width)   // full-image, mirror-space
        let fullYBottomLeft = Double(roi.minY + point.location.y * roi.height)
        return [fullX, 1.0 - fullYBottomLeft]                        // bottom-left → top-left
    }

    /// The full-frame ROI — used for fallback (full-image) observations, where the
    /// ROI-relative remap collapses to an identity.
    private let fullFrameROI = CGRect(x: 0, y: 0, width: 1, height: 1)

    private func emitLost() {
        // Decay smoothing state so a fresh detection doesn't lerp from a stale pose.
        smoothed.removeAll()
        smoothedArms.removeAll()
        handEstimator.reset()
        Task { @MainActor in self.delegate?.poseEstimatorDidLoseTracking(self) }
    }
}
