// 从 public/favicon.svg 生成 PWA 所需的 PNG 图标。
// 用法：npm run icons（依赖 sharp，见 devDependencies）
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const SOURCE = "public/favicon.svg";
const OUT_DIR = "public/icons";
const BRAND_GREEN = "#2F6C5B";

// maskable 图标要求主体落在中心 80% 安全区内，故在实底上缩放合成
const MASKABLE_SCALE = 0.8;

async function renderPng(size, { background = null, scale = 1 } = {}) {
  const innerSize = Math.round(size * scale);
  const icon = await sharp(SOURCE, { density: 384 })
    .resize(innerSize, innerSize)
    .png()
    .toBuffer();

  if (!background && scale === 1) return icon;

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: icon, gravity: "center" }])
    .png()
    .toBuffer();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const icons = [
    ["icon-192.png", await renderPng(192)],
    ["icon-512.png", await renderPng(512)],
    ["icon-maskable-512.png", await renderPng(512, { background: BRAND_GREEN, scale: MASKABLE_SCALE })],
    ["apple-touch-icon.png", await renderPng(180, { background: BRAND_GREEN })],
  ];

  for (const [name, buffer] of icons) {
    await sharp(buffer).toFile(`${OUT_DIR}/${name}`);
    console.log(`generated ${OUT_DIR}/${name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
