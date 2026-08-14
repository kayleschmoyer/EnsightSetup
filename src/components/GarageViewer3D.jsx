import React, { useRef, useState, useCallback, useMemo, useEffect, Component } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Html, Box, Edges } from '@react-three/drei';
import * as THREE from 'three';
import { RotateCw, Eye, Cpu } from 'lucide-react';
import { analyzeFloorPlan } from '../services/FloorPlanAnalyzer';

// -- Error Boundary -----------------------------------------------------------
class Canvas3DErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div className="flex-1 flex items-center justify-center text-sm text-red-400 p-8 text-center">
        <div><p className="font-semibold mb-2">3D rendering error</p>
          <p className="text-xs text-muted-foreground">{this.state.error.message}</p></div>
      </div>
    );
    return this.props.children;
  }
}

// -- Constants ----------------------------------------------------------------
const FLOOR_HEIGHT = 4.0;
const FLOOR_W      = 22;
const FLOOR_D      = 15;
const WALL_H       = FLOOR_HEIGHT - 0.2;
const WALL_T       = 0.35;
const SLAB_T       = 0.18;

const DEVICE_COLORS_HEX = {
  'cam-fli':        '#3b82f6',
  'cam-lpr':        '#8b5cf6',
  'cam-people':     '#06b6d4',
  'sign-led':       '#f59e0b',
  'sign-static':    '#eab308',
  'sign-designable':'#f97316',
  'sensor-nwave':   '#10b981',
  'sensor-parksol': '#14b8a6',
  'sensor-proco':   '#22c55e',
  'sensor-ensight': '#34d399',
};

const CAMERA_TYPES = [
  { id: 'cam-fli',    name: 'FLI',    color: '#3b82f6' },
  { id: 'cam-lpr',    name: 'LPR',    color: '#8b5cf6' },
  { id: 'cam-people', name: 'People', color: '#06b6d4' },
];

// -- Coordinate helpers -------------------------------------------------------
const nToW = (nx, ny) => ({
  x: (nx - 0.5) * FLOOR_W,
  z: (ny - 0.5) * FLOOR_D,
});
const deviceToPos3D = (device) => ({
  x: ((device.x || 0) / 50) - 8,
  z: ((device.y || 0) / 50) - 5,
});
const pos3DToDevice = (x, z) => ({ x: (x + 8) * 50, y: (z + 5) * 50 });

// -- Data URL texture hook ----------------------------------------------------
function useDataUrlTexture(dataUrl) {
  const [texture, setTexture] = useState(null);
  useEffect(() => {
    if (!dataUrl) { setTexture(null); return; }
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, (tex) => { tex.flipY = false; setTexture(tex); });
    return () => setTexture(null);
  }, [dataUrl]);
  return texture;
}

// -- Floor plan analysis hook -------------------------------------------------
function useFloorPlanAnalysis(bgImage) {
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const prevRef = useRef(null);
  useEffect(() => {
    if (!bgImage) { setAnalysis(null); return; }
    if (bgImage === prevRef.current) return;
    prevRef.current = bgImage;
    setAnalyzing(true);
    analyzeFloorPlan(bgImage).then(r => { setAnalysis(r); setAnalyzing(false); });
  }, [bgImage]);
  return { analysis, analyzing };
}

// -- Perimeter walls ----------------------------------------------------------
function PerimeterWalls({ bounds, y, isActive }) {
  if (!bounds) return null;
  const { left, right, top, bottom } = bounds;
  const wLeft   = (left   - 0.5) * FLOOR_W;
  const wRight  = (right  - 0.5) * FLOOR_W;
  const wTop    = (top    - 0.5) * FLOOR_D;
  const wBottom = (bottom - 0.5) * FLOOR_D;
  const spanX = wRight - wLeft;
  const spanZ = wBottom - wTop;
  const wallY = y + SLAB_T / 2 + WALL_H / 2;
  const op = isActive ? 0.88 : 0.4;

  const walls = [
    { pos: [wLeft  + WALL_T/2,           wallY, (wTop + wBottom)/2], args: [WALL_T, WALL_H, spanZ + WALL_T] },
    { pos: [wRight - WALL_T/2,           wallY, (wTop + wBottom)/2], args: [WALL_T, WALL_H, spanZ + WALL_T] },
    { pos: [(wLeft+wRight)/2,            wallY, wTop    + WALL_T/2], args: [spanX - WALL_T*2, WALL_H, WALL_T] },
    { pos: [(wLeft+wRight)/2,            wallY, wBottom - WALL_T/2], args: [spanX - WALL_T*2, WALL_H, WALL_T] },
  ];

  return (
    <group>
      {walls.map((w, i) => (
        <group key={i}>
          <mesh position={w.pos}>
            <boxGeometry args={w.args} />
            <meshStandardMaterial color="#4a5568" roughness={0.9} transparent opacity={op} />
          </mesh>
          {/* Safety rail on top */}
          <mesh position={[w.pos[0], w.pos[1] + WALL_H/2 + 0.05, w.pos[2]]}>
            <boxGeometry args={[w.args[0], 0.1, w.args[2]]} />
            <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.18} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// -- Structural pillar --------------------------------------------------------
function Pillar({ nx, ny, y, isActive }) {
  const { x, z } = nToW(nx, ny);
  return (
    <mesh position={[x, y + SLAB_T/2 + WALL_H/2, z]} castShadow>
      <boxGeometry args={[0.4, WALL_H, 0.4]} />
      <meshStandardMaterial color="#9ca3af" roughness={0.7} transparent opacity={isActive ? 0.9 : 0.35} />
    </mesh>
  );
}

// -- Interior wall segment ----------------------------------------------------
function InteriorWallSeg({ x0, x1, ny, y, isActive }) {
  const wx0 = (x0 - 0.5) * FLOOR_W;
  const wx1 = (x1 - 0.5) * FLOOR_W;
  const wz  = (ny - 0.5) * FLOOR_D;
  const spanX = wx1 - wx0;
  const h = WALL_H * 0.35;
  return (
    <mesh position={[(wx0+wx1)/2, y + SLAB_T/2 + h/2, wz]}>
      <boxGeometry args={[spanX, h, WALL_T * 0.6]} />
      <meshStandardMaterial color="#374151" roughness={0.85} transparent opacity={isActive ? 0.65 : 0.2} />
    </mesh>
  );
}

// -- Ramp geometry ------------------------------------------------------------
function RampGeometry({ zone, baseY, isActive }) {
  const { cx, cy, w, h } = zone;
  const { x: wCx, z: wCz } = nToW(cx, cy);
  const rampW = Math.max(w * FLOOR_W * 0.9, 2.5);
  const rampD = Math.max(h * FLOOR_D * 0.9, 2.0);
  const angle = Math.atan2(FLOOR_HEIGHT * 0.85, rampD);
  const midY  = baseY + FLOOR_HEIGHT * 0.5;
  const slantLen = Math.sqrt(rampD ** 2 + (FLOOR_HEIGHT * 0.85) ** 2);

  return (
    <group position={[wCx, midY, wCz]}>
      {/* Slab */}
      <mesh rotation={[angle, 0, 0]} receiveShadow>
        <boxGeometry args={[rampW, SLAB_T, slantLen]} />
        <meshStandardMaterial color="#2d3748" roughness={0.9} transparent opacity={isActive ? 0.85 : 0.3} />
      </mesh>
      {/* Side curb walls */}
      {[-rampW/2 + WALL_T/2, rampW/2 - WALL_T/2].map((ox, i) => (
        <mesh key={i} position={[ox, 0.35, 0]} rotation={[angle, 0, 0]}>
          <boxGeometry args={[WALL_T, 0.7, slantLen]} />
          <meshStandardMaterial color="#4a5568" roughness={0.85} transparent opacity={isActive ? 0.7 : 0.2} />
        </mesh>
      ))}
      {/* Handrails */}
      {[-rampW/2 + 0.05, rampW/2 - 0.05].map((ox, i) => (
        <mesh key={`r${i}`} position={[ox, 0.72, 0]} rotation={[angle, 0, 0]}>
          <boxGeometry args={[0.06, 0.06, slantLen * 0.95]} />
          <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={isActive ? 0.3 : 0.08} />
        </mesh>
      ))}
    </group>
  );
}

// -- Parking stripes ----------------------------------------------------------
function ParkingStripes({ bounds, y, isActive }) {
  if (!isActive || !bounds) return null;
  const wL = (bounds.left  - 0.5) * FLOOR_W + WALL_T;
  const wR = (bounds.right - 0.5) * FLOOR_W - WALL_T;
  const wT = (bounds.top   - 0.5) * FLOOR_D + WALL_T;
  const wB = (bounds.bottom- 0.5) * FLOOR_D - WALL_T;
  const n = 14;
  const step = (wR - wL) / n;
  return (
    <group>
      {Array.from({ length: n + 1 }, (_, i) => (
        <mesh key={i} position={[wL + i * step, y + SLAB_T/2 + 0.012, (wT+wB)/2]}>
          <boxGeometry args={[0.04, 0.01, wB - wT]} />
          <meshBasicMaterial color="#4b5563" transparent opacity={0.55} />
        </mesh>
      ))}
    </group>
  );
}

// -- Ceiling soffit ------------------------------------------------------------
function Soffit({ bounds, y, isActive }) {
  if (!bounds) return null;
  const cx = ((bounds.left + bounds.right)  / 2 - 0.5) * FLOOR_W;
  const cz = ((bounds.top  + bounds.bottom) / 2 - 0.5) * FLOOR_D;
  const sw = (bounds.right - bounds.left)  * FLOOR_W;
  const sd = (bounds.bottom - bounds.top)  * FLOOR_D;
  return (
    <mesh position={[cx, y + FLOOR_HEIGHT, cz]}>
      <boxGeometry args={[sw, SLAB_T, sd]} />
      <meshStandardMaterial color="#1a202c" roughness={0.95} transparent opacity={isActive ? 0.55 : 0.18} />
    </mesh>
  );
}

// -- Full level floor assembly ------------------------------------------------
function AnalyzedFloor({ level, y, isActive, analysis, analyzing, floorTexture, placementMode, onFloorClick }) {
  return (
    <group>
      {/* Concrete slab */}
      <mesh position={[0, y + SLAB_T/2, 0]} receiveShadow>
        <boxGeometry args={[FLOOR_W, SLAB_T, FLOOR_D]} />
        <meshStandardMaterial color={isActive ? '#243040' : '#1a2030'} roughness={0.95} transparent opacity={isActive ? 0.9 : 0.28} />
      </mesh>

      {/* Clickable surface for camera placement */}
      {placementMode && isActive && (
        <mesh position={[0, y + SLAB_T + 0.01, 0]} rotation={[-Math.PI/2, 0, 0]} onClick={onFloorClick}>
          <planeGeometry args={[FLOOR_W, FLOOR_D]} />
          <meshStandardMaterial color="#348fe2" transparent opacity={0.07} />
        </mesh>
      )}

      {/* Floor plan texture overlay */}
      {floorTexture && (
        <mesh position={[0, y + SLAB_T + 0.016, 0]} rotation={[-Math.PI/2, 0, 0]}>
          <planeGeometry args={[FLOOR_W, FLOOR_D]} />
          <meshBasicMaterial map={floorTexture} transparent opacity={isActive ? 0.83 : 0.35} depthWrite={false} />
        </mesh>
      )}

      {/* Perimeter walls */}
      {analysis && <PerimeterWalls bounds={analysis.bounds} y={y} isActive={isActive} />}

      {/* Interior dividers */}
      {analysis && isActive && analysis.interiorWalls.slice(0, 30).map((w, i) => (
        <InteriorWallSeg key={i} x0={w.x0} x1={w.x1} ny={w.y} y={y} isActive={isActive} />
      ))}

      {/* Pillars */}
      {analysis && analysis.pillars.slice(0, 40).map((p, i) => (
        <Pillar key={i} nx={p.nx} ny={p.ny} y={y} isActive={isActive} />
      ))}

      {/* Parking bay lines */}
      <ParkingStripes bounds={analysis?.bounds} y={y} isActive={isActive} />

      {/* Ceiling / soffit */}
      {analysis && <Soffit bounds={analysis.bounds} y={y} isActive={isActive} />}

      {/* Analyzing indicator */}
      {analyzing && isActive && (
        <Html position={[0, y + 2, 0]} center>
          <div style={{ color: '#93c5fd', fontSize: 11, background: 'rgba(0,0,0,0.6)', padding: '4px 10px', borderRadius: 6 }}>
            Analyzing floor plan�
          </div>
        </Html>
      )}

      {/* Level label */}
      <Html
        position={analysis
          ? [(analysis.bounds.left - 0.5) * FLOOR_W + 0.4, y + SLAB_T + 0.15, (analysis.bounds.top - 0.5) * FLOOR_D + 0.4]
          : [-FLOOR_W/2 + 0.5, y + SLAB_T + 0.15, -FLOOR_D/2 + 0.5]}
        center={false}
        style={{ pointerEvents: 'none' }}
      >
        <span style={{ color: isActive ? '#93c5fd' : '#adb5bd', fontSize: 11, fontWeight: 700,
          textShadow: '0 1px 4px rgba(0,0,0,0.9)', background: 'rgba(0,0,0,0.45)',
          padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>
          {level.name}
        </span>
      </Html>
    </group>
  );
}

// -- Camera FOV cone ----------------------------------------------------------
function CameraFOVCone({ rotation, color }) {
  return (
    <group rotation={[0, rotation, 0]}>
      <mesh position={[0, 0, -1.5]} rotation={[Math.PI/2, 0, 0]}>
        <coneGeometry args={[0.8, 3, 12, 1, true]} />
        <meshStandardMaterial color={color} transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0, -1.5]} rotation={[Math.PI/2, 0, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 3, 4]} />
        <meshStandardMaterial color={color} transparent opacity={0.45} />
      </mesh>
    </group>
  );
}

// -- Rotation handle ----------------------------------------------------------
function RotationHandle({ rotation, onRotate, color }) {
  const handleRef = useRef();
  const isDragging = useRef(false);
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const hx = Math.sin(rotation) * -0.8;
  const hz = Math.cos(rotation) * -0.8;

  const onPointerDown = useCallback((e) => {
    e.stopPropagation(); isDragging.current = true;
    gl.domElement.style.cursor = 'grabbing';
    gl.domElement.setPointerCapture(e.pointerId);
  }, [gl]);

  const onPointerMove = useCallback((e) => {
    if (!isDragging.current) return;
    e.stopPropagation();
    const rect = gl.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(mouse, camera);
    const pt = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, pt);
    if (handleRef.current) {
      const wp = new THREE.Vector3();
      handleRef.current.parent.getWorldPosition(wp);
      onRotate(Math.atan2(-(pt.x - wp.x), -(pt.z - wp.z)));
    }
  }, [camera, gl, raycaster, plane, onRotate]);

  const onPointerUp = useCallback((e) => {
    isDragging.current = false; gl.domElement.style.cursor = '';
    gl.domElement.releasePointerCapture(e.pointerId);
  }, [gl]);

  return (
    <group ref={handleRef}>
      <mesh rotation={[Math.PI/2, 0, 0]}>
        <torusGeometry args={[0.8, 0.015, 8, 32]} />
        <meshStandardMaterial color={color} transparent opacity={0.4} />
      </mesh>
      <mesh position={[hx, 0, hz]}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <sphereGeometry args={[0.12, 12, 12]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

// -- Ceiling-mounted camera ----------------------------------------------------
function CameraMount({ device, ceilY, isSelected, onSelect, onRotate, mode }) {
  const groupRef = useRef();
  const color = DEVICE_COLORS_HEX[device.type] || '#6b7280';
  const { x, z } = deviceToPos3D(device);
  const rotation = device.rotation3d || 0;

  useFrame((s) => {
    if (!groupRef.current) return;
    groupRef.current.position.y = ceilY - 0.1 + (isSelected ? Math.sin(s.clock.elapsedTime * 3) * 0.03 : 0);
  });

  return (
    <group ref={groupRef} position={[x, ceilY - 0.1, z]}>
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 0.3, 8]} />
        <meshStandardMaterial color="#444" />
      </mesh>
      <mesh onClick={(e) => { e.stopPropagation(); onSelect(device); }}>
        <sphereGeometry args={[0.25, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={isSelected ? 0.5 : 0.2} />
      </mesh>
      <group rotation={[0, rotation, 0]}>
        <mesh position={[0, 0, -0.25]}>
          <cylinderGeometry args={[0.1, 0.08, 0.15, 8]} />
          <meshStandardMaterial color="#222" />
        </mesh>
      </group>
      <CameraFOVCone rotation={rotation} color={color} />
      {isSelected && (
        <mesh rotation={[Math.PI/2, 0, 0]}>
          <torusGeometry args={[0.4, 0.03, 8, 32]} />
          <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.5} />
        </mesh>
      )}
      {isSelected && mode === 'rotate' && (
        <RotationHandle rotation={rotation} onRotate={(r) => onRotate(device.id, r)} color={color} />
      )}
      <Html position={[0, -0.5, 0]} center style={{ pointerEvents: 'none' }}>
        <div style={{ background: isSelected ? color : 'rgba(0,0,0,0.7)', color: '#fff',
          fontSize: 9, padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap', fontWeight: isSelected ? 600 : 400 }}>
          {device.name}
        </div>
      </Html>
    </group>
  );
}

// -- Placement ghost ----------------------------------------------------------
function PlacementGhost({ position, color }) {
  const ref = useRef();
  useFrame((s) => { if (ref.current) ref.current.material.opacity = 0.3 + Math.sin(s.clock.elapsedTime * 4) * 0.15; });
  if (!position) return null;
  return (
    <group position={position}>
      <mesh ref={ref}><sphereGeometry args={[0.25, 16, 16]} /><meshStandardMaterial color={color} transparent opacity={0.4} /></mesh>
      <mesh position={[0, 0.15, 0]}><cylinderGeometry args={[0.06, 0.06, 0.3, 8]} /><meshStandardMaterial color="#555" transparent opacity={0.4} /></mesh>
    </group>
  );
}

// -- Other device marker -------------------------------------------------------
function DeviceMarker({ device, floorY }) {
  const ref = useRef();
  const color = DEVICE_COLORS_HEX[device.type] || '#6b7280';
  const { x, z } = deviceToPos3D(device);
  const isSensor = device.type?.startsWith('sensor-');
  useFrame((s) => { if (ref.current) ref.current.position.y = floorY + 0.3 + Math.sin(s.clock.elapsedTime * 2 + device.id) * 0.05; });
  return (
    <group ref={ref} position={[x, floorY + 0.3, z]}>
      <Box args={isSensor ? [0.3, 0.3, 0.3] : [0.4, 0.6, 0.15]}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.2} />
        <Edges color="white" />
      </Box>
    </group>
  );
}

// -- Per-level scene -----------------------------------------------------------
function LevelScene({ level, levelIndex, currentLevel, devices, placementMode,
  onFloorClick, onFloorHover, selectedDevice, onSelectDevice, onRotateCamera, mode, ghostPos }) {

  const isActive = level.id === currentLevel?.id;
  const floorTexture = useDataUrlTexture(level.bgImage || null);
  const { analysis, analyzing } = useFloorPlanAnalysis(level.bgImage || null);

  const baseY = levelIndex * FLOOR_HEIGHT;
  const ceilY = baseY + FLOOR_HEIGHT - 0.2;

  const cameras = useMemo(() =>
    (devices || []).filter(d => d.type?.startsWith('cam-') && !d.pendingPlacement && level.id === currentLevel?.id),
    [devices, level, currentLevel]);
  const others = useMemo(() =>
    (devices || []).filter(d => !d.type?.startsWith('cam-') && !d.pendingPlacement && level.id === currentLevel?.id),
    [devices, level, currentLevel]);

  const handleClick = useCallback((e) => {
    if (!placementMode || !isActive) return;
    e.stopPropagation();
    const cx = THREE.MathUtils.clamp(e.point.x, -FLOOR_W/2+0.5, FLOOR_W/2-0.5);
    const cz = THREE.MathUtils.clamp(e.point.z, -FLOOR_D/2+0.5, FLOOR_D/2-0.5);
    onFloorClick(cx, cz);
  }, [placementMode, isActive, onFloorClick]);

  const handleMove = useCallback((e) => {
    if (!placementMode || !isActive) return;
    e.stopPropagation();
    const cx = THREE.MathUtils.clamp(e.point.x, -FLOOR_W/2+0.5, FLOOR_W/2-0.5);
    const cz = THREE.MathUtils.clamp(e.point.z, -FLOOR_D/2+0.5, FLOOR_D/2-0.5);
    onFloorHover([cx, ceilY, cz]);
  }, [placementMode, isActive, ceilY, onFloorHover]);

  return (
    <group onPointerMove={handleMove}>
      <AnalyzedFloor
        level={level} y={baseY} isActive={isActive}
        analysis={analysis} analyzing={analyzing} floorTexture={floorTexture}
        placementMode={placementMode} onFloorClick={handleClick}
      />

      {/* Ramps */}
      {analysis && isActive && analysis.rampZones.map((rz, i) => (
        <RampGeometry key={i} zone={rz} baseY={baseY} isActive={isActive} />
      ))}

      {/* Cameras on ceiling */}
      {cameras.map(d => (
        <CameraMount key={d.id} device={d} ceilY={ceilY}
          isSelected={selectedDevice?.id === d.id}
          onSelect={onSelectDevice} onRotate={onRotateCamera} mode={mode} />
      ))}

      {/* Signs / sensors on floor */}
      {others.map(d => (
        <DeviceMarker key={d.id} device={d} floorY={baseY + SLAB_T} />
      ))}

      {/* Placement ghost on ceiling */}
      {placementMode && isActive && ghostPos && (
        <PlacementGhost position={ghostPos} color={DEVICE_COLORS_HEX['cam-fli']} />
      )}
    </group>
  );
}

// -- 3D Scene -----------------------------------------------------------------
function Scene({ levels, currentLevel, devices, placementMode, selectedDevice,
  onSelectDevice, onPlaceCamera, onRotateCamera, mode, ghostPos, onFloorHover }) {
  return (
    <>
      <PerspectiveCamera makeDefault position={[24, 20, 24]} fov={46} />
      <OrbitControls enableDamping dampingFactor={0.05} minDistance={8} maxDistance={90}
        enabled={mode !== 'rotate' || !selectedDevice} />

      <ambientLight intensity={0.55} />
      <directionalLight position={[14, 26, 14]} intensity={1.1} castShadow shadow-mapSize={[2048, 2048]} />
      <pointLight position={[-12, 12, -8]} intensity={0.35} color="#93c5fd" />
      <pointLight position={[12, 8, 12]} intensity={0.22} color="#fde68a" />
      <hemisphereLight skyColor="#1e3a5f" groundColor="#374151" intensity={0.4} />

      {/* Ground */}
      <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, -0.3, 0]} receiveShadow>
        <planeGeometry args={[70, 50]} />
        <meshStandardMaterial color="#0d1117" roughness={0.98} />
      </mesh>

      {levels.map((level, i) => (
        <LevelScene key={level.id}
          level={level} levelIndex={i} currentLevel={currentLevel}
          devices={devices} placementMode={placementMode}
          onFloorClick={onPlaceCamera} onFloorHover={onFloorHover}
          selectedDevice={selectedDevice}
          onSelectDevice={onSelectDevice} onRotateCamera={onRotateCamera}
          mode={mode} ghostPos={ghostPos}
        />
      ))}
    </>
  );
}

// -- Main export ---------------------------------------------------------------
export default function GarageViewer3D({ levels, currentLevel, devices, onAddDevice, onUpdateDevice }) {
  const [mode, setMode] = useState('view');
  const [selectedCameraType, setSelectedCameraType] = useState('cam-fli');
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [ghostPos, setGhostPos] = useState(null);

  const hasBg = (levels || []).some(l => l.bgImage);
  const placementMode = mode === 'place';

  const handlePlaceCamera = useCallback((x, z) => {
    if (!onAddDevice) return;
    const coords = pos3DToDevice(x, z);
    onAddDevice(selectedCameraType, { x: coords.x, y: coords.y, pendingPlacement: false, rotation3d: 0 });
  }, [selectedCameraType, onAddDevice]);

  const handleRotateCamera = useCallback((deviceId, r) => {
    if (!onUpdateDevice) return;
    onUpdateDevice(deviceId, { rotation3d: r });
    setSelectedDevice(prev => prev?.id === deviceId ? { ...prev, rotation3d: r } : prev);
  }, [onUpdateDevice]);

  const handleSelectDevice = useCallback((device) => {
    setSelectedDevice(prev => prev?.id === device.id ? null : device);
    if (mode === 'place') setMode('view');
  }, [mode]);

  const startPlacement = useCallback((camType) => {
    setSelectedCameraType(camType); setMode('place'); setSelectedDevice(null);
  }, []);

  return (
    <div className="flex-1 flex flex-col">
      {/* Toolbar */}
      <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold">3D Garage</h3>
            <p className="text-[10px] text-muted-foreground">
              {(levels||[]).length} level{(levels||[]).length !== 1 ? 's' : ''}
              {hasBg ? ' — structure auto-detected from floor plan images' : ' — add a background PNG or PDF per level to generate 3D structure'}
            </p>
          </div>

          <div className="h-5 w-px bg-border" />

          <div className="flex items-center gap-1">
            {[
              { id: 'view',   icon: Eye,      label: 'View', cls: 'text-primary border-primary/30 bg-primary/15' },
              { id: 'rotate', icon: RotateCw, label: 'Aim',  cls: 'text-amber-400 border-amber-500/30 bg-amber-500/15' },
            ].map(btn => (
              <button key={btn.id}
                onClick={() => { setMode(mode === btn.id && btn.id !== 'view' ? 'view' : btn.id); setGhostPos(null); }}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all border ${
                  mode === btn.id ? btn.cls : 'text-muted-foreground hover:text-foreground hover:bg-accent border-transparent'
                }`}>
                <btn.icon className="w-3.5 h-3.5" />{btn.label}
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-border" />

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground uppercase font-semibold mr-1">Add cam:</span>
            {CAMERA_TYPES.map(cam => (
              <button key={cam.id} onClick={() => startPlacement(cam.id)}
                className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all ${
                  placementMode && selectedCameraType === cam.id
                    ? 'text-white border border-white/20'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
                style={placementMode && selectedCameraType === cam.id ? { background: cam.color + '30' } : {}}>
                <span className="w-2 h-2 rounded-full" style={{ background: cam.color }} />{cam.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {placementMode && <span className="text-primary text-[10px] font-medium animate-pulse">Click within floor plan to place camera on ceiling</span>}
          {mode === 'rotate' && <span className="text-amber-400 text-[10px] font-medium">Click camera, drag white handle to aim</span>}
        </div>
      </div>

      {!hasBg && (
        <div className="px-4 py-1.5 bg-blue-500/5 border-b border-blue-500/20 text-xs text-blue-400 flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 shrink-0" />
          Set a background PNG per level (Layout tab ? camera icon) to auto-generate walls, ramps and pillars in 3D.
        </div>
      )}

      <div className="flex-1 relative bg-[#0d1117]">
        <div className="absolute inset-0">
          <Canvas3DErrorBoundary>
            <Canvas shadows onPointerMissed={() => { if (mode === 'place') { setMode('view'); setGhostPos(null); } }}>
              <Scene
                levels={levels || []}
                currentLevel={currentLevel}
                devices={devices || []}
                placementMode={placementMode}
                selectedDevice={selectedDevice}
                onSelectDevice={handleSelectDevice}
                onPlaceCamera={handlePlaceCamera}
                onRotateCamera={handleRotateCamera}
                mode={mode}
                ghostPos={ghostPos}
                onFloorHover={setGhostPos}
              />
            </Canvas>
          </Canvas3DErrorBoundary>
        </div>

        {selectedDevice && (
          <div className="absolute bottom-4 left-4 bg-card/90 backdrop-blur border border-border rounded-lg p-3 text-xs space-y-1.5 min-w-[180px]">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: DEVICE_COLORS_HEX[selectedDevice.type] }} />
              <span className="font-semibold text-sm">{selectedDevice.name}</span>
            </div>
            <div className="text-muted-foreground">Type: {selectedDevice.type?.replace('cam-','').toUpperCase()}</div>
            <div className="text-muted-foreground">Aim: {Math.round((selectedDevice.rotation3d||0)*180/Math.PI)}�</div>
            <div className="flex gap-1.5 mt-2">
              <button onClick={() => setMode('rotate')}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 cursor-pointer text-[11px] font-medium">
                <RotateCw className="w-3 h-3" />Aim
              </button>
              <button onClick={() => { setSelectedDevice(null); setMode('view'); }}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-muted hover:bg-accent cursor-pointer text-[11px] font-medium text-muted-foreground">
                Deselect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
