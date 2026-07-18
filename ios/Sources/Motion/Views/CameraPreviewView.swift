//
//  CameraPreviewView.swift
//  Motion
//
//  Two layers:
//    • `CameraPreview` — a UIViewRepresentable hosting an AVCaptureVideoPreviewLayer
//      tied to the live capture session.
//    • `PoseOverlay` — a SwiftUI Canvas drawing the detected joints, a simple skeleton,
//      a framing guide, and a readiness-tinted border.
//
//  Coordinate note: joints are normalized [0,1] with TOP-LEFT origin, which maps
//  directly onto the SwiftUI view's coordinate space (also top-left), so we just
//  scale by the view size. The preview layer is already mirrored to match, so the
//  overlay lines up with what the player sees.
//

import AVFoundation
import SwiftUI

// MARK: - Camera preview layer

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        view.videoPreviewLayer.session = session
        view.videoPreviewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {
        // Session is stable for the view's lifetime; nothing to update.
    }

    /// A UIView whose backing layer IS an AVCaptureVideoPreviewLayer.
    final class PreviewUIView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var videoPreviewLayer: AVCaptureVideoPreviewLayer {
            layer as! AVCaptureVideoPreviewLayer
        }
    }
}

// MARK: - Pose + framing overlay

struct PoseOverlay: View {
    let joints: Joints?
    let tracking: TrackingState

    /// Simple bone list (protocol joint pairs) for a readable skeleton.
    private static let bones: [(JointName, JointName)] = [
        (.head, .torso),
        (.torso, .leftHand), (.torso, .rightHand),
        (.torso, .leftKnee), (.torso, .rightKnee),
        (.leftKnee, .leftFoot), (.rightKnee, .rightFoot),
    ]

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            ZStack {
                // Framing guide: a soft rounded rect where the whole body should sit.
                RoundedRectangle(cornerRadius: 24)
                    .stroke(style: StrokeStyle(lineWidth: 2, dash: [8, 8]))
                    .foregroundStyle(.white.opacity(0.25))
                    .padding(24)

                // Skeleton + joints.
                Canvas { ctx, _ in
                    guard let joints else { return }
                    let map = joints.asMap
                    func p(_ n: JointName) -> CGPoint? {
                        guard let v = map[n] else { return nil }
                        return CGPoint(x: v[0] * size.width, y: v[1] * size.height)
                    }

                    // Bones.
                    for (a, b) in Self.bones {
                        guard let pa = p(a), let pb = p(b) else { continue }
                        var path = Path()
                        path.move(to: pa)
                        path.addLine(to: pb)
                        ctx.stroke(path, with: .color(color.opacity(0.7)), lineWidth: 4)
                    }
                    // Joint dots.
                    for n in JointName.allCases {
                        guard let pt = p(n) else { continue }
                        let r: CGFloat = n == .head ? 10 : 6
                        let rect = CGRect(x: pt.x - r, y: pt.y - r, width: r * 2, height: r * 2)
                        ctx.fill(Path(ellipseIn: rect), with: .color(color))
                    }
                }

                // Readiness border tint.
                RoundedRectangle(cornerRadius: 0)
                    .stroke(color.opacity(0.9), lineWidth: 4)
                    .ignoresSafeArea()
            }
        }
        .allowsHitTesting(false)
    }

    /// Green when tracking is good, amber for correctable issues, red when lost.
    private var color: Color {
        switch tracking {
        case .ok: return .green
        case .lost: return .red
        default: return .yellow
        }
    }
}
