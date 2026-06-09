'use client';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

export function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const unlock = trpc.vault.unlock.useMutation({
    onSuccess: () => onUnlocked(),
    onError: (e) => setError(e.message),
  });

  return (
    <div className="max-w-md mx-auto mt-24 bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-1">Unlock vault</h2>
      <p className="text-sm text-[var(--color-muted)] mb-4">
        Enter the passphrase you set with <code>amm vault init</code>.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          unlock.mutate({ passphrase });
        }}
      >
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
          className="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] mono"
          placeholder="passphrase"
        />
        {error && <p className="text-sm text-[var(--color-danger)] mt-2">{error}</p>}
        <button
          type="submit"
          disabled={unlock.isPending || passphrase.length === 0}
          className="mt-4 w-full px-3 py-2 rounded bg-[var(--color-accent)] text-black font-medium disabled:opacity-50"
        >
          {unlock.isPending ? 'unlocking...' : 'unlock'}
        </button>
      </form>
    </div>
  );
}
