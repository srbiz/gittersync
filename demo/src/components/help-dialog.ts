export function showHelpDialog(context: 'setup' | 'board' | 'status'): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '500';

  const content = helpContent[context];

  overlay.innerHTML = `
    <div class="modal help-dialog">
      <div class="modal-header">
        <h2>${content.title}</h2>
        <button class="btn-icon" data-action="close-help">✕</button>
      </div>
      <div class="help-body">
        ${content.body}
      </div>
      <div class="modal-footer">
        <button class="btn-primary" data-action="close-help">Got it</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-action="close-help"]').forEach(el => el.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

const helpContent: Record<string, { title: string; body: string }> = {
  setup: {
    title: 'Getting Started – GitterSync Demo',
    body: `
      <div class="help-section">
        <h4>What is GitterSync?</h4>
        <p>GitterSync uses GitHub as a free database backend. Your Kanban tasks are stored as JSON files in a GitHub repository — synced automatically between devices.</p>
      </div>
      <div class="help-section">
        <h4>How to connect</h4>
        <ol>
          <li><strong>Get a PAT</strong> — Create a GitHub Personal Access Token with <code>repo</code> scope at GitHub Settings &gt; Developer settings &gt; Personal access tokens.</li>
          <li><strong>Paste it above</strong> — The token is stored encrypted in your browser's localStorage.</li>
          <li><strong>Use the default repo</strong> — <code>srbiz/gittersync-demo-data</code> works out of the box. Or enter your own.</li>
          <li><strong>Click "Start Demo"</strong> — The app will pull existing tasks from GitHub and open the board.</li>
        </ol>
      </div>
      <div class="help-section">
        <h4>Token encryption</h4>
        <p>Check "Encrypt token with passphrase" to store the token securely. You'll need the passphrase on each new device or after clearing browser data.</p>
      </div>
      <div class="help-section">
        <h4>No GitHub account?</h4>
        <p>You'll need a free GitHub account and a PAT to use this demo. It takes 2 minutes to set up.</p>
      </div>
    `,
  },
  board: {
    title: 'Kanban Board Guide',
    body: `
      <div class="help-section">
        <h4>Creating tasks</h4>
        <p>Click <strong>+ Add Task</strong> at the bottom of any column, or the <strong>➕</strong> button in the column header. Fill in the title, description, priority, assignee, due date, labels, and attachments.</p>
      </div>
      <div class="help-section">
        <h4>Editing &amp; deleting</h4>
        <p>Hover a task card and click <strong>✏️</strong> to edit or <strong>🗑️</strong> to delete. Drag a card to move it between columns.</p>
      </div>
      <div class="help-section">
        <h4>Syncing</h4>
        <ul>
          <li><strong>⬇️ Pull</strong> — Download latest data from GitHub</li>
          <li><strong>⬆️ Push</strong> — Upload your local changes to GitHub</li>
          <li><strong>🔄 Sync</strong> — Full sync (push + pull)</li>
          <li><strong>Auto</strong> — When checked, syncs automatically every 30 seconds</li>
        </ul>
      </div>
      <div class="help-section">
        <h4>Status panel</h4>
        <p>Click <strong>📊 Status</strong> in the status bar to open the Status Panel. From there you can view sync details, run compaction, <strong>📦 Export</strong> data as ZIP, or <strong>📂 Import</strong> a previously exported ZIP.</p>
      </div>
      <div class="help-section">
        <h4>File attachments</h4>
        <p>When creating or editing a task, use the <strong>Attachments</strong> section to upload files. They're stored in the <code>files/</code> folder of your GitHub repo. Click a file name to download it.</p>
      </div>
    `,
  },
  status: {
    title: 'Sync Status Panel',
    body: `
      <div class="help-section">
        <h4>What you see here</h4>
        <p>This panel shows the real-time state of your GitterSync connection. Use it to monitor sync health and perform maintenance operations.</p>
      </div>
      <div class="help-section">
        <h4>Status fields</h4>
        <ul>
          <li><strong>Online</strong> — Are we connected to GitHub?</li>
          <li><strong>Syncing</strong> — Is a sync operation in progress?</li>
          <li><strong>Pending Changes</strong> — Local changes not yet pushed</li>
          <li><strong>Device ID</strong> — Unique identifier for this browser</li>
          <li><strong>Sync Cursor</strong> — Last synced commit SHA</li>
          <li><strong>Rate Limit</strong> — Remaining GitHub API calls</li>
          <li><strong>Repo Size</strong> — GitHub repository size in KB</li>
        </ul>
      </div>
      <div class="help-section">
        <h4>Actions</h4>
        <ul>
          <li><strong>Pull / Push / Full Sync</strong> — Manual sync controls</li>
          <li><strong>🗜️ Compact</strong> — Merges all changelogs into a single collection push. Reduces GitHub API calls.</li>
          <li><strong>📦 Export</strong> — Downloads all data as a ZIP file for backup.</li>
          <li><strong>📂 Import</strong> — Restores data from a previously exported ZIP file.</li>
        </ul>
      </div>
      <div class="help-section">
        <h4>Auto-sync</h4>
        <p>Enabled by default (30s interval). Toggle it off/on in the top bar.</p>
      </div>
    `,
  },
};
