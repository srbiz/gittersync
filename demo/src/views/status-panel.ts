/**
 * Status Panel — Slide-out panel showing full sync status
 */

import { getState, subscribe, showMessage } from '../state';
import { pushChanges, pullChanges, fullSync, compact, getFullStatus, exportData, importData } from '../gittersync-adapter';
import { showHelpDialog } from '../components/help-dialog';

let panel: HTMLElement | null = null;

export function showStatusPanel(): void {
    if (panel) {
        panel.remove();
        panel = null;
        return;
    }

    panel = document.createElement('div');
    panel.className = 'status-panel';
    document.body.appendChild(panel);

    const render = () => {
        if (!panel) return;
        const state = getState();

        panel.innerHTML = `
            <h2>
                <span>📊 Sync Status</span>
                <span>
                    <button class="btn-help" data-action="help" title="Help guide" style="margin-right:0.5rem">?</button>
                    <button class="btn-icon" data-action="close">✕</button>
                </span>
            </h2>
            <div class="status-grid">
                <div class="status-item">
                    <span class="label">Online</span>
                    <span class="value" style="color:${state.online ? 'var(--success)' : 'var(--danger)'}">${state.online ? '✅ Online' : '❌ Offline'}</span>
                </div>
                <div class="status-item">
                    <span class="label">Syncing</span>
                    <span class="value">${state.syncing ? '⏳ In progress' : '✅ Idle'}</span>
                </div>
                <div class="status-item">
                    <span class="label">Pending Changes</span>
                    <span class="value">${state.pendingChanges}</span>
                </div>
                <div class="status-item">
                    <span class="label">Device ID</span>
                    <span class="value" title="${state.deviceId || '—'}">${state.deviceId ? state.deviceId.slice(0, 16) + '…' : '—'}</span>
                </div>
                <div class="status-item">
                    <span class="label">Last Sync</span>
                    <span class="value">${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString() : 'Never'}</span>
                </div>
                <div class="status-item">
                    <span class="label">Sync Cursor</span>
                    <span class="value" title="${state.cursor || '—'}">${state.cursor ? state.cursor.slice(0, 12) + '…' : '—'}</span>
                </div>
                <div class="status-item">
                    <span class="label">Rate Limit</span>
                    <span class="value">${state.rateLimitRemaining !== null ? `${state.rateLimitRemaining} remaining` : 'Unknown'}</span>
                </div>
                <div class="status-item">
                    <span class="label">Repo Size</span>
                    <span class="value">${state.repoSizeKb !== null ? `${state.repoSizeKb} KB` : 'Unknown'}</span>
                </div>
                <div class="status-item">
                    <span class="label">Config</span>
                    <span class="value">${state.config ? `${state.config.owner}/${state.config.repo}` : '—'}</span>
                </div>
            </div>
            <div class="status-actions">
                <button class="btn-sm btn-secondary" data-action="pull">⬇️ Pull</button>
                <button class="btn-sm btn-secondary" data-action="push">⬆️ Push</button>
                <button class="btn-sm btn-primary" data-action="sync">🔄 Full Sync</button>
                <button class="btn-sm btn-secondary" data-action="compact">🗜️ Compact</button>
                <button class="btn-sm btn-secondary" data-action="export">📦 Export</button>
                <button class="btn-sm btn-secondary" data-action="import">📂 Import</button>
                <button class="btn-sm btn-secondary" data-action="refresh">🔄 Refresh Status</button>
            </div>
            <input type="file" id="import-file-input" accept=".zip" style="display:none">
            <p style="text-align:center;margin-top:1rem;color:var(--text-muted);font-size:0.75rem">
                Auto-sync every 30s &middot; Toggle in top bar
            </p>
        `;

        panel.querySelector('[data-action="help"]')?.addEventListener('click', () => {
            showHelpDialog('status');
        });

        panel.querySelector('[data-action="close"]')?.addEventListener('click', () => {
            panel?.remove();
            panel = null;
        });

        panel.querySelector('[data-action="pull"]')?.addEventListener('click', async () => {
            await pullChanges();
            await getFullStatus();
            showMessage('success', 'Pull complete');
        });
        panel.querySelector('[data-action="push"]')?.addEventListener('click', async () => {
            await pushChanges();
            await getFullStatus();
        });
        panel.querySelector('[data-action="sync"]')?.addEventListener('click', async () => {
            await fullSync();
            await getFullStatus();
        });
        panel.querySelector('[data-action="compact"]')?.addEventListener('click', async () => {
            await compact();
            await getFullStatus();
        });
        panel.querySelector('[data-action="export"]')?.addEventListener('click', async () => {
            await exportData();
            await getFullStatus();
        });
        panel.querySelector('[data-action="import"]')?.addEventListener('click', () => {
            const fileInput = document.getElementById('import-file-input') as HTMLInputElement;
            if (!fileInput) return;
            fileInput.click();
        });
        const fileInput = document.getElementById('import-file-input') as HTMLInputElement;
        if (fileInput) {
            fileInput.addEventListener('change', async () => {
                const file = fileInput.files?.[0];
                if (file) {
                    await importData(file);
                    await getFullStatus();
                    fileInput.value = '';
                }
            });
        }
        panel.querySelector('[data-action="refresh"]')?.addEventListener('click', async () => {
            await getFullStatus();
            showMessage('info', 'Status refreshed');
        });
    };

    subscribe(render);
    render();
    getFullStatus();
}