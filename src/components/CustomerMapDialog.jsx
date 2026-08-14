import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { geoAlbersUsa, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import usStatesTopology from 'us-atlas/states-10m.json';
import { geocodeCustomersForMap } from '../lib/geocode';
import { customerLocationFields } from '../lib/customerUtils';
import {
  STATE_ABBR_TO_FIPS,
  STATE_FIPS_TO_ABBR,
  COMPACT_STATE_ABBRS,
  STATE_LABEL_OVERRIDES,
  HIDDEN_MAP_LABEL_ABBRS,
  customerCountsByState,
  clusterMarkers,
  markerArcs,
  densityGlows,
} from '../lib/customerMapUtils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from './ui/dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from './ui/select';
import {
  Loader2, MapPin, Minus, Plus, Maximize2, Sparkles, Filter,
} from 'lucide-react';

const MAP_WIDTH = 960;
const MAP_HEIGHT = 560;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 24;
const ACCOUNT_FOCUS_SCALE = 6;
const USA_FIT_PADDING = 24;
const STATE_FIT_PADDING = 48;
const CLUSTER_ZOOM_THRESHOLD = 4.5;
const HOVER_LEAVE_MS = 150;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pointerToSvg(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * MAP_WIDTH,
    y: ((clientY - rect.top) / rect.height) * MAP_HEIGHT,
  };
}

function wheelZoomFactor(e) {
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 16;
  else if (e.deltaMode === 2) delta *= window.innerHeight;
  if (Math.abs(delta) < 4) return e.deltaY > 0 ? 1 / 1.2 : 1.2;
  return Math.exp(-delta * 0.0025);
}

function fitBounds(bounds, padding = USA_FIT_PADDING) {
  const [[x0, y0], [x1, y1]] = bounds;
  const dx = Math.max(x1 - x0, 1);
  const dy = Math.max(y1 - y0, 1);
  const scale = clamp(
    Math.min((MAP_WIDTH - padding * 2) / dx, (MAP_HEIGHT - padding * 2) / dy),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  return {
    scale,
    x: (MAP_WIDTH - scale * (x0 + x1)) / 2,
    y: (MAP_HEIGHT - scale * (y0 + y1)) / 2,
  };
}

function customerStateAbbr(customer) {
  return (customerLocationFields(customer).state || '').trim().toUpperCase();
}

function useMapViewport(usaFitView) {
  const fitRef = useRef(usaFitView);
  fitRef.current = usaFitView;
  const [view, setView] = useState(usaFitView);
  const viewRef = useRef(view);
  viewRef.current = view;

  const resetView = useCallback(() => setView(fitRef.current), []);

  const zoomBy = useCallback((factor, anchorX = MAP_WIDTH / 2, anchorY = MAP_HEIGHT / 2) => {
    setView((prev) => {
      const worldX = (anchorX - prev.x) / prev.scale;
      const worldY = (anchorY - prev.y) / prev.scale;
      const nextScale = clamp(prev.scale * factor, MIN_ZOOM, MAX_ZOOM);
      return {
        scale: nextScale,
        x: anchorX - worldX * nextScale,
        y: anchorY - worldY * nextScale,
      };
    });
  }, []);

  const flyTo = useCallback((worldX, worldY, targetScale = ACCOUNT_FOCUS_SCALE) => {
    const scale = clamp(targetScale, MIN_ZOOM, MAX_ZOOM);
    setView({
      scale,
      x: MAP_WIDTH / 2 - worldX * scale,
      y: MAP_HEIGHT / 2 - worldY * scale,
    });
  }, []);

  const fitToBounds = useCallback((bounds) => {
    setView(fitBounds(bounds));
  }, []);

  return {
    view, viewRef, setView, resetView, zoomBy, flyTo, fitToBounds,
  };
}

export default function CustomerMapDialog({ open, onOpenChange, customers }) {
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [hoveredStateFips, setHoveredStateFips] = useState(null);
  const hoverLeaveTimerRef = useRef(null);

  const handleStateHoverEnter = useCallback((stateId) => {
    if (hoverLeaveTimerRef.current) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    setHoveredStateFips(stateId);
  }, []);

  const handleStateHoverLeave = useCallback(() => {
    hoverLeaveTimerRef.current = setTimeout(() => {
      setHoveredStateFips(null);
      hoverLeaveTimerRef.current = null;
    }, HOVER_LEAVE_MS);
  }, []);

  useEffect(() => () => {
    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
  }, []);
  const [stateFilter, setStateFilter] = useState('ALL');
  const [isPanning, setIsPanning] = useState(false);
  const [countyPaths, setCountyPaths] = useState([]);
  const mapContainerRef = useRef(null);
  const svgRef = useRef(null);
  const panStartRef = useRef(null);

  const projection = useMemo(
    () => geoAlbersUsa().scale(1280).translate([MAP_WIDTH / 2, MAP_HEIGHT / 2]),
    [],
  );

  const pathGenerator = useMemo(() => geoPath(projection), [projection]);

  const usaFitView = useMemo(() => {
    try {
      const states = feature(usStatesTopology, usStatesTopology.objects.states);
      return fitBounds(pathGenerator.bounds(states), USA_FIT_PADDING);
    } catch {
      return { x: 0, y: 0, scale: 0.88 };
    }
  }, [pathGenerator]);

  const {
    view, viewRef, setView, resetView, zoomBy, flyTo, fitToBounds,
  } = useMapViewport(usaFitView);
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;

  const locationQueryKey = useMemo(
    () => customers.map((c) => {
      const loc = customerLocationFields(c);
      return `${c.id}:${[loc.address, loc.city, loc.state, loc.zip].join('|')}`;
    }).join(';'),
    [customers],
  );

  const { data: locationData, isLoading: loadingLocations } = useQuery({
    queryKey: ['customer-map-locations', locationQueryKey],
    queryFn: ({ signal }) => geocodeCustomersForMap(customers, signal),
    enabled: open && customers.length > 0,
    staleTime: 30 * 60 * 1000,
  });

  const plotted = useMemo(() => locationData?.plotted ?? [], [locationData?.plotted]);
  const skipped = useMemo(() => locationData?.skipped ?? [], [locationData?.skipped]);

  const customerCountByState = useMemo(
    () => customerCountsByState(customers),
    [customers],
  );

  const maxStateCount = useMemo(
    () => Math.max(1, ...Object.values(customerCountByState)),
    [customerCountByState],
  );

  const availableStates = useMemo(
    () => Object.keys(customerCountByState).sort(),
    [customerCountByState],
  );

  const panelCustomers = useMemo(() => {
    if (stateFilter === 'ALL') return [];
    return customers.filter((c) => customerStateAbbr(c) === stateFilter);
  }, [customers, stateFilter]);

  const handleOpenChange = useCallback((nextOpen) => {
    if (!nextOpen) {
      setHoveredId(null);
      setSelectedCustomerId(null);
      setHoveredStateFips(null);
      setStateFilter('ALL');
      setCountyPaths([]);
      resetView();
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, resetView]);

  const statePaths = useMemo(() => {
    try {
      const states = feature(usStatesTopology, usStatesTopology.objects.states);
      return states.features.map((f) => ({
        id: f.id,
        abbr: STATE_FIPS_TO_ABBR[f.id],
        d: pathGenerator(f),
        feature: f,
        centroid: pathGenerator.centroid(f),
      }));
    } catch {
      return [];
    }
  }, [pathGenerator]);

  const markerPositions = useMemo(() => plotted.map((point, index) => {
    const projected = projection(point.coordinates);
    if (!projected) return null;
    return {
      ...point,
      x: projected[0],
      y: projected[1],
      stateAbbr: customerStateAbbr(point.customer),
      index,
    };
  }).filter(Boolean), [plotted, projection]);

  const filteredMarkers = useMemo(() => {
    if (stateFilter === 'ALL') return markerPositions;
    return markerPositions.filter((p) => p.stateAbbr === stateFilter);
  }, [markerPositions, stateFilter]);

  const useClusters = view.scale < CLUSTER_ZOOM_THRESHOLD && filteredMarkers.length > 1;
  const displayItems = useMemo(
    () => (useClusters ? clusterMarkers(filteredMarkers, view.scale) : filteredMarkers.map((m) => ({ type: 'marker', ...m }))),
    [useClusters, filteredMarkers, view.scale],
  );

  const arcs = useMemo(() => {
    if (view.scale >= 3.5 || filteredMarkers.length < 2) return [];
    return markerArcs(filteredMarkers, 220, 20);
  }, [filteredMarkers, view.scale]);

  const glows = useMemo(
    () => densityGlows(filteredMarkers, 48 + filteredMarkers.length * 2),
    [filteredMarkers],
  );

  const findMarkerByCustomerId = useCallback((customerId) => {
    if (!customerId) return null;
    return markerPositions.find((p) => p.customer.id === customerId) ?? null;
  }, [markerPositions]);

  const hoveredMarker = useMemo(() => {
    if (!hoveredId) return null;
    return findMarkerByCustomerId(hoveredId);
  }, [hoveredId, findMarkerByCustomerId]);

  const selectedMarker = useMemo(
    () => findMarkerByCustomerId(selectedCustomerId),
    [selectedCustomerId, findMarkerByCustomerId],
  );

  const tooltipMarker = hoveredMarker ?? selectedMarker;

  const activeStateFips = stateFilter !== 'ALL' ? STATE_ABBR_TO_FIPS[stateFilter] : null;
  const showCounties = stateFilter !== 'ALL';
  const markerScreenScale = 1 / view.scale;
  const showStateLabels = view.scale < usaFitView.scale * 4;

  useEffect(() => {
    if (!open || stateFilter === 'ALL') return;
    const match = statePaths.find((s) => s.id === activeStateFips);
    if (match?.feature) {
      fitToBounds(pathGenerator.bounds(match.feature), STATE_FIT_PADDING);
    }
  }, [open, stateFilter, activeStateFips, statePaths, pathGenerator, fitToBounds]);

  useEffect(() => {
    if (!open || !showCounties) {
      setCountyPaths([]);
      return undefined;
    }

    let cancelled = false;
    import('us-atlas/counties-10m.json').then((topology) => {
      if (cancelled) return;
      const topo = topology.default ?? topology;
      const counties = feature(topo, topo.objects.counties);
      const prefix = activeStateFips;
      const paths = counties.features
        .filter((f) => {
          if (!prefix) return true;
          return String(f.id).padStart(5, '0').startsWith(prefix);
        })
        .map((f) => ({ id: f.id, d: pathGenerator(f) }));
      setCountyPaths(paths);
    });

    return () => { cancelled = true; };
  }, [open, showCounties, activeStateFips, pathGenerator]);

  useLayoutEffect(() => {
    if (!open) return undefined;

    let detached = null;

    const attach = () => {
      detached?.();
      detached = null;
      const container = mapContainerRef.current;
      const svg = svgRef.current;
      if (!container || !svg) return false;

      const onWheel = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pt = pointerToSvg(svg, e.clientX, e.clientY);
        zoomByRef.current(wheelZoomFactor(e), pt.x, pt.y);
      };

      container.addEventListener('wheel', onWheel, { passive: false, capture: true });
      detached = () => container.removeEventListener('wheel', onWheel, { capture: true });
      return true;
    };

    if (!attach()) {
      const frameId = requestAnimationFrame(() => attach());
      return () => {
        cancelAnimationFrame(frameId);
        detached?.();
      };
    }

    return () => detached?.();
  }, [open]);

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-map-marker]')) return;
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);
    setIsPanning(true);
    panStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      viewX: viewRef.current.x,
      viewY: viewRef.current.y,
    };
  }, [viewRef]);

  const handlePointerMove = useCallback((e) => {
    if (!isPanning || !panStartRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - panStartRef.current.clientX) / rect.width) * MAP_WIDTH;
    const dy = ((e.clientY - panStartRef.current.clientY) / rect.height) * MAP_HEIGHT;
    setView({
      ...viewRef.current,
      x: panStartRef.current.viewX + dx,
      y: panStartRef.current.viewY + dy,
    });
  }, [isPanning, setView, viewRef]);

  const handlePointerUp = useCallback((e) => {
    if (!svgRef.current) return;
    svgRef.current.releasePointerCapture(e.pointerId);
    setIsPanning(false);
    panStartRef.current = null;
  }, []);

  const focusOnMarker = useCallback((point) => {
    const targetScale = clamp(
      Math.max(viewRef.current.scale, ACCOUNT_FOCUS_SCALE),
      MIN_ZOOM,
      ACCOUNT_FOCUS_SCALE,
    );
    flyTo(point.x, point.y, targetScale);
  }, [flyTo, viewRef]);

  const handleAccountSelect = useCallback((customerId) => {
    setSelectedCustomerId(customerId);
    const point = findMarkerByCustomerId(customerId);
    if (point) focusOnMarker(point);
  }, [findMarkerByCustomerId, focusOnMarker]);

  const handleMarkerClick = useCallback((e, point) => {
    e.stopPropagation();
    setSelectedCustomerId(point.customer.id);
    focusOnMarker(point);
  }, [focusOnMarker]);

  const handleClusterClick = useCallback((e, cluster) => {
    e.stopPropagation();
    setSelectedCustomerId(null);
    const targetScale = clamp(
      Math.max(view.scale * 1.6, CLUSTER_ZOOM_THRESHOLD + 0.5),
      MIN_ZOOM,
      ACCOUNT_FOCUS_SCALE,
    );
    flyTo(cluster.x, cluster.y, targetScale);
  }, [flyTo, view.scale]);

  const handleStateFilterChange = useCallback((value) => {
    setStateFilter(value);
    setHoveredId(null);
    setSelectedCustomerId(null);
    if (value === 'ALL') resetView();
  }, [resetView]);

  const handleStateClick = useCallback((state) => {
    if (!state.abbr || !customerCountByState[state.abbr]) return;
    if (stateFilter === state.abbr) {
      handleStateFilterChange('ALL');
      return;
    }
    handleStateFilterChange(state.abbr);
  }, [customerCountByState, handleStateFilterChange, stateFilter]);

  const zoomPercent = Math.round((view.scale / usaFitView.scale) * 100);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-5xl w-[95vw] p-0 gap-0 overflow-hidden border-cyan-500/20 bg-card shadow-[0_0_60px_rgba(34,211,238,0.08)]">
        <div className="relative px-6 pt-6 pb-4 border-b border-cyan-500/15 bg-gradient-to-r from-cyan-500/8 via-violet-500/8 to-fuchsia-500/8">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl tracking-tight">
              <Sparkles className="w-5 h-5 text-cyan-400" />
              Geographic Intelligence
            </DialogTitle>
            <DialogDescription className="text-muted-foreground/90">
              Click a state to see accounts · click an account to locate it on the map
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Badge variant="secondary" className="bg-cyan-500/10 text-cyan-300 border-cyan-500/20">
              {customers.length} total
            </Badge>
            <Badge variant="secondary" className="bg-violet-500/10 text-violet-300 border-violet-500/20">
              {filteredMarkers.length} shown
            </Badge>
            {useClusters && (
              <Badge variant="outline" className="text-cyan-400/80 border-cyan-500/25 text-[10px]">
                Clustered — zoom in for detail
              </Badge>
            )}
            {skipped.length > 0 && (
              <Badge variant="outline" className="text-muted-foreground border-border/60">
                {skipped.length} unplotted
              </Badge>
            )}
            {loadingLocations && (
              <span className="inline-flex items-center gap-1.5 text-xs text-cyan-400/80 ml-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Resolving coordinates…
              </span>
            )}
          </div>
          {availableStates.length > 0 && (
            <div className="flex items-center gap-2 mt-3 max-w-xs">
              <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <Select value={stateFilter} onValueChange={handleStateFilterChange}>
                <SelectTrigger className="h-8 text-xs bg-background/60 border-cyan-500/20">
                  <SelectValue placeholder="Filter by state" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All states</SelectItem>
                  {availableStates.map((abbr) => (
                    <SelectItem key={abbr} value={abbr}>{abbr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="relative bg-[#020617] overflow-hidden">
          <div className="absolute inset-3 sm:inset-4 pointer-events-none z-10">
            <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-cyan-400/40 rounded-tl-sm" />
            <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-cyan-400/40 rounded-tr-sm" />
            <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-violet-400/40 rounded-bl-sm" />
            <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-violet-400/40 rounded-br-sm" />
          </div>

          <div className="relative px-3 py-4 sm:px-5 sm:py-5">
            <div
              ref={mapContainerRef}
              className="relative mx-auto max-w-full rounded-xl overflow-hidden ring-1 ring-cyan-500/25 shadow-[inset_0_0_100px_rgba(34,211,238,0.08),0_0_40px_rgba(34,211,238,0.06)]"
              style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}
            >
              <svg
                ref={svgRef}
                viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                className={`w-full h-full touch-none select-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
                role="img"
                aria-label="Interactive United States map showing customer locations"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                onDoubleClick={resetView}
              >
                <defs>
                  <radialGradient id="ocean-glow" cx="50%" cy="45%" r="65%">
                    <stop offset="0%" stopColor="#0c4a6e" stopOpacity="0.35" />
                    <stop offset="55%" stopColor="#0f172a" stopOpacity="0.15" />
                    <stop offset="100%" stopColor="#020617" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id="state-fill" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#0c1929" />
                    <stop offset="45%" stopColor="#111827" />
                    <stop offset="100%" stopColor="#0a1628" />
                  </linearGradient>
                  <linearGradient id="state-fill-hover" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#164e63" />
                    <stop offset="50%" stopColor="#1e3a5f" />
                    <stop offset="100%" stopColor="#134e4a" />
                  </linearGradient>
                  <linearGradient id="state-fill-active" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#155e75" />
                    <stop offset="50%" stopColor="#1e40af" />
                    <stop offset="100%" stopColor="#0f766e" />
                  </linearGradient>
                  <linearGradient id="state-stroke" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="rgba(94,234,212,0.82)" />
                    <stop offset="50%" stopColor="rgba(186,196,255,0.88)" />
                    <stop offset="100%" stopColor="rgba(110,231,183,0.78)" />
                  </linearGradient>
                  <filter id="state-glow" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation="0.8" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="density-blur" x="-100%" y="-100%" width="300%" height="300%">
                    <feGaussianBlur stdDeviation="12" />
                  </filter>
                  <filter id="marker-glow" x="-100%" y="-100%" width="300%" height="300%">
                    <feGaussianBlur stdDeviation="3.5" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="pin-shadow" x="-50%" y="-50%" width="200%" height="200%">
                    <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#000" floodOpacity="0.5" />
                  </filter>
                </defs>

                <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#020617" />
                <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#ocean-glow)" />

                <g transform={`translate(${view.x}, ${view.y}) scale(${view.scale})`}>
                  {/* Density glow layer */}
                  <g opacity={0.55} filter="url(#density-blur)">
                    {glows.map((g) => (
                      <circle
                        key={`glow-${g.id}`}
                        cx={g.x}
                        cy={g.y}
                        r={g.r}
                        fill={g.color}
                        opacity={0.12}
                      />
                    ))}
                  </g>

                  {/* State borders — under-glow pass for readability */}
                  {statePaths.map((state) => {
                    const isDimmed = activeStateFips && state.id !== activeStateFips;
                    return (
                      <path
                        key={`border-${state.id}`}
                        d={state.d}
                        fill="none"
                        stroke="rgba(56,189,248,0.28)"
                        strokeWidth={2.4}
                        opacity={isDimmed ? 0.2 : 0.7}
                        style={{ pointerEvents: 'none' }}
                      />
                    );
                  })}

                  {/* Customer density tint per state */}
                  {statePaths.map((state) => {
                    const count = state.abbr ? (customerCountByState[state.abbr] || 0) : 0;
                    if (!count) return null;
                    const intensity = 0.1 + (count / maxStateCount) * 0.28;
                    return (
                      <path
                        key={`density-${state.id}`}
                        d={state.d}
                        fill={`rgba(34,211,238,${intensity})`}
                        stroke="none"
                        style={{ pointerEvents: 'none' }}
                      />
                    );
                  })}

                  {/* States */}
                  {statePaths.map((state) => {
                    const isActive = activeStateFips && state.id === activeStateFips;
                    const isHovered = hoveredStateFips === state.id;
                    const isDimmed = activeStateFips && state.id !== activeStateFips;
                    const hasAccounts = state.abbr && customerCountByState[state.abbr] > 0;
                    let fill = 'url(#state-fill)';
                    if (isActive) fill = 'url(#state-fill-active)';
                    else if (isHovered) fill = 'url(#state-fill-hover)';

                    return (
                      <path
                        key={state.id}
                        d={state.d}
                        fill={fill}
                        stroke="url(#state-stroke)"
                        strokeWidth={1}
                        filter="url(#state-glow)"
                        opacity={isDimmed ? 0.3 : 0.94}
                        className={hasAccounts ? 'cursor-pointer' : 'cursor-default'}
                        onMouseEnter={() => handleStateHoverEnter(state.id)}
                        onMouseLeave={handleStateHoverLeave}
                        onClick={() => handleStateClick(state)}
                      />
                    );
                  })}

                  {/* County detail when zoomed or filtered */}
                  {countyPaths.length > 0 && (
                    <g opacity={0.35} style={{ pointerEvents: 'none' }}>
                      {countyPaths.map((county) => (
                        <path
                          key={county.id}
                          d={county.d}
                          fill="none"
                          stroke="rgba(186,196,210,0.5)"
                          strokeWidth={0.45}
                        />
                      ))}
                    </g>
                  )}

                  {/* Connection arcs — static paths; no pointer events */}
                  <g style={{ pointerEvents: 'none' }}>
                    {arcs.map((arc) => (
                      <path
                        key={arc.id}
                        d={arc.d}
                        fill="none"
                        stroke="url(#state-stroke)"
                        strokeWidth={0.8}
                        opacity={0.22}
                        strokeDasharray="4 8"
                      />
                    ))}
                  </g>

                  {/* State labels */}
                  {showStateLabels && statePaths.map((state) => {
                    if (!state.abbr || HIDDEN_MAP_LABEL_ABBRS.has(state.abbr)) return null;
                    const compact = COMPACT_STATE_ABBRS.has(state.abbr);
                    const override = STATE_LABEL_OVERRIDES[state.abbr];
                    const x = state.centroid[0] + (override?.dx ?? 0);
                    const y = state.centroid[1] + (override?.dy ?? 0);
                    const fontSize = override?.fontSize ?? (compact ? 10 : 9);
                    const count = customerCountByState[state.abbr] || 0;

                    return (
                      <g key={`label-${state.id}`} style={{ pointerEvents: 'none', userSelect: 'none' }}>
                        <text
                          x={x}
                          y={y}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill={compact ? 'rgba(226,232,240,0.92)' : 'rgba(186,196,210,0.72)'}
                          stroke="rgba(2,6,23,0.85)"
                          strokeWidth={3}
                          paintOrder="stroke fill"
                          fontSize={fontSize}
                          fontWeight={700}
                          fontFamily="system-ui, sans-serif"
                          letterSpacing="0.06em"
                        >
                          {state.abbr}
                        </text>
                        {count > 0 && view.scale < usaFitView.scale * 1.6 && (
                          <text
                            x={x}
                            y={y + 11}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill="rgba(34,211,238,0.9)"
                            fontSize={8}
                            fontWeight={700}
                            fontFamily="system-ui, sans-serif"
                          >
                            {count}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Markers & clusters */}
                  {displayItems.map((item) => {
                    if (item.type === 'cluster') {
                      const isHovered = item.markers?.some((m) => m.customer.id === hoveredId);
                      return (
                        <g
                          key={item.id}
                          data-map-marker
                          transform={`translate(${item.x}, ${item.y}) scale(${markerScreenScale})`}
                          className="cursor-pointer"
                          onClick={(e) => handleClusterClick(e, item)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleClusterClick(e, item);
                            }
                          }}
                          tabIndex={0}
                          role="button"
                          aria-label={`${item.count} customers clustered. Click to zoom in.`}
                        >
                          <circle r={isHovered ? 22 : 18} fill={item.color} opacity={0.15} />
                          <circle
                            r={isHovered ? 16 : 14}
                            fill="#0f172a"
                            stroke={item.color}
                            strokeWidth={2}
                          />
                          <text
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill={item.color}
                            fontSize={11}
                            fontWeight={700}
                            fontFamily="system-ui, sans-serif"
                          >
                            {item.count}
                          </text>
                        </g>
                      );
                    }

                    const point = item;
                    const isHovered = hoveredId === point.customer.id;
                    const isSelected = selectedCustomerId === point.customer.id;

                    return (
                      <g
                        key={point.customer.id}
                        data-map-marker
                        transform={`translate(${point.x}, ${point.y}) scale(${markerScreenScale})`}
                        className="cursor-pointer"
                        onMouseEnter={() => setHoveredId(point.customer.id)}
                        onMouseLeave={() => setHoveredId((prev) => (prev === point.customer.id ? null : prev))}
                        onClick={(e) => handleMarkerClick(e, point)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleMarkerClick(e, point);
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={`${point.customer.friendlyName}, ${point.locationName}. Click to locate.`}
                        aria-pressed={isSelected}
                      >
                        {(isSelected || isHovered) && (
                          <circle
                            r={isSelected ? 22 : 18}
                            fill="none"
                            stroke={point.color}
                            strokeWidth={isSelected ? 1.2 : 0.8}
                            opacity={isSelected ? 0.65 : 0.35}
                            strokeDasharray={isSelected ? undefined : '2 4'}
                          />
                        )}
                        <circle r={14} fill={point.color} opacity={isSelected ? 0.18 : 0.1} />
                        <g filter="url(#pin-shadow)">
                          <path
                            d="M0,-11 C-5.5,-11 -9,-7 -9,-2.5 C-9,2 0,12 0,12 C0,12 9,2 9,-2.5 C9,-7 5.5,-11 0,-11 Z"
                            fill={point.color}
                            stroke={isSelected ? '#fff' : '#020617'}
                            strokeWidth={isSelected ? 2 : 1.5}
                          />
                          <circle cy={-4} r={2.5} fill="#fff" opacity={0.9} />
                        </g>
                      </g>
                    );
                  })}
                </g>
              </svg>

              {tooltipMarker && (
                <MapTooltip marker={tooltipMarker} isSelected={tooltipMarker.customer.id === selectedCustomerId} />
              )}

              <div className="absolute bottom-3 right-3 flex items-center gap-1.5 z-20">
                <div className="flex items-center rounded-lg border border-cyan-500/25 bg-[#0a0f1a]/90 backdrop-blur-md shadow-lg overflow-hidden">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-none h-8 w-8 text-cyan-300 hover:bg-cyan-500/10 hover:text-cyan-200"
                    onClick={() => zoomBy(1 / 1.3)}
                    aria-label="Zoom out"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </Button>
                  <span className="px-2 text-[10px] font-mono text-cyan-300/80 min-w-[3rem] text-center tabular-nums">
                    {zoomPercent}%
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-none h-8 w-8 text-cyan-300 hover:bg-cyan-500/10 hover:text-cyan-200"
                    onClick={() => zoomBy(1.3)}
                    aria-label="Zoom in"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-8 w-8 rounded-lg border border-violet-500/25 bg-[#0a0f1a]/90 backdrop-blur-md text-violet-300 hover:bg-violet-500/10 hover:text-violet-200 shadow-lg"
                  onClick={resetView}
                  aria-label="Reset to full map view"
                  title="Reset view"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        {stateFilter !== 'ALL' && (
          <div className="px-6 py-3 border-t border-cyan-500/15 bg-cyan-500/5">
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-xs font-semibold text-cyan-300/90">
                {stateFilter} — {panelCustomers.length} account{panelCustomers.length !== 1 ? 's' : ''}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => handleStateFilterChange('ALL')}
              >
                Clear selection
              </Button>
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 max-h-32 overflow-y-auto">
              {panelCustomers.map((c) => {
                const isSelected = selectedCustomerId === c.id;
                const isPlotted = plotted.some((p) => p.customer.id === c.id);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => handleAccountSelect(c.id)}
                      disabled={!isPlotted}
                      className={`w-full text-left text-xs truncate flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors ${
                        isSelected
                          ? 'bg-cyan-500/20 text-cyan-100 ring-1 ring-cyan-500/35'
                          : 'text-foreground/90 hover:bg-cyan-500/10'
                      } ${!isPlotted ? 'opacity-50 cursor-not-allowed' : ''}`}
                      title={isPlotted ? c.friendlyName : `${c.friendlyName} (could not plot)`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSelected ? 'bg-cyan-300' : 'bg-cyan-400'}`}
                      />
                      {c.friendlyName}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {skipped.length > 0 && !loadingLocations && (
          <div className="px-6 py-3 border-t border-border/60 bg-muted/20 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">Could not plot: </span>
            {skipped.slice(0, 4).map((s) => s.customer.friendlyName).join(', ')}
            {skipped.length > 4 && ` and ${skipped.length - 4} more`}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MapTooltip({ marker, isSelected }) {
  return (
    <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-cyan-500/25 bg-[#0a0f1a]/95 backdrop-blur-md shadow-[0_0_30px_rgba(34,211,238,0.12)] min-w-[240px] max-w-sm">
        <div
          className="w-3 h-3 rounded-full mt-1 shrink-0 ring-2 ring-white/10 shadow-[0_0_12px_currentColor]"
          style={{ backgroundColor: marker.color, color: marker.color }}
        />
        <div className="min-w-0">
          <p className="font-semibold text-sm text-foreground truncate">
            {marker.customer.friendlyName}
          </p>
          <p className="text-xs text-cyan-400/70 flex items-center gap-1 mt-0.5">
            <MapPin className="w-3 h-3 shrink-0" />
            <span className="truncate">{marker.locationName || marker.address}</span>
          </p>
          {isSelected && (
            <p className="text-[10px] text-cyan-400/80 mt-1.5 font-mono">Selected on map</p>
          )}
        </div>
      </div>
    </div>
  );
}
