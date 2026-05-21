import { expect, test } from '@playwright/test';

test('dashboard renders HUD and nonblank WebGL scene', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await expect(page.locator('.speed-readout')).toBeVisible();
  await expect(page.locator('.mini-map')).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await page.waitForTimeout(1500);

  const canvasState = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return { hasCanvas: false, width: 0, height: 0, nonWhiteSamples: 0 };

    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const pixels = new Uint8Array(4 * 25);
    let sample = 0;

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        gl.readPixels(
          Math.floor(canvas.width * (0.25 + x * 0.125)),
          Math.floor(canvas.height * (0.25 + y * 0.125)),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
          sample * 4
        );
        sample += 1;
      }
    }

    let nonWhiteSamples = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) {
        nonWhiteSamples += 1;
      }
    }

    return {
      hasCanvas: true,
      width: canvas.width,
      height: canvas.height,
      nonWhiteSamples
    };
  });

  expect(canvasState.hasCanvas).toBe(true);
  expect(canvasState.width).toBeGreaterThan(300);
  expect(canvasState.height).toBeGreaterThan(300);
  expect(canvasState.nonWhiteSamples).toBeGreaterThan(0);
});
