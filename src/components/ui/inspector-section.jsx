import React, { useCallback, useState } from 'react';
import * as Accordion from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

const STORAGE_KEY = 'inspector.sections.v1';

function readSectionState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSectionState(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Collapsible inspector card with optional collapsed summary and localStorage persistence.
 */
export function InspectorSection({
  id,
  title,
  summary,
  defaultOpen = false,
  actions = null,
  children,
  className,
}) {
  const [open, setOpen] = useState(() => {
    const stored = readSectionState();
    if (typeof stored[id] === 'boolean') return stored[id];
    return !!defaultOpen;
  });

  const onValueChange = useCallback((value) => {
    const nextOpen = value === id;
    setOpen(nextOpen);
    writeSectionState({ ...readSectionState(), [id]: nextOpen });
  }, [id]);

  return (
    <Accordion.Root
      type="single"
      collapsible
      value={open ? id : ''}
      onValueChange={onValueChange}
      className={cn('rounded-lg border border-border bg-muted/20', className)}
    >
      <Accordion.Item value={id} className="border-none group">
        <Accordion.Header className="flex items-center gap-1 px-1">
          <Accordion.Trigger
            className="flex flex-1 items-center justify-between gap-2 px-2 py-2 cursor-pointer select-none text-left outline-none"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-[.08em] text-muted-foreground shrink-0">
              {title}
            </span>
            <span className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
              {summary != null && summary !== '' && (
                <span className="text-[10.5px] text-muted-foreground/70 truncate max-w-[180px] group-data-[state=open]:hidden">
                  {summary}
                </span>
              )}
              <ChevronDown
                className="h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
                aria-hidden
              />
            </span>
          </Accordion.Trigger>
          {actions != null && (
            <div className="shrink-0 pr-2">
              {actions}
            </div>
          )}
        </Accordion.Header>
        {/* forceMount keeps fields in the DOM when collapsed (tests + form state). */}
        <Accordion.Content
          forceMount
          className="overflow-hidden data-[state=closed]:hidden"
        >
          <div className="px-3 pb-3 pt-0.5 space-y-2.5">
            {children}
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  );
}

export default InspectorSection;
