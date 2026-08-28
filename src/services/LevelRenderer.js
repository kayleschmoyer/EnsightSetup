// Offscreen Konva renderer used by PDF export.
// Mirrors src/components/MapCanvas.jsx so every level prints
// identically to what the user sees in the editor.

import Konva from 'konva';
import { LOGICAL_W, LOGICAL_H, getLogicalCanvasFit, getBackgroundFitRect } from '../lib/canvasConstants';
import { coneWedgeRotation, isDualLensCamera } from '../lib/deviceNamingUtils';
import { getFloorPlanSignedUrl } from './ImageUploadService';

const DEVICE_SIZE = 10;

const DEVICE_COLORS = {
  'cam-fli': '#22c55e',
  'cam-lpr': '#3b82f6',
  'cam-people': '#06b6d4',
  'sign-led': '#f59e0b',
  'sign-static': '#eab308',
  'sign-designable': '#f97316',
  'sensor-nwave': '#10b981',
  'sensor-parksol': '#14b8a6',
  'sensor-proco': '#22c55e',
  'sensor-ensight': '#34d399',
};

const DEVICE_LABELS = {
  'cam-fli': 'FLI',
  'cam-lpr': 'LPR',
  'cam-people': 'PPL',
  'sign-led': 'LED',
  'sign-static': 'STC',
  'sign-designable': 'DSG',
  'sensor-nwave': 'NW',
  'sensor-parksol': 'PS',
  'sensor-proco': 'PR',
  'sensor-ensight': 'EV',
};

const hexToRgba = (hex, alpha) => {
  const cleaned = (hex || '#3b82f6').replace('#', '');
  const full = cleaned.length === 3 ? cleaned.split('').map(c => c + c).join('') : cleaned;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

const darkenHex = (hex, factor = 0.45) => {
  const cleaned = (hex || '#3b82f6').replace('#', '');
  const full = cleaned.length === 3 ? cleaned.split('').map(c => c + c).join('') : cleaned;
  const r = Math.max(0, Math.round(parseInt(full.slice(0, 2), 16) * factor));
  const g = Math.max(0, Math.round(parseInt(full.slice(2, 4), 16) * factor));
  const b = Math.max(0, Math.round(parseInt(full.slice(4, 6), 16) * factor));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

// Slightly stronger than the live editor so FOV wedges stay readable in PDF export.
const PDF_CONE_FILL_OPACITY = 0.4;
const PDF_CONE_STROKE_OPACITY = 1;
const PDF_CONE_STROKE_WIDTH = 1.5;

function addCameraWedge(group, { x = 0, y = 0, rotation, radius, fill }) {
  group.add(new Konva.Wedge({
    x,
    y,
    rotation,
    angle: 60,
    radius,
    fill,
    opacity: PDF_CONE_FILL_OPACITY,
    stroke: fill,
    strokeWidth: PDF_CONE_STROKE_WIDTH,
    strokeOpacity: PDF_CONE_STROKE_OPACITY,
    listening: false,
  }));
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new window.Image();
    // Signed Storage URLs are cross-origin — without this, stage.toDataURL()
    // below throws on a tainted canvas.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function addBackgroundImage(group, img) {
  const fit = getBackgroundFitRect(img.width, img.height);
  if (!fit) return;
  group.add(new Konva.Image({
    image: img,
    x: fit.x,
    y: fit.y,
    width: fit.w,
    height: fit.h,
    listening: false,
  }));
}

function addGrid(group, fitScale) {
  for (let i = 0; i < Math.ceil(LOGICAL_W / 40) + 1; i++) {
    group.add(new Konva.Rect({
      x: i * 40,
      y: 0,
      width: 1 / fitScale,
      height: LOGICAL_H,
      fill: 'rgba(100,116,139,0.08)',
      listening: false,
    }));
  }
  for (let i = 0; i < Math.ceil(LOGICAL_H / 40) + 1; i++) {
    group.add(new Konva.Rect({
      x: 0,
      y: i * 40,
      width: LOGICAL_W,
      height: 1 / fitScale,
      fill: 'rgba(100,116,139,0.08)',
      listening: false,
    }));
  }
}

function addZones(group, zones) {
  for (const zone of zones) {
    const pts = (() => {
      if (Array.isArray(zone.points) && zone.points.length >= 3) return zone.points;
      const x = zone.x ?? 80;
      const y = zone.y ?? 80;
      const w = zone.width ?? 160;
      const h = zone.height ?? 100;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    })();
    const color = zone.color || '#3b82f6';
    const opacity = zone.opacity ?? 0.25;
    const flat = pts.flatMap(p => [p.x, p.y]);

    group.add(new Konva.Line({
      points: flat,
      closed: true,
      fill: hexToRgba(color, opacity),
      stroke: color,
      strokeWidth: 1.5,
      dash: [6, 3],
      listening: false,
    }));

    if (zone.name) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      group.add(new Konva.Text({
        x: cx,
        y: cy - 7,
        text: zone.name,
        fontSize: 11,
        fontStyle: 'bold',
        fill: color,
        offsetX: zone.name.length * 3.5,
        listening: false,
      }));
    }
  }
}

function addSignBody(group, device, fill, sz, deviceRot = 0) {
  const signW = sz * 1.6;
  const signH = sz * 0.9;
  const dual = device.sided === 'dual';
  const boldSides = Array.isArray(device.boldSides)
    ? device.boldSides
    : (dual ? [] : ['top']);
  const boldStroke = darkenHex(fill);
  const boldW = Math.max(2, sz * 0.18);
  const edgePoints = {
    top: [-signW / 2, -signH / 2, signW / 2, -signH / 2],
    bottom: [-signW / 2, signH / 2, signW / 2, signH / 2],
    left: [-signW / 2, -signH / 2, -signW / 2, signH / 2],
    right: [signW / 2, -signH / 2, signW / 2, signH / 2],
  };

  group.add(new Konva.Rect({
    x: -signW / 2,
    y: -signH / 2,
    width: signW,
    height: signH,
    cornerRadius: 2,
    fill,
    opacity: 0.9,
    shadowColor: 'black',
    shadowBlur: 4,
    shadowOpacity: 0.3,
    shadowOffset: { x: 0, y: 2 },
    listening: false,
  }));

  boldSides.forEach((side) => {
    if (!edgePoints[side]) return;
    group.add(new Konva.Line({
      points: edgePoints[side],
      stroke: boldStroke,
      strokeWidth: boldW,
      lineCap: 'butt',
      opacity: 0.95,
      listening: false,
    }));
  });

  const label = device.name || DEVICE_LABELS[device.type] || '';
  const usableW = signW * 0.92;
  const maxFont = Math.max(7, signH * 0.55);
  const fitFont = label.length > 0 ? usableW / (label.length * 0.58) : maxFont;
  const fontSize = Math.max(4.5, Math.min(maxFont, fitFont));
  const boxW = signW * 2;
  group.add(new Konva.Text({
    text: label,
    rotation: -deviceRot,
    fontSize,
    fontStyle: 'bold',
    fill: '#fff',
    width: boxW,
    height: signH,
    offsetX: boxW / 2,
    offsetY: signH / 2,
    align: 'center',
    verticalAlign: 'middle',
    listening: false,
  }));
}

function addDeviceLabel(group, device, sz, deviceRot) {
  const label = device.name || DEVICE_LABELS[device.type] || '?';
  const usableW = sz * 0.92;
  const maxFont = Math.max(7, sz * 0.32);
  const fitFont = label.length > 0 ? usableW / (label.length * 0.58) : maxFont;
  const fontSize = Math.max(4.5, Math.min(maxFont, fitFont));
  const boxW = sz * 4;
  group.add(new Konva.Text({
    text: label,
    rotation: -deviceRot,
    fontSize,
    fontStyle: 'bold',
    fill: '#fff',
    width: boxW,
    height: sz,
    offsetX: boxW / 2,
    offsetY: sz / 2,
    align: 'center',
    verticalAlign: 'middle',
    listening: false,
  }));
}

function addDevices(group, devices) {
  for (const device of devices) {
    const fill = device.color || DEVICE_COLORS[device.type] || '#6b7280';
    const isCamera = device.type?.startsWith('cam-');
    const isSign = device.type?.startsWith('sign-');
    const isDualLens = isDualLensCamera(device);
    const coneSize = device.coneSize ?? 40;
    const sz = device.iconSize ?? DEVICE_SIZE;
    const deviceRot = device.rotation || 0;

    const deviceGroup = new Konva.Group({
      x: device.x || 0,
      y: device.y || 0,
      rotation: deviceRot,
      listening: false,
    });

    if (isCamera && isDualLens) {
      const s1Color = device.stream1?.color
        || DEVICE_COLORS[device.stream1?.streamType]
        || fill;
      const s2Color = device.stream2?.color
        || DEVICE_COLORS[device.stream2?.streamType]
        || fill;
      const lensOffset = sz * 0.34;
      const lensRadius = sz * 0.4;
      const localConeRot = (streamKey) =>
        coneWedgeRotation(device[streamKey]?.rotation ?? 0);
      addCameraWedge(deviceGroup, {
        x: 0,
        y: -lensOffset,
        rotation: localConeRot('stream1'),
        radius: device.stream1?.coneSize ?? coneSize,
        fill: s1Color,
      });
      addCameraWedge(deviceGroup, {
        x: 0,
        y: lensOffset,
        rotation: localConeRot('stream2'),
        radius: device.stream2?.coneSize ?? coneSize,
        fill: s2Color,
      });
      deviceGroup.add(new Konva.Circle({
        x: 0,
        y: -lensOffset,
        radius: lensRadius,
        fill: s1Color,
        opacity: 0.95,
        stroke: '#1f2937',
        strokeWidth: 0.75,
        listening: false,
      }));
      deviceGroup.add(new Konva.Circle({
        x: 0,
        y: lensOffset,
        radius: lensRadius,
        fill: s2Color,
        opacity: 0.95,
        stroke: '#1f2937',
        strokeWidth: 0.75,
        listening: false,
      }));
      addDeviceLabel(deviceGroup, device, sz, deviceRot);
    } else if (isCamera) {
      addCameraWedge(deviceGroup, {
        rotation: coneWedgeRotation(device.stream1?.rotation ?? 0),
        radius: coneSize,
        fill,
      });
      deviceGroup.add(new Konva.Circle({
        radius: sz / 2,
        fill,
        opacity: 0.9,
        shadowColor: 'black',
        shadowBlur: 4,
        shadowOpacity: 0.3,
        shadowOffset: { x: 0, y: 2 },
        listening: false,
      }));
      addDeviceLabel(deviceGroup, device, sz, deviceRot);
    } else if (isSign) {
      addSignBody(deviceGroup, device, fill, sz, deviceRot);
    } else {
      deviceGroup.add(new Konva.Circle({
        radius: sz / 2,
        fill,
        opacity: 0.9,
        shadowColor: 'black',
        shadowBlur: 4,
        shadowOpacity: 0.3,
        shadowOffset: { x: 0, y: 2 },
        listening: false,
      }));
      addDeviceLabel(deviceGroup, device, sz, deviceRot);
    }

    group.add(deviceGroup);
  }
}

/**
 * Render a level to a PNG dataURL using an offscreen Konva stage.
 * @param {object} level   - level object with devices, zones, bgImage
 * @param {object} options - { width, height, pixelRatio, cropToBackground }
 * @returns {Promise<{ dataUrl: string, width: number, height: number }|null>}
 */
export async function renderLevelToDataURL(level, {
  width,
  height,
  pixelRatio = 2,
  cropToBackground = false,
} = {}) {
  let stageWidth = width || LOGICAL_W;
  let stageHeight = height || LOGICAL_H;
  if (!stageWidth || !stageHeight) return null;

  let groupX = 0;
  let groupY = 0;
  let groupScale = 1;
  let showGrid = true;

  // bgImage is a Storage object path — resolve it to a signed URL once and reuse
  // it below, rather than re-signing for the crop-sizing pass and the draw pass.
  const bgUrl = level.bgImage ? await getFloorPlanSignedUrl(level.bgImage) : null;

  if (cropToBackground && bgUrl) {
    const img = await loadImage(bgUrl);
    const fitRect = img ? getBackgroundFitRect(img.width, img.height) : null;
    if (fitRect) {
      const padding = 32;
      stageWidth = Math.ceil(fitRect.w + padding * 2);
      stageHeight = Math.ceil(fitRect.h + padding * 2);
      groupX = padding - fitRect.x;
      groupY = padding - fitRect.y;
      showGrid = false;
    }
  } else {
    const fit = getLogicalCanvasFit(stageWidth, stageHeight);
    groupX = fit.fitOffsetX;
    groupY = fit.fitOffsetY;
    groupScale = fit.fitScale;
  }

  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-99999px';
  container.style.top = '-99999px';
  container.style.width = `${stageWidth}px`;
  container.style.height = `${stageHeight}px`;
  document.body.appendChild(container);

  const stage = new Konva.Stage({ container, width: stageWidth, height: stageHeight });
  const layer = new Konva.Layer();
  stage.add(layer);

  try {
    const canvasGroup = new Konva.Group({
      x: groupX,
      y: groupY,
      scaleX: groupScale,
      scaleY: groupScale,
    });

    if (showGrid) addGrid(canvasGroup, groupScale);

    if (bgUrl) {
      const img = await loadImage(bgUrl);
      if (img) addBackgroundImage(canvasGroup, img);
    }

    const zones = Array.isArray(level.zones) ? level.zones : [];
    addZones(canvasGroup, zones);

    const placed = (level.devices || []).filter(d => !d.pendingPlacement);
    addDevices(canvasGroup, placed);

    layer.add(canvasGroup);
    layer.draw();
    return {
      dataUrl: stage.toDataURL({ pixelRatio, mimeType: 'image/png' }),
      width: stageWidth,
      height: stageHeight,
    };
  } catch (e) {
    console.warn('Level render failed:', e);
    return null;
  } finally {
    stage.destroy();
    container.remove();
  }
}
