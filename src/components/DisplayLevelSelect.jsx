import React, { useCallback } from 'react';
import { Label } from './ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';

/**
 * Site + level assignment for the DisplayLevels config sheet tab.
 */
export default function DisplayLevelSelect({
  sites = [],
  siteId,
  levelAll = false,
  levelIds = [],
  onSiteChange,
  onLevelAllChange,
  onLevelIdsChange,
}) {
  const site = sites.find((s) => s.id === siteId);
  const levels = site?.levels || [];

  const toggleLevel = useCallback((id) => {
    if (levelAll) return;
    const next = levelIds.includes(id)
      ? levelIds.filter((x) => x !== id)
      : [...levelIds, id];
    onLevelIdsChange(next);
  }, [levelAll, levelIds, onLevelIdsChange]);

  const levelButtonClass = (active) => (
    `w-full text-left px-3 py-1.5 rounded-md text-xs cursor-pointer transition-all ${
      active
        ? 'bg-primary/10 text-primary border border-primary/20'
        : 'bg-muted text-muted-foreground hover:bg-accent border border-transparent'
    }`
  );

  return (
    <div className="space-y-3">
      <div>
        <Label>Site</Label>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Site for this display on the DisplayLevels tab.
        </p>
        <Select
          value={siteId != null ? String(siteId) : 'none'}
          onValueChange={(v) => onSiteChange(v === 'none' ? null : v)}
        >
          <SelectTrigger className="mt-1.5">
            <SelectValue placeholder="Select site..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select site...</SelectItem>
            {sites.map((s) => (
              <SelectItem key={s.id} value={String(s.id)}>
                {s.name || s.internalName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {siteId != null && (
        <div>
          <Label>Levels</Label>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Select one or more levels, or choose All for every level in this site.
          </p>
          <div className="mt-1.5 space-y-1">
            <button
              type="button"
              aria-pressed={levelAll}
              onClick={() => onLevelAllChange(!levelAll)}
              className={levelButtonClass(levelAll)}
            >
              All
            </button>
            {!levelAll && levels.map((level) => {
              const selected = levelIds.includes(level.id);
              return (
                <button
                  key={level.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleLevel(level.id)}
                  className={levelButtonClass(selected)}
                >
                  {level.name || level.internalName}
                </button>
              );
            })}
            {!levelAll && levels.length === 0 && (
              <p className="text-[10px] text-muted-foreground px-1">No levels in this site.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
