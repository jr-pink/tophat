import Foundation
import Vision
import AppKit
// One private local raster. No network, identity lookup or image logging.
guard CommandLine.arguments.count == 2,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.automaticallyDetectsLanguage = true
try VNImageRequestHandler(cgImage: cg).perform([request])
let rows = (request.results ?? []).compactMap { item -> [String: Any]? in
    guard let text = item.topCandidates(1).first else { return nil }
    return ["text": text.string, "confidence": text.confidence,
            "box": [item.boundingBox.minX, item.boundingBox.minY, item.boundingBox.width, item.boundingBox.height]]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: rows))
