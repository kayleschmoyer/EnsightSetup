import { customerLocationFields } from './customerUtils';

export const STATE_ABBR_TO_FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11',
  FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21',
  LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30',
  NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49',
  VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
};

export const STATE_FIPS_TO_ABBR = Object.fromEntries(
  Object.entries(STATE_ABBR_TO_FIPS).map(([abbr, fips]) => [fips, abbr]),
);

/** States with tiny geographic area on Albers USA — brighter, larger labels. */
export const COMPACT_STATE_ABBRS = new Set([
  'MD', 'DE', 'NJ', 'RI', 'CT', 'MA', 'NH', 'VT',
]);

/** Label position tweaks relative to projected centroid. */
export const STATE_LABEL_OVERRIDES = {
  NJ: { dx: 0, dy: 0, fontSize: 10 },
  DE: { dx: 0, dy: 0, fontSize: 10 },
  MD: { dx: 0, dy: 1, fontSize: 10 },
  RI: { dx: 0, dy: 0, fontSize: 9 },
  CT: { dx: 0, dy: -4, fontSize: 9 },
  MA: { dx: 4, dy: 0, fontSize: 10 },
  NH: { dx: 0, dy: -4, fontSize: 9 },
  VT: { dx: -4, dy: 0, fontSize: 9 },
};

/** Not a state — hide geographic label on the map. */
export const HIDDEN_MAP_LABEL_ABBRS = new Set(['DC']);

/** Count customers per state abbreviation from the customer list. */
export function customerCountsByState(customers) {
  const counts = {};
  customers.forEach((c) => {
    const abbr = (customerLocationFields(c).state || c.state || '').trim().toUpperCase();
    if (abbr) counts[abbr] = (counts[abbr] || 0) + 1;
  });
  return counts;
}

/** Cluster markers in screen space when zoomed out. */
export function clusterMarkers(markers, viewScale, pixelRadius = 40) {
  if (markers.length === 0) return [];
  const worldRadius = pixelRadius / Math.max(viewScale, 0.5);
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < markers.length; i++) {
    if (used.has(i)) continue;
    const group = [markers[i]];
    used.add(i);

    for (let j = i + 1; j < markers.length; j++) {
      if (used.has(j)) continue;
      const dx = markers[i].x - markers[j].x;
      const dy = markers[i].y - markers[j].y;
      if (Math.sqrt(dx * dx + dy * dy) < worldRadius) {
        group.push(markers[j]);
        used.add(j);
      }
    }

    if (group.length === 1) {
      clusters.push({ type: 'marker', ...group[0] });
    } else {
      const x = group.reduce((s, m) => s + m.x, 0) / group.length;
      const y = group.reduce((s, m) => s + m.y, 0) / group.length;
      const color = group[0].color;
      clusters.push({
        type: 'cluster',
        x,
        y,
        count: group.length,
        markers: group,
        color,
        id: `cluster-${group.map((m) => m.customer.id).join('-')}`,
      });
    }
  }

  return clusters;
}

/** Curved arc path between two points. */
export function arcPath(x1, y1, x2, y2, bulgeFactor = 0.18) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const bulge = dist * bulgeFactor;
  const cx = mx - (dy / dist) * bulge;
  const cy = my + (dx / dist) * bulge;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

/** Pairs of nearby markers for subtle connection arcs. */
export function markerArcs(markers, maxDistance = 180, maxArcs = 16) {
  if (markers.length < 2) return [];
  const arcs = [];

  for (let i = 0; i < markers.length; i++) {
    for (let j = i + 1; j < markers.length; j++) {
      const dx = markers[i].x - markers[j].x;
      const dy = markers[i].y - markers[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= maxDistance) {
        arcs.push({
          id: `${markers[i].customer.id}-${markers[j].customer.id}`,
          d: arcPath(markers[i].x, markers[i].y, markers[j].x, markers[j].y),
          dist,
        });
      }
    }
  }

  arcs.sort((a, b) => a.dist - b.dist);
  return arcs.slice(0, maxArcs);
}

/** Density glow blobs at marker positions. */
export function densityGlows(markers, radius = 55) {
  return markers.map((m) => ({
    id: m.customer?.id ?? m.id,
    x: m.x,
    y: m.y,
    r: radius,
    color: m.color,
  }));
}
