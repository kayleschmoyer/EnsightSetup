import React, { useState, useCallback } from 'react';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from './ui/dialog';
import { Plus } from 'lucide-react';

const ADD_NEW_VALUE = '__add_new__';

/**
 * Dropdown to assign a device to a site-level group (display or sensor).
 * Mirrors server assignment: select existing or add a new group.
 */
export default function GroupAssignmentSelect({
  label,
  description,
  value,
  groups = [],
  getGroupLabel = (g) => g.name || g.groupId || '',
  getGroupId = (g) => g.id,
  onChange,
  onAddGroup,
  noneLabel = 'No group',
  addDialogTitle = 'Add Group',
  addDialogDescription = 'Groups batch device updates so signs or sensors are not all polled at once.',
  addNameLabel = 'Group name',
  addPlaceholder = 'e.g. Group1',
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const selectValue = value != null ? String(value) : 'none';

  const handleSelect = useCallback((v) => {
    if (v === ADD_NEW_VALUE) {
      setNewName('');
      setShowAdd(true);
      return;
    }
    onChange(v === 'none' ? null : v);
  }, [onChange]);

  const handleAdd = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed || !onAddGroup) return;
    setAdding(true);
    try {
      const created = await onAddGroup(trimmed);
      if (created?.id != null) {
        onChange(created.id);
      }
      setShowAdd(false);
      setNewName('');
    } finally {
      setAdding(false);
    }
  }, [newName, onAddGroup, onChange]);

  return (
    <div>
      <Label>{label}</Label>
      {description && (
        <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
      )}
      <div className="flex gap-2 mt-1.5">
        <Select value={selectValue} onValueChange={handleSelect}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder={noneLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{noneLabel}</SelectItem>
            {groups.map((g) => (
              <SelectItem key={getGroupId(g)} value={String(getGroupId(g))}>
                {getGroupLabel(g)}
              </SelectItem>
            ))}
            {onAddGroup && (
              <SelectItem value={ADD_NEW_VALUE} className="text-primary font-medium">
                + Add new group…
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {onAddGroup && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="Add group"
            onClick={() => {
              setNewName('');
              setShowAdd(true);
            }}
          >
            <Plus className="w-4 h-4" />
          </Button>
        )}
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{addDialogTitle}</DialogTitle>
            <DialogDescription>{addDialogDescription}</DialogDescription>
          </DialogHeader>
          <div>
            <Label>{addNameLabel}</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={addPlaceholder}
              className="mt-1.5"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
              }}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowAdd(false)} disabled={adding}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={!newName.trim() || adding}>
              {adding ? 'Adding…' : 'Add Group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
