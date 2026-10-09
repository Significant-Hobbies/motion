//
//  PoseMathTests.swift
//  MotionTests
//
//  Pins the coordinate and smoothing contract `PoseEstimator` relies on: y flip,
//  mirrored left/right swap, fallbacks, dropout reuse, quality, ROI clamping and
//  ROI→full-image lifting. Camera, Vision requests and MediaPipe stay device-only.
//

import CoreGraphics
import Testing
import Vision

@testable import Motion

private typealias VisionJoint = VNHumanBodyPoseObservation.JointName

private func lookup(_ readings: [VisionJoint: PoseReading]) -> PoseMath.BodyLookup {
    { readings[$0] }
}

private func approx(_ a: Point2?, _ b: Point2, tolerance: Double = 1e-12) -> Bool {
    guard let a, a.count == b.count else { return false }
    return zip(a, b).allSatisfy { abs($0 - $1) <= tolerance }
}

@Suite struct PoseMathMappingTests {
    @Test func topLeftFlipsOnlyY() {
        #expect(PoseMath.topLeft(x: 0.2, y: 0.9) == [0.2, 1.0 - 0.9])
    }

    @Test func bodyJointsSwapSidesForTheMirroredBuffer() {
        let raw = PoseMath.bodyJoints(
            lookup([
                .leftWrist: ([0.1, 0.1], 0.9), .rightWrist: ([0.9, 0.1], 0.8),
                .leftKnee: ([0.2, 0.7], 0.7), .rightKnee: ([0.8, 0.7], 0.6),
                .leftAnkle: ([0.2, 0.9], 0.5), .rightAnkle: ([0.8, 0.9], 0.4),
            ]))
        #expect(raw[.rightHand]?.point == [0.1, 0.1])
        #expect(raw[.leftHand]?.point == [0.9, 0.1])
        #expect(raw[.rightKnee]?.confidence == 0.7)
        #expect(raw[.leftKnee]?.confidence == 0.6)
        #expect(raw[.rightFoot]?.confidence == 0.5)
        #expect(raw[.leftFoot]?.confidence == 0.4)
        #expect(raw[.head] == nil)
        #expect(raw[.torso] == nil)
    }

    @Test func headPrefersNoseThenNeck() {
        let both = PoseMath.bodyJoints(lookup([.nose: ([0.5, 0.1], 0.9), .neck: ([0.5, 0.2], 0.8)]))
        #expect(both[.head]?.point == [0.5, 0.1])
        let neckOnly = PoseMath.bodyJoints(lookup([.neck: ([0.5, 0.2], 0.8)]))
        #expect(neckOnly[.head]?.point == [0.5, 0.2])
    }

    @Test func torsoFallsBackFromRootToShouldersToHips() {
        let root = PoseMath.bodyJoints(
            lookup([.root: ([0.5, 0.5], 0.9), .leftShoulder: ([0.4, 0.3], 0.9), .rightShoulder: ([0.6, 0.3], 0.9)]))
        #expect(root[.torso]?.point == [0.5, 0.5])

        let shoulders = PoseMath.bodyJoints(
            lookup([.leftShoulder: ([0.4, 0.3], 0.9), .rightShoulder: ([0.6, 0.5], 0.7), .leftHip: ([0, 0], 1)]))
        #expect(approx(shoulders[.torso]?.point, [0.5, 0.4]))
        #expect(shoulders[.torso]?.confidence == 0.7)

        let hips = PoseMath.bodyJoints(
            lookup([.leftShoulder: ([0.4, 0.3], 0.9), .leftHip: ([0.4, 0.6], 0.5), .rightHip: ([0.6, 0.6], 0.6)]))
        #expect(approx(hips[.torso]?.point, [0.5, 0.6]))
        #expect(hips[.torso]?.confidence == 0.5)
    }

    @Test func armJointsSwapSides() {
        let arms = PoseMath.armJoints(
            lookup([
                .leftShoulder: ([0.4, 0.3], 0.2), .rightShoulder: ([0.6, 0.3], 0.3),
                .leftElbow: ([0.3, 0.4], 0.15),
            ]))
        #expect(arms[.rightShoulder]?.point == [0.4, 0.3])
        #expect(arms[.leftShoulder]?.point == [0.6, 0.3])
        #expect(arms[.rightElbow]?.confidence == 0.15)
        #expect(arms[.leftElbow] == nil)
    }
}

@Suite struct PoseMathSmoothingTests {
    @Test func firstSightingAdoptsThenBlendsThenReusesOnDropout() {
        var previous: [JointName: Point2] = [:]

        let first = PoseMath.smooth([.head: ([0.2, 0.4], 0.9)], previous: &previous, alpha: 0.5)
        #expect(first.points[.head] == [0.2, 0.4])
        #expect(first.confidences[.head] == 0.9)
        #expect(first.points[.torso] == nil)

        let second = PoseMath.smooth([.head: ([0.6, 0.8], 0.7)], previous: &previous, alpha: 0.5)
        #expect(approx(second.points[.head], [0.4, 0.6]))
        #expect(approx(previous[.head], [0.4, 0.6]))
        #expect(second.confidences[.head] == 0.7)

        let dropout = PoseMath.smooth([:] as [JointName: PoseReading], previous: &previous, alpha: 0.5)
        #expect(approx(dropout.points[.head], [0.4, 0.6]))
        #expect(dropout.confidences[.head] == 0)
        #expect(approx(previous[.head], [0.4, 0.6]))
    }

    @Test func alphaWeightsTheCurrentFrame() {
        var previous: [ArmJointName: Point2] = [.leftElbow: [0, 0]]
        let out = PoseMath.smooth([.leftElbow: ([1, 1], 0.2)], previous: &previous, alpha: 0.25)
        #expect(approx(out.points[.leftElbow], [0.25, 0.25]))
    }

    @Test func qualityAveragesOverAllEightJoints() {
        #expect(PoseMath.quality([:]) == 0)
        #expect(PoseMath.quality([.head: 0.8, .torso: 0.8]) == 1.6 / 8)
        #expect(PoseMath.quality([.head: 0]) == 0)
    }
}

@Suite struct PoseMathGeometryTests {
    @Test func roiIsCenteredWithFlippedY() {
        let roi = PoseMath.roi(aroundTopLeftWrist: [0.5, 0.25], size: 0.3)
        #expect(abs(roi.midX - 0.5) < 1e-9)
        #expect(abs(roi.midY - 0.75) < 1e-9)
        #expect(abs(roi.width - 0.3) < 1e-9 && abs(roi.height - 0.3) < 1e-9)
    }

    @Test func roiClampsInsideTheFrameWithoutShrinking() {
        for wrist: Point2 in [[0, 0], [1, 1], [-0.2, 1.4], [0.99, 0.01]] {
            let roi = PoseMath.roi(aroundTopLeftWrist: wrist, size: 0.3)
            #expect(roi.minX >= -1e-9 && roi.minY >= -1e-9)
            #expect(roi.maxX <= 1 + 1e-9 && roi.maxY <= 1 + 1e-9)
            #expect(abs(roi.width - 0.3) < 1e-9)
        }
    }

    @Test func liftFromROIMapsCropRelativePointsToTheFullImage() {
        let roi = CGRect(x: 0.2, y: 0.4, width: 0.3, height: 0.3)
        #expect(approx(PoseMath.liftFromROI(CGPoint(x: 0, y: 0), roi: roi), [0.2, 0.6]))
        #expect(approx(PoseMath.liftFromROI(CGPoint(x: 1, y: 1), roi: roi), [0.5, 0.3]))
        let full = CGRect(x: 0, y: 0, width: 1, height: 1)
        #expect(approx(PoseMath.liftFromROI(CGPoint(x: 0.3, y: 0.8), roi: full), [0.3, 0.2]))
    }

    @Test func roiCenterRoundTripsThroughLift() {
        let wrist: Point2 = [0.42, 0.37]
        let roi = PoseMath.roi(aroundTopLeftWrist: wrist, size: 0.3)
        #expect(approx(PoseMath.liftFromROI(CGPoint(x: 0.5, y: 0.5), roi: roi), wrist, tolerance: 1e-9))
    }
}

@Suite struct HandInputTests {
    @Test func onlyWristsDetectedThisFrameAreFresh() {
        let wrists = WristReadings(left: [0.3, 0.5], leftConfidence: 0, right: [0.7, 0.5], rightConfidence: 0.6)
        #expect(wrists.freshLeft == nil)
        #expect(wrists.freshRight == [0.7, 0.5])
        let missing = WristReadings(left: nil, leftConfidence: nil, right: nil, rightConfidence: 0.9)
        #expect(missing.freshLeft == nil && missing.freshRight == nil)
    }

    @Test func fingertipsAreOmittedOnlyWhenBothSidesAreMissing() {
        #expect(PoseMath.fingertips(left: nil, right: nil) == nil)
        let one = PoseMath.fingertips(left: [0.1, 0.2], right: nil)
        #expect(one?.left == [0.1, 0.2])
        #expect(one?.right == nil)
    }
}
