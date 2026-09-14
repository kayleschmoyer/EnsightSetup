import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SATURATION_THRESHOLD,
  buildMarkingMask,
  cleanImageData,
  componentBounds,
  dilateMask,
  excludeOversizedComponents,
  excludeUnanchoredComponents,
  fillEnclosedRegions,
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
/** A pastel plan tint — a street-name banner, a zone fill. Chroma 36. */
const PALE_BLUE = [207, 226, 243];

/** Paint a solid `size`×`size` block — the stand-in for a device glyph. */
function paintBlock(grid, x0, y0, size, color) {
  for (let y = y0; y < y0 + size; y += 1) {
    for (let x = x0; x < x0 + size; x += 1) grid[y][x] = color;
  }
}

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

  it('leaves a pastel plan tint alone but flags vivid markup', () => {
    const grid = planGrid(2);
    grid[0][0] = PALE_BLUE;          // a street-name banner fill
    grid[0][1] = [255, 180, 140];    // a peach zone highlight, chroma 115
    grid[1][0] = [34, 197, 94];      // an FOV wedge green, chroma 163
    grid[1][1] = [59, 130, 246];     // a sign-rectangle blue, chroma 187
    const image = imageFrom(grid);

    const mask = buildMarkingMask(image);

    expect(mask[0]).toBe(0);
    expect(mask[2]).toBe(1);
    expect(mask[3]).toBe(1);
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

describe('componentBounds', () => {
  it('finds the inclusive bounding box of each component', () => {
    // 5x4: an L-shaped component spanning (1,1)-(3,2).
    const mask = new Uint8Array(20);
    mask[1 * 5 + 1] = 1; // (1,1)
    mask[1 * 5 + 2] = 1; // (2,1)
    mask[2 * 5 + 2] = 1; // (2,2)
    mask[2 * 5 + 3] = 1; // (3,2)
    const { labels, sizes } = labelConnectedComponents(mask, 5, 4);

    const [bounds] = componentBounds(labels, sizes.length, 5);

    expect(bounds).toEqual({ minX: 1, maxX: 3, minY: 1, maxY: 2 });
  });
});

describe('excludeUnanchoredComponents', () => {
  it('spares a thin component with no compact neighbour nearby', () => {
    const mask = new Uint8Array(400); // 20x20, all zero — a lone thin shape
    // A staircase from (0,0) to (10,10): 21 pixels across a 11x11 box, ratio ~0.17.
    let x = 0;
    let y = 0;
    mask[y * 20 + x] = 1;
    for (let i = 0; i < 10; i += 1) {
      x += 1;
      mask[y * 20 + x] = 1;
      y += 1;
      mask[y * 20 + x] = 1;
    }

    const filtered = excludeUnanchoredComponents(mask, 20, 20);

    expect(filtered.some(Boolean)).toBe(false);
  });

  it('keeps a thin component anchored to a compact one nearby', () => {
    const mask = new Uint8Array(400); // 20x20
    // A compact 4x4 "icon" at (0,0)-(3,3)...
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) mask[y * 20 + x] = 1;
    }
    // ...and a thin staircase reaching away from right beside it.
    let x = 5;
    let y = 0;
    mask[y * 20 + x] = 1;
    for (let i = 0; i < 6; i += 1) {
      x += 1;
      mask[y * 20 + x] = 1;
      y += 1;
      mask[y * 20 + x] = 1;
    }

    const filtered = excludeUnanchoredComponents(mask, 20, 20);

    // Both the icon and the line beside it survive.
    expect(filtered[0]).toBe(1);
    expect(filtered[5]).toBe(1);
  });

  it('never excludes a lone compact component', () => {
    const mask = new Uint8Array(100); // 10x10, nothing else on the plan
    for (let y = 3; y < 7; y += 1) {
      for (let x = 3; x < 7; x += 1) mask[y * 10 + x] = 1;
    }

    expect(excludeUnanchoredComponents(mask, 10, 10)).toEqual(mask);
  });

  it('does not let a compact speck below the anchor size anchor itself', () => {
    // A 2x2 "arrowhead" with a thin "dimension line" beside it, nothing else.
    const mask = new Uint8Array(400); // 20x20
    mask[0] = 1;
    mask[1] = 1;
    mask[20] = 1;
    mask[21] = 1;
    for (let x = 4; x < 16; x += 1) mask[10 * 20 + x] = 1;

    const filtered = excludeUnanchoredComponents(mask, 20, 20, { minAnchorPixels: 16 });

    expect(filtered.some(Boolean)).toBe(false);
  });

  it('keeps a small speck that sits beside a real anchor', () => {
    const mask = new Uint8Array(400); // 20x20
    // A 4x4 icon...
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) mask[y * 20 + x] = 1;
    }
    // ...and a single-pixel "label digit" two pixels off it.
    mask[6] = 1;

    const filtered = excludeUnanchoredComponents(mask, 20, 20, { minAnchorPixels: 16 });

    expect(filtered[6]).toBe(1);
  });
});

describe('fillEnclosedRegions', () => {
  it('adds what a component fully surrounds', () => {
    // 6x6: a ring of masked pixels around a 2x2 hollow.
    const mask = new Uint8Array(36);
    for (let y = 1; y <= 4; y += 1) {
      for (let x = 1; x <= 4; x += 1) {
        if (y === 1 || y === 4 || x === 1 || x === 4) mask[y * 6 + x] = 1;
      }
    }

    const filled = fillEnclosedRegions(mask, 6, 6, 100);

    expect(filled[2 * 6 + 2]).toBe(1);
    expect(filled[3 * 6 + 3]).toBe(1);
    // Outside the ring is untouched.
    expect(filled[0]).toBe(0);
  });

  it('leaves an enclosed region alone when it is bigger than the cap', () => {
    const mask = new Uint8Array(36);
    for (let y = 1; y <= 4; y += 1) {
      for (let x = 1; x <= 4; x += 1) {
        if (y === 1 || y === 4 || x === 1 || x === 4) mask[y * 6 + x] = 1;
      }
    }

    // The hollow is 4 pixels; a cap of 3 means "that's a ring around the plan".
    expect(fillEnclosedRegions(mask, 6, 6, 3)).toBe(mask);
  });

  it('returns the mask untouched for a solid shape', () => {
    const mask = new Uint8Array(16);
    for (const i of [5, 6, 9, 10]) mask[i] = 1;

    expect(fillEnclosedRegions(mask, 4, 4, 100)).toBe(mask);
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
    paintBlock(grid, 5, 5, 4, RED);
    const image = imageFrom(grid);

    const result = cleanImageData(image);

    expect(result.removedPixels).toBe(16);
    expect(result.totalPixels).toBe(169);
    expect(result.removedRatio).toBeCloseTo(16 / 169);
    expect(pixelAt(image, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(image, 8, 8)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(image, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(image, 0, 12)).toEqual([0, 0, 0, 255]);
  });

  it('leaves a lone vivid speck alone — a dimension tick, not a device', () => {
    const grid = planGrid(13);
    grid[6][6] = RED;
    grid[6][7] = RED;
    const image = imageFrom(grid);

    const result = cleanImageData(image);

    expect(result.removedPixels).toBe(0);
    expect(pixelAt(image, 6, 6)).toEqual([...RED, 255]);
  });

  it('blends from adjoining line art when a marking sits against a wall', () => {
    const grid = planGrid(9);
    for (let y = 0; y < 9; y += 1) grid[y][0] = BLACK;
    paintBlock(grid, 1, 3, 4, RED); // pressed right up against the wall
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
    paintBlock(grid, 1, 3, 4, RED); // adjacent to the wall, so dilation reaches across it
    const image = imageFrom(grid);

    cleanImageData(image);

    // Dilation only claims pixels that read as background, never line art.
    for (let y = 0; y < 9; y += 1) {
      expect(pixelAt(image, 0, y)).toEqual([0, 0, 0, 255]);
    }
  });

  it('clears the anti-aliased halo around a marking via dilation', () => {
    const grid = planGrid(9);
    paintBlock(grid, 3, 3, 4, RED);
    grid[4][2] = [255, 200, 200]; // pale edge blend, below the chroma threshold
    const image = imageFrom(grid);

    cleanImageData(image);

    // Dilation pulls the halo into the mask even though it wasn't flagged itself.
    expect(pixelAt(image, 2, 4)).toEqual([255, 255, 255, 255]);
  });

  it('never touches a pastel banner or zone fill, even a small one', () => {
    const grid = planGrid(20);
    paintBlock(grid, 2, 2, 6, PALE_BLUE); // a street-name banner, well under the size cap
    grid[4][4] = BLACK;                    // its text
    const image = imageFrom(grid);

    const result = cleanImageData(image);

    expect(result.removedPixels).toBe(0);
    expect(pixelAt(image, 2, 2)).toEqual([...PALE_BLUE, 255]);
    expect(pixelAt(image, 4, 4)).toEqual([0, 0, 0, 255]);
  });

  it('takes the black text inside a coloured label box out with the box', () => {
    const grid = planGrid(12);
    paintBlock(grid, 2, 2, 6, [245, 158, 11]); // an orange label box
    grid[4][4] = BLACK;                         // the "2" printed in it
    grid[4][5] = BLACK;
    const image = imageFrom(grid);

    cleanImageData(image);

    // The digit is gone with the box, not left behind and smeared into the fill.
    expect(pixelAt(image, 4, 4)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(image, 2, 2)).toEqual([255, 255, 255, 255]);
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
    paintBlock(grid, 33, 33, 4, RED); // the actual device callout
    const image = imageFrom(grid);

    const result = cleanImageData(image);

    // The zone fill (400 px, far above the default cap) survives untouched.
    expect(pixelAt(image, 15, 15)).toEqual([255, 180, 140, 255]);
    expect(pixelAt(image, 20, 20)).toEqual([255, 180, 140, 255]);
    // The lone device marking still gets cleaned.
    expect(pixelAt(image, 35, 35)).toEqual([255, 255, 255, 255]);
    expect(result.removedPixels).toBe(16);
  });

  it('removes a device icon and its attached leader, but leaves an isolated CAD line and a zone fill alone', () => {
    const grid = planGrid(50);
    // A large "zone highlight" fill — the plan's own colour coding.
    for (let y = 10; y < 30; y += 1) {
      for (let x = 10; x < 30; x += 1) grid[y][x] = [255, 180, 140];
    }
    // A compact device icon...
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) grid[y][x] = RED;
    }
    // ...with a thin leader line reaching away from it.
    let x = 7;
    let y = 2;
    grid[y][x] = RED;
    for (let i = 0; i < 5; i += 1) {
      x += 1;
      grid[y][x] = RED;
      y += 1;
      grid[y][x] = RED;
    }
    // An isolated thin CAD line, nowhere near any icon.
    let lx = 40;
    let ly = 40;
    grid[ly][lx] = RED;
    for (let i = 0; i < 4; i += 1) {
      lx += 1;
      grid[ly][lx] = RED;
      ly += 1;
      grid[ly][lx] = RED;
    }
    const image = imageFrom(grid);

    cleanImageData(image);

    // The zone fill survives.
    expect(pixelAt(image, 15, 15)).toEqual([255, 180, 140, 255]);
    // The icon and its attached leader are gone.
    expect(pixelAt(image, 3, 3)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(image, 9, 4)).toEqual([255, 255, 255, 255]);
    // The isolated CAD line, with no icon nearby, is untouched.
    expect(pixelAt(image, 40, 40)).toEqual([...RED, 255]);
  });
});
