//
//  CalibrationController.swift
//  Motion
//
//  Drives the ~5-second calibration flow and captures a player-relative baseline used
//  to normalize output so different body sizes / camera distances play the same.
//
//  Flow (each stage ~equal slices of the total time):
//      neutral → stand still, arms down         (measure standing height + shoulder width)
//      arms    → arms extended out to the sides (measure arm-span reach)
//      squat   → a small squat                  (measure squat depth range)
//      done    → baseline captured
//
//  It emits `CalibMessage`s (via AppModel) with a monotonically increasing `progress`
//  in 0..1 across the WHOLE flow, and stores a `CalibrationBaseline`.
//

import Foundation

/// Player-relative reference frame captured during calibration.
struct CalibrationBaseline: Sendable, Equatable {
    /// Head→feet vertical span while standing (normalized frame units).
    var standingHeight: Double
    /// Shoulder-to-shoulder (≈ hip) width while neutral (normalized units).
    var shoulderWidth: Double
    /// Max horizontal hand separation captured during the arms stage.
    var armSpan: Double
    /// Torso Y at rest vs. at squat bottom — the usable squat range.
    var squatRange: Double
}

@MainActor
final class CalibrationController {
    /// Total wall-clock duration of the calibration.
    var totalDuration: TimeInterval = 5.0

    private(set) var baseline: CalibrationBaseline?

    /// Ordered stages and the fraction of the total each occupies.
    private let stages: [CalibMessage.Stage] = [.neutral, .arms, .squat]

    private weak var model: AppModel?
    private var driver: Task<Void, Never>?

    // Running measurements collected across the active stage.
    private var standingHeights: [Double] = []
    private var shoulderWidths: [Double] = []
    private var armSpans: [Double] = []
    private var torsoYs: [Double] = []

    init(model: AppModel) {
        self.model = model
    }

    /// Start the timed flow. Reads the latest joints from the model as it advances.
    func start() {
        cancel()
        resetMeasurements()
        driver = Task { [weak self] in
            guard let self else { return }
            let start = ProcessInfo.processInfo.systemUptime
            let perStage = totalDuration / Double(stages.count)

            for (index, stage) in stages.enumerated() {
                // Announce the stage entering, progress at the stage's start.
                let stageStartProgress = Double(index) / Double(stages.count)
                await self.emit(stage: stage, progress: stageStartProgress)

                // Sample for the stage's slice, updating progress smoothly.
                let stageStart = ProcessInfo.processInfo.systemUptime
                while ProcessInfo.processInfo.systemUptime - stageStart < perStage {
                    if Task.isCancelled { return }
                    await self.sample(for: stage)
                    let elapsed = ProcessInfo.processInfo.systemUptime - start
                    let progress = min(0.999, elapsed / self.totalDuration)
                    await self.emit(stage: stage, progress: progress)
                    try? await Task.sleep(nanoseconds: 100_000_000) // 10 Hz sampling
                }
            }

            // Finalize the baseline and announce done at full progress.
            self.finalizeBaseline()
            await self.emit(stage: .done, progress: 1.0)
        }
    }

    func cancel() {
        driver?.cancel()
        driver = nil
    }

    // MARK: - Sampling

    /// Pull the current joints from the model and record the metric relevant to `stage`.
    private func sample(for stage: CalibMessage.Stage) async {
        guard let j = model?.joints else { return }
        let map = j.asMap

        func span(_ a: JointName, _ b: JointName) -> Double? {
            guard let pa = map[a], let pb = map[b] else { return nil }
            let dx = pa[0] - pb[0], dy = pa[1] - pb[1]
            return (dx * dx + dy * dy).squareRoot()
        }

        switch stage {
        case .neutral:
            if let head = map[.head], let lf = map[.leftFoot], let rf = map[.rightFoot] {
                standingHeights.append(max(lf[1], rf[1]) - head[1])
            }
            if let w = span(.leftHand, .rightHand) { shoulderWidths.append(w) }
        case .arms:
            if let w = span(.leftHand, .rightHand) { armSpans.append(w) }
        case .squat:
            if let t = map[.torso] { torsoYs.append(t[1]) }
        case .done:
            break
        }
    }

    private func finalizeBaseline() {
        func median(_ xs: [Double]) -> Double {
            guard !xs.isEmpty else { return 0 }
            let s = xs.sorted()
            return s[s.count / 2]
        }
        let squatRange: Double = {
            guard let lo = torsoYs.min(), let hi = torsoYs.max() else { return 0 }
            return hi - lo
        }()
        baseline = CalibrationBaseline(
            standingHeight: median(standingHeights),
            shoulderWidth: median(shoulderWidths),
            armSpan: armSpans.max() ?? 0,
            squatRange: squatRange
        )
    }

    private func resetMeasurements() {
        standingHeights.removeAll()
        shoulderWidths.removeAll()
        armSpans.removeAll()
        torsoYs.removeAll()
        baseline = nil
    }

    private func emit(stage: CalibMessage.Stage, progress: Double) async {
        model?.calibrationDidAdvance(stage: stage, progress: progress)
    }
}
