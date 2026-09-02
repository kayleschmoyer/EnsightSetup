import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Stage, Layer, Rect, Circle, Text, Group, Image as KonvaImage, Transformer, Wedge, Line } from 'react-konva';
import useImage from 'use-image';
import { LOGICAL_W, LOGICAL_H, getLogicalCanvasFit } from '../lib/canvasConstants';
import { coneWedgeRotation, isDualLensCamera } from '../lib/deviceNamingUtils';
import { signMapLabelLines } from '../lib/signInserts';
import { getFloorPlanImageUrl } from '../services/ImageUploadService';

const hexToRgba = (hex, alpha) => {
  const cleaned = (hex || '#3b82f6').replace('#', '');
  const full = cleaned.length === 3
    ? cleaned.split('').map(c => c + c).join('')
    : cleaned;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

// Return a darker shade of the given hex color (factor < 1 darkens).
const darkenHex = (hex, factor = 0.45) => {
  const cleaned = (hex || '#3b82f6').replace('#', '');
  const full = cleaned.length === 3
    ? cleaned.split('').map(c => c + c).join('')
    : cleaned;
  const r = Math.max(0, Math.round(parseInt(full.slice(0, 2), 16) * factor));
  const g = Math.max(0, Math.round(parseInt(full.slice(2, 4), 16) * factor));
  const b = Math.max(0, Math.round(parseInt(full.slice(4, 6), 16) * factor));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

// Pick white or near-black text for best contrast against a hex bg color
const contrastTextColor = (hex) => {
  const cleaned = (hex || '#3b82f6').replace('#', '');
  const full = cleaned.length === 3
    ? cleaned.split('').map(c => c + c).join('')
    : cleaned;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Perceived luminance (sRGB)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#111827' : '#ffffff';
};

const SNAP_DIST = 12;

// ── Fully editable polygon zone ──────────────────────────────────────────────
function ZoneNode({ zone, isSelected, onSelect, onUpdate, allZones = [] }) {
  const lineRef = useRef(null);
  const dragStartPos = useRef(null);
  const dragStartPoints = useRef(null);

  // Ensure points array exists (migrate old rect-based zones on the fly)
  const pts = (() => {
    if (Array.isArray(zone.points) && zone.points.length >= 3) return zone.points;
    const x = zone.x ?? 80, y = zone.y ?? 80;
    const w = zone.width ?? 160, h = zone.height ?? 100;
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  })();

  const color = zone.color || '#3b82f6';
  const opacity = zone.opacity ?? 0.25;
  const flatPoints = pts.flatMap(p => [p.x, p.y]);

  // Centroid for label - use area-weighted polygon centroid so it sits
  // inside irregular shapes instead of being skewed by vertex density.
  const { cx, cy } = (() => {
    let area = 0, x = 0, y = 0;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      const cross = p1.x * p2.y - p2.x * p1.y;
      area += cross;
      x += (p1.x + p2.x) * cross;
      y += (p1.y + p2.y) * cross;
    }
    area /= 2;
    if (Math.abs(area) < 1e-6) {
      // Degenerate – fall back to vertex average
      const ax = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const ay = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      return { cx: ax, cy: ay };
    }
    return { cx: x / (6 * area), cy: y / (6 * area) };
  })();

  const updatePoints = (newPts) => onUpdate(zone.id, { points: newPts });

  // Move a single vertex (with snap-to-zone-vertex)
  const handleVertexDrag = (idx, e) => {
    let x = e.target.x();
    let y = e.target.y();
    for (const other of allZones) {
      if (other.id === zone.id) continue;
      const otherPts = Array.isArray(other.points) ? other.points : [];
      for (const op of otherPts) {
        const dx = op.x - x;
        const dy = op.y - y;
        if (dx * dx + dy * dy < SNAP_DIST * SNAP_DIST) {
          x = op.x;
          y = op.y;
          e.target.x(x);
          e.target.y(y);
          break;
        }
      }
    }
    const newPts = pts.map((p, i) => i === idx ? { x, y } : p);
    updatePoints(newPts);
  };

  // Insert new point at midpoint between idx and idx+1
  const handleMidpointClick = (idx) => {
    const a = pts[idx];
    const b = pts[(idx + 1) % pts.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const newPts = [...pts.slice(0, idx + 1), mid, ...pts.slice(idx + 1)];
    updatePoints(newPts);
  };

  // Delete vertex on double-click (min 3 points)
  const handleVertexDblClick = (idx) => {
    if (pts.length <= 3) return;
    updatePoints(pts.filter((_, i) => i !== idx));
  };

  // Whole-shape drag via the Line itself
  const handleLineDragStart = (e) => {
    dragStartPos.current = { x: e.target.x(), y: e.target.y() };
    dragStartPoints.current = pts.map(p => ({ ...p }));
  };

  const handleLineDragEnd = (e) => {
    const dx = e.target.x();
    const dy = e.target.y();
    e.target.x(0);
    e.target.y(0);
    updatePoints(dragStartPoints.current.map(p => ({ x: p.x + dx, y: p.y + dy })));
  };

  return (
    <>
      {/* Fill + stroke polygon */}
      <Line
        ref={lineRef}
        points={flatPoints}
        closed
        fill={hexToRgba(color, opacity)}
        stroke={color}
        strokeWidth={isSelected ? 2 : 1.5}
        dash={isSelected ? undefined : [6, 3]}
        draggable={isSelected}
        onClick={() => onSelect(zone)}
        onTap={() => onSelect(zone)}
        onDragStart={handleLineDragStart}
        onDragEnd={handleLineDragEnd}
      />

      {/* Label - subtle pill anchored to top of zone */}
      {zone.name && (() => {
        const fontSize = isSelected ? 10 : 9;
        const padX = 5;
        const padY = 2;
        const approxW = zone.name.length * 5.4 + padX * 2;
        const approxH = fontSize + padY * 2;
        return (
          <Group x={cx} y={cy} listening={false} opacity={isSelected ? 0.95 : 0.7}>
            <Rect
              x={-approxW / 2}
              y={-approxH / 2}
              width={approxW}
              height={approxH}
              cornerRadius={3}
              fill={hexToRgba(color, 0.85)}
            />
            <Text
              text={zone.name}
              fontSize={fontSize}
              fontStyle="bold"
              fill={contrastTextColor(color)}
              width={approxW}
              height={approxH}
              offsetX={approxW / 2}
              offsetY={approxH / 2}
              align="center"
              verticalAlign="middle"
            />
          </Group>
        );
      })()}

      {/* Vertex handles + midpoint handles (only when selected) */}
      {isSelected && pts.map((pt, idx) => {
        const next = pts[(idx + 1) % pts.length];
        const mx = (pt.x + next.x) / 2;
        const my = (pt.y + next.y) / 2;
        return (
          <React.Fragment key={idx}>
            {/* Vertex handle */}
            <Circle
              x={pt.x}
              y={pt.y}
              radius={6}
              fill="#fff"
              stroke={color}
              strokeWidth={2}
              draggable
              onDragMove={(e) => handleVertexDrag(idx, e)}
              onDragEnd={(e) => handleVertexDrag(idx, e)}
              onDblClick={() => handleVertexDblClick(idx)}
              onDblTap={() => handleVertexDblClick(idx)}
              hitStrokeWidth={8}
            />
            {/* Midpoint handle – click to insert point */}
            <Circle
              x={mx}
              y={my}
              radius={4}
              fill={color}
              opacity={0.5}
              onClick={() => handleMidpointClick(idx)}
              onTap={() => handleMidpointClick(idx)}
              hitStrokeWidth={8}
            />
          </React.Fragment>
        );
      })}
    </>
  );
}

const DEVICE_SIZE = 10;
const SELECTED_STROKE_WIDTH = 2;

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

/**
 * bgImage is a stored object key, not a renderable src — resolve it to a URL
 * before loading (see ImageUploadService.getImageUrl).
 */
function useFloorPlanImageUrl(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!path) { setUrl(null); return undefined; }
    let cancelled = false;
    getFloorPlanImageUrl(path).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [path]);
  return url;
}

function BackgroundImage({ src, width, height }) {
  const imageUrl = useFloorPlanImageUrl(src);
  const [image] = useImage(imageUrl);
  if (!image) return null;
  // Fit the image inside the logical canvas (letterbox), centered.
  const scale = Math.min(width / image.width, height / image.height);
  return (
    <KonvaImage
      image={image}
      x={(width - image.width * scale) / 2}
      y={(height - image.height * scale) / 2}
      width={image.width * scale}
      height={image.height * scale}
      listening={false}
    />
  );
}


function HoverPulse({ color = '#facc15', baseRadius = 14 }) {
  const innerRef = useRef(null);
  const outerRef = useRef(null);

  useEffect(() => {
    let raf;
    const start = performance.now();
    const tick = (now) => {
      const t = ((now - start) % 1400) / 1400; // 0..1
      const ease = 1 - Math.pow(1 - t, 2);
      if (outerRef.current) {
        outerRef.current.radius(baseRadius + ease * baseRadius * 1.8);
        outerRef.current.opacity(0.85 * (1 - t));
      }
      if (innerRef.current) {
        innerRef.current.radius(baseRadius + ease * baseRadius * 0.9);
        innerRef.current.opacity(0.55 * (1 - t));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [baseRadius]);

  return (
    <>
      <Circle
        ref={outerRef}
        radius={baseRadius}
        stroke={color}
        strokeWidth={3}
        listening={false}
      />
      <Circle
        ref={innerRef}
        radius={baseRadius}
        stroke={color}
        strokeWidth={2}
        listening={false}
      />
    </>
  );
}

function DeviceNode({ device, isSelected, isHovered, isDimmed, onSelect, onDragEnd, color, onNodeRef }) {
  const groupRef = useRef(null);
  useEffect(() => {
    onNodeRef?.(device.id, groupRef.current);
    return () => onNodeRef?.(device.id, null);
  }, [device.id, onNodeRef]);

  const isDisabled = !!device.disabled;
  const baseFill = device.color || color || DEVICE_COLORS[device.type] || '#6b7280';
  const fill = isDisabled ? '#9ca3af' : baseFill;
  const isCamera = device.type?.startsWith('cam-');
  const isSign = device.type?.startsWith('sign-');
  const isDualLens = isDualLensCamera(device);
  const coneSize = device.coneSize ?? 40;
  const sz = device.iconSize ?? DEVICE_SIZE;
  const coneFillOpacity = isDisabled ? 0.1 : (isSelected ? 0.45 : 0.32);
  const coneStrokeOpacity = isDisabled ? 0.35 : (isSelected ? 1 : 0.9);
  const coneStrokeWidth = 1.25;
  const groupOpacity = (isDisabled ? 0.55 : 1) * (isDimmed ? 0.28 : 1);

  // Dual-lens body geometry: two circles arranged side-by-side along the
  // local Y axis. The outer Group's rotation (= device.rotation) rotates
  // them into the perpendicular-to-facing-direction layout, so we do NOT
  // rotate the positions here — doing so would double-rotate after each
  // Transformer commit.
  const lensRadius = sz * 0.4;
  const lensOffset = sz * 0.34; // half the lens-to-lens spacing
  const lens1Pos = { x: 0, y: -lensOffset };
  const lens2Pos = { x: 0, y:  lensOffset };

  // Per-stream cone offset (degrees from device facing). The outer Group
  // rotation orients the device; cone offsets aim each lens independently.
  const deviceRot = device.rotation || 0;
  const streamConeRot = (streamKey) =>
    coneWedgeRotation(device[streamKey]?.rotation ?? 0);

  return (
    <Group
      ref={groupRef}
      name={`device-${device.id}`}
      x={device.x || 0}
      y={device.y || 0}
      // Rotation is controlled by device.rotation. The Transformer will
      // read this as its starting angle, so rotating from a non-zero state
      // works correctly (drags compose with the current angle instead of
      // snapping back to 0). Scale is intentionally NOT a React prop — we
      // imperatively reset it to 1 in handleTransformEnd, and Konva
      // preserves that across re-renders because react-konva only updates
      // props that change. iconSize/coneSize drive the actual visual size.
      rotation={deviceRot}
      opacity={groupOpacity}
      draggable={isSelected}
      onClick={() => onSelect(device)}
      onTap={() => onSelect(device)}
      onDragEnd={(e) => {
        onDragEnd(device.id, {
          x: e.target.x(),
          y: e.target.y(),
        });
      }}
    >
      {/* Camera cones - dual lens. Each stream's cone is colored by its own
          streamType (FLI/LPR/People) so mixed-type dual lenses are visually
          distinct. An explicit stream.color override still wins. */}
      {isCamera && isDualLens && (() => {
        const s1Color = device.stream1?.color
          || DEVICE_COLORS[device.stream1?.streamType]
          || fill;
        const s2Color = device.stream2?.color
          || DEVICE_COLORS[device.stream2?.streamType]
          || fill;
        return (
          <>
            {/* Cone apex anchored on lens 1's position so the cone visually
                grows out of that lens (like a real dual-lens camera). */}
            <Wedge
              x={lens1Pos.x}
              y={lens1Pos.y}
              rotation={streamConeRot('stream1')}
              angle={60}
              radius={device.stream1?.coneSize ?? coneSize}
              fill={s1Color}
              opacity={coneFillOpacity}
              stroke={s1Color}
              strokeWidth={coneStrokeWidth}
              strokeOpacity={coneStrokeOpacity}
              listening={false}
            />
            <Wedge
              x={lens2Pos.x}
              y={lens2Pos.y}
              rotation={streamConeRot('stream2')}
              angle={60}
              radius={device.stream2?.coneSize ?? coneSize}
              fill={s2Color}
              opacity={coneFillOpacity}
              stroke={s2Color}
              strokeWidth={coneStrokeWidth}
              strokeOpacity={coneStrokeOpacity}
              listening={false}
            />
          </>
        );
      })()}

      {/* Camera cone - single lens. Local rotation only — outer Group
          rotation orients it to device.rotation in world space. */}
      {isCamera && !isDualLens && (
        <Wedge
          rotation={streamConeRot('stream1')}
          angle={60}
          radius={coneSize}
          fill={fill}
          opacity={coneFillOpacity}
          stroke={fill}
          strokeWidth={coneStrokeWidth}
          strokeOpacity={coneStrokeOpacity}
          listening={false}
        />
      )}

      {/* Sign body + bold-edge marker(s) + label. The outer Group's
          rotation handles device.rotation, so this inner Group does NOT
          rotate — children draw in unrotated local coords. */}
      {isSign && (() => {
        const labelLines = signMapLabelLines(device);
        const lineCount = Math.max(1, labelLines.length);
        const longest = labelLines.reduce((m, line) => Math.max(m, line.length), 0);
        // Stack controller + each insert top-to-bottom; grow the plaque with line count.
        const signW = sz * (lineCount > 1 ? Math.min(3.2, Math.max(1.8, 1.2 + longest * 0.08)) : 1.6);
        const signH = sz * (lineCount > 1 ? Math.min(4.2, 0.55 + lineCount * 0.42) : 0.9);
        const dual = device.sided === 'dual';
        // Sides marked as the display face. Falls back to the
        // legacy behavior when no explicit selection has been made:
        //   single-sided => top edge bold; dual-sided => no bold edge.
        const boldSides = Array.isArray(device.boldSides)
          ? device.boldSides
          : (dual ? [] : ['top']);
        const boldStroke = darkenHex(fill);
        const boldW = Math.max(2, sz * 0.18);
        const edgePoints = {
          top:    [-signW / 2, -signH / 2,  signW / 2, -signH / 2],
          bottom: [-signW / 2,  signH / 2,  signW / 2,  signH / 2],
          left:   [-signW / 2, -signH / 2, -signW / 2,  signH / 2],
          right:  [ signW / 2, -signH / 2,  signW / 2,  signH / 2],
        };
        // Enlarged invisible hit pad so the sign is easy to click/drag even
        // at small icon sizes. Padding scales with size but has a minimum
        // so tiny signs still have a comfortable hit target.
        const hitPad = Math.max(6, sz * 0.6);
        return (
          // Group is listening (default) so the body + hit-pad receive
          // clicks. Individual decoration shapes opt out via listening={false}.
          <Group>
            {/* Invisible enlarged hit area (fill is needed so Konva registers
                hits; opacity 0 keeps it invisible). */}
            <Rect
              x={-(signW / 2 + hitPad)}
              y={-(signH / 2 + hitPad)}
              width={signW + hitPad * 2}
              height={signH + hitPad * 2}
              fill="#000"
              opacity={0}
            />
            {/* Selection ring (rotated to match rectangle) */}
            {isSelected && (
              <Rect
                x={-(signW / 2 + 4)}
                y={-(signH / 2 + 4)}
                width={signW + 8}
                height={signH + 8}
                cornerRadius={2}
                stroke="#348fe2"
                strokeWidth={SELECTED_STROKE_WIDTH}
                dash={[4, 2]}
                fill="transparent"
                listening={false}
              />
            )}
            {/* Sign body (rectangle) */}
            <Rect
              x={-signW / 2}
              y={-signH / 2}
              width={signW}
              height={signH}
              cornerRadius={2}
              fill={fill}
              opacity={0.9}
              shadowColor="black"
              shadowBlur={isSelected ? 8 : 4}
              shadowOpacity={0.3}
              shadowOffset={{ x: 0, y: 2 }}
            />

            {/* Bold edge(s) marking display side(s), drawn in a darker
                shade of the device color. Each line is the exact length of
                its rectangle edge (butt cap, no rounded overhang). */}
            {boldSides.map(side => edgePoints[side] && (
              <Line
                key={side}
                points={edgePoints[side]}
                stroke={boldStroke}
                strokeWidth={boldW}
                lineCap="butt"
                opacity={isDisabled ? 0.4 : 0.95}
              />
            ))}

            {/* Label = controller + each insert stacked top-to-bottom.
                Counter-rotated so text stays upright. */}
            {(() => {
              const label = labelLines.join('\n');
              const usableW = signW * 0.92;
              const usableH = signH * 0.9;
              const maxByHeight = usableH / (lineCount * 1.2);
              const maxByWidth = longest > 0 ? usableW / (longest * 0.55) : maxByHeight;
              const fontSize = Math.max(4.5, Math.min(9, maxByHeight, maxByWidth));
              const boxW = signW * 1.05;
              return (
                <Text
                  text={label}
                  rotation={-deviceRot}
                  fontSize={fontSize}
                  fontStyle="bold"
                  fill="#fff"
                  width={boxW}
                  height={signH}
                  offsetX={boxW / 2}
                  offsetY={signH / 2}
                  align="center"
                  verticalAlign="middle"
                  lineHeight={1.2}
                  wrap="none"
                  ellipsis={false}
                  listening={false}
                />
              );
            })()}
          </Group>
        );
      })()}

      {/* Selection ring (sized to clear both lenses for dual-lens) */}
      {isSelected && !isSign && (
        <Circle
          radius={(isCamera && isDualLens ? lensOffset + lensRadius : sz / 2) + 4}
          stroke="#348fe2"
          strokeWidth={SELECTED_STROKE_WIDTH}
          dash={[4, 2]}
          fill="transparent"
        />
      )}

      {/* Hover pulse (from sidebar hover) */}
      {isHovered && <HoverPulse color="#facc15" baseRadius={sz / 2 + 6} />}

      {/* Device body (non-sign, single-lens). Dual-lens cameras get their
          own two-circle body below so they're easy to distinguish on the map. */}
      {!isSign && !(isCamera && isDualLens) && (
        <Circle
          radius={sz / 2}
          fill={fill}
          opacity={0.9}
          shadowColor="black"
          shadowBlur={isSelected ? 8 : 4}
          shadowOpacity={0.3}
          shadowOffset={{ x: 0, y: 2 }}
        />
      )}

      {/* Dual-lens camera body: two lens circles arranged perpendicular to
          the device's facing direction. Each circle is tinted with its own
          stream's color so the lens you see on the map matches the cone it
          emits. */}
      {isCamera && isDualLens && (() => {
        const s1Color = device.stream1?.color
          || DEVICE_COLORS[device.stream1?.streamType]
          || fill;
        const s2Color = device.stream2?.color
          || DEVICE_COLORS[device.stream2?.streamType]
          || fill;
        return (
          <>
            <Circle
              x={lens1Pos.x}
              y={lens1Pos.y}
              radius={lensRadius}
              fill={s1Color}
              opacity={0.95}
              stroke="#1f2937"
              strokeWidth={0.75}
              shadowColor="black"
              shadowBlur={isSelected ? 6 : 3}
              shadowOpacity={0.3}
              shadowOffset={{ x: 0, y: 1 }}
            />
            <Circle
              x={lens2Pos.x}
              y={lens2Pos.y}
              radius={lensRadius}
              fill={s2Color}
              opacity={0.95}
              stroke="#1f2937"
              strokeWidth={0.75}
              shadowColor="black"
              shadowBlur={isSelected ? 6 : 3}
              shadowOpacity={0.3}
              shadowOffset={{ x: 0, y: 1 }}
            />
          </>
        );
      })()}

      {/* Label = device name (e.g. 1.1F) inside the circle. The outer
          Group is rotated by device.rotation, so we counter-rotate the
          label here to keep it readable (horizontal) regardless of which
          way the camera faces. Signs render their own label inside the
          sign group (which IS allowed to rotate with the rectangle). */}
      {!isSign && (() => {
        const label = device.name || '';
        const usableW = sz * 0.92;
        const maxFont = Math.max(7, sz * 0.32);
        // Bold glyph width ≈ 0.58 * fontSize.
        const fitFont = label.length > 0 ? usableW / (label.length * 0.58) : maxFont;
        const fontSize = Math.max(4.5, Math.min(maxFont, fitFont));
        const boxW = sz * 4;
        return (
          <Text
            text={label}
            rotation={-deviceRot}
            fontSize={fontSize}
            fontStyle="bold"
            fill="#fff"
            width={boxW}
            height={sz}
            offsetX={boxW / 2}
            offsetY={sz / 2}
            align="center"
            verticalAlign="middle"
            wrap="none"
            ellipsis={false}
            listening={false}
          />
        );
      })()}

      {/* Hover popup label — also counter-rotated so it stays upright. */}
      {isHovered && (() => {
        const hoverLines = isSign ? signMapLabelLines(device) : [device.name || ''];
        const hoverText = hoverLines.join('\n');
        const lineCount = Math.max(1, hoverLines.length);
        const longest = hoverLines.reduce((m, line) => Math.max(m, line.length), 0);
        const boxW = Math.max(100, Math.min(220, 24 + longest * 7));
        const boxH = Math.max(20, 8 + lineCount * 14);
        return (
          <Group y={-(sz / 2 + boxH + 10)} rotation={-deviceRot} listening={false}>
            <Rect
              x={-boxW / 2}
              width={boxW}
              height={boxH}
              cornerRadius={4}
              fill="#1f2937"
              stroke="#facc15"
              strokeWidth={1.5}
              shadowColor="black"
              shadowBlur={6}
              shadowOpacity={0.5}
            />
            <Text
              text={hoverText}
              fontSize={11}
              fontStyle="bold"
              fill="#facc15"
              width={boxW}
              height={boxH}
              offsetX={boxW / 2}
              align="center"
              verticalAlign="middle"
              lineHeight={1.2}
            />
            {/* Tail */}
            <Line
              points={[-5, boxH, 0, boxH + 6, 5, boxH]}
              closed
              fill="#1f2937"
              stroke="#facc15"
              strokeWidth={1.5}
            />
          </Group>
        );
      })()}
    </Group>
  );
}

function deviceMatchesFilter(device, filterType) {
  if (!filterType || filterType === 'all') return true;
  if (filterType === 'cameras') return device.type?.startsWith('cam-');
  if (filterType === 'signs') return device.type?.startsWith('sign-');
  if (filterType === 'sensors') return device.type?.startsWith('sensor-');
  return true;
}

export default function MapCanvas({
  devices = [],
  zones = [],
  bgImage,
  selectedDevice,
  selectedZone,
  onSelectDevice,
  onSelectZone,
  onUpdateDevice,
  onUpdateZone,
  deviceColors,
  stageRef,
  hoveredDeviceId,
  /** When set, next canvas click places this device (logical coords). */
  placingDeviceId = null,
  onPlaceAt = null,
  /** Sidebar type filter — dims non-matching devices instead of hiding them. */
  filterType = 'all',
  /** Pan/zoom the view to frame this device id when it changes. */
  focusDeviceId = null,
  bgLoading = false,
}) {
  const containerRef = useRef(null);
  const internalStageRef = useRef(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  // Pan & zoom (applied on top of letterbox fit). zoom=1 means "fit".
  const [zoom, setZoom] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const isPlaceMode = Boolean(placingDeviceId && onPlaceAt);

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setStageSize({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 6;

  const handleDragEnd = useCallback((deviceId, pos) => {
    onUpdateDevice(deviceId, pos);
  }, [onUpdateDevice]);

  // ── Direct-manipulation Transformer (resize + rotate selected device) ──
  const transformerRef = useRef(null);
  const deviceNodeRefs = useRef(new Map());
  const registerDeviceNode = useCallback((id, node) => {
    if (node) deviceNodeRefs.current.set(id, node);
    else deviceNodeRefs.current.delete(id);
  }, []);

  // Attach the Transformer to the currently selected device's Group node.
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    if (selectedDevice) {
      const node = deviceNodeRefs.current.get(selectedDevice.id);
      if (node) {
        tr.nodes([node]);
        tr.getLayer()?.batchDraw();
        return;
      }
    }
    tr.nodes([]);
    tr.getLayer()?.batchDraw();
  }, [selectedDevice, devices]);

  const handleTransformEnd = useCallback(() => {
    if (!selectedDevice) return;
    const node = deviceNodeRefs.current.get(selectedDevice.id);
    if (!node) return;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const s = (Math.abs(scaleX) + Math.abs(scaleY)) / 2;
    const prevIcon = selectedDevice.iconSize ?? DEVICE_SIZE;
    // Resize affects icon size only — FOV cone stays via inspector controls.
    const newIcon = Math.round(Math.min(300, Math.max(10, prevIcon * s)));
    let rot = node.rotation() % 360;
    if (rot < 0) rot += 360;
    // Reset scale imperatively. Scale is NOT a React prop, so this value
    // persists across re-renders (react-konva only writes props that
    // changed). Rotation IS controlled, so React will reapply the new
    // device.rotation value automatically — no imperative reset needed.
    node.scaleX(1);
    node.scaleY(1);
    onUpdateDevice(selectedDevice.id, {
      iconSize: newIcon,
      rotation: Math.round(rot),
    });
  }, [selectedDevice, onUpdateDevice]);

  const { fitScale, fitOffsetX, fitOffsetY } = getLogicalCanvasFit(
    stageSize.width,
    stageSize.height
  );

  const pointerToLogical = useCallback((pointer) => {
    if (!pointer) return null;
    const worldX = (pointer.x - stagePos.x) / zoom;
    const worldY = (pointer.y - stagePos.y) / zoom;
    const x = Math.round(Math.min(LOGICAL_W, Math.max(0, (worldX - fitOffsetX) / fitScale)));
    const y = Math.round(Math.min(LOGICAL_H, Math.max(0, (worldY - fitOffsetY) / fitScale)));
    return { x, y };
  }, [stagePos, zoom, fitOffsetX, fitOffsetY, fitScale]);

  const handleStageClick = useCallback((e) => {
    const stage = e.target.getStage();
    if (isPlaceMode && stage) {
      const logical = pointerToLogical(stage.getPointerPosition());
      if (logical) {
        onPlaceAt(placingDeviceId, logical);
        return;
      }
    }
    if (e.target === e.target.getStage()) {
      onSelectDevice(null);
      onSelectZone?.(null);
    }
  }, [isPlaceMode, placingDeviceId, onPlaceAt, pointerToLogical, onSelectDevice, onSelectZone]);

  // Space = temporary pan mode (avoids fighting device drag).
  useEffect(() => {
    const isTypingTarget = (el) => {
      if (!el || el === document.body) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    const onKeyDown = (e) => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      setSpaceHeld(true);
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Frame a device when focusDeviceId changes (sidebar select / place).
  useEffect(() => {
    if (focusDeviceId == null) return;
    const device = devices.find((d) => d.id === focusDeviceId);
    if (!device || device.pendingPlacement) return;
    const dx = Number(device.x) || 0;
    const dy = Number(device.y) || 0;
    const targetZoom = Math.max(1.2, Math.min(MAX_ZOOM, zoom < 1 ? 1.4 : zoom));
    const screenX = fitOffsetX * targetZoom + dx * fitScale * targetZoom;
    const screenY = fitOffsetY * targetZoom + dy * fitScale * targetZoom;
    setZoom(targetZoom);
    setStagePos({
      x: stageSize.width / 2 - screenX,
      y: stageSize.height / 2 - screenY,
    });
  // Only re-run when the focused device id changes, not on every pan/zoom.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [focusDeviceId]);

  // Wheel zoom, anchored at the pointer position
  const handleWheel = useCallback((e) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    if (!stage) return;
    const oldScale = zoom;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    // Convert pointer to world-space (account for current stage pos+scale)
    const worldX = (pointer.x - stagePos.x) / oldScale;
    const worldY = (pointer.y - stagePos.y) / oldScale;
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const factor = 1.1;
    let newScale = direction > 0 ? oldScale * factor : oldScale / factor;
    newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newScale));
    setZoom(newScale);
    setStagePos({
      x: pointer.x - worldX * newScale,
      y: pointer.y - worldY * newScale,
    });
  }, [zoom, stagePos]);

  const handleStageDragEnd = useCallback((e) => {
    // Only update if the event target is the Stage itself (not a child like a device)
    if (e.target === e.target.getStage()) {
      setStagePos({ x: e.target.x(), y: e.target.y() });
    }
    setIsPanning(false);
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setStagePos({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor) => {
    const oldScale = zoom;
    let newScale = oldScale * factor;
    newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newScale));
    // Zoom around stage center
    const cx = stageSize.width / 2;
    const cy = stageSize.height / 2;
    const worldX = (cx - stagePos.x) / oldScale;
    const worldY = (cy - stagePos.y) / oldScale;
    setZoom(newScale);
    setStagePos({
      x: cx - worldX * newScale,
      y: cy - worldY * newScale,
    });
  }, [zoom, stagePos, stageSize]);

  // Fit metrics already computed above for place-mode / focus math.
  // Devices only drag when selected, so the stage can pan freely otherwise.
  const canPan = !isPlaceMode;
  const cursor = isPlaceMode
    ? 'crosshair'
    : (isPanning || spaceHeld ? 'grabbing' : 'grab');

  return (
    <div ref={containerRef} className="w-full h-full relative" style={{ cursor }}>
      {isPlaceMode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-md border border-primary/40 bg-card/95 text-xs text-foreground shadow-md pointer-events-none">
          Click the map to place the device · Esc to cancel
        </div>
      )}
      {bgLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/50 pointer-events-none">
          <span className="text-xs text-muted-foreground bg-card border border-border rounded-md px-3 py-2 shadow">
            Loading floor plan…
          </span>
        </div>
      )}
      {!bgImage && devices.length === 0 && !isPlaceMode && !bgLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none px-6">
          <div className="text-center max-w-xs">
            <p className="text-sm font-medium text-foreground">Empty layout</p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Upload a floor plan background, then add devices and click the map to place them.
            </p>
          </div>
        </div>
      )}
      <Stage
        ref={(node) => {
          internalStageRef.current = node;
          if (stageRef) stageRef.current = node;
        }}
        width={stageSize.width}
        height={stageSize.height}
        x={stagePos.x}
        y={stagePos.y}
        scaleX={zoom}
        scaleY={zoom}
        draggable={canPan}
        onWheel={handleWheel}
        onDragStart={(e) => { if (e.target === e.target.getStage()) setIsPanning(true); }}
        onDragEnd={handleStageDragEnd}
        onClick={handleStageClick}
        onTap={handleStageClick}
      >
        <Layer>
          {/* Logical canvas group: bg + grid + zones + devices share one coord space */}
          <Group
            x={fitOffsetX}
            y={fitOffsetY}
            scaleX={fitScale}
            scaleY={fitScale}
          >
            {/* Logical canvas bounds (subtle outline so it's visible) */}
            <Rect
              x={0}
              y={0}
              width={LOGICAL_W}
              height={LOGICAL_H}
              fill="rgba(255,255,255,0.015)"
              stroke="rgba(100,116,139,0.25)"
              strokeWidth={1 / fitScale}
              listening={false}
            />

            {/* Grid pattern (inside logical space so it pans/zooms with content) */}
            {Array.from({ length: Math.ceil(LOGICAL_W / 40) + 1 }).map((_, i) => (
              <Rect
                key={`gv-${i}`}
                x={i * 40}
                y={0}
                width={1 / fitScale}
                height={LOGICAL_H}
                fill="rgba(100,116,139,0.08)"
                listening={false}
              />
            ))}
            {Array.from({ length: Math.ceil(LOGICAL_H / 40) + 1 }).map((_, i) => (
              <Rect
                key={`gh-${i}`}
                x={0}
                y={i * 40}
                width={LOGICAL_W}
                height={1 / fitScale}
                fill="rgba(100,116,139,0.08)"
                listening={false}
              />
            ))}

            {/* Background image (fits inside the logical canvas) */}
            {bgImage && (
              <BackgroundImage src={bgImage} width={LOGICAL_W} height={LOGICAL_H} />
            )}

            {/* Zones (below devices) */}
            {zones.map(zone => (
              <ZoneNode
                key={zone.id}
                zone={zone}
                isSelected={selectedZone?.id === zone.id}
                onSelect={(z) => { onSelectZone?.(z); onSelectDevice(null); }}
                onUpdate={onUpdateZone}
                allZones={zones}
              />
            ))}

            {/* Devices */}
            {devices.map(device => (
              <DeviceNode
                key={device.id}
                device={device}
                isSelected={selectedDevice?.id === device.id}
                isHovered={hoveredDeviceId === device.id}
                isDimmed={!deviceMatchesFilter(device, filterType)}
                onSelect={onSelectDevice}
                onDragEnd={handleDragEnd}
                color={deviceColors?.[device.type]}
                onNodeRef={registerDeviceNode}
              />
            ))}

            {/* Direct-manipulation handles for the selected device */}
            <Transformer
              ref={transformerRef}
              rotateEnabled
              resizeEnabled
              keepRatio
              ignoreStroke
              anchorSize={12}
              anchorCornerRadius={2}
              borderStroke="#348fe2"
              borderStrokeWidth={1}
              anchorStroke="#348fe2"
              anchorFill="#ffffff"
              rotateAnchorOffset={20}
              enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
              onTransformEnd={handleTransformEnd}
              boundBoxFunc={(oldBox, newBox) => {
                // Prevent zero/negative sizing.
                if (newBox.width < 6 || newBox.height < 6) return oldBox;
                return newBox;
              }}
            />
          </Group>
        </Layer>
      </Stage>

      {/* Zoom / pan controls overlay */}
      <div
        className="absolute bottom-3 right-3 flex flex-col gap-1 bg-card/95 backdrop-blur-sm border border-border rounded-md shadow-lg p-1 z-10"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoomBy(1.2)}
          title="Zoom in"
          aria-label="Zoom in"
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-muted text-foreground text-base leading-none"
        >+
        </button>
        <div
          className="text-[9px] text-muted-foreground text-center font-mono select-none"
          title="Relative to fit view (1× = fit)"
        >
          {Math.abs(zoom - 1) < 0.02 ? 'Fit' : `${zoom.toFixed(1)}×`}
        </div>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.2)}
          title="Zoom out"
          aria-label="Zoom out"
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-muted text-foreground text-base leading-none"
        >−
        </button>
        <button
          type="button"
          onClick={resetView}
          title="Fit to view"
          aria-label="Fit to view"
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-muted text-foreground text-[10px] font-semibold"
        >Fit
        </button>
      </div>
      {!isPlaceMode && (
        <div className="absolute bottom-3 left-3 z-10 text-[10px] text-muted-foreground bg-card/90 border border-border rounded px-2 py-1 pointer-events-none">
          Drag empty canvas to pan · scroll to zoom · select a device to move it
        </div>
      )}
    </div>
  );
}
