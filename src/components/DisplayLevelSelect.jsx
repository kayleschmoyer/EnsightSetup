import React, { useCallback } from 'react';
import { Label } from './ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';

/**
 * Garage + level assignment for the DisplayLevels config sheet tab.
 */
export default function DisplayLevelSelect({
  garages = [],
  garageId,
  levelAll = false,
  levelIds = [],
  onGarageChange,
  onLevelAllChange,
  onLevelIdsChange,
}) {
  const garage = garages.find((g) => g.id === garageId);
  const levels = garage?.levels || [];

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
        <Label>Garage</Label>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Site for this display on the DisplayLevels tab.
        </p>
        <Select
          value={garageId != null ? String(garageId) : 'none'}
          onValueChange={(v) => onGarageChange(v === 'none' ? null : Number(v))}
        >
          <SelectTrigger className="mt-1.5">
            <SelectValue placeholder="Select garage..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select garage...</SelectItem>
            {garages.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>
                {g.name || g.internalName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {garageId != null && (
        <div>
          <Label>Levels</Label>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Select one or more levels, or choose All for every level in this garage.
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
              <p className="text-[10px] text-muted-foreground px-1">No levels in this garage.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
