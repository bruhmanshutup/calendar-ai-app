/**
 * Downloads the free (CC0) Poly Haven assets used by the landing scene into
 * public/. Re-run any time; existing files are skipped.
 *
 *   node scripts/fetch-polyhaven-assets.mjs
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const API = "https://api.polyhaven.com/files/";

const MODELS = [
  "book_encyclopedia_set_01",
  "binder_notebook",
  "office_notepads",
  "multi_cleaner_bottle",
  "wicker_basket_01",
  "tea_set_01",
  "stationery_supplies",
  "throw_pillows_01",
  "alarm_clock_01",
  "classic_laptop",
  "croissant",
  "food_apple_01",
  "football",
  "gamepad",
];
const HDRIS = ["brown_photostudio_02"];
const TEXTURES = {
  walnut_veneer_02: ["Diffuse", "nor_gl", "Rough"],
  fabric_pattern_07: ["col_1", "nor_gl", "Rough"],
};
const RES = "1k";

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function download(url, file) {
  if (await exists(file)) return 0;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return bytes.length;
}

async function files(asset) {
  const response = await fetch(API + asset);
  if (!response.ok) throw new Error(`${response.status} for ${asset}`);
  return response.json();
}

let total = 0;
for (const asset of MODELS) {
  const entry = (await files(asset)).gltf[RES].gltf;
  const dir = path.join(ROOT, "public", "models", asset);
  total += await download(entry.url, path.join(dir, `${asset}.gltf`));
  for (const [relative, info] of Object.entries(entry.include ?? {})) {
    total += await download(info.url, path.join(dir, relative));
  }
  console.log("model", asset);
}
for (const asset of HDRIS) {
  const entry = (await files(asset)).hdri[RES].hdr;
  total += await download(entry.url, path.join(ROOT, "public", "hdr", `${asset}_${RES}.hdr`));
  console.log("hdri", asset);
}
for (const [asset, maps] of Object.entries(TEXTURES)) {
  const info = await files(asset);
  for (const map of maps) {
    const entry = info[map][RES].jpg ?? info[map][RES].png;
    const extension = info[map][RES].jpg ? "jpg" : "png";
    total += await download(entry.url, path.join(ROOT, "public", "textures", asset, `${map}_${RES}.${extension}`));
  }
  console.log("texture", asset);
}
console.log(`downloaded ${(total / 1024 / 1024).toFixed(1)} MB`);
