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
//    • The camera connection is configured with `isVideoMirrored = true` for BOTH the
//      front AND the wide-rear camera (see CameraController — the rear is mirrored in
//      software precisely so this mapping stays camera-agnostic), so the pixel buffer
//      Vision sees is ALWAYS mirrored like a mirror regardless of which camera is active.
//      Therefore Vision's x is already in mirror space and we DO NOT flip x again here.
//      (If you ever disable connection mirroring, flip x here: x' = 1 - x.)
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

    /// Lower threshold for the OPTIONAL arm-chain joints (shoulders + elbows). Vision
    /// scores elbows well below wrists at body distance, so gating them at the full
    /// `confidenceThreshold` drops them and the avatar's arms render as straight sticks
    /// (no bend). These joints are purely cosmetic (they only refine the drawn arm and
    /// the sword's aim), so a looser gate is safe — a slightly noisy elbow beats none.
    var armConfidenceThreshold: Float = 0.12

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

    /// Turns each side's ROI hand observation into smoothed openness + fingertip. This is the
    /// FALLBACK hand path, used only when MediaPipe can't initialize.
    private let handEstimator = HandPoseEstimator()

    /// PRIMARY hand path: Google MediaPipe `HandLandmarker` (21 3D landmarks/hand), far more
    /// robust for hand open/close at body distance than Vision's ROI hand pose. When it
    /// initializes (`isAvailable`), the streamed openness + fingertips come from it and the
    /// Vision hand ROI pass is skipped entirely. When it can't init (model missing /
    /// unsupported), we transparently fall back to `handEstimator` above. See
    /// `HandLandmarkerEstimator` and `computeHands(...)`.
    private let mediaPipeHands = HandLandmarkerEstimator()

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

            let handler = VNImageRequestHandler(
                cvPixelBuffer: pixelBuffer,
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
            // Pass the pixel buffer + frame time through so the MediaPipe hand path can run on
            // the SAME frame (VIDEO mode needs a monotonic ms timestamp; `now` is our clock).
            self.buildAndEmit(
                from: points, handler: handler,
                pixelBuffer: pixelBuffer, timestampSeconds: now)
        }
    }

    // MARK: - Mapping

    /// Map Vision's recognized points to the 8 protocol joints, applying coordinate
    /// flip, left/right swap, smoothing, and confidence thresholding.
    private func buildAndEmit(
        from points: [VNHumanBodyPoseObservation.JointName: VNRecognizedPoint],
        handler: VNImageRequestHandler,
        pixelBuffer: CVPixelBuffer,
        timestampSeconds: TimeInterval
    ) {
        // Required joints gate at `confidenceThreshold`; the cosmetic arm chain (shoulders +
        // elbows) at the looser `armConfidenceThreshold` so a bent arm survives a ~0.15 elbow.
        let raw = PoseMath.bodyJoints { self.reading(points[$0], threshold: self.confidenceThreshold) }
        let rawArms = PoseMath.armJoints { self.reading(points[$0], threshold: self.armConfidenceThreshold) }

        // Nothing usable this frame.
        guard !raw.isEmpty else {
            emitLost()
            return
        }

        // Exponential smoothing per joint; a brief dropout keeps the last smoothed value so
        // the overlay doesn't jitter and the arm doesn't snap.
        let body = PoseMath.smooth(raw, previous: &smoothed, alpha: smoothing)
        let arms = PoseMath.smooth(rawArms, previous: &smoothedArms, alpha: smoothing)

        // ── PASS 2: ROI-ZOOMED HANDS ─────────────────────────────────────────────────────
        // The ROI is centered on the smoothed, mirror-corrected wrist just computed, and each
        // request is tied to a specific side, so left/right is deterministic. A side whose
        // wrist is missing/low-confidence this frame falls back to the full-frame request.
        let wrists = WristReadings(
            left: body.points[.leftHand], leftConfidence: body.confidences[.leftHand],
            right: body.points[.rightHand], rightConfidence: body.confidences[.rightHand])
        let (hands, fingertips) = computeHands(
            wrists: wrists, handler: handler,
            pixelBuffer: pixelBuffer, timestampSeconds: timestampSeconds)

        let frame = PoseFrame(
            joints: body.points, armJoints: arms.points, quality: PoseMath.quality(body.confidences),
            confidences: body.confidences, hands: hands, fingertips: fingertips)
        Task { @MainActor in self.delegate?.poseEstimator(self, didProduce: frame) }
    }

    /// A Vision point if it clears `threshold`, converted to top-left origin. x is kept as-is
    /// (buffer already mirrored); y is flipped.
    private func reading(_ point: VNRecognizedPoint?, threshold: Float) -> PoseReading? {
        guard let point, point.confidence >= threshold else { return nil }
        let location = PoseMath.topLeft(x: Double(point.location.x), y: Double(point.location.y))
        return (location, Double(point.confidence))
    }

    // MARK: - ROI-zoomed hands (pass 2)

    /// Turn the frame's hands into openness (`HandState`) + index fingertips (`Fingertips`).
    /// Returns `nil` for a field when there is nothing meaningful to send.
    private func computeHands(
        wrists: WristReadings,
        handler: VNImageRequestHandler,
        pixelBuffer: CVPixelBuffer,
        timestampSeconds: TimeInterval
    ) -> (HandState?, Fingertips?) {
        // ── PRIMARY: MediaPipe HandLandmarker ────────────────────────────────────────────────
        // When available it OWNS the hand signal and the Vision ROI pass is skipped. Only
        // wrists detected this frame are passed, so a stale dropout wrist can't mis-assign.
        // `analyze` returns nil only if MediaPipe became unavailable mid-run; the Vision path
        // below is then the safety net.
        if mediaPipeHands.isAvailable,
            let out = mediaPipeHands.analyze(
                pixelBuffer: pixelBuffer,
                timestampSeconds: timestampSeconds,
                leftWrist: wrists.freshLeft,
                rightWrist: wrists.freshRight
            )
        {
            return out
        }
        return visionHands(wrists: wrists, handler: handler)
    }

    /// FALLBACK: Apple Vision ROI hand pose (original path). A per-wrist ROI request runs for
    /// each wrist detected this frame, plus one full-frame request when either is missing.
    private func visionHands(wrists: WristReadings, handler: VNImageRequestHandler) -> (HandState?, Fingertips?) {
        let leftROI = wrists.freshLeft.map { roi(aroundTopLeftWrist: $0) }
        let rightROI = wrists.freshRight.map { roi(aroundTopLeftWrist: $0) }
        // ROI can still be rejected in edge cases; fail soft (no hands this frame).
        guard performHandRequests(leftROI: leftROI, rightROI: rightROI, handler: handler) else {
            return (nil, nil)
        }

        // Prefer each side's ROI result; a side without one takes the nearest full-frame
        // observation by its (possibly stale) wrist.
        let leftObs: VNHumanHandPoseObservation? =
            leftROI != nil
            ? leftHandRequest.results?.first
            : nearestFallbackObservation(toTopLeftWrist: wrists.left)
        let rightObs: VNHumanHandPoseObservation? =
            rightROI != nil
            ? rightHandRequest.results?.first
            : nearestFallbackObservation(toTopLeftWrist: wrists.right)

        // Nothing on either side and never seen: omit `hands`/`fingertips` from the packet.
        if leftObs == nil && rightObs == nil && !handEstimator.hasEverSeenHand {
            return (nil, nil)
        }

        // Each side's points are lifted out of ITS OWN ROI; a fallback side uses the full frame.
        let leftReading = handEstimator.analyzeSide(
            observation: leftObs, side: .left,
            mapPoint: { self.mapRecognizedPoint($0, roi: leftROI ?? self.fullFrameROI) })
        let rightReading = handEstimator.analyzeSide(
            observation: rightObs, side: .right,
            mapPoint: { self.mapRecognizedPoint($0, roi: rightROI ?? self.fullFrameROI) })

        let hands = HandState(left: leftReading.openness, right: rightReading.openness)
        return (hands, PoseMath.fingertips(left: leftReading.indexTip, right: rightReading.indexTip))
    }

    /// Configure and perform this frame's hand requests. Results stay attributed to the
    /// correct side because each side has its own request. Returns false when nothing ran
    /// or Vision rejected the batch.
    private func performHandRequests(leftROI: CGRect?, rightROI: CGRect?, handler: VNImageRequestHandler) -> Bool {
        var toPerform: [VNDetectHumanHandPoseRequest] = []
        if let leftROI {
            leftHandRequest.regionOfInterest = leftROI
            toPerform.append(leftHandRequest)
        }
        if let rightROI {
            rightHandRequest.regionOfInterest = rightROI
            toPerform.append(rightHandRequest)
        }
        // If EITHER wrist is missing, run the full-frame request once so that hand can still
        // be picked up (best-effort: lower resolution, but better than losing it).
        if leftROI == nil || rightROI == nil {
            fallbackHandRequest.regionOfInterest = fullFrameROI
            toPerform.append(fallbackHandRequest)
        }
        guard !toPerform.isEmpty else { return false }
        do {
            try handler.perform(toPerform)
        } catch {
            return false
        }
        return true
    }

    /// Pick the full-frame (fallback) hand observation whose wrist is nearest the given
    /// body wrist (top-left space). Used only for a side that had no ROI observation.
    private func nearestFallbackObservation(toTopLeftWrist wrist: Point2?)
        -> VNHumanHandPoseObservation?
    {
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
            let dx = mapped[0] - Double(target.x)
            let dy = mapped[1] - Double(target.y)
            let d = dx * dx + dy * dy
            if d < bestDist {
                bestDist = d
                best = obs
            }
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
        PoseMath.roi(aroundTopLeftWrist: wrist, size: roiSize)
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
        // (0..1 within the crop), NOT remapped to the full image, so lift them with the
        // ROI rect. The full-frame fallback ROI makes this an identity apart from the flip.
        PoseMath.liftFromROI(point.location, roi: roi)
    }

    /// The full-frame ROI — used for fallback (full-image) observations, where the
    /// ROI-relative remap collapses to an identity.
    private let fullFrameROI = CGRect(x: 0, y: 0, width: 1, height: 1)

    private func emitLost() {
        // Decay smoothing state so a fresh detection doesn't lerp from a stale pose.
        smoothed.removeAll()
        smoothedArms.removeAll()
        handEstimator.reset()
        mediaPipeHands.reset()
        Task { @MainActor in self.delegate?.poseEstimatorDidLoseTracking(self) }
    }
}
