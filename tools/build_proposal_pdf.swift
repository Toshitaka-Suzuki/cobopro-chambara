import Foundation
import CoreGraphics
import ImageIO

let root = URL(fileURLWithPath: "/Users/suzuki/dev/cobopro-chambara")
let inputFiles = [
    root.appendingPathComponent("tmp/pdfs/proposal-v01-p01.png"),
    root.appendingPathComponent("tmp/pdfs/proposal-v01-p02.png")
]
let outputFile = root.appendingPathComponent("output/pdf/robot-chambara-proposal-v01.pdf")
let qaDirectory = root.appendingPathComponent("tmp/pdfs")

var mediaBox = CGRect(x: 0, y: 0, width: 841.89, height: 595.28)
guard let consumer = CGDataConsumer(url: outputFile as CFURL),
      let pdf = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else {
    fatalError("PDF context could not be created")
}

for file in inputFiles {
    guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fatalError("Image could not be read: \(file.path)")
    }
    pdf.beginPDFPage(nil)
    pdf.draw(image, in: mediaBox)
    pdf.endPDFPage()
}
pdf.closePDF()

guard let document = CGPDFDocument(outputFile as CFURL), document.numberOfPages == 2 else {
    fatalError("Generated PDF does not contain two pages")
}

let renderWidth = 1684
let renderHeight = 1191
let colorSpace = CGColorSpaceCreateDeviceRGB()

for pageNumber in 1...document.numberOfPages {
    guard let page = document.page(at: pageNumber),
          let bitmap = CGContext(
            data: nil,
            width: renderWidth,
            height: renderHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else {
        fatalError("Page \(pageNumber) could not be rendered")
    }
    bitmap.setFillColor(CGColor(gray: 1, alpha: 1))
    bitmap.fill(CGRect(x: 0, y: 0, width: renderWidth, height: renderHeight))
    bitmap.scaleBy(x: CGFloat(renderWidth) / mediaBox.width, y: CGFloat(renderHeight) / mediaBox.height)
    bitmap.drawPDFPage(page)
    guard let rendered = bitmap.makeImage() else { fatalError("Rendered image missing") }
    let qaFile = qaDirectory.appendingPathComponent("proposal-v01-pdf-page-\(pageNumber).png")
    guard let destination = CGImageDestinationCreateWithURL(qaFile as CFURL, "public.png" as CFString, 1, nil) else {
        fatalError("QA image destination could not be created")
    }
    CGImageDestinationAddImage(destination, rendered, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("QA image could not be written") }
}

print("Created: \(outputFile.path)")
print("Pages: \(document.numberOfPages)")
