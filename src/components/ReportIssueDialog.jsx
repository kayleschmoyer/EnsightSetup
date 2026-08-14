import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Loader2, MessageSquarePlus, X } from 'lucide-react';
import {
  submitClickUpFeedback,
  buildFeedbackContext,
  prepareFeedbackScreenshot,
} from '../services/ClickUpFeedbackService';
import {
  useAppStore,
  useCurrentCustomer,
  useCurrentGarage,
  useCurrentLevel,
} from '../stores/useAppStore';
import PhotoPickControls from './PhotoPickControls';

const ISSUE_TYPES = [
  { id: 'bug', label: 'Bug' },
  { id: 'request', label: 'Request' },
  { id: 'question', label: 'Question' },
  { id: 'other', label: 'Other' },
];

const EMPTY_FORM = {
  title: '',
  description: '',
  type: 'bug',
  reporter: '',
};

export default function ReportIssueDialog({ open, onOpenChange }) {
  const customer = useCurrentCustomer();
  const garage = useCurrentGarage();
  const level = useCurrentLevel();
  const currentView = useAppStore((s) => s.currentView);

  const [form, setForm] = useState(EMPTY_FORM);
  const [screenshot, setScreenshot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [taskUrl, setTaskUrl] = useState('');
  const [warning, setWarning] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY_FORM);
    setScreenshot(null);
    setError('');
    setWarning('');
    setSubmitted(false);
    setTaskUrl('');
    setSubmitting(false);
  }, [open]);

  const attachScreenshot = async (file) => {
    if (!file || submitting) return;
    setError('');
    try {
      const prepared = await prepareFeedbackScreenshot(file);
      setScreenshot(prepared);
    } catch (err) {
      setError(err.message || 'Could not attach screenshot.');
    }
  };

  const handlePaste = async (event) => {
    if (submitting) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type?.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) await attachScreenshot(file);
        return;
      }
    }
  };

  const handleSubmit = async () => {
    if (!form.title.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    setWarning('');
    try {
      const result = await submitClickUpFeedback({
        title: form.title,
        description: form.description,
        type: form.type,
        reporter: form.reporter,
        context: buildFeedbackContext({
          customer,
          garage,
          level,
          pathname: typeof window !== 'undefined' ? window.location.pathname : currentView,
        }),
        screenshot: screenshot
          ? {
            filename: screenshot.filename,
            contentType: screenshot.contentType,
            dataBase64: screenshot.dataBase64,
          }
          : null,
      });
      setTaskUrl(result.taskUrl || '');
      setWarning(result.warning || '');
      setSubmitted(true);
      setForm(EMPTY_FORM);
      setScreenshot(null);
    } catch (err) {
      setError(err.message || 'Failed to create ClickUp task.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (submitting) return;
      onOpenChange(next);
    }}>
      <DialogContent className="sm:max-w-md" onPaste={handlePaste}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="w-4 h-4 text-primary" />
            Report issue / request
          </DialogTitle>
          <DialogDescription>
            Sends a bug report or request to ClickUp so it can be tracked without leaving the app.
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div className="space-y-3 py-1">
            <p className="text-sm text-foreground">Thanks — the task was created and assigned.</p>
            {warning ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">{warning}</p>
            ) : null}
            {taskUrl ? (
              <a
                href={taskUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline break-all"
              >
                Open in ClickUp
              </a>
            ) : null}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <Label htmlFor="feedback-type">Type</Label>
                <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Issue type">
                  {ISSUE_TYPES.map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={form.type === id}
                      onClick={() => setForm((f) => ({ ...f, type: id }))}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
                        form.type === id
                          ? 'bg-primary/10 text-primary border-primary/25'
                          : 'bg-muted text-muted-foreground border-transparent hover:bg-accent'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label htmlFor="feedback-title">Title *</Label>
                <Input
                  id="feedback-title"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Short summary of the issue or request"
                  className="mt-1.5"
                  maxLength={200}
                  disabled={submitting}
                />
              </div>

              <div>
                <Label htmlFor="feedback-description">Details</Label>
                <Textarea
                  id="feedback-description"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What happened, what you expected, and any steps to reproduce."
                  className="mt-1.5 min-h-[100px]"
                  maxLength={8000}
                  disabled={submitting}
                />
              </div>

              <div>
                <Label>Screenshot <span className="text-muted-foreground font-normal">(optional)</span></Label>
                {screenshot ? (
                  <div className="mt-1.5 relative rounded-md border border-border overflow-hidden bg-muted/30">
                    <img
                      src={screenshot.previewUrl}
                      alt="Screenshot preview"
                      className="max-h-40 w-full object-contain bg-background"
                    />
                    <button
                      type="button"
                      onClick={() => setScreenshot(null)}
                      disabled={submitting}
                      className="absolute top-1.5 right-1.5 p-1 rounded-md bg-background/90 border border-border hover:bg-accent cursor-pointer"
                      aria-label="Remove screenshot"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="mt-1.5 flex flex-col gap-2">
                    <PhotoPickControls
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      disabled={submitting}
                      uploadLabel="Upload image"
                      hint="On a phone or tablet, Take photo opens the camera. You can also paste with Ctrl+V / ⌘V."
                      onFiles={(files) => {
                        const file = files[0];
                        if (file) attachScreenshot(file);
                      }}
                    />
                  </div>
                )}
              </div>

              <div>
                <Label htmlFor="feedback-reporter">
                  Your name or email <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="feedback-reporter"
                  value={form.reporter}
                  onChange={(e) => setForm((f) => ({ ...f, reporter: e.target.value }))}
                  placeholder="so we can follow up if needed"
                  className="mt-1.5"
                  maxLength={200}
                  disabled={submitting}
                />
              </div>

              {(customer || garage || level) && (
                <p className="text-[10px] text-muted-foreground">
                  Current context will be included automatically
                  {customer?.friendlyName ? `: ${customer.friendlyName}` : ''}
                  {garage?.name ? ` / ${garage.name}` : ''}
                  {level?.name ? ` / ${level.name}` : ''}.
                </p>
              )}

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!form.title.trim() || submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  'Send to ClickUp'
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
