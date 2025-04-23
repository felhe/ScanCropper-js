import { program } from "npm:commander";
import { ScanCropper } from "./ScanCropper.ts";
import { Settings } from "./Settings.ts";

program
  .requiredOption("-i, --input <path>", "Input file or directory")
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
  inputDir: undefined,
  outputDir: opts.outputDir,
  outputFormat: opts.format === "jpg" ? "jpg" : "png",
};

const cropper = new ScanCropper(settings);
await cropper.init();

const inputStat = await Deno.stat(opts.input);
if (inputStat.isDirectory) {
  await cropper.processAllFromDir(opts.input);
} else if (inputStat.isFile) {
  await cropper.processFilePath(opts.input);
} else {
  console.error("Invalid input path.");
  Deno.exit(1);
}
