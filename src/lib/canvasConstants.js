// Logical canvas size – device/zone coordinates are stored in this space so
// they stay aligned with the background regardless of viewport / stage size.
export const LOGICAL_W = 1200;
export const LOGICAL_H = 800;

export function getLogicalCanvasFit(stageWidth, stageHeight) {
  const fitScale = Math.min(stageWidth / LOGICAL_W, stageHeight / LOGICAL_H) || 1;
  const fitOffsetX = (stageWidth - LOGICAL_W * fitScale) / 2;
  const fitOffsetY = (stageHeight - LOGICAL_H * fitScale) / 2;
  return { fitScale, fitOffsetX, fitOffsetY };
}

/** Background image letterbox rect inside the logical canvas (matches MapCanvas). */
export function getBackgroundFitRect(imageWidth, imageHeight) {
  if (!imageWidth || !imageHeight) return null;
  const scale = Math.min(LOGICAL_W / imageWidth, LOGICAL_H / imageHeight);
  const w = imageWidth * scale;
  const h = imageHeight * scale;
  return {
    x: (LOGICAL_W - w) / 2,
    y: (LOGICAL_H - h) / 2,
    w,
    h,
  };
}
