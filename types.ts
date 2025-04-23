export interface Settings {
  blur: number;
  thresh: number;
  maxVal: number;
  writeOutput: boolean;
  inputDir?: string;
  outputDir?: string;
  outputFormat: "jpg" | "png";
}
