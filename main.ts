import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "npm:commander";
import cv from "npm:@techstark/opencv-js";
import { argv } from "node:process";
import { Buffer } from "node:buffer";
import sharp from "npm:sharp";

// Settings interface
interface Settings {
  blur: number;
  thresh: number;
  maxVal: number;
  writeOutput: boolean;
  inputDir: string;
  outputDir: string;
  outputFormat: "jpg" | "png";
  degToRad: number;
}

class ScanCropper {
  private settings: Settings;
  private errors = 0;
  private images = 0;
  private scans = 0;

  constructor(settings: Settings) {
    this.settings = settings;
    if (this.settings.writeOutput) {
      fs.mkdirSync(this.settings.outputDir, { recursive: true });
    }
  }

  private getCandidateRegions(
    img: cv.Mat,
    contours: cv.MatVector,
  ): Array<{ box: cv.Mat; rect: cv.RotatedRect; area: number }> {
    const imgArea = img.rows * img.cols;
    const regions: Array<{ box: cv.Mat; rect: cv.RotatedRect; area: number }> =
      [];

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const rect = cv.minAreaRect(cnt);
      const box = (cv.RotatedRect as any).points(rect) as any;
      // Convert points to Mat for contourArea
      const matBox = cv.matFromArray(4, 1, cv.CV_32SC2, box.flat());
      const area = rect.size.width * rect.size.height;
      // if (area / imgArea > 0.05) {
      if (area > 0.03 * imgArea) {
        regions.push({ box: matBox, rect, area });
      }
      cnt.delete();
    }

    regions.sort((a, b) => b.area - a.area);
    return regions;
  }

  private rotateImage(
    img: cv.Mat,
    angle: number,
    center: { x: number; y: number },
  ): cv.Mat {
    const M = cv.getRotationMatrix2D(
      new cv.Point(center.x, center.y),
      angle,
      1,
    );
    const dst = new cv.Mat();
    cv.warpAffine(
      img,
      dst,
      M,
      new cv.Size(img.cols, img.rows),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(),
    );
    M.delete();
    return dst;
  }

  private rotateBox(
    box: { x: number; y: number }[],
    angle: number,
    center: { x: number; y: number },
  ): { x: number; y: number }[] {
    const rad = -angle * this.settings.degToRad;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    return box.map(({ x, y }) => {
      const dx = x - center.x;
      const dy = y - center.y;
      return {
        x: dx * cos - dy * sin + center.x,
        y: dx * sin + dy * cos + center.y,
      };
    });
  }

  private getCenter(points: Array<{ x: number; y: number }>) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }

  //   The points array for storing rectangle vertices. The order is bottomLeft, topLeft,
  // topRight, bottomRight.
  private getBoxFromCenter(
    center: { x: number; y: number },
    size: { width: number; height: number },
  ): Array<{ x: number; y: number }> {
    const x = center.x;
    const y = center.y;
    const w = size.width / 2;
    const h = size.height / 2;

    return [
      { x: x - w, y: y - h },
      { x: x + w, y: y - h },
      { x: x + w, y: y + h },
      { x: x - w, y: y + h },
    ];
  }

  private clipScans(
    img: cv.Mat,
    regions: Array<{ box: cv.Mat; rect: cv.RotatedRect; area: number }>,
  ): cv.Mat[] {
    const scans: cv.Mat[] = [];

    regions.forEach(({ box, rect }) => {
      let angle = rect.angle;
      if (angle < -45) angle += 90;

      // Extract box points
      const pts = (cv.RotatedRect as any).points(rect) as any;
      const center = this.getCenter(
        pts,
      );

      const rotatedImg = this.rotateImage(img, angle, center);
      const rotatedPts = this.rotateBox(pts, angle, center);

      const xs = rotatedPts.map((p) => Math.round(p.x));
      const ys = rotatedPts.map((p) => Math.round(p.y));
      const xMin = Math.max(Math.min(...xs), 0);
      const yMin = Math.max(Math.min(...ys), 0);
      const xMax = Math.min(Math.max(...xs), img.cols);
      const yMax = Math.min(Math.max(...ys), img.rows);

      try {
        const rectROI = new cv.Rect(
          xMin,
          yMin,
          xMax - xMin,
          yMax - yMin,
        );
        const crop = rotatedImg.roi(rectROI);
        scans.push(crop);
      } catch (e) {
        console.error("Error cropping scan:", e);
        this.errors++;
      }

      rotatedImg.delete();
      box.delete();
    });

    return scans;
  }

  private findScans(img: cv.Mat): cv.Mat[] {
    const blurred = new cv.Mat();
    cv.medianBlur(img, blurred, this.settings.blur);

    const gray = new cv.Mat();
    cv.cvtColor(blurred, gray, cv.COLOR_BGR2GRAY);
    blurred.delete();

    const thresh = new cv.Mat();
    cv.threshold(
      gray,
      thresh,
      this.settings.thresh,
      this.settings.maxVal,
      cv.THRESH_BINARY_INV,
    );
    gray.delete();

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(
      thresh,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );
    thresh.delete();
    hierarchy.delete();

    const regions = this.getCandidateRegions(img, contours);
    contours.delete();

    return this.clipScans(img, regions);
  }

  async processInput(filePath: string): Promise<cv.Mat[]> {
    this.images++;

    const { data, info } = await sharp(filePath)
      .ensureAlpha()
      .toColourspace("rgba") // 🔥 Key Fix
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rgbaMat = cv.matFromImageData({
      data,
      width: info.width,
      height: info.height,
    });
    const mat = new cv.Mat();
    cv.cvtColor(rgbaMat, mat, cv.COLOR_RGBA2BGR);
    rgbaMat.delete();

    // const buffer = fs.readFileSync(filePath);
    // const imageData = { data: buffer, width: 2552, height: 3510 } as ImageData;
    // imageData.data = buffer;
    // const mat = cv.matFromImageData(imageData);

    if (mat.empty()) {
      console.warn(`Failed to read image: ${filePath}`);
      mat.delete();
      return [];
    }

    const scans = this.findScans(mat);
    const results: cv.Mat[] = [];

    for (const scan of scans) {
      const idx = scans.indexOf(scan);
      if (scan.empty()) continue;
      results.push(scan);
      this.scans++;

      if (this.settings.writeOutput) {
        const ext = this.settings.outputFormat === "jpg" ? ".jpg" : ".png";
        const name = `${
          path.basename(filePath, path.extname(filePath))
        }_${idx}${ext}`;
        const outPath = path.join(this.settings.outputDir, name);

        const rgbMat = new cv.Mat();
        cv.cvtColor(scan, rgbMat, cv.COLOR_BGR2RGB); // Convert from BGR → RGB

        const processedImage = await sharp(Buffer.from(rgbMat.data), {
          raw: {
            width: rgbMat.cols,
            height: rgbMat.rows,
            channels: 3,
          },
        })
          .toFormat(this.settings.outputFormat)
          .toBuffer();
        // const buff = Buffer.from(scan.data);
        fs.writeFileSync(outPath, processedImage);
        console.log(`Saved scan: ${outPath}`);
      }
    }

    mat.delete();
    return results;
  }

  async processInputs(filePaths: string[]): Promise<void> {
    for (const fp of filePaths) {
      await this.processInput(fp);
    }
    console.log(
      `Processed ${this.images} images, extracted ${this.scans} scans, with ${this.errors} errors.`,
    );
  }
}

// Initialize OpenCV and run
(async () => {
  await new Promise<void>((resolve) => {
    cv["onRuntimeInitialized"] = resolve;
  });

  // CLI parsing
  program
    .requiredOption("-i, --input-dir <dir>", "Input directory")
    .option("-o, --output-dir <dir>", "Output directory", "./output")
    .option("-b, --blur <number>", "Median blur kernel size", "9")
    .option("-t, --thresh <number>", "Threshold value", "250")
    .option("-m, --max-val <number>", "Max threshold value", "255")
    .option("-f, --format <format>", "Output format (jpg|png)", "png")
    .option("-w, --write-output", "Write output images", false);
  program.parse(argv);

  const opts = program.opts();
  const settings: Settings = {
    blur: parseInt(opts.blur, 10),
    thresh: parseInt(opts.thresh, 10),
    maxVal: parseInt(opts.maxVal, 10),
    writeOutput: opts.writeOutput,
    inputDir: opts.inputDir,
    outputDir: opts.outputDir,
    outputFormat: opts.format === "jpg" ? "jpg" : "png",
    degToRad: Math.PI / 180,
  };

  const cropper = new ScanCropper(settings);
  const files = fs.readdirSync(settings.inputDir)
    .map((f: any): any => path.join(settings.inputDir, f))
    .filter((f: any): any =>
      [".jpg", ".jpeg", ".png", ".tiff"].includes(path.extname(f).toLowerCase())
    );

  await cropper.processInputs(files);
})();
