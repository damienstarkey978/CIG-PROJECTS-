#!/usr/bin/env node
/**
 * Generate Capacitor / store icons + splash from the approved power icon.
 * Source: resources/icon-source.png (1254×1254 green power/cycle mark).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'resources', 'icon-source.png');
const SIGNAL_NIGHT = { r: 10, g: 15, b: 12, alpha: 1 }; // #0A0F0C

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function squareIcon(size, outPath, { padRatio = 0.12 } = {}) {
  const pad = Math.round(size * padRatio);
  const inner = size - pad * 2;
  const resized = await sharp(source)
    .resize(inner, inner, { fit: 'contain', background: SIGNAL_NIGHT })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: SIGNAL_NIGHT },
  })
    .composite([{ input: resized, left: pad, top: pad }])
    .png()
    .toFile(outPath);
}

async function maskableIcon(size, outPath) {
  // Safe zone ~66% for adaptive / maskable icons
  const pad = Math.round(size * 0.18);
  const inner = size - pad * 2;
  const resized = await sharp(source)
    .resize(inner, inner, { fit: 'contain', background: SIGNAL_NIGHT })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: SIGNAL_NIGHT },
  })
    .composite([{ input: resized, left: pad, top: pad }])
    .png()
    .toFile(outPath);
}

async function splash(width, height, outPath) {
  const mark = Math.round(Math.min(width, height) * 0.28);
  const resized = await sharp(source)
    .resize(mark, mark, { fit: 'contain', background: SIGNAL_NIGHT })
    .png()
    .toBuffer();
  await sharp({
    create: { width, height, channels: 4, background: SIGNAL_NIGHT },
  })
    .composite([
      {
        input: resized,
        left: Math.round((width - mark) / 2),
        top: Math.round((height - mark) / 2),
      },
    ])
    .png()
    .toFile(outPath);
}

async function main() {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing source icon: ${source}`);
  }

  const resources = path.join(root, 'resources');
  const www = path.join(root, 'www');
  const iosAppIcon = path.join(
    root,
    'ios',
    'App',
    'App',
    'Assets.xcassets',
    'AppIcon.appiconset'
  );
  const androidRes = path.join(root, 'android', 'app', 'src', 'main', 'res');

  await ensureDir(resources);
  await ensureDir(www);

  // Capacitor Assets / generic
  await squareIcon(1024, path.join(resources, 'icon.png'), { padRatio: 0.08 });
  await maskableIcon(1024, path.join(resources, 'icon-foreground.png'));
  await splash(2732, 2732, path.join(resources, 'splash.png'));
  await splash(2732, 2732, path.join(resources, 'splash-dark.png'));
  await squareIcon(192, path.join(www, 'icon.png'), { padRatio: 0.1 });

  // iOS AppIcon set (single 1024 marketing + common sizes for Xcode)
  if (fs.existsSync(path.dirname(iosAppIcon))) {
    await ensureDir(iosAppIcon);
    const iosSizes = [
      ['icon-20@2x', 40],
      ['icon-20@3x', 60],
      ['icon-29@2x', 58],
      ['icon-29@3x', 87],
      ['icon-40@2x', 80],
      ['icon-40@3x', 120],
      ['icon-60@2x', 120],
      ['icon-60@3x', 180],
      ['icon-76', 76],
      ['icon-76@2x', 152],
      ['icon-83.5@2x', 167],
      ['icon-1024', 1024],
    ];
    // Modern single-size App Store asset
    await squareIcon(1024, path.join(iosAppIcon, 'AppIcon-1024.png'), { padRatio: 0.08 });
    for (const [name, size] of iosSizes) {
      await squareIcon(size, path.join(iosAppIcon, `${name}.png`), { padRatio: 0.08 });
    }
    await fs.promises.writeFile(
      path.join(iosAppIcon, 'Contents.json'),
      JSON.stringify(
        {
          images: [
            {
              filename: 'AppIcon-1024.png',
              idiom: 'universal',
              platform: 'ios',
              size: '1024x1024',
            },
          ],
          info: { author: 'on-go', version: 1 },
        },
        null,
        2
      )
    );
  }

  // Android mipmaps + adaptive
  if (fs.existsSync(androidRes)) {
    const dens = [
      ['mdpi', 48],
      ['hdpi', 72],
      ['xhdpi', 96],
      ['xxhdpi', 144],
      ['xxxhdpi', 192],
    ];
    for (const [density, size] of dens) {
      const mipmap = path.join(androidRes, `mipmap-${density}`);
      await ensureDir(mipmap);
      await squareIcon(size, path.join(mipmap, 'ic_launcher.png'), { padRatio: 0.1 });
      await squareIcon(size, path.join(mipmap, 'ic_launcher_round.png'), { padRatio: 0.1 });
      await maskableIcon(size, path.join(mipmap, 'ic_launcher_foreground.png'));
    }

    // Adaptive icon XML
    const anydpi = path.join(androidRes, 'mipmap-anydpi-v26');
    await ensureDir(anydpi);
    const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
    await fs.promises.writeFile(path.join(anydpi, 'ic_launcher.xml'), adaptive);
    await fs.promises.writeFile(path.join(anydpi, 'ic_launcher_round.xml'), adaptive);

    const values = path.join(androidRes, 'values');
    await ensureDir(values);
    const colorsPath = path.join(values, 'ic_launcher_background.xml');
    await fs.promises.writeFile(
      colorsPath,
      `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0A0F0C</color>
</resources>
`
    );

    // Splash drawables
    for (const [density, size] of [
      ['mdpi', 320],
      ['hdpi', 480],
      ['xhdpi', 720],
      ['xxhdpi', 960],
      ['xxxhdpi', 1280],
    ]) {
      const drawable = path.join(androidRes, `drawable-${density}`);
      await ensureDir(drawable);
      await splash(size, size, path.join(drawable, 'splash.png'));
    }
    const drawable = path.join(androidRes, 'drawable');
    await ensureDir(drawable);
    await splash(480, 480, path.join(drawable, 'splash.png'));
  }

  // Store marketing sizes (also used for Connect / Play listing)
  const store = path.join(resources, 'store');
  await ensureDir(store);
  await squareIcon(1024, path.join(store, 'ios-appicon-1024.png'), { padRatio: 0.08 });
  await squareIcon(512, path.join(store, 'play-icon-512.png'), { padRatio: 0.08 });
  await maskableIcon(512, path.join(store, 'play-feature-graphic-source-512.png'));
  // Play feature graphic 1024×500
  {
    const w = 1024;
    const h = 500;
    const mark = 280;
    const resized = await sharp(source)
      .resize(mark, mark, { fit: 'contain', background: SIGNAL_NIGHT })
      .png()
      .toBuffer();
    await sharp({
      create: { width: w, height: h, channels: 4, background: SIGNAL_NIGHT },
    })
      .composite([{ input: resized, left: Math.round((w - mark) / 2), top: Math.round((h - mark) / 2) }])
      .png()
      .toFile(path.join(store, 'play-feature-graphic-1024x500.png'));
  }

  console.log('Generated Capacitor / store icons and splash assets.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
