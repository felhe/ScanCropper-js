import { program } from "npm:commander";
import { ScanCropper } from "./ScanCropper.ts";
import { Settings } from "./Settings.ts";
import { extname } from "https://deno.land/std@0.224.0/path/extname.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { basename } from "https://deno.land/std@0.224.0/path/basename.ts";

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

if (settings.writeOutput && settings.outputDir) {
  await Deno.mkdir(settings.outputDir, { recursive: true });
}

const inputStat = await Deno.stat(opts.input);
if (inputStat.isDirectory) {
  const dirPath = opts.input;
  const files: string[] = [];
  for await (const entry of Deno.readDir(dirPath)) {
    if (entry.isFile) {
      const ext = extname(entry.name).toLowerCase();
      if ([".jpg", ".jpeg", ".png", ".tiff"].includes(ext)) {
        files.push(join(dirPath, entry.name));
      }
    }
  }
  let totalScans = 0;
  for (const file of files) {
    totalScans += await processFilePath(file);
  }
  console.log(
    `Done: ${files.length} images → ${totalScans} scans`,
  );
} else if (inputStat.isFile) {
  await processFilePath(opts.input);
} else {
  console.error("Invalid input path.");
  Deno.exit(1);
}

async function processFilePath(filePath: string) {
  const buffer = await Deno.readFile(filePath);
  const filename = basename(filePath, extname(filePath));
  const crops = await cropper.processBuffer(buffer);
  if (crops) {
    for (const crop of crops) {
      const i = crops!.indexOf(crop);
      if (settings.writeOutput && settings.outputDir) {
        const outPath = join(
          settings.outputDir,
          `${filename}_${i}.${settings.outputFormat}`,
        );
        await Deno.writeFile(outPath, crop);
        console.log(`→ ${outPath}`);
      }
    }
  }
  return crops?.length || 0;
}
