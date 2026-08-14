import { jsPDF } from 'jspdf';
import { renderLevelToDataURL } from './LevelRenderer';
import { LOGICAL_W, LOGICAL_H } from '../lib/canvasConstants';
import { formatTrafficDirectionLabel } from '../lib/trafficFlowUtils';
import { uniqueGarageDevices } from '../lib/deviceCountUtils';

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

const C = {
  SLATE_900: [15, 23, 42],
  SLATE_800: [30, 41, 59],
  SLATE_700: [51, 65, 85],
  SLATE_600: [71, 85, 105],
  SLATE_500: [100, 116, 139],
  SLATE_400: [148, 163, 184],
  SLATE_300: [203, 213, 225],
  SLATE_200: [226, 232, 240],
  SLATE_100: [241, 245, 249],
  SLATE_50: [248, 250, 252],
  WHITE: [255, 255, 255],
  BLUE_600: [37, 99, 235],
  BLUE_50: [239, 246, 255],
  RED_500: [239, 68, 68],
  RED_50: [254, 242, 242],
  GREEN_500: [34, 197, 94],
  GREEN_50: [240, 253, 244],
  AMBER_500: [245, 158, 11],
  AMBER_50: [255, 251, 235],
};

const DEVICE_TYPE_LABELS = {
  'cam-fli': 'FLI Camera',
  'cam-lpr': 'LPR Camera',
  'cam-people': 'People Counter',
  'sign-led': 'LED Sign',
  'sign-static': 'Static Sign',
  'sign-designable': 'Designable Sign',
  'sensor-nwave': 'NWAVE',
  'sensor-parksol': 'Parksol',
  'sensor-proco': 'Proco',
  'sensor-ensight': 'Ensight Vision',
};

const DEVICE_SHORT_LABELS = {
  'cam-fli': 'FLI', 'cam-lpr': 'LPR', 'cam-people': 'PPL',
  'sign-led': 'LED', 'sign-static': 'STC', 'sign-designable': 'DSG',
  'sensor-nwave': 'NW', 'sensor-parksol': 'PS', 'sensor-proco': 'PR',
  'sensor-ensight': 'EV',
};

const DEVICE_COLORS_RGB = {
  'cam-fli': [59, 130, 246],
  'cam-lpr': [139, 92, 246],
  'cam-people': [6, 182, 212],
  'sign-led': [245, 158, 11],
  'sign-static': [234, 179, 8],
  'sign-designable': [249, 115, 22],
  'sensor-nwave': [16, 185, 129],
  'sensor-parksol': [20, 184, 166],
  'sensor-proco': [34, 197, 94],
  'sensor-ensight': [52, 211, 153],
};

const CATEGORY_INFO = {
  cameras: { label: 'Cameras', color: C.BLUE_600, bg: C.BLUE_50, icon: '\u25CF' },
  signs: { label: 'Signs', color: C.AMBER_500, bg: C.AMBER_50, icon: '\u25A0' },
  sensors: { label: 'Sensors', color: C.GREEN_500, bg: C.GREEN_50, icon: '\u25B2' },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────

const sc = (doc, rgb) => doc.setTextColor(...rgb);
const sf = (doc, rgb) => doc.setFillColor(...rgb);
const sd = (doc, rgb) => doc.setDrawColor(...rgb);

function getCategory(type) {
  if (type?.startsWith('cam-')) return 'cameras';
  if (type?.startsWith('sign-')) return 'signs';
  if (type?.startsWith('sensor-')) return 'sensors';
  return 'other';
}

function groupDevicesByCategory(devices) {
  const g = { cameras: [], signs: [], sensors: [] };
  (devices || []).forEach(d => { const cat = getCategory(d.type); if (g[cat]) g[cat].push(d); });
  return g;
}

/**
 * Camera IP for the device table. Imported devices store IP at the top level
 * (stream1 may be an RTSP URL string); editor-created cameras store it on the
 * stream object. Dual-lens cameras show both stream IPs when they differ.
 */
function cameraIpAddress(device) {
  const streamIp = (stream) =>
    (typeof stream === 'object' && stream !== null ? stream.ipAddress : '') || '';
  const ip1 = streamIp(device.stream1) || device.ipAddress || '';
  const ip2 = streamIp(device.stream2);
  if (ip1 && ip2 && ip2 !== ip1) return `${ip1} / ${ip2}`;
  return ip1 || ip2 || '-';
}

function getImageDimensions(dataUrl) {
  return new Promise(resolve => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function drawCone(doc, cx, cy, rotation, radius, colorRgb, opacity) {
  const startAngle = ((rotation || 0) - 30) * Math.PI / 180;
  const endAngle = startAngle + (60 * Math.PI / 180);
  const steps = 20;
  const bg = [248, 250, 252]; // SLATE_50 background blend
  const blended = colorRgb.map((c, i) => Math.round(bg[i] * (1 - opacity) + c * opacity));
  sf(doc, blended);
  for (let i = 0; i < steps; i++) {
    const a1 = startAngle + (endAngle - startAngle) * (i / steps);
    const a2 = startAngle + (endAngle - startAngle) * ((i + 1) / steps);
    doc.triangle(
      cx, cy,
      cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius,
      cx + Math.cos(a2) * radius, cy + Math.sin(a2) * radius,
      'F'
    );
  }
}

function truncate(doc, text, maxW) {
  if (!text) return '-';
  const s = String(text);
  if (doc.getTextWidth(s) <= maxW) return s;
  let t = s;
  while (t.length > 0 && doc.getTextWidth(t + '\u2026') > maxW) t = t.slice(0, -1);
  return t + '\u2026';
}

function rRect(doc, x, y, w, h, r, opts = {}) {
  if (opts.fill) sf(doc, opts.fill);
  if (opts.stroke) sd(doc, opts.stroke);
  doc.roundedRect(x, y, w, h, r, r, opts.fill && opts.stroke ? 'FD' : opts.fill ? 'F' : 'S');
}

function checkPage(doc, y, needed = 60) {
  if (y + needed > PAGE_H - 50) { doc.addPage(); return 55; }
  return y;
}

// ─── PAGE ELEMENTS ─────────────────────────────────────────────────────────────

function drawFooter(doc, page, total, name) {
  const y = PAGE_H - 28;
  sd(doc, C.SLATE_200);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  sc(doc, C.SLATE_400);
  doc.text(name, MARGIN, y + 12);
  doc.text(`Page ${page} of ${total}`, PAGE_W - MARGIN, y + 12, { align: 'right' });
  sc(doc, C.SLATE_300);
  doc.text('Garage Layout Manager', PAGE_W / 2, y + 12, { align: 'center' });
}

function sectionHead(doc, y, title, accent = C.BLUE_600) {
  sf(doc, accent);
  doc.rect(MARGIN, y, 3, 14, 'F');
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  sc(doc, C.SLATE_800);
  doc.text(title, MARGIN + 10, y + 11);
  return y + 22;
}

// ─── COVER PAGE ────────────────────────────────────────────────────────────────

function drawCover(doc, garage, allLevels) {
  const bannerH = 210;
  sf(doc, C.SLATE_900);
  doc.rect(0, 0, PAGE_W, bannerH, 'F');
  sf(doc, C.BLUE_600);
  doc.rect(0, bannerH, PAGE_W, 4, 'F');

  // Label
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(120, 170, 255);
  doc.text('PARKING FACILITY DOCUMENTATION', MARGIN, 55);

  // Garage name
  doc.setFontSize(26);
  doc.setFont('helvetica', 'bold');
  sc(doc, C.WHITE);
  const nameLines = doc.splitTextToSize(garage.name || 'Unnamed Garage', CONTENT_W);
  doc.text(nameLines, MARGIN, 90);

  // Address
  const addr = [garage.address, garage.city, garage.state, garage.zip].filter(Boolean).join(', ');
  if (addr) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    sc(doc, C.SLATE_400);
    doc.text(addr, MARGIN, 90 + nameLines.length * 30 + 10);
  }

  // Date
  doc.setFontSize(9);
  sc(doc, C.SLATE_500);
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  doc.text(`Generated ${dateStr} at ${new Date().toLocaleTimeString()}`, MARGIN, bannerH - 20);

  // ── Summary Cards ──
  let y = bannerH + 28;
  const uniqueDevices = uniqueGarageDevices({ levels: allLevels });
  const totalDevices = uniqueDevices.length;
  const totalSpots = allLevels.reduce((s, l) => s + (l.totalSpots || 0), 0);
  const totalEV = allLevels.reduce((s, l) => s + (l.evSpots || 0), 0);
  const totalADA = allLevels.reduce((s, l) => s + (l.handicapSpots || 0), 0);
  const cardW = (CONTENT_W - 20) / 3;
  const cardH = 65;

  const cards = [
    { label: 'LEVELS', value: String(allLevels.length), sub: `${totalSpots.toLocaleString()} total parking spots` },
    { label: 'DEVICES', value: String(totalDevices), sub: 'installed across all levels' },
    { label: 'PARKING', value: totalSpots.toLocaleString(), sub: `${totalEV} EV  \u2022  ${totalADA} ADA` },
  ];

  cards.forEach((card, i) => {
    const cx = MARGIN + i * (cardW + 10);
    rRect(doc, cx, y, cardW, cardH, 4, { fill: C.WHITE, stroke: C.SLATE_200 });
    sf(doc, C.BLUE_600);
    doc.rect(cx, y, cardW, 3, 'F'); // top accent

    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    sc(doc, C.SLATE_500);
    doc.text(card.label, cx + 12, y + 18);

    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    sc(doc, C.SLATE_900);
    doc.text(card.value, cx + 12, y + 40);

    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    sc(doc, C.SLATE_500);
    doc.text(card.sub, cx + 12, y + 54);
  });

  y += cardH + 25;

  // ── Device Breakdown ──
  y = sectionHead(doc, y, 'DEVICE BREAKDOWN');
  const allDevices = uniqueDevices;
  const groups = groupDevicesByCategory(allDevices);
  const catCardW = (CONTENT_W - 20) / 3;
  const catCardH = 52;

  ['cameras', 'signs', 'sensors'].forEach((cat, i) => {
    const info = CATEGORY_INFO[cat];
    const count = groups[cat].length;
    const cx = MARGIN + i * (catCardW + 10);
    rRect(doc, cx, y, catCardW, catCardH, 4, { fill: C.WHITE, stroke: C.SLATE_200 });
    sf(doc, info.color);
    doc.roundedRect(cx, y, 4, catCardH, 2, 2, 'F');

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    sc(doc, info.color);
    doc.text(`${count}`, cx + 14, y + 18);
    sc(doc, C.SLATE_800);
    doc.text(info.label, cx + 14 + doc.getTextWidth(`${count} `), y + 18);

    // Per-type breakdown
    const typeCounts = {};
    groups[cat].forEach(d => { typeCounts[d.type] = (typeCounts[d.type] || 0) + 1; });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    let lineY = y + 30;
    Object.entries(typeCounts).forEach(([type, cnt]) => {
      const color = DEVICE_COLORS_RGB[type] || C.SLATE_500;
      sf(doc, color);
      doc.circle(cx + 18, lineY - 2.5, 2.5, 'F');
      sc(doc, C.SLATE_700);
      doc.text(`${cnt} ${DEVICE_TYPE_LABELS[type] || type}`, cx + 24, lineY);
      lineY += 10;
    });
  });

  y += catCardH + 25;

  // ── Level Overview Table ──
  y = sectionHead(doc, y, 'LEVEL OVERVIEW');
  const cols = [MARGIN, MARGIN + 130, MARGIN + 200, MARGIN + 260, MARGIN + 320, MARGIN + 380];
  const headers = ['Level Name', 'Devices', 'Spots', 'EV', 'ADA', 'Device Types'];

  sf(doc, C.SLATE_800);
  doc.rect(MARGIN, y, CONTENT_W, 18, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  sc(doc, C.WHITE);
  headers.forEach((h, i) => doc.text(h, cols[i] + 8, y + 12));
  y += 20;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  allLevels.forEach((level, idx) => {
    if (idx % 2 === 0) { sf(doc, C.SLATE_50); doc.rect(MARGIN, y - 2, CONTENT_W, 18, 'F'); }
    sc(doc, C.SLATE_800);
    doc.setFont('helvetica', 'bold');
    doc.text(level.name || '-', cols[0] + 8, y + 10);
    doc.setFont('helvetica', 'normal');
    doc.text(String(level.devices?.length || 0), cols[1] + 8, y + 10);
    doc.text(String(level.totalSpots || 0), cols[2] + 8, y + 10);
    doc.text(String(level.evSpots || 0), cols[3] + 8, y + 10);
    doc.text(String(level.handicapSpots || 0), cols[4] + 8, y + 10);

    // Type dots
    const types = [...new Set((level.devices || []).map(d => d.type))];
    let dx = cols[5] + 8;
    types.forEach(type => {
      sf(doc, DEVICE_COLORS_RGB[type] || C.SLATE_400);
      doc.circle(dx + 3, y + 7, 3.5, 'F');
      doc.setFontSize(5);
      sc(doc, C.WHITE);
      doc.setFont('helvetica', 'bold');
      doc.text(DEVICE_SHORT_LABELS[type] || '?', dx + 3, y + 8.5, { align: 'center' });
      dx += 13;
    });
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    y += 18;
  });
}

// ─── CONTACTS & SERVERS PAGE ───────────────────────────────────────────────────

function drawContactsAndServers(doc, garage) {
  const hasContacts = garage.contacts?.length > 0;
  const hasServers = garage.servers?.length > 0;
  if (!hasContacts && !hasServers) return;

  doc.addPage();
  let y = 45;

  if (hasContacts) {
    y = sectionHead(doc, y, 'KEY CONTACTS & EMERGENCY INFORMATION');
    y += 4;

    const typeStyle = {
      emergency: { color: C.RED_500, bg: C.RED_50, label: 'EMERGENCY' },
      phone: { color: C.BLUE_600, bg: C.BLUE_50, label: 'PRIMARY' },
      email: { color: C.GREEN_500, bg: C.GREEN_50, label: 'EMAIL' },
    };

    const sorted = [...garage.contacts].sort((a, b) => {
      if (a.type === 'emergency') return -1;
      if (b.type === 'emergency') return 1;
      return 0;
    });

    sorted.forEach(contact => {
      y = checkPage(doc, y, 62);
      const style = typeStyle[contact.type] || typeStyle.phone;
      const cardH = 52;

      rRect(doc, MARGIN, y, CONTENT_W, cardH, 4, { fill: style.bg, stroke: C.SLATE_200 });
      sf(doc, style.color);
      doc.roundedRect(MARGIN, y, 4, cardH, 2, 2, 'F');

      // Badge
      doc.setFontSize(6.5);
      doc.setFont('helvetica', 'bold');
      sc(doc, style.color);
      doc.text(style.label, MARGIN + 14, y + 14);

      // Name
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      sc(doc, C.SLATE_800);
      doc.text(contact.name || '-', MARGIN + 14, y + 30);

      // Title
      if (contact.title) {
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        sc(doc, C.SLATE_500);
        doc.text(contact.title, MARGIN + 14, y + 42);
      }

      // Phone & Email on right side
      const rightX = PAGE_W - MARGIN - 12;
      if (contact.phone) {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        sc(doc, C.SLATE_800);
        doc.text(contact.phone, rightX, y + 24, { align: 'right' });
      }
      if (contact.email) {
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        sc(doc, C.BLUE_600);
        doc.text(contact.email, rightX, y + 38, { align: 'right' });
      }

      y += cardH + 8;
    });
  }

  if (hasServers) {
    y += 8;
    y = checkPage(doc, y, 80);
    y = sectionHead(doc, y, 'SERVER INFRASTRUCTURE');
    y += 4;

    // Table header
    sf(doc, C.SLATE_800);
    doc.rect(MARGIN, y, CONTENT_W, 18, 'F');
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    sc(doc, C.WHITE);

    const sCols = [MARGIN + 8, MARGIN + 140, MARGIN + 280, MARGIN + 400];
    ['Server Name', 'IP Address', 'Type', 'Assigned Devices'].forEach((h, i) => doc.text(h, sCols[i], y + 12));
    y += 22;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);

    garage.servers.forEach((srv, idx) => {
      y = checkPage(doc, y, 20);
      if (idx % 2 === 0) { sf(doc, C.SLATE_50); doc.rect(MARGIN, y - 4, CONTENT_W, 18, 'F'); }

      const assignedCount = (garage.levels || []).reduce((sum, l) =>
        sum + (l.devices || []).filter(d => d.serverId === srv.id).length, 0);

      sc(doc, C.SLATE_800);
      doc.setFont('helvetica', 'bold');
      doc.text(srv.name || `Server ${srv.id}`, sCols[0], y + 8);
      doc.setFont('helvetica', 'normal');
      doc.text(srv.ip || '-', sCols[1], y + 8);
      doc.text(srv.type || '-', sCols[2], y + 8);
      doc.text(String(assignedCount), sCols[3], y + 8);
      y += 18;
    });
  }
}

// ─── LEVEL MAP PAGE ────────────────────────────────────────────────────────────

async function drawLevelPages(doc, level, mapRender) {
  const mapImage = typeof mapRender === 'string' ? mapRender : mapRender?.dataUrl;
  const mapImgW = mapRender?.width || LOGICAL_W;
  const mapImgH = mapRender?.height || LOGICAL_H;
  doc.addPage();
  const devices = level.devices || [];
  const placed = devices.filter(d => !d.pendingPlacement);

  // ── Level header bar ──
  sf(doc, C.SLATE_900);
  doc.rect(0, 0, PAGE_W, 48, 'F');
  sf(doc, C.BLUE_600);
  doc.rect(0, 48, PAGE_W, 3, 'F');

  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  sc(doc, C.WHITE);
  doc.text(level.name || 'Unnamed Level', MARGIN, 30);

  // Stats chips
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  const chips = [
    `${level.totalSpots || 0} Spots`,
    `${level.evSpots || 0} EV`,
    `${level.handicapSpots || 0} ADA`,
    `${devices.length} Devices`,
  ];
  sc(doc, C.SLATE_400);
  doc.text(chips.join('   \u2022   '), PAGE_W - MARGIN, 30, { align: 'right' });

  let y = 65;

  // ── Stats row ──
  const statW = (CONTENT_W - 30) / 4;
  const statH = 38;
  const statItems = [
    { label: 'Total Spots', value: String(level.totalSpots || 0), color: C.SLATE_800 },
    { label: 'EV Charging', value: String(level.evSpots || 0), color: C.GREEN_500 },
    { label: 'ADA Accessible', value: String(level.handicapSpots || 0), color: C.BLUE_600 },
    { label: 'Devices', value: String(devices.length), color: C.AMBER_500 },
  ];

  statItems.forEach((item, i) => {
    const sx = MARGIN + i * (statW + 10);
    rRect(doc, sx, y, statW, statH, 3, { fill: C.SLATE_50, stroke: C.SLATE_200 });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    sc(doc, C.SLATE_500);
    doc.text(item.label, sx + 8, y + 13);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    sc(doc, item.color);
    doc.text(item.value, sx + 8, y + 30);
  });

  y += statH + 15;

  // ── Floor Plan Map ──
  y = sectionHead(doc, y, 'FLOOR PLAN');
  const mapBoxW = CONTENT_W;
  const maxMapH = PAGE_H - MARGIN - y - 44;
  const { w: mapDrawW, h: mapDrawH } = fitMapInBox(mapBoxW, maxMapH, mapImgW, mapImgH);
  const mapDrawX = MARGIN + (mapBoxW - mapDrawW) / 2;

  if (mapImage) {
    sf(doc, [245, 246, 248]);
    doc.rect(MARGIN, y, mapBoxW, mapDrawH, 'F');
    try {
      doc.addImage(mapImage, 'PNG', mapDrawX, y, mapDrawW, mapDrawH);
    } catch (e) { /* ignore */ }
    sd(doc, C.SLATE_300);
    doc.setLineWidth(0.5);
    doc.rect(MARGIN, y, mapBoxW, mapDrawH, 'S');
  } else {
    drawMapPlaceholder(doc, y, mapBoxW, mapDrawH);
  }

  y += mapDrawH + 8;

  // ── Legend ──
  const typesUsed = [...new Set(placed.map(d => d.type))];
  if (typesUsed.length > 0) {
    rRect(doc, MARGIN, y, CONTENT_W, 20, 3, { fill: C.SLATE_50, stroke: C.SLATE_200 });
    let lx = MARGIN + 8;
    doc.setFontSize(6);
    doc.setFont('helvetica', 'bold');
    sc(doc, C.SLATE_500);
    doc.text('LEGEND', lx, y + 13);
    lx += 36;

    typesUsed.forEach(type => {
      const color = DEVICE_COLORS_RGB[type] || C.SLATE_500;
      sf(doc, color);
      doc.circle(lx, y + 10, 3.5, 'F');
      doc.setFontSize(4.5);
      sc(doc, C.WHITE);
      doc.text(DEVICE_SHORT_LABELS[type] || '?', lx, y + 11.5, { align: 'center' });
      lx += 7;
      doc.setFontSize(6.5);
      doc.setFont('helvetica', 'normal');
      sc(doc, C.SLATE_700);
      const label = DEVICE_TYPE_LABELS[type] || type;
      doc.text(label, lx, y + 13);
      lx += doc.getTextWidth(label) + 12;
    });
    y += 28;
  }

  // ── Device Inventory ──
  if (devices.length > 0) {
    y += 4;
    y = checkPage(doc, y, 70);
    y = sectionHead(doc, y, 'DEVICE INVENTORY');
    y = drawDeviceTables(doc, devices, y);
  } else {
    y += 10;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    sc(doc, C.SLATE_400);
    doc.text('No devices installed on this level.', MARGIN + 10, y + 10);
  }

  return y;
}

function fitMapInBox(boxW, boxH, imageW, imageH) {
  if (!imageW || !imageH) {
    return { w: boxW, h: boxH };
  }
  const aspect = imageW / imageH;
  let drawW = boxW;
  let drawH = drawW / aspect;
  if (drawH > boxH) {
    drawH = boxH;
    drawW = drawH * aspect;
  }
  return { w: drawW, h: drawH };
}

function drawMapPlaceholder(doc, y, w, h) {
  rRect(doc, MARGIN, y, w, h, 4, { fill: C.SLATE_50, stroke: C.SLATE_200 });
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  sc(doc, C.SLATE_400);
  doc.text('No floor plan image uploaded for this level', PAGE_W / 2, y + h / 2 - 5, { align: 'center' });
  doc.setFontSize(8);
  doc.text('Upload a floor plan in the editor to see it here', PAGE_W / 2, y + h / 2 + 10, { align: 'center' });
}

// ─── DEVICE TABLES ─────────────────────────────────────────────────────────────

function drawDeviceTables(doc, devices, startY) {
  const groups = groupDevicesByCategory(devices);
  let y = startY;

  if (groups.cameras.length > 0) {
    y = checkPage(doc, y, 55);
    y = drawCategoryTable(doc, 'cameras', groups.cameras, y, [
      { label: 'Device Name', w: 120, get: d => d.name },
      { label: 'Type', w: 75, get: d => DEVICE_TYPE_LABELS[d.type] || d.type },
      { label: 'Hardware', w: 60, get: d => d.hardwareType === 'dual-lens' ? 'Dual Lens' : d.hardwareType === 'bullet' ? 'Bullet' : '-' },
      { label: 'IP Address', w: 90, get: d => cameraIpAddress(d) },
      { label: 'Server', w: 70, get: d => d.serverId ? `Server ${d.serverId}` : d.server || '-' },
      { label: 'Traffic', w: 55, get: d => formatTrafficDirectionLabel(d.trafficFlow?.direction) },
      { label: 'Status', w: 45, get: d => d.disabled ? 'Disabled' : (d.pendingPlacement ? 'Unplaced' : 'Placed') },
    ]);
    y += 12;
  }

  if (groups.signs.length > 0) {
    y = checkPage(doc, y, 55);
    y = drawCategoryTable(doc, 'signs', groups.signs, y, [
      { label: 'Device Name', w: 120, get: d => d.name },
      { label: 'Type', w: 90, get: d => DEVICE_TYPE_LABELS[d.type] || d.type },
      { label: 'IP Address', w: 90, get: d => d.ipAddress || '-' },
      { label: 'MAC Address', w: 90, get: d => d.macAddress || '-' },
      { label: 'Server', w: 70, get: d => d.serverId ? `Server ${d.serverId}` : d.server || '-' },
      { label: 'Status', w: 45, get: d => d.disabled ? 'Disabled' : (d.pendingPlacement ? 'Unplaced' : 'Placed') },
    ]);
    y += 12;
  }

  if (groups.sensors.length > 0) {
    y = checkPage(doc, y, 55);
    y = drawCategoryTable(doc, 'sensors', groups.sensors, y, [
      { label: 'Device Name', w: 115, get: d => d.name },
      { label: 'Type', w: 80, get: d => DEVICE_TYPE_LABELS[d.type] || d.type },
      { label: 'Sensor Group', w: 80, get: d => d.sensorGroup || '-' },
      { label: 'Count', w: 45, get: d => String(d.sensorCount || '-') },
      { label: 'API Key', w: 75, get: d => d.apiKey || '-' },
      { label: 'Server', w: 70, get: d => d.serverId ? `Server ${d.serverId}` : d.server || '-' },
      { label: 'Status', w: 45, get: d => d.disabled ? 'Disabled' : (d.pendingPlacement ? 'Unplaced' : 'Placed') },
    ]);
    y += 12;
  }

  return y;
}

function drawCategoryTable(doc, category, devices, startY, columns) {
  const info = CATEGORY_INFO[category];
  let y = startY;

  // Category banner
  rRect(doc, MARGIN, y, CONTENT_W, 20, 3, { fill: info.bg });
  sf(doc, info.color);
  doc.roundedRect(MARGIN, y, 4, 20, 2, 2, 'F');
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  sc(doc, info.color);
  doc.text(`${info.label.toUpperCase()}  \u2014  ${devices.length} device${devices.length !== 1 ? 's' : ''}`, MARGIN + 12, y + 13);
  y += 26;

  // Column headers
  y = drawTableHeader(doc, y, columns);

  // Rows
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);

  devices.forEach((device, idx) => {
    const reasonText = device.disabled
      ? (device.disabledReason || 'No reason provided')
      : (device.pendingPlacement && device.placementReason ? device.placementReason : null);
    const rowH = reasonText ? 24 : 15;

    if (y + rowH + 1 > PAGE_H - 50) {
      doc.addPage();
      y = 50;
      y = drawTableHeader(doc, y, columns);
    }

    // Alternating row bg
    if (idx % 2 === 0) { sf(doc, C.SLATE_50); doc.rect(MARGIN, y - 3, CONTENT_W, rowH, 'F'); }

    // Bottom border
    sd(doc, C.SLATE_200);
    doc.setLineWidth(0.25);
    doc.line(MARGIN, y + rowH - 3, MARGIN + CONTENT_W, y + rowH - 3);

    let rx = MARGIN + 6;
    columns.forEach((col, ci) => {
      const val = col.get(device) || '-';

      if (ci === 0) {
        // Color dot + bold name
        const color = DEVICE_COLORS_RGB[device.type] || C.SLATE_500;
        sf(doc, color);
        doc.circle(rx + 2, y + 5, 2.5, 'F');
        doc.setFont('helvetica', 'bold');
        sc(doc, device.disabled ? C.SLATE_500 : C.SLATE_800);
        doc.text(truncate(doc, val, col.w - 14), rx + 8, y + 8);
        doc.setFont('helvetica', 'normal');
      } else {
        sc(doc, C.SLATE_700);
        // Color status differently
        if (col.label === 'Status') {
          if (val === 'Unplaced') sc(doc, C.AMBER_500);
          else if (val === 'Disabled') sc(doc, C.RED_500);
        }
        doc.text(truncate(doc, val, col.w - 6), rx, y + 8);
      }
      rx += col.w;
    });

    // Reason sub-line (italic, indented)
    if (reasonText) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(6.5);
      sc(doc, device.disabled ? C.RED_500 : C.AMBER_500);
      doc.text(truncate(doc, reasonText, CONTENT_W - 20), MARGIN + 14, y + 18);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
    }

    y += rowH;
  });

  return y;
}

function drawTableHeader(doc, y, columns) {
  sf(doc, C.SLATE_800);
  doc.rect(MARGIN, y, CONTENT_W, 16, 'F');
  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'bold');
  sc(doc, C.WHITE);
  let hx = MARGIN + 6;
  columns.forEach(col => {
    doc.text(col.label, hx, y + 11);
    hx += col.w;
  });
  return y + 18;
}

// ─── CAMERA VIEWS PAGE ─────────────────────────────────────────────────────────

function drawCameraViews(doc, allLevels) {
  const camerasWithViews = allLevels.flatMap(l =>
    (l.devices || [])
      .filter(d => d.type?.startsWith('cam-') && d.viewImage)
      .map(d => ({ ...d, levelName: l.name }))
  );

  if (camerasWithViews.length === 0) return;

  doc.addPage();
  let y = 45;
  y = sectionHead(doc, y, 'CAMERA VIEWS');
  y += 4;

  const thumbW = (CONTENT_W - 15) / 2;
  const thumbH = 140;
  let col = 0;

  camerasWithViews.forEach((cam) => {
    if (col === 0 && y + thumbH + 30 > PAGE_H - 50) {
      doc.addPage();
      y = 50;
    }

    const cx = MARGIN + col * (thumbW + 15);

    // Card
    rRect(doc, cx, y, thumbW, thumbH + 24, 4, { fill: C.WHITE, stroke: C.SLATE_200 });

    // Image
    try {
      doc.addImage(cam.viewImage, 'JPEG', cx + 3, y + 3, thumbW - 6, thumbH - 6);
    } catch { /* skip */ }

    // Caption
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    sc(doc, C.SLATE_800);
    doc.text(truncate(doc, cam.name || '-', thumbW - 12), cx + 6, y + thumbH + 8);

    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    sc(doc, C.SLATE_500);
    doc.text(`${cam.levelName} \u2022 ${DEVICE_TYPE_LABELS[cam.type] || cam.type}`, cx + 6, y + thumbH + 18);

    col++;
    if (col >= 2) {
      col = 0;
      y += thumbH + 32;
    }
  });
}

// ─── MAIN EXPORT ───────────────────────────────────────────────────────────────

export async function generateGaragePDF(garage, currentLevelId, stageRef) {
  if (!garage) return;

  const doc = new jsPDF('portrait', 'pt', 'letter');
  const allLevels = garage.levels || [];

  // ── Cover Page ──
  drawCover(doc, garage, allLevels);

  // ── Contacts & Servers ──
  drawContactsAndServers(doc, garage);

  // ── Level Pages ──
  // Render offscreen with crop-to-background so portrait plans fill the PDF map area.
  for (const level of allLevels) {
    const mapRender = await renderLevelToDataURL(level, {
      width: LOGICAL_W,
      height: LOGICAL_H,
      pixelRatio: 2,
      cropToBackground: true,
    });
    await drawLevelPages(doc, level, mapRender);
  }

  // ── Camera Views ──
  drawCameraViews(doc, allLevels);

  // ── Page Numbers ──
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawFooter(doc, i, totalPages, garage.name || 'Garage');
  }

  const filename = (garage.name || 'Garage').replace(/[^a-zA-Z0-9 _-]/g, '') + ' - Documentation.pdf';
  doc.save(filename);
}
