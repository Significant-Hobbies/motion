//
//  MotionApp.swift
//  Motion
//
//  App entry point. Owns the single `AppModel` and injects it into the view tree.
//

import SaaSMakerUI
import SwiftUI

@main
struct MotionApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .smTheme(Design.palette)
        }
    }
}
