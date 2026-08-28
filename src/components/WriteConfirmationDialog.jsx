import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { ShieldAlert } from 'lucide-react';
import { registerWriteConfirmationHandler } from '../services/WriteGuard';

function formatValue(value) {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * App-root dialog for the write-interception compliance gate (WriteGuard.js).
 * Every blocked insert/update/upsert/delete pops this up with exactly what
 * would have been written. There is no "proceed anyway" — this is the whole
 * behavior for a write until live writes are explicitly re-enabled in code.
 */
export default function WriteConfirmationDialog() {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    registerWriteConfirmationHandler((next) => setSummary(next));
    return () => registerWriteConfirmationHandler(null);
  }, []);

  return (
    <Dialog open={Boolean(summary)} onOpenChange={(open) => !open && setSummary(null)}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive shrink-0" />
            Live write blocked
          </DialogTitle>
          <DialogDescription>
            {summary?.title} — this action did not run against the database. Nothing was saved.
          </DialogDescription>
        </DialogHeader>

        {summary?.tables?.length > 0 && (
          <div className="text-sm">
            <div className="font-medium mb-1">Table(s) affected</div>
            <div className="flex flex-wrap gap-1">
              {summary.tables.map((t, i) => (
                <span key={`${t}-${i}`} className="px-2 py-0.5 rounded bg-muted text-xs font-mono">{t}</span>
              ))}
            </div>
          </div>
        )}

        {summary?.changes?.length > 0 && (
          <div className="space-y-3">
            {summary.changes.map((change, i) => (
              <div key={i} className="border border-border rounded-lg p-3 text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted">{change.table}</span>
                  <span className="text-xs text-muted-foreground">{change.identifier}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Before</div>
                    <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                      {formatValue(change.before)}
                    </pre>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">After</div>
                    <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                      {formatValue(change.after)}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {summary?.note && (
          <p className="text-xs text-muted-foreground italic">{summary.note}</p>
        )}

        <DialogFooter>
          <Button onClick={() => setSummary(null)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
