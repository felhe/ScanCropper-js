import { basename, extname, join } from "https://deno.land/std/path/mod.ts";
import { program } from "npm:commander";
import cv from "npm:@techstark/opencv-js";
import sharp from "npm:sharp";
// @deno-types="npm:@types/node"
import { Buffer } from "node:buffer";

// Settings interface
interface Settings {
  blur: number;
  thresh: number;
  maxVal: number;
  writeOutput: boolean;
  inputDir: string;
  outputDir: string;
  outputFormat: "jpg" | "png";
}

class ScanCropper {
  private errors = 0;
  private images = 0;
  private scans = 0;

  constructor(private settings: Settings) {}

  async init() {
    if (this.settings.writeOutput) {
      await Deno.mkdir(this.settings.outputDir, { recursive: true });
    }
  }

  private getCandidateRegions(
    img: cv.Mat,
    contours: cv.MatVector,
  ) {
    const imgArea = img.rows * img.cols;
    const regions: Array<{ box: cv.Mat; rect: cv.RotatedRect; area: number }> =
      [];

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const rect = cv.minAreaRect(cnt);
      // @ts-ignore wrongly typed in opencv-js
      const pts = cv.RotatedRect.points(rect);
      const area = rect.size.width * rect.size.height;

      if (area > imgArea * 0.03) {
        const matBox = cv.matFromArray(4, 1, cv.CV_32SC2, pts.flat());
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
  ) {
    const M = cv.getRotationMatrix2D(
      new cv.Point(center.x, center.y),
      angle,
      1,
    );
    const dst = new cv.Mat();
    try {
      cv.warpAffine(
        img,
        dst,
        M,
        new cv.Size(img.cols, img.rows),
        cv.INTER_LINEAR,
        cv.BORDER_CONSTANT,
        new cv.Scalar(0, 0, 0, 0),
      );
      return dst;
    } finally {
      M.delete();
    }
  }

  private rotatePoints(
    pts: Array<{ x: number; y: number }>,
    angleDeg: number,
    center: { x: number; y: number },
  ) {
    const rad = -angleDeg * (Math.PI / 180);
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    return pts.map(({ x, y }) => {
      const dx = x - center.x;
      const dy = y - center.y;
      return {
        x: Math.round(dx * cos - dy * sin + center.x),
        y: Math.round(dx * sin + dy * cos + center.y),
      };
    });
  }

  private getCenter(pts: Array<{ x: number; y: number }>) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }

  private clipScans(
    img: cv.Mat,
    regions: ReturnType<typeof this.getCandidateRegions>,
  ) {
    const scans: cv.Mat[] = [];

    for (const { box, rect } of regions) {
      let angle = rect.angle;
      if (angle < -45) angle += 90;

      // @ts-ignore wrongly typed in opencv-js
      const pts = cv.RotatedRect.points(rect);
      const center = this.getCenter(pts);

      let rotatedImg: cv.Mat | null = null;
      try {
        rotatedImg = this.rotateImage(img, angle, center);
        const rotatedPts = this.rotatePoints(pts, angle, center);

        const xs = rotatedPts.map((p) => p.x);
        const ys = rotatedPts.map((p) => p.y);
        const x1 = Math.max(Math.min(...xs), 0);
        const y1 = Math.max(Math.min(...ys), 0);
        const x2 = Math.min(Math.max(...xs), img.cols);
        const y2 = Math.min(Math.max(...ys), img.rows);

        const roi = new cv.Rect(x1, y1, x2 - x1, y2 - y1);
        scans.push(rotatedImg.roi(roi));
      } catch {
        this.errors++;
      } finally {
        box.delete();
        rotatedImg?.delete();
      }
    }

    return scans;
  }

  private findScans(img: cv.Mat) {
    const blurred = new cv.Mat();
    cv.medianBlur(img, blurred, this.settings.blur);

    const gray = new cv.Mat();
    cv.cvtColor(blurred, gray, cv.COLOR_BGR2GRAY);
    blurred.delete();

    const bin = new cv.Mat();
    cv.threshold(
      gray,
      bin,
      this.settings.thresh,
      this.settings.maxVal,
      cv.THRESH_BINARY_INV,
    );
    gray.delete();

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(
      bin,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );
    bin.delete();
    hierarchy.delete();

    const regions = this.getCandidateRegions(img, contours);
    contours.delete();

    return this.clipScans(img, regions);
  }

  async processInput(filePath: string) {
    this.images++;
    const buffer = await Deno.readFile(filePath);
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .toColourspace("rgba")
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rgba = cv.matFromImageData({
      data,
      width: info.width,
      height: info.height,
    });
    const bgr = new cv.Mat();
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    rgba.delete();

    if (bgr.empty()) {
      console.warn(`Could not decode: ${filePath}`);
      bgr.delete();
      return;
    }

    const scans = this.findScans(bgr);
    for (let i = 0; i < scans.length; i++) {
      const scan = scans[i];
      if (scan.empty()) {
        scan.delete();
        continue;
      }
      this.scans++;

      if (this.settings.writeOutput) {
        const name = `${
          basename(filePath, extname(filePath))
        }_${i}.${this.settings.outputFormat}`;
        const outPath = join(this.settings.outputDir, name);

        const rgb = new cv.Mat();
        cv.cvtColor(scan, rgb, cv.COLOR_BGR2RGB);
        scan.delete();

        const imgBuf = await sharp(Buffer.from(rgb.data), {
          raw: { width: rgb.cols, height: rgb.rows, channels: 3 },
        })
          .toFormat(this.settings.outputFormat)
          .toBuffer();
        rgb.delete();

        await Deno.writeFile(outPath, imgBuf);
        console.log(`→ ${outPath}`);
      } else {
        scan.delete();
      }
    }

    bgr.delete();
  }

  async processAll(files: string[]) {
    for (const f of files) {
      await this.processInput(f);
    }
    console.log(
      `Done: ${this.images} images → ${this.scans} scans (${this.errors} errors)`,
    );
  }
}

(async () => {
  // Wait for OpenCV
  await new Promise<void>((resolve) => {
    cv.onRuntimeInitialized = resolve;
  });

  program
    .requiredOption("-i, --input-dir <dir>", "Input directory")
    .option("-o, --output-dir <dir>", "Output directory")
    .option("-b, --blur <n>", "Median blur kernel size", "9")
    .option("-t, --thresh <n>", "Threshold value", "250")
    .option("-m, --max-val <n>", "Max threshold value", "255")
    .option("-f, --format <fmt>", "Output format (jpg|png)", "png")
    .option("-w, --write-output", "Write output images", false).parse(
      ["", "", ...Deno.args],
    );

  const opts = program.opts();
  const settings: Settings = {
    blur: +opts.blur,
    thresh: +opts.thresh,
    maxVal: +opts.maxVal,
    writeOutput: opts.writeOutput,
    inputDir: opts.inputDir,
    outputDir: opts.outputDir,
    outputFormat: opts.format === "jpg" ? "jpg" : "png",
  };

  const cropper = new ScanCropper(settings);

  await cropper.init();

  const files: string[] = [];
  for await (const entry of Deno.readDir(settings.inputDir)) {
    if (entry.isFile) {
      const ext = extname(entry.name).toLowerCase();
      if ([".jpg", ".jpeg", ".png", ".tiff"].includes(ext)) {
        files.push(join(settings.inputDir, entry.name));
      }
    }
  }

  await cropper.processAll(files);
})();
