import React, { useMemo, useCallback, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  normalizeTrafficDirection,
  normalizeFlowDestinations,
  parseFlowTargetKey,
} from '../lib/trafficFlowUtils';

const nodeStyle = {
  padding: '8px 16px',
  borderRadius: '8px',
  fontSize: '12px',
  fontWeight: '600',
  border: '1px solid',
};

function zoneNameForFlow(levels, levelId, zoneId) {
  if (zoneId == null || zoneId === '') return '';
  const level = (levels ?? []).find(l => String(l?.id) === String(levelId));
  const zone = (level?.zones ?? []).find(z => String(z?.id) === String(zoneId));
  return zone ? (zone.name || `Zone ${zone.id}`) : '';
}

function buildFlowGraph(devices, levels, currentLevel) {
  const nodes = [];
  const edges = [];

  const cameras = devices.filter(d => d.type?.startsWith('cam-') && d.trafficFlow?.direction);

  // Create level nodes
  levels.forEach((level, i) => {
    nodes.push({
      id: `level-${level.id}`,
      data: {
        label: level.name,
      },
      position: { x: 300, y: i * 120 + 50 },
      style: {
        ...nodeStyle,
        background: level.id === currentLevel?.id ? '#293138' : '#2d353c',
        borderColor: level.id === currentLevel?.id ? '#348fe2' : '#495057',
        color: '#fff',
      },
    });
  });

  // Create camera nodes and edges
  cameras.forEach((cam, i) => {
    const nodeId = `cam-${cam.id}`;
    const flowLevelId = cam.trafficFlow?.level || currentLevel?.id;
    const levelIndex = levels.findIndex(l => l.id?.toString() === flowLevelId?.toString());
    const resolvedLevelIndex = levelIndex >= 0 ? levelIndex : levels.findIndex(l => l.id === currentLevel?.id);

    nodes.push({
      id: nodeId,
      data: {
        label: `📷 ${cam.name}`,
      },
      position: { x: 50 + (i % 3) * 160, y: Math.max(0, resolvedLevelIndex) * 120 + 50 },
      style: {
        ...nodeStyle,
        background: '#151c23',
        borderColor: '#348fe2',
        color: '#93c5fd',
      },
    });

    // Edge from camera to its traffic-flow level (fallback: current level)
    edges.push({
      id: `e-${nodeId}-level`,
      source: nodeId,
      target: `level-${flowLevelId}`,
      animated: true,
      style: { stroke: '#3b82f6', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6' },
      // Zone-targeted flows still terminate at the level node — name the zone
      // on the edge so the graph doesn't read as a whole-level count.
      label: [
        normalizeTrafficDirection(cam.trafficFlow.direction).toUpperCase(),
        zoneNameForFlow(levels, flowLevelId, cam.trafficFlow.zone),
      ].filter(Boolean).join(' · '),
      labelStyle: { fontSize: 10, fill: '#94a3b8' },
    });

    // Edges to opposite-flow destinations (a destination may name a zone)
    normalizeFlowDestinations(cam.trafficFlow.destinations).forEach(destKey => {
      const { levelId: destLevelId, zoneId: destZoneId } = parseFlowTargetKey(destKey);
      const destZoneName = zoneNameForFlow(levels, destLevelId, destZoneId);
      edges.push({
        id: `e-${nodeId}-dest-${destKey}`,
        source: `level-${flowLevelId}`,
        target: `level-${destLevelId}`,
        animated: true,
        style: { stroke: '#22c55e', strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#22c55e' },
        ...(destZoneName ? { label: destZoneName, labelStyle: { fontSize: 10, fill: '#94a3b8' } } : {}),
      });
    });
  });

  return { nodes, edges };
}

export default function TrafficFlowView({ devices, levels, currentLevel, onUpdateDevice }) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildFlowGraph(devices, levels, currentLevel),
    [devices, levels, currentLevel]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync nodes/edges when data changes
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const camerasWithFlow = devices.filter(d => d.type?.startsWith('cam-') && d.trafficFlow?.direction);

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-card/50 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Traffic Flow Visualization</h3>
          <p className="text-xs text-muted-foreground">
            {camerasWithFlow.length} camera{camerasWithFlow.length !== 1 ? 's' : ''} with traffic flow configured
          </p>
        </div>
      </div>

      {/* Flow Canvas */}
      <div className="flex-1">
        {camerasWithFlow.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            fitView
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#495057" gap={20} size={1} />
            <Controls className="[&>button]:bg-card [&>button]:border-border [&>button]:text-foreground" />
            <MiniMap
              nodeColor="#3b82f6"
              maskColor="rgba(0,0,0,0.7)"
              className="!bg-card !border-border"
            />
          </ReactFlow>
        ) : (
          <div className="flex-1 h-full flex flex-col items-center justify-center text-muted-foreground">
            <svg className="w-16 h-16 mb-4 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
            <p className="text-sm font-medium mb-1">No Traffic Flows</p>
            <p className="text-xs">Configure back-of-car direction on cameras in the Layout tab to see flows here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
