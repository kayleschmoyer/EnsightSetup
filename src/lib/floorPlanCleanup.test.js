import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SATURATION_THRESHOLD,
  buildMarkingMask,
  cleanImageData,
  dilateMask,
  excludeOversizedComponents,
  inpaintMasked,
  labelConnectedComponents,
} from './floorPlanCleanup';

/** Build an RGBA image from a `[r,g,b]` per-pixel grid. */
function imageFrom(pixels) {
  const height = pixels.length;
  const width = pixels[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixels[y][x];
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { data, width, height };
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3],
  ];
}

/** A white plan with black line art — the base every fixture builds on. */
function planGrid(size, fill = [255, 255, 255]) {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => [...fill]));
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const RED = [220, 30, 30];

describe('buildMarkingMask', () => {
  it('flags saturated pixels and leaves greyscale line art alone', () => {
    const grid = planGrid(3);
    grid[0][0] = BLACK;          // line art
    grid[0][1] = [128, 128, 128]; // grey shading
    grid[1][1] = RED;             // a marking
    const image = imageFrom(grid);

    const mask = buildMarkingMask(image);

    expect(mask[0]).toBe(0);
    expect(mask[1]).toBe(0);
    expect(mask[4]).toBe(1);
  });

  it('ignores transparent pixels regardless of their colour channels', () => {
    const grid = planGrid(2);
    grid[0][0] = [...RED, 0];
    const image = imageFrom(grid);

    expect(buildMarkingMask(image)[0]).toBe(0);
  });

  it('leaves faint colour noise below the threshold in place', () => {
    const noise = DEFAULT_SATURATION_THRESHOLD - 1;
    const grid = planGrid(2);
    grid[0][0] = [255, 255 - noise, 255];
    const image = imageFrom(grid);

    expect(buildMarkingMask(image)[0]).toBe(0);
  });

  it('honours a custom threshold', () => {
    const grid = planGrid(2);
    grid[0][0] = [255, 235, 255]; // chroma of 20
    const image = imageFrom(grid);

    expect(buildMarkingMask(image, { saturationThreshold: 10 })[0]).toBe(1);
    expect(buildMarkingMask(image, { saturationThreshold: 30 })[0]).toBe(0);
  });
});

describe('dilateMask', () => {
  it('grows a single flagged pixel into its neighbourhood', () => {
    const mask = new Uint8Array(25);
    mask[12] = 1; // centre of a 5x5

    const grown = dilateMask(mask, 5, 5, 1);

    // The 3x3 block around the centre is now flagged...
    for (const index of [6, 7, 8, 11, 12, 13, 16, 17, 18]) {
      expect(grown[index]).toBe(1);
    }
    // ...and nothing beyond it.
    expect(grown[0]).toBe(0);
    expect(grown[24]).toBe(0);
  });

  it('clips at the edges instead of wrapping to the next row', () => {
    const mask = new Uint8Array(9);
    mask[3] = 1; // left edge of the middle row

    const grown = dilateMask(mask, 3, 3, 1);

    expect(grown[2]).toBe(0); // right edge of the top row must not be caught
    expect(grown[5]).toBe(0); // right edge of the middle row
  });

  it('returns the mask untouched for a zero radius', () => {
    const mask = new Uint8Array([0, 1, 0, 0]);
    expect(dilateMask(mask, 2, 2, 0)).toBe(mask);
  });
});

describe('labelConnectedComponents', () => {
  it('gives separate ids and sizes to disjoint blobs', () => {
    // 5x5: a 2-pixel blob at the top-left, a 3-pixel blob at the bottom-right.
    const mask = new Uint8Array(25);
    mask[0] = 1;
    mask[1] = 1;
    mask[18] = 1;
    mask[19] = 1;
    mask[24] = 1;

    const { labels, sizes } = labelConnectedComponents(mask, 5, 5);

    expect(labels[0]).toBe(labels[1]);
    expect(labels[18]).toBe(labels[19]);
    expect(labels[18]).toBe(labels[24]);
    expect(labels[0]).not.toBe(labels[18]);
    expect(sizes.sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('does not connect pixels that only touch diagonally', () => {
    const mask = new Uint8Array(4);
    mask[0] = 1; // top-left
    mask[3] = 1; // bottom-right

    const { labels } = labelConnectedComponents(mask, 2, 2);

    expect(labels[0]).not.toBe(labels[3]);
  });
});

describe('excludeOversizedComponents', () => {
  it('drops a region bigger than the cap and keeps a smaller one', () => {
    // 5x5: a 4-pixel block (too big) and a lone pixel (fine).
    const mask = new Uint8Array(25);
    mask[0] = 1;
    mask[1] = 1;
    mask[5] = 1;
    mask[6] = 1;
    mask[24] = 1;

    const filtered = excludeOversizedComponents(mask, 5, 5, 2);

    expect(Array.from(filtered.slice(0, 2))).toEqual([0, 0]);
    expect(filtered[24]).toBe(1);
  });

  it('returns the mask untouched when nothing exceeds the cap', () => {
    const mask = new Uint8Array([1, 0, 0, 1]);
    expect(excludeOversizedComponents(mask, 2, 2, 5)).toBe(mask);
  });
});

describe('inpaintMasked', () => {
  it('fills a masked pixel from its unmasked neighbours', () => {
    const grid = planGrid(3);
    grid[1][1] = RED;
    const image = imageFrom(grid);
    const mask = new Uint8Array(9);
    mask[4] = 1;

    inpaintMasked(image.data, mask, 3, 3);

    expect(pixelAt(image, 1, 1)).toEqual([255, 255, 255, 255]);
  });

  it('closes a hole larger than one pass can reach', () => {
    const grid = planGrid(5);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) grid[y][x] = RED;
    }
    const image = imageFrom(grid);
    const mask = new Uint8Array(25);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) mask[y * 5 + x] = 1;
    }

    inpaintMasked(image.data, mask, 5, 5);

    // Every masked pixel, including the fully-enclosed centre, ends up plan-white.
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) {
        expect(pixelAt(image, x, y)).toEqual([255, 255, 255, 255]);
      }
    }
  });

  it('falls back to the average plan colour when everything is masked', () => {
    const image = imageFrom(planGrid(2, RED));
    const mask = new Uint8Array([1, 1, 1, 1]);

    inpaintMasked(image.data, mask, 2, 2);

    // No unmasked pixel to sample anywhere — white is the safe plan colour.
    expect(pixelAt(image, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('does nothing when the mask is empty', () => {
    const image = imageFrom(planGrid(2, BLACK));

    inpaintMasked(image.data, new Uint8Array(4), 2, 2);

    expect(pixelAt(image, 0, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe('cleanImageData', () => {
  it('removes a coloured marking and preserves the line art around it', () => {
    const grid = planGrid(13);
    // A wall down the left edge, further than the dilated mask can reach.
    for (let y = 0; y < 13; y += 1) grid[y][0] = BLACK;
    // A camera icon in open floor space.
    grid[6][6] = RED;
    grid[6][7] = RED;
    const image = imageFrom(grid);

    const result = cleanImageData(image);

    expect(result.removedPixels).toBe(2);
    expect(result.totalPixels).toBe(169);
    expect(result.removedRatio).toBeCloseTo(2 / 169);
    expect(pixelAt(image, 6, 6)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(image, 7, 6)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(image, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(image, 0, 12)).toEqual([0, 0, 0, 255]);
  });

  it('blends from adjoining line art when a marking sits against a wall', () => {
    const grid = planGrid(9);
    for (let y = 0; y < 9; y += 1) grid[y][0] = BLACK;
    grid[4][1] = RED; // pressed right up against the wall
    const image = imageFrom(grid);

    cleanImageData(image);

    // The fill averages whatever surrounds the hole, so a marking touching a
    // wall picks up some of it rather than punching a white notch through it.
    const [r, g, b] = pixelAt(image, 1, 4);
    expect(r).toBeLessThan(255);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('reports nothing removed and leaves an already-clean plan byte-identical', () => {
    const grid = planGrid(4);
    grid[1][1] = BLACK;
    grid[2][2] = [90, 90, 90];
    const image = imageFrom(grid);
    const before = Uint8ClampedArray.from(image.data);

    const result = cleanImageData(image);

    expect(result).toEqual({ removedPixels: 0, totalPixels: 16, removedRatio: 0 });
    expect(image.data).toEqual(before);
  });

  it('keeps a wall intact when dilation grows the mask into it', () => {
    const grid = planGrid(9);
    for (let y = 0; y < 9; y += 1) grid[y][0] = BLACK;
    grid[4][1] = RED; // adjacent to the wall, so dilation reaches across it
    const image = imageFrom(grid);

    cleanImageData(image);

    // Dilation only claims pixels that read as background, never line art.
    for (let y = 0; y < 9; y += 1) {
      expect(pixelAt(image, 0, y)).toEqual([0, 0, 0, 255]);
    }
  });

  it('clears the anti-aliased halo around a marking via dilation', () => {
    const grid = planGrid(7);
    grid[3][3] = RED;
    grid[3][2] = [255, 200, 200]; // pale edge blend, below the chroma threshold
    const image = imageFrom(grid);

    cleanImageData(image);

    // Dilation pulls the halo into the mask even though it wasn't flagged itself.
    expect(pixelAt(image, 2, 3)).toEqual([255, 255, 255, 255]);
  });

  it('spares a large colour-coded plan region but still removes a small icon on it', () => {
    // A 40x40 plan with a 20x20 "zone highlight" fill (the plan's own colour
    // coding) plus a single-pixel "camera" marking well away from it, mirroring
    // an uploaded plan that colour-codes zones itself instead of staying B/W.
    const grid = planGrid(40, [255, 180, 140]); // stand-in: a peach zone fill
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x < 40; x += 1) {
        if (y >= 10 && y < 30 && x >= 10 && x < 30) grid[y][x] = [255, 180, 140];
        else grid[y][x] = WHITE;
      }
    }
    grid[35][35] = RED; // the actual device callout
    const image = imageFrom(grid);

    const result = cleanImageData(image);

    // The zone fill (400 px, far above the default cap) survives untouched.
    expect(pixelAt(image, 15, 15)).toEqual([255, 180, 140, 255]);
    expect(pixelAt(image, 20, 20)).toEqual([255, 180, 140, 255]);
    // The lone device marking still gets cleaned.
    expect(pixelAt(image, 35, 35)).toEqual([255, 255, 255, 255]);
    expect(result.removedPixels).toBe(1);
  });
});
