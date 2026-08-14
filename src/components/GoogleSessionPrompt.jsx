import React, { useCallback, useEffect, useState } from 'react';
import {
  hadGoogleSession,
  isSignedIn,
  isTokenExpiringSoon,
  publishGoogleAuthState,
  refreshAccessTokenSilently,
  signInWithGoogle,
  subscribeGoogleAuth,
  verifySharedFolderAccess,
} from '../services/GoogleDriveService';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';

/**
 * Global Google session UI — re-auth from any screen when the OAuth token expires.
 */
export default function GoogleSessionPrompt() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signedIn, setSignedIn] = useState(() => isSignedIn());

  const refreshSessionState = useCallback(() => {
    if (hadGoogleSession() && !isSignedIn()) {
      setOpen(true);
      setError('');
    } else {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    refreshSessionState();
    return subscribeGoogleAuth((nextSignedIn) => {
      setSignedIn(Boolean(nextSignedIn));
      if (nextSignedIn) {
        setOpen(false);
        setError('');
      } else if (hadGoogleSession()) {
        setOpen(true);
        setError('');
      } else {
        setOpen(false);
      }
    });
  }, [refreshSessionState]);

  // Re-arms whenever auth changes, so signing in later (e.g. via this popup)
  // still gets proactive silent token renewal.
  useEffect(() => {
    if (!signedIn) return undefined;

    const renewSoon = async () => {
      if (!isTokenExpiringSoon()) return;
      try {
        await refreshAccessTokenSilently();
      } catch {
        refreshSessionState();
      }
    };

    renewSoon();
    const intervalId = setInterval(renewSoon, 2 * 60_000);
    return () => clearInterval(intervalId);
  }, [signedIn, refreshSessionState]);

  const handleSignIn = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await signInWithGoogle({ prompt: 'select_account' });
      const hasDriveAccess = await verifySharedFolderAccess();
      if (!hasDriveAccess) {
        const message =
          'Signed in, but Google Drive access to the configuration folder was denied. ' +
          'Ask an administrator to share the folder, or sign in again and approve Drive permissions.';
        publishGoogleAuthState(true, { driveAccessDenied: true, error: message });
        setError(message);
        return;
      }
      publishGoogleAuthState(true, { driveAccessDenied: false });
      setOpen(false);
    } catch (err) {
      setError(err.message || 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  }, []);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !isSignedIn()) setOpen(true); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Google session expired</DialogTitle>
          <DialogDescription>
            Your Google sign-in timed out. Drive catalog Sync and shared SetupJson layout sync need a
            fresh sign-in. You can sign in here without leaving this page.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button onClick={handleSignIn} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in with Google'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
