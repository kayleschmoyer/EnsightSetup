import React, { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import {
  DEFAULT_CUSTOMER_SUPPORT,
  MAINTENANCE_PROVIDERS,
  normalizeCustomerSupport,
  normalizeCustomerConfig,
  customerConfigPatch,
} from '../lib/customerUtils';
import { updateCustomerInfo } from '../services/CustomerRepository';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from './ui/select';
import { Building2, Clock, Headphones, Wrench } from 'lucide-react';
import { cn } from '../lib/utils';

function SupportToggleCard({
  active,
  onToggle,
  icon: Icon,
  title,
  description,
  activeClassName,
  iconClassName,
  switchClassName,
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={cn(
        'relative w-full rounded-xl border p-3.5 text-left transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        active
          ? activeClassName
          : 'border-border/80 bg-muted/15 hover:border-primary/25 hover:bg-muted/25',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
              active ? iconClassName : 'border-border/70 bg-background/50 text-muted-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">{title}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{description}</p>
          </div>
        </div>
        <Switch
          checked={active}
          onCheckedChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={title}
          className={switchClassName}
        />
      </div>
    </button>
  );
}

export default function CustomerSupportDialog({ customer, open, onOpenChange }) {
  const updateCustomer = useAppStore((s) => s.updateCustomer);
  const [form, setForm] = useState(DEFAULT_CUSTOMER_SUPPORT);
  const [syncError, setSyncError] = useState('');

  useEffect(() => {
    if (!customer || !open) return;
    setForm(normalizeCustomerConfig(customer).support);
    setSyncError('');
  }, [customer, open]);

  const handleSave = useCallback(async () => {
    if (!customer) return;
    setSyncError('');
    const normalized = normalizeCustomerSupport({
      ...form,
      maintenanceOther: form.maintenanceProvider === 'other' ? form.maintenanceOther.trim() : '',
    });
    const updates = customerConfigPatch(customer, { support: normalized });
    try {
      const { updatedAt } = await updateCustomerInfo(customer.id, {
        friendlyName: customer.friendlyName || '',
        support: normalized,
      });
      updateCustomer(customer.id, { ...updates, lastSetupSavedAt: updatedAt });
    } catch (err) {
      setSyncError(
        err.message || 'Save failed — nothing was changed. Check your connection and try again.',
      );
      return;
    }
    onOpenChange(false);
  }, [customer, form, onOpenChange, updateCustomer]);

  if (!customer) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden">
        <div className="px-6 pt-6 pb-4 border-b border-border/60 bg-gradient-to-br from-primary/5 via-transparent to-amber-500/5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Headphones className="w-5 h-5 text-primary" />
              Support Information
            </DialogTitle>
            <DialogDescription className="truncate">
              {customer.friendlyName}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              <Wrench className="w-3.5 h-3.5" />
              Maintenance responsibility
            </Label>
            <Select
              value={form.maintenanceProvider || 'unset'}
              onValueChange={(value) => setForm((prev) => ({
                ...prev,
                maintenanceProvider: value === 'unset' ? '' : value,
                maintenanceOther: value === 'other' ? prev.maintenanceOther : '',
              }))}
            >
              <SelectTrigger className="h-9 bg-background/60">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unset">Not set</SelectItem>
                {Object.entries(MAINTENANCE_PROVIDERS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.maintenanceProvider === 'other' && (
              <Input
                value={form.maintenanceOther}
                onChange={(e) => setForm((prev) => ({ ...prev, maintenanceOther: e.target.value }))}
                placeholder="Enter maintenance provider"
                className="h-9"
                maxLength={120}
              />
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SupportToggleCard
              active={form.enterpriseSite}
              onToggle={() => setForm((prev) => ({ ...prev, enterpriseSite: !prev.enterpriseSite }))}
              icon={Building2}
              title="Enterprise Site"
              description="Priority account with elevated support tier"
              activeClassName="border-amber-400/45 bg-gradient-to-br from-amber-500/12 via-amber-500/5 to-transparent shadow-[inset_0_1px_0_rgba(251,191,36,0.15)]"
              iconClassName="border-amber-400/40 bg-amber-500/15 text-amber-600 dark:text-amber-300"
              switchClassName="data-[state=checked]:bg-amber-500"
            />
            <SupportToggleCard
              active={form.support24Hour}
              onToggle={() => setForm((prev) => ({ ...prev, support24Hour: !prev.support24Hour }))}
              icon={Clock}
              title="24 Hour Support"
              description="Round-the-clock coverage for this customer"
              activeClassName="border-cyan-400/40 bg-gradient-to-br from-cyan-500/12 via-sky-500/5 to-transparent shadow-[inset_0_1px_0_rgba(34,211,238,0.12)]"
              iconClassName="border-cyan-400/35 bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"
              switchClassName="data-[state=checked]:bg-cyan-500"
            />
          </div>
        </div>

        {syncError && (
          <div className="mx-6 mb-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">Sheet sync failed</p>
            <p className="text-sm text-destructive mt-1">{syncError}</p>
          </div>
        )}

        <DialogFooter className="px-6 py-4 border-t border-border/60 bg-muted/10">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
