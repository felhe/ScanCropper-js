import { ScanCropper } from "./src/ScanCropper.ts";
import { Settings } from "./src/Settings.ts";

(async () => {
  const settings: Settings = {
    blur: 9,
    thresh: 250,
    maxVal: 255,
    writeOutput: false,
    outputFormat: "png",
  };

  const cropper = new ScanCropper(settings);
  await cropper.init();

  const buffer = await Deno.readFile("./images/input/Scan.png");
  const result = await cropper.processBuffer(buffer, "manual");
  console.log(result);
})();
