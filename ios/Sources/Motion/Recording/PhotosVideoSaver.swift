//
//  PhotosVideoSaver.swift
//  Motion
//
//  Shared "save a finished video to Photos" step for the v1 ReplayKit recorder and the
//  parked v2 composite recorder. Requests ADD-ONLY authorization (matches
//  `NSPhotoLibraryAddUsageDescription`); it never reads the library.
//

import Foundation
import Photos

enum PhotosVideoSaver {
    /// Outcome of a save attempt; `message` is user-facing.
    enum Outcome: Sendable {
        case saved
        case failed(String)
    }

    /// Save the video at `url` to Photos, requesting add-only permission first.
    static func save(url: URL) async -> Outcome {
        let status = await requestAddPermission()
        guard status == .authorized || status == .limited else {
            return .failed("Photos access denied — enable it in Settings to save your clip.")
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let req = PHAssetCreationRequest.forAsset()
                req.addResource(with: .video, fileURL: url, options: nil)
            }
            return .saved
        } catch {
            return .failed("Couldn't save to Photos: \(error.localizedDescription)")
        }
    }

    private static func requestAddPermission() async -> PHAuthorizationStatus {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if current == .notDetermined {
            return await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        }
        return current
    }
}
