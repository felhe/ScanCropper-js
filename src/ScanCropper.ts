import cv from "npm:@techstark/opencv-js";
import { Settings } from "./Settings.ts";
import { Image } from "npm:image-js";

export class ScanCropper {
  private images = 0;
  private scans = 0;
  private errors = 0;

  // Reusable Mats for the pipeline:
  private matSrc: cv.Mat | null = null;
  private matGray: cv.Mat | null = null;
  private matBin: cv.Mat | null = null;
  private contours: cv.MatVector | null = null;
  private hierarchy: cv.Mat | null = null;

  constructor(private settings: Settings) {}

  async init() {
    return new Promise<void>((resolve) => {
      cv.onRuntimeInitialized = () => resolve();
    });
  }

  async processBuffer(buffer: Uint8Array) {
    this.images++;

    // 1) Load & one‐time RGBA conversion
    const srcImage = await Image.load(buffer);
    const rgba = srcImage.rgba8(); // Heavy, only do once
    const imgData = new ImageData(
      new Uint8ClampedArray(rgba.data),
      rgba.width,
      rgba.height,
    );

    // 2) Create source Mat once
    this.matSrc = cv.matFromImageData(imgData);

    // 3) Allocate or reuse intermediate Mats
    this.matGray = this.matGray || new cv.Mat();
    this.matBin = this.matBin || new cv.Mat();
    this.contours = this.contours || new cv.MatVector();
    this.hierarchy = this.hierarchy || new cv.Mat();

    // 4) Blur → Gray → Threshold
    const blurred = new cv.Mat();
    try {
      cv.medianBlur(this.matSrc, blurred, this.settings.blur);
      cv.cvtColor(blurred, this.matGray, cv.COLOR_BGR2GRAY);
      cv.threshold(
        this.matGray,
        this.matBin,
        this.settings.thresh,
        this.settings.maxVal,
        cv.THRESH_BINARY_INV,
      );
    } finally {
      blurred.delete();
    }

    // 5) Find contours
    cv.findContours(
      this.matBin,
      this.contours,
      this.hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    // 6) Candidate regions & clipping
    const regions = this.getCandidateRegions(this.matSrc, this.contours);
    const scanMats = this.clipScans(this.matSrc, regions);

    // 7) Convert each Mat ROI → Image-JS buffer
    const outBuffers: Uint8Array[] = [];
    for (const roi of scanMats) {
      if (roi.empty()) {
        roi.delete();
        continue;
      }
      this.scans++;

      // Convert BGR→RGB into a buffer
      const rgb = new cv.Mat();
      cv.cvtColor(roi, rgb, cv.COLOR_BGR2RGB);
      roi.delete();

      // Build Image-JS from rgb.data without extra copies
      const img = new Image(rgb.cols, rgb.rows, {
        data: rgb.data,
        components: 3,
        alpha: 0,
      });
      outBuffers.push(img.toBuffer({ format: this.settings.outputFormat }));
      rgb.delete();
    }

    // 8) Yield so GC can run before next heavy iteration
    await new Promise((r) => setTimeout(r, 0));

    return outBuffers;
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
      // @ts-ignore: points() is incorrectly typed
      const pts: number[][] = cv.RotatedRect.points(rect);
      const area = rect.size.width * rect.size.height;

      if (area > imgArea * 0.03) {
        const box = cv.matFromArray(4, 1, cv.CV_32SC2, pts.flat());
        regions.push({ box, rect, area });
      }

      cnt.delete();
    }

    regions.sort((a, b) => b.area - a.area);
    return regions;
  }

  private clipScans(
    img: cv.Mat,
    regions: ReturnType<ScanCropper["getCandidateRegions"]>,
  ): cv.Mat[] {
    const scans: cv.Mat[] = [];

    for (const { box, rect } of regions) {
      let angle = rect.angle;
      if (angle < -45) angle += 90;

      // @ts-ignore
      const pts: { x: number; y: number }[] = cv.RotatedRect.points(rect);
      const center = this.getCenter(pts);

      let rotated: cv.Mat | null = null;
      try {
        rotated = this.rotateImage(img, angle, center);

        const rpts = this.rotatePoints(pts, angle, center);
        const xs = rpts.map((p) => p.x),
          ys = rpts.map((p) => p.y);

        const x1 = Math.max(Math.min(...xs), 0),
          y1 = Math.max(Math.min(...ys), 0),
          x2 = Math.min(Math.max(...xs), img.cols),
          y2 = Math.min(Math.max(...ys), img.rows);

        const roiRect = new cv.Rect(x1, y1, x2 - x1, y2 - y1);
        scans.push(rotated.roi(roiRect));
      } catch {
        this.errors++;
      } finally {
        box.delete();
        rotated?.delete();
      }
    }

    return scans;
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
    const rad = -angleDeg * (Math.PI / 180),
      sin = Math.sin(rad),
      cos = Math.cos(rad);

    return pts.map(({ x, y }) => {
      const dx = x - center.x,
        dy = y - center.y;
      return {
        x: Math.round(dx * cos - dy * sin + center.x),
        y: Math.round(dx * sin + dy * cos + center.y),
      };
    });
  }

  private getCenter(pts: Array<{ x: number; y: number }>) {
    const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }
}
