import React, { useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { HardDrive, Cloud } from 'lucide-react';

export default function AppSettingsDialog({ open, onOpenChange }) {
  const localSaveEnabled = useAppStore((s) => s.localSaveEnabled);
  const localSaveError = useAppStore((s) => s.localSaveError);
  const setLocalSaveEnabled = useAppStore((s) => s.setLocalSaveEnabled);
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);

  const handleLocalSaveChange = (checked) => {
    if (checked) {
      setConfirmEnableOpen(true);
      return;
    }
    setLocalSaveEnabled(false);
  };

  const confirmEnableLocalSave = () => {
    setLocalSaveEnabled(true);
    setConfirmEnableOpen(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              Configure how Garage Editor stores your changes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3 rounded-xl border border-border/80 bg-muted/20 p-4">
              <Cloud className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div className="min-w-0 text-xs text-muted-foreground leading-relaxed space-y-1.5">
                <p className="text-sm font-semibold text-foreground">Shared layout (SetupJson)</p>
                <p>
                  When you are signed in with a linked Google Sheet, map layout, devices, zones, and
                  floor plans auto-save to the <span className="font-medium text-foreground">SetupJson</span> tab
                  so everyone sees the same editor state.
                </p>
                <p>
                  Config sheet tabs (Cameras, DisplayControllers, etc.) sync field data separately.
                </p>
              </div>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-xl border border-border/80 p-4">
              <div className="flex items-start gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
                  <HardDrive className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <Label htmlFor="local-save" className="text-sm font-semibold">
                    Remember opened customers
                  </Label>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Keeps a lightweight list of customers you open in this browser after refresh.
                    When a customer is linked to a Google Sheet, map layout and floor plans are
                    not stored locally — they load from the shared SetupJson tab. Turning this off
                    stops new saves but does not delete data already stored here.
                  </p>
                </div>
              </div>
              <Switch
                id="local-save"
                checked={localSaveEnabled}
                onCheckedChange={handleLocalSaveChange}
                aria-label="Save locally in this browser"
              />
            </div>

            {localSaveError && (
              <p className="text-xs text-destructive">{localSaveError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmEnableOpen} onOpenChange={setConfirmEnableOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remember opened customers?</DialogTitle>
            <DialogDescription className="text-left space-y-2 pt-1">
              <span className="block">
                Customers you open stay listed in this browser after refresh. Linked Google Sheet
                layouts still load from SetupJson — floor plans are not kept in browser storage.
              </span>
              <span className="block">
                You can turn this off at any time in Settings.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmEnableOpen(false)}>Cancel</Button>
            <Button onClick={confirmEnableLocalSave}>Remember opened customers</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
