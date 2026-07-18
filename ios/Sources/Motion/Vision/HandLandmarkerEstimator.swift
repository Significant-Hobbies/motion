//
//  HandLandmarkerEstimator.swift
//  Motion
//
//  Robust hand open/close using Google MediaPipe Tasks `HandLandmarker` (21 3D landmarks
//  per hand), REPLACING the weaker Apple-Vision ROI hand-pose signal. Vision still owns the
//  BODY pose (see PoseEstimator); this estimator owns the HAND signal — per-hand openness
//  (0..1) plus the index-fingertip — and is fed the SAME camera pixel buffers Vision uses.
//
//  WHY MEDIAPIPE: at body distance the hand is only a few dozen pixels of the frame and
//  Apple Vision's fist/open reading is noisy. MediaPipe's HandLandmarker is trained for
//  small, distant hands and returns denser, steadier landmarks, so open/close is far more
//  reliable. When it can't initialize (model missing / unsupported), the caller falls back
//  to the Vision hand path so the app never loses the signal (see PoseEstimator).
//
//  RUNNING MODE: `.video`. We feed monotonically-increasing millisecond timestamps derived
//  from the frame clock. VIDEO mode is stateful/tracking (cheaper + steadier than IMAGE per
//  frame) and synchronous (`detect(videoFrame:timestampInMilliseconds:)` returns the result
//  inline), which fits the existing off-main-thread pull model — no delegate/callback plumbing.
//
//  COORDINATE CONVENTION (must match PoseEstimator's output — there is no compiler to catch
//  a flip):
//    • MediaPipe returns normalized landmarks in [0,1], origin TOP-LEFT, y DOWN — already the
//      protocol's convention, so (unlike Vision, which is bottom-left) there is NO y-flip.
//    • The pixel buffer is ALREADY software-mirrored by the camera connection
//      (`isVideoMirrored = true`, see CameraController) and display-upright, and we pass it to
//      MPImage with `.up` orientation — exactly like Vision. So MediaPipe's x is already in the
//      app's mirror-space: x is kept as-is (NOT flipped). This is the same "keep x, buffer is
//      pre-mirrored" rule the body pose uses.
//    • Net mapping: protocol point = [landmark.x, landmark.y] directly, clamped to [0,1].
//
//  LEFT/RIGHT ASSIGNMENT (documented choice): we DO NOT trust MediaPipe's handedness label.
//  Because the buffer is mirrored, MediaPipe's "Left"/"Right" is computed on a mirror image and
//  is unreliable/inverted for our purposes — and the rest of the app already keys everything to
//  the BODY wrists. So we assign each detected hand to the player side whose body wrist
//  (`joints.leftHand` / `.rightHand`, already mirror-corrected top-left) is NEAREST to that
//  hand's wrist landmark. This guarantees `hands.left` / `fingertips.left` line up with the
//  player's real left exactly as the body joints do — one source of truth for sidedness.
//
//  OPENNESS MATH (per hand) — same idea as the old Vision formula, on better landmarks:
//    ratio = mean(dist(fingertipᵢ, wrist)) / palmLength
//      • fingertipᵢ = the four NON-THUMB fingertips (index/middle/ring/little TIP).
//      • palmLength = dist(wrist, middleFingerMCP) — the scale reference that barely changes
//        with finger flexion, making the ratio invariant to how near/far the hand is.
//    A fist curls tips back toward the wrist → ratio ≈ 1; an open palm extends them to ~2×
//    palm length → ratio ≈ 2. Map [OPEN_RATIO_MIN…OPEN_RATIO_MAX] onto 0..1 and clamp.
//    We use MediaPipe's 3D landmarks in 2D (x,y) only, to stay in the same image plane the
//    Vision formula used and keep the empirical band comparable.
//

import Foundation
import MediaPipeTasksVision

/// One MediaPipe hand: its analyzed openness/fingertip plus the wrist position we use to
/// assign it to a player side. All points are in protocol space (top-left, 0..1, mirror).
private struct DetectedHand {
    let openness: Double?
    /// Index fingertip in protocol space, or nil if unusable.
    let indexTip: Point2?
    /// Wrist in protocol space — used to match this hand to the nearest body wrist.
    let wrist: Point2
}

/// Wraps MediaPipe `HandLandmarker`. Owns NO camera; the caller feeds it the same pixel
/// buffers Vision uses. `@unchecked Sendable` because it is only ever touched from the
/// PoseEstimator's serial work queue (same threading contract as HandPoseEstimator).
final class HandLandmarkerEstimator: @unchecked Sendable {

    // MARK: - Tuning (kept in sync with the Vision-path HandPoseEstimator so the downstream
    // openness feel is unchanged when we fall back).

    /// Empirical ratio band mapped onto openness 0..1. ratio ≤ MIN → 0 (fist); ≥ MAX → 1.
    private let openRatioMin: Double = 1.1
    private let openRatioMax: Double = 2.0

    /// Exponential smoothing for openness (matches HandPoseEstimator.smoothing).
    private let smoothing: Double = 0.4
    /// Lighter smoothing for the fingertip cursor (matches HandPoseEstimator.fingertipSmoothing).
    private let fingertipSmoothing: Double = 0.5
    /// Neutral openness a lost hand decays toward.
    private let neutralOpenness: Double = 0.5

    // MARK: - Smoothing memory (touched only from the caller's serial work queue)

    private var smoothedLeft: Double?
    private var smoothedRight: Double?
    private var tipLeft: Point2?
    private var tipRight: Point2?

    /// True once ANY hand has been detected since the last reset (parallels HandPoseEstimator).
    private(set) var hasEverSeenHand = false

    // MARK: - MediaPipe

    /// The underlying detector. `nil` if init failed — the caller then uses the Vision path.
    private let landmarker: HandLandmarker?

    /// True iff MediaPipe initialized and can be used this session.
    var isAvailable: Bool { landmarker != nil }

    /// MediaPipe VIDEO mode requires strictly-increasing timestamps. We derive ms from the
    /// same monotonic clock the pipeline throttles on, but guard against a non-increasing
    /// value (clock quantization / same-ms frames) by nudging forward.
    private var lastTimestampMs: Int = -1

    // MediaPipe's 21-landmark indices (the ordering is a stable, documented MediaPipe
    // contract — same as the `HandLandmark` enum: 0 = wrist … 20 = pinky tip). We use raw
    // indices to avoid depending on the exact Swift-imported enum name.
    private let wristIdx = 0            // WRIST
    private let middleMCPIdx = 9        // MIDDLE_FINGER_MCP (palm-length reference)
    private let indexTipIdx = 8         // INDEX_FINGER_TIP
    private let nonThumbTipIdx: [Int] = [8, 12, 16, 20]  // INDEX/MIDDLE/RING/PINKY tips

    // MARK: - Init

    /// Build the HandLandmarker from the bundled model. Returns an estimator whose
    /// `isAvailable` is false (rather than throwing) if the model is missing or MediaPipe
    /// can't initialize — so the caller degrades to Vision instead of crashing.
    init() {
        guard let modelPath = Bundle.main.path(forResource: "hand_landmarker", ofType: "task") else {
            NSLog("[Motion] MediaPipe HandLandmarker: model 'hand_landmarker.task' not found in bundle — falling back to Vision hand path.")
            landmarker = nil
            return
        }

        let options = HandLandmarkerOptions()
        options.baseOptions.modelAssetPath = modelPath
        options.runningMode = .video
        options.numHands = 2
        // Slightly permissive presence/tracking so distant hands aren't dropped; detection
        // confidence left at the model default via the options object.
        options.minHandDetectionConfidence = 0.3
        options.minHandPresenceConfidence = 0.3
        options.minTrackingConfidence = 0.3

        do {
            landmarker = try HandLandmarker(options: options)
            NSLog("[Motion] MediaPipe HandLandmarker initialized (VIDEO mode, numHands=2).")
        } catch {
            NSLog("[Motion] MediaPipe HandLandmarker init failed: \(error.localizedDescription) — falling back to Vision hand path.")
            landmarker = nil
        }
    }

    /// Reset smoothing so a fresh detection doesn't lerp from a stale value (parallels
    /// HandPoseEstimator.reset). Does NOT tear down the detector.
    func reset() {
        smoothedLeft = nil
        smoothedRight = nil
        tipLeft = nil
        tipRight = nil
        hasEverSeenHand = false
    }

    // MARK: - Public entry

    /// Detect hands in `pixelBuffer` and return smoothed openness + fingertip per PLAYER side,
    /// assigning each detected hand to the nearest body wrist. Call from the caller's serial
    /// work queue (same contract as the Vision path). Returns `nil` when MediaPipe is
    /// unavailable so the caller can fall back to Vision.
    ///
    /// - Parameters:
    ///   - pixelBuffer: the SAME display-upright, mirrored BGRA buffer Vision receives.
    ///   - timestampSeconds: a monotonically-increasing frame time (the pipeline's uptime clock).
    ///   - leftWrist / rightWrist: the body wrists in protocol space (top-left, mirror), or nil
    ///     if that side's wrist wasn't confident this frame. Used ONLY for side assignment.
    /// - Returns: `(hands, fingertips)` ready to place straight into `PoseFrame`, or nil if
    ///   MediaPipe is unavailable (caller falls back to Vision).
    func analyze(
        pixelBuffer: CVPixelBuffer,
        timestampSeconds: TimeInterval,
        leftWrist: Point2?,
        rightWrist: Point2?
    ) -> (hands: HandState?, fingertips: Fingertips?)? {
        guard let landmarker else { return nil }

        // MPImage from the pixel buffer. `.up` because the buffer is already display-upright
        // AND mirrored (exactly what we hand Vision). MediaPipe then reads it in the same
        // mirror-space, so no x-flip is needed downstream.
        guard let image = try? MPImage(pixelBuffer: pixelBuffer, orientation: .up) else {
            return (nil, nil)
        }

        // Strictly-increasing millisecond timestamp for VIDEO mode.
        var tsMs = Int((timestampSeconds * 1000.0).rounded())
        if tsMs <= lastTimestampMs { tsMs = lastTimestampMs + 1 }
        lastTimestampMs = tsMs

        let result: HandLandmarkerResult
        do {
            result = try landmarker.detect(videoFrame: image, timestampInMilliseconds: tsMs)
        } catch {
            // A single-frame detection failure is non-fatal: emit a decayed reading.
            return emit(left: nil, right: nil)
        }

        // Turn each detected hand into an analyzed DetectedHand (openness + tip + wrist).
        var detected: [DetectedHand] = []
        for hand in result.landmarks where hand.count >= 21 {
            detected.append(measure(landmarks: hand))
        }
        if !detected.isEmpty { hasEverSeenHand = true }

        // Assign each hand to the player side whose body wrist is nearest its wrist landmark.
        let (leftHand, rightHand) = assignSides(detected, leftWrist: leftWrist, rightWrist: rightWrist)
        return emit(left: leftHand, right: rightHand)
    }

    // MARK: - Per-hand measurement

    /// Measure openness + index fingertip + wrist for one hand's 21 landmarks. Coordinates are
    /// mapped into protocol space (top-left, 0..1, mirror) — which for MediaPipe is the identity
    /// on (x, y) plus a clamp (see the coordinate note in the file header).
    private func measure(landmarks: [NormalizedLandmark]) -> DetectedHand {
        func pt(_ i: Int) -> Point2 {
            let l = landmarks[i]
            return [clamp01(Double(l.x)), clamp01(Double(l.y))]
        }

        let wrist = pt(wristIdx)
        let openness = computeOpenness(landmarks: landmarks)
        let indexTip = pt(indexTipIdx)
        return DetectedHand(openness: openness, indexTip: indexTip, wrist: wrist)
    }

    /// Openness 0..1 for one hand from the 21 landmarks, or nil if the scale reference is
    /// degenerate. Uses the (x, y) plane only (see openness math in the file header).
    private func computeOpenness(landmarks: [NormalizedLandmark]) -> Double? {
        let wrist = landmarks[wristIdx]
        let middleMCP = landmarks[middleMCPIdx]
        let scale = dist(wrist, middleMCP)
        guard scale > 1e-4 else { return nil }

        var sum = 0.0
        for i in nonThumbTipIdx {
            sum += dist(landmarks[i], wrist)
        }
        let meanTipDist = sum / Double(nonThumbTipIdx.count)

        let ratio = meanTipDist / scale
        let openness = (ratio - openRatioMin) / (openRatioMax - openRatioMin)
        return min(1.0, max(0.0, openness))
    }

    // MARK: - Side assignment

    /// Assign detected hands to (left, right) PLAYER sides by nearest body wrist. Falls back
    /// sensibly when body wrists are missing: with one hand and one known wrist, assign to that
    /// side; with two hands and no wrists, split by image x (mirror-space: player-left hand sits
    /// at larger x). Returns the analyzed hand for each side (or nil).
    private func assignSides(
        _ hands: [DetectedHand],
        leftWrist: Point2?,
        rightWrist: Point2?
    ) -> (left: DetectedHand?, right: DetectedHand?) {
        if hands.isEmpty { return (nil, nil) }

        // Preferred path: at least one body wrist known → assign each hand to its nearest wrist,
        // resolving collisions so two hands don't both claim the same side.
        if leftWrist != nil || rightWrist != nil {
            var left: (hand: DetectedHand, d: Double)?
            var right: (hand: DetectedHand, d: Double)?
            for h in hands {
                let dl = leftWrist.map { sqDist(h.wrist, $0) } ?? Double.greatestFiniteMagnitude
                let dr = rightWrist.map { sqDist(h.wrist, $0) } ?? Double.greatestFiniteMagnitude
                if dl <= dr {
                    if left == nil || dl < left!.d { // closer left claim wins; loser tries right
                        if let prev = left { assignFallback(prev.hand, into: &right) }
                        left = (h, dl)
                    } else {
                        assignFallback(h, into: &right)
                    }
                } else {
                    if right == nil || dr < right!.d {
                        if let prev = right { assignFallback(prev.hand, into: &left) }
                        right = (h, dr)
                    } else {
                        assignFallback(h, into: &left)
                    }
                }
            }
            return (left?.hand, right?.hand)
        }

        // No body wrists this frame: split by image x. Buffer is mirror-space, so the player's
        // LEFT hand appears at the LARGER x. One hand → leave the other side nil.
        let sorted = hands.sorted { $0.wrist[0] > $1.wrist[0] }
        if sorted.count == 1 { return (sorted[0], nil) }
        return (sorted.first, sorted.last)
    }

    /// Place `hand` into `slot` if empty or if it's closer than the incumbent — used to resolve
    /// two hands contending for the same side (the far one spills to the other side).
    private func assignFallback(_ hand: DetectedHand, into slot: inout (hand: DetectedHand, d: Double)?) {
        if slot == nil { slot = (hand, Double.greatestFiniteMagnitude) }
    }

    // MARK: - Smoothing / decay (mirrors HandPoseEstimator so the feel matches on fallback)

    /// Apply smoothing/decay to each side and package into `HandState` + `Fingertips`, matching
    /// the caller's expectations from the Vision path exactly.
    private func emit(left: DetectedHand?, right: DetectedHand?) -> (HandState?, Fingertips?) {
        // If nothing has EVER been seen and nothing now, omit entirely (matches Vision path).
        if left == nil && right == nil && !hasEverSeenHand {
            return (nil, nil)
        }

        let lo = smoothedOpenness(raw: left?.openness, previous: &smoothedLeft)
        let ro = smoothedOpenness(raw: right?.openness, previous: &smoothedRight)
        let lt = smoothedTip(raw: left?.indexTip, previous: &tipLeft)
        let rt = smoothedTip(raw: right?.indexTip, previous: &tipRight)

        let hands = HandState(left: lo, right: ro)
        let fingertips: Fingertips? = (lt == nil && rt == nil) ? nil : Fingertips(left: lt, right: rt)
        return (hands, fingertips)
    }

    /// Exponential smoothing of a fresh openness reading, or decay toward neutral when absent.
    /// A hand never seen (previous nil, no reading) defaults to OPEN (1.0) so it can't falsely
    /// trigger a grab — identical to HandPoseEstimator.
    private func smoothedOpenness(raw: Double?, previous: inout Double?) -> Double {
        if let raw {
            let a = smoothing
            let next = previous.map { a * raw + (1 - a) * $0 } ?? raw
            previous = next
            return next
        }
        guard let prev = previous else { return 1.0 }
        let next = prev + (neutralOpenness - prev) * 0.1
        previous = next
        return next
    }

    /// Light exponential smoothing of the fingertip; absent → last value; never seen → nil.
    private func smoothedTip(raw: Point2?, previous: inout Point2?) -> Point2? {
        guard let raw else { return previous }
        let a = fingertipSmoothing
        guard let prev = previous, prev.count == 2 else {
            previous = raw
            return raw
        }
        let next: Point2 = [a * raw[0] + (1 - a) * prev[0], a * raw[1] + (1 - a) * prev[1]]
        previous = next
        return next
    }

    // MARK: - Geometry

    private func clamp01(_ v: Double) -> Double { min(1.0, max(0.0, v)) }

    private func dist(_ a: NormalizedLandmark, _ b: NormalizedLandmark) -> Double {
        let dx = Double(a.x - b.x), dy = Double(a.y - b.y)
        return (dx * dx + dy * dy).squareRoot()
    }

    private func sqDist(_ a: Point2, _ b: Point2) -> Double {
        let dx = a[0] - b[0], dy = a[1] - b[1]
        return dx * dx + dy * dy
    }
}
