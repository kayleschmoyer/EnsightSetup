import React, { useState, useMemo, useCallback, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useAppStore } from '../stores/useAppStore';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import {
  generateCameraHubConfig,
  generateDevicesConfig,
  generateFLICameraConfig,
  generateFLIGlobalConfig,
  downloadFile as downloadConfigFile,
} from '../services/ConfigService';
import { Download, Copy, Check, FileCode2, Building2, Layers, ChevronRight, ChevronDown, RotateCcw, Search, X } from 'lucide-react';

// Use locally installed monaco-editor instead of CDN
loader.config({ monaco });

export default function ConfigEditor({ garages }) {
  const [activeConfig, setActiveConfig] = useState('devices-all');
  const [copied, setCopied] = useState(false);
  const [edits, setEdits] = useState({}); // { [configKey]: editedContent }
  const [search, setSearch] = useState('');
  const [collapsedGarages, setCollapsedGarages] = useState({});
  const [globalCollapsed, setGlobalCollapsed] = useState(false);
  const mode = useAppStore(s => s.mode);

  // Gather ALL devices across all garages and levels
  const allDevices = useMemo(() => {
    const devs = [];
    (garages || []).forEach(g => {
      (g.levels || []).forEach(l => {
        (l.devices || []).forEach(d => {
          devs.push({ ...d, _garageName: g.name, _levelName: l.name });
        });
      });
    });
    return devs;
  }, [garages]);

  const allCameras = useMemo(() => allDevices.filter(d => d.type?.startsWith('cam-')), [allDevices]);
  const allFliCameras = useMemo(() => allCameras.filter(d => d.type === 'cam-fli'), [allCameras]);

  // Build per-garage configs too
  const garageConfigs = useMemo(() => {
    const gc = [];
    (garages || []).forEach(g => {
      const gDevices = [];
      (g.levels || []).forEach(l => {
        (l.devices || []).forEach(d => gDevices.push(d));
      });
      if (gDevices.length > 0) {
        gc.push({ garage: g, devices: gDevices });
      }
    });
    return gc;
  }, [garages]);

  const configs = useMemo(() => {
    const cfgs = {};
    // All devices combined
    try {
      cfgs['devices-all'] = generateDevicesConfig(allDevices);
    } catch { cfgs['devices-all'] = '<!-- No devices to generate config for -->'; }
    // All cameras combined
    try {
      cfgs['camerahub-all'] = allCameras.length > 0 ? generateCameraHubConfig(allCameras) : '<!-- No cameras configured -->';
    } catch { cfgs['camerahub-all'] = '<!-- Error generating CameraHub config -->'; }
    // Per-garage configs
    garageConfigs.forEach(({ garage, devices }) => {
      const cameras = devices.filter(d => d.type?.startsWith('cam-'));
      try {
        cfgs[`devices-${garage.id}`] = generateDevicesConfig(devices);
      } catch { cfgs[`devices-${garage.id}`] = `<!-- Error generating config for ${garage.name} -->`; }
      if (cameras.length > 0) {
        try {
          cfgs[`camerahub-${garage.id}`] = generateCameraHubConfig(cameras);
        } catch { cfgs[`camerahub-${garage.id}`] = `<!-- Error -->`; }
      }
    });
    // Individual FLI camera configs
    allFliCameras.forEach(cam => {
      try {
        cfgs[`fli-${cam.id}`] = generateFLICameraConfig(cam);
      } catch { cfgs[`fli-${cam.id}`] = `<!-- Error generating FLI config for ${cam.name} -->`; }
    });
    // FLI Global config (site-wide)
    try {
      const siteName = (garages || [])[0]?.name?.replace(/\s+/g, '') || 'EnsightProject';
      cfgs['fli-global'] = generateFLIGlobalConfig({ siteName });
    } catch { cfgs['fli-global'] = '<!-- Error generating FLI Global config -->'; }

    return cfgs;
  }, [allDevices, allCameras, allFliCameras, garageConfigs]);

  const currentContent = edits[activeConfig] ?? configs[activeConfig] ?? '';
  const isEdited = activeConfig in edits;

  const handleEditorChange = useCallback((value) => {
    setEdits(prev => ({ ...prev, [activeConfig]: value }));
  }, [activeConfig]);

  const handleResetCurrent = useCallback(() => {
    setEdits(prev => {
      const next = { ...prev };
      delete next[activeConfig];
      return next;
    });
  }, [activeConfig]);

  const handleDownload = useCallback(() => {
    let filename = 'config.xml';
    if (activeConfig === 'devices-all') filename = 'DevicesConfig.xml';
    else if (activeConfig === 'camerahub-all') filename = 'CameraHubConfig.xml';
    else if (activeConfig === 'fli-global') filename = 'FLI-config.xml';
    else if (activeConfig.startsWith('fli-')) filename = `${activeConfig}.xml`;
    else if (activeConfig.startsWith('devices-')) {
      const g = garageConfigs.find(gc => `devices-${gc.garage.id}` === activeConfig);
      filename = g ? `${g.garage.name}-DevicesConfig.xml` : 'DevicesConfig.xml';
    } else if (activeConfig.startsWith('camerahub-')) {
      const g = garageConfigs.find(gc => `camerahub-${gc.garage.id}` === activeConfig);
      filename = g ? `${g.garage.name}-CameraHubConfig.xml` : 'CameraHubConfig.xml';
    }
    downloadConfigFile(currentContent, filename);
  }, [activeConfig, currentContent, garageConfigs]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(currentContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentContent]);

  const handleDownloadAll = useCallback(() => {
    Object.entries(configs).forEach(([key, content]) => {
      let fname = `${key}.xml`;
      if (key === 'devices-all') fname = 'DevicesConfig.xml';
      else if (key === 'camerahub-all') fname = 'CameraHubConfig.xml';
      downloadConfigFile(content, fname);
    });
  }, [configs]);

  return (
    <div className="flex-1 flex flex-col">
      {/* Toolbar */}
      <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileCode2 className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Configuration Editor</h3>
          <Badge variant="outline" className="h-5 text-[10px]">
            {allDevices.length} device{allDevices.length !== 1 ? 's' : ''} across {(garages || []).length} site{(garages || []).length !== 1 ? 's' : ''}
          </Badge>
          {isEdited && (
            <Badge variant="secondary" className="h-5 text-[10px] bg-amber-500/15 text-amber-500" title="Preview edits only — not saved to devices">
              Modified (preview)
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isEdited && (
            <Button variant="outline" size="sm" onClick={handleResetCurrent} className="h-7 text-xs" title="Reset to generated">
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Reset
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleCopy} className="h-7 text-xs">
            {copied ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload} className="h-7 text-xs">
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Download
          </Button>
          <Button size="sm" onClick={handleDownloadAll} className="h-7 text-xs" title="Regenerates XML from devices and downloads all configs">
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Export All
          </Button>
        </div>
      </div>
      <p className="px-4 py-1.5 text-[11px] text-muted-foreground border-b border-border bg-muted/20">
        Edits here are preview-only and are not saved to the customer. Export regenerates from devices.
      </p>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* File tree */}
        <div className="w-60 border-r border-border bg-card/30 flex flex-col min-h-0">
          {/* Search */}
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files..."
                className="h-7 text-xs pl-7 pr-7"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  title="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          <ScrollArea className="flex-1 min-h-0">
          <div className="py-2">
            {(() => {
              const q = search.trim().toLowerCase();
              const matches = (label) => !q || label.toLowerCase().includes(q);

              // Global files
              const globalFiles = [
                { key: 'devices-all', label: 'DevicesConfig.xml' },
                { key: 'camerahub-all', label: 'CameraHubConfig.xml' },
                { key: 'fli-global', label: 'FLI-config.xml' },
              ].filter(f => matches(f.label));

              const renderFileButton = (key, label) => (
                <button
                  key={key}
                  onClick={() => setActiveConfig(key)}
                  className={`w-full text-left px-3 py-1.5 rounded-md text-xs cursor-pointer transition-colors truncate ${
                    activeConfig === key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  title={label}
                >
                  {label}
                </button>
              );

              const renderedGarages = garageConfigs
                .map(({ garage, devices }) => {
                  const cameras = devices.filter(d => d.type?.startsWith('cam-'));
                  const flis = devices.filter(d => d.type === 'cam-fli');
                  const files = [
                    { key: `devices-${garage.id}`, label: 'DevicesConfig.xml' },
                  ];
                  if (cameras.length > 0) files.push({ key: `camerahub-${garage.id}`, label: 'CameraHubConfig.xml' });
                  flis.forEach(cam => files.push({ key: `fli-${cam.id}`, label: `${cam.name}.xml` }));
                  const filteredFiles = files.filter(f => matches(f.label) || matches(garage.name));
                  return { garage, files: filteredFiles };
                })
                .filter(g => g.files.length > 0);

              const hasAny = globalFiles.length > 0 || renderedGarages.length > 0;

              return (
                <>
                  {globalFiles.length > 0 && (
                    <div className="mb-2">
                      <button
                        onClick={() => setGlobalCollapsed(v => !v)}
                        className="w-full flex items-center gap-1 px-2 py-1 hover:bg-accent/40 rounded"
                      >
                        {globalCollapsed ? <ChevronRight className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
                        <Layers className="w-3 h-3 text-muted-foreground" />
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold flex-1 text-left">All Sites</p>
                        <span className="text-[10px] text-muted-foreground/60">{globalFiles.length}</span>
                      </button>
                      {!globalCollapsed && (
                        <div className="space-y-0.5 px-1 mt-0.5">
                          {globalFiles.map(f => renderFileButton(f.key, f.label))}
                        </div>
                      )}
                    </div>
                  )}

                  {renderedGarages.map(({ garage, files }) => {
                    const isCollapsed = q ? false : !!collapsedGarages[garage.id];
                    return (
                      <div key={garage.id} className="mb-2">
                        <button
                          onClick={() => setCollapsedGarages(prev => ({ ...prev, [garage.id]: !prev[garage.id] }))}
                          className="w-full flex items-center gap-1 px-2 py-1 hover:bg-accent/40 rounded"
                          title={garage.name}
                        >
                          {isCollapsed ? <ChevronRight className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
                          <Building2 className="w-3 h-3 text-muted-foreground" />
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold flex-1 truncate text-left">{garage.name}</p>
                          <span className="text-[10px] text-muted-foreground/60">{files.length}</span>
                        </button>
                        {!isCollapsed && (
                          <div className="space-y-0.5 px-1 mt-0.5">
                            {files.map(f => renderFileButton(f.key, f.label))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {!hasAny && (
                    <div className="px-3 py-4 text-center text-muted-foreground">
                      <p className="text-xs">{q ? 'No files match' : 'No devices configured'}</p>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
          </ScrollArea>
        </div>

        {/* Editor */}
        <div className="flex-1">
          <Editor
            height="100%"
            language="xml"
            theme={mode === 'dark' ? 'vs-dark' : 'light'}
            value={currentContent}
            onChange={handleEditorChange}
            options={{
              minimap: { enabled: true },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 12 },
              automaticLayout: true,
              formatOnPaste: true,
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
            }}
            loading={
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                Loading editor...
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
