import SaaSMakerUI
import SwiftUI

/// Motion's identity on the shared dark palette; type faces come from SaaSMakerUI.
enum Design {
    static let palette: SMPalette = {
        let night = Color(red: 5 / 255, green: 7 / 255, blue: 13 / 255)
        var p = SMPalette.ink.brand(
            Color(red: 53 / 255, green: 224 / 255, blue: 200 / 255), foreground: night)
        p.background = night
        p.card = Color(red: 13 / 255, green: 18 / 255, blue: 32 / 255)
        p.surface = p.card
        p.foreground = Color(red: 244 / 255, green: 247 / 255, blue: 255 / 255)
        p.mutedForeground = Color(red: 138 / 255, green: 149 / 255, blue: 181 / 255)
        p.success = p.brand
        p.destructive = Color(red: 255 / 255, green: 77 / 255, blue: 109 / 255)
        p.warning = Color(red: 255 / 255, green: 204 / 255, blue: 51 / 255)
        p.radius = 16
        return p
    }()

    static let heading = Font.custom(palette.displayFont, size: 17, relativeTo: .headline)
        .weight(.semibold)
    static let caption = Font.custom(palette.sansFont, size: 12, relativeTo: .caption)
    static let detail = Font.custom(palette.sansFont, size: 11, relativeTo: .caption2)
    static let mono = Font.custom(palette.monoFont, size: 11, relativeTo: .caption2)
}
