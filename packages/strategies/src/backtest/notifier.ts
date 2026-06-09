import { exec } from 'node:child_process';
import { createLogger } from '@amm/shared';

const log = createLogger('notifier');

/**
 * Cross-platform desktop notifications. Best-effort; if the OS-specific path
 * fails, falls back to logging.
 *
 *  - macOS: `osascript -e 'display notification ...'`
 *  - Linux: `notify-send`
 *  - Windows: powershell BurntToast / fallback to logging
 */
export function notify(title: string, body: string): void {
  const t = title.replace(/"/g, '\\"');
  const b = body.replace(/"/g, '\\"');

  const cmd = (() => {
    switch (process.platform) {
      case 'darwin':
        return `osascript -e 'display notification "${b}" with title "${t}"'`;
      case 'linux':
        return `notify-send "${t}" "${b}"`;
      case 'win32':
        // Use a one-liner PowerShell toast that doesn't require a module.
        return `powershell -NoProfile -Command "[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show('${b}','${t}') | Out-Null"`;
      default:
        return null;
    }
  })();

  if (!cmd) {
    log.info({ title, body }, 'notify (unsupported platform; logged)');
    return;
  }

  exec(cmd, (err) => {
    if (err) {
      log.warn({ title, body, err: err.message }, 'notify failed; logged instead');
    }
  });
}
