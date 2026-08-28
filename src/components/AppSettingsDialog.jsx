import React from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Cloud } from 'lucide-react';

export default function AppSettingsDialog({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            How Garage Editor stores your changes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-start gap-3 rounded-xl border border-border/80 bg-muted/20 p-4">
            <Cloud className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div className="min-w-0 text-xs text-muted-foreground leading-relaxed space-y-1.5">
              <p className="text-sm font-semibold text-foreground">Shared database</p>
              <p>
                All customer data — sites, levels, devices, zones, and floor plans — lives in the
                shared database and auto-saves as you edit, so everyone signed in sees the same state.
              </p>
              <p>
                Nothing is stored in this browser. Sign in to see and edit customers.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
