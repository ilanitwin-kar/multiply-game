import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "www");

function drawIcon(size) {
  const png = new PNG({ width: size, height: size });
  const r = 108;
  const g = 92;
  const b = 231;
  const t = Math.max(2, Math.floor(size * 0.09));
  const m = Math.floor(size * 0.2);
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      let pr = r;
      let pg = g;
      let pb = b;
      const hBar = y >= cy - t / 2 && y < cy + t / 2 && x >= m && x < size - m;
      const vBar = x >= cx - t / 2 && x < cx + t / 2 && y >= m && y < size - m;
      if (hBar || vBar) {
        pr = pg = pb = 255;
      }
      png.data[idx] = pr;
      png.data[idx + 1] = pg;
      png.data[idx + 2] = pb;
      png.data[idx + 3] = 255;
    }
  }
  return png;
}

function writePng(png, file) {
  return new Promise((resolve, reject) => {
    png
      .pack()
      .pipe(fs.createWriteStream(file))
      .on("finish", resolve)
      .on("error", reject);
  });
}

for (const size of [192, 512]) {
  await writePng(drawIcon(size), path.join(outDir, `icon-${size}.png`));
}
console.log("Wrote icon-192.png and icon-512.png");
