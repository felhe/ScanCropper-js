import { program } from "npm:commander";
import cv from "npm:@techstark/opencv-js";
import { ScanCropper } from "./ScanCropper.ts";
import { Settings } from "./types.ts";

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
  .option("-w, --write-output", "Write output images", false)
  .parse(["", "", ...Deno.args]);

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
await cropper.processAllFromDir(opts.inputDir);
