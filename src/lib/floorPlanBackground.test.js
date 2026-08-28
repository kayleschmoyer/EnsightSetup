import { describe, expect, it, vi } from 'vitest';
import {
  FLOOR_PLAN_ACCEPT,
  MAX_FLOOR_PLAN_BYTES,
  MAX_FLOOR_PLAN_DATA_URL_CHARS,
  approxDataUrlBytes,
  compressOversizedBackgrounds,
  isImageFloorPlanFile,
  isOversizedFloorPlan,
  isPdfFloorPlanFile,
  loadFloorPlanBackground,
} from './floorPlanBackground';

const dataUrl = (chars) => `data:image/png;base64,${'A'.repeat(chars)}`;
const oversized = dataUrl(MAX_FLOOR_PLAN_DATA_URL_CHARS + 1000);
const small = dataUrl(100);

describe('floorPlanBackground', () => {
  it('accepts common image and PDF MIME types', () => {
    expect(FLOOR_PLAN_ACCEPT).toContain('application/pdf');
    expect(FLOOR_PLAN_ACCEPT).toContain('image/png');
  });

  it('detects PDF files by type or extension', () => {
    expect(isPdfFloorPlanFile({ type: 'application/pdf', name: 'level-2.pdf' })).toBe(true);
    expect(isPdfFloorPlanFile({ type: '', name: 'level-2.PDF' })).toBe(true);
    expect(isPdfFloorPlanFile({ type: 'image/png', name: 'level-2.png' })).toBe(false);
  });

  it('detects image files by type or extension', () => {
    expect(isImageFloorPlanFile({ type: 'image/png', name: 'plan.png' })).toBe(true);
    expect(isImageFloorPlanFile({ type: '', name: 'plan.JPG' })).toBe(true);
    expect(isImageFloorPlanFile({ type: 'application/pdf', name: 'plan.pdf' })).toBe(false);
  });

  it('rejects unsupported file types', async () => {
    await expect(loadFloorPlanBackground({ type: 'text/plain', name: 'notes.txt' }))
      .rejects.toThrow(/Unsupported file type/);
  });

  it('flags only backgrounds past the per-plan budget', () => {
    expect(isOversizedFloorPlan(null)).toBe(false);
    expect(isOversizedFloorPlan(small)).toBe(false);
    expect(isOversizedFloorPlan(oversized)).toBe(true);
  });

  it('approximates decoded bytes from a data URL', () => {
    // 4 base64 chars encode 3 bytes.
    expect(approxDataUrlBytes(dataUrl(400))).toBe(300);
    expect(approxDataUrlBytes(null)).toBe(0);
  });

  it('targets a ~500KB blob budget now that backgrounds upload to Storage', () => {
    // Backgrounds are uploaded as Storage blobs (see ImageUploadService.uploadFloorPlanBackground)
    // instead of embedded as base64 — the tight data-URL/Sheets-cell ceiling no longer applies.
    expect(MAX_FLOOR_PLAN_BYTES).toBe(500_000);
  });
});

describe('compressOversizedBackgrounds', () => {
  const sites = () => ([
    {
      id: 1,
      levels: [
        { id: 11, bgImage: oversized },
        { id: 12, bgImage: small },
      ],
    },
    { id: 2, levels: [{ id: 21, bgImage: null }] },
  ]);

  it('leaves setups without oversized plans untouched', async () => {
    const input = [{ id: 1, levels: [{ id: 11, bgImage: small }] }];
    const compress = vi.fn();
    const result = await compressOversizedBackgrounds(input, { compress });

    expect(result.sites).toBe(input);
    expect(result.compressed).toBe(0);
    expect(compress).not.toHaveBeenCalled();
  });

  it('recompresses only the oversized plans and reports savings', async () => {
    const input = sites();
    const compress = vi.fn().mockResolvedValue(small);
    const result = await compressOversizedBackgrounds(input, { compress });

    expect(compress).toHaveBeenCalledTimes(1);
    expect(compress).toHaveBeenCalledWith(oversized);
    expect(result.compressed).toBe(1);
    expect(result.savedChars).toBe(oversized.length - small.length);
    expect(result.sites[0].levels[0].bgImage).toBe(small);
    // The already-small plan is passed through untouched.
    expect(result.sites[0].levels[1]).toBe(input[0].levels[1]);
    // Sites with nothing oversized keep their identity so store diffing stays cheap.
    expect(result.sites[1]).toBe(input[1]);
  });

  it('keeps the original plan when compression fails or does not help', async () => {
    const failing = await compressOversizedBackgrounds(sites(), {
      compress: vi.fn().mockRejectedValue(new Error('no canvas')),
    });
    expect(failing.compressed).toBe(0);
    expect(failing.sites[0].levels[0].bgImage).toBe(oversized);

    const bigger = await compressOversizedBackgrounds(sites(), {
      compress: vi.fn().mockResolvedValue(dataUrl(MAX_FLOOR_PLAN_DATA_URL_CHARS + 5000)),
    });
    expect(bigger.compressed).toBe(0);
    expect(bigger.sites[0].levels[0].bgImage).toBe(oversized);
  });

  it('tolerates missing site/level arrays', async () => {
    await expect(compressOversizedBackgrounds(null)).resolves.toMatchObject({ compressed: 0 });
    await expect(compressOversizedBackgrounds([{ id: 1 }])).resolves.toMatchObject({ compressed: 0 });
  });
});
