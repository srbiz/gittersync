/**
 * Board View — Main kanban board with columns and sync controls
 */

import { getState, subscribe, showMessage } from '../state';
import { renderColumn } from '../components/column';
import { renderSyncBar } from '../components/sync-bar';
import { showHelpDialog } from '../components/help-dialog';

export function renderBoard(container: HTMLElement): void {
    container.innerHTML = '';

    // Top bar
    const topBar = document.createElement('div');
    topBar.className = 'top-bar';
    topBar.innerHTML = `
        <div class="top-bar-brand">
            <span>GS</span>
            <span>GitterSync Demo</span>
        </div>
        <div class="top-bar-actions">
            <button class="btn-help" data-action="help" title="Help guide">?</button>
            <button class="btn-sm btn-secondary" data-action="pull" title="Pull from GitHub">⬇️</button>
            <button class="btn-sm btn-secondary" data-action="push" title="Push to GitHub">⬆️</button>
            <button class="btn-sm btn-primary" data-action="sync" title="Full sync">🔄 Sync</button>
            <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.8rem;color:var(--text-secondary)">
                <input type="checkbox" id="auto-sync" checked>
                Auto
            </label>
            <a href="https://paypal.me/GovindBhumkarIN" target="_blank" class="sponsor-link" title="Support this project">♥ Sponsor</a>
        </div>
    `;

    topBar.querySelector('[data-action="help"]')?.addEventListener('click', () => {
        showHelpDialog('board');
    });

    topBar.querySelector('[data-action="pull"]')?.addEventListener('click', async () => {
        const { pullChanges } = await import('../gittersync-adapter');
        await pullChanges();
    });
    topBar.querySelector('[data-action="push"]')?.addEventListener('click', async () => {
        const { pushChanges } = await import('../gittersync-adapter');
        await pushChanges();
    });
    topBar.querySelector('[data-action="sync"]')?.addEventListener('click', async () => {
        const { fullSync } = await import('../gittersync-adapter');
        await fullSync();
    });

    container.appendChild(topBar);

    // Sync status bar
    renderSyncBar(container);

    // Board container
    const board = document.createElement('div');
    board.className = 'board';
    container.appendChild(board);

    // Render columns reactively
    const renderColumns = () => {
        const state = getState();
        board.innerHTML = '';
        state.columns.forEach(col => {
            board.appendChild(renderColumn(col));
        });
    };

    subscribe(renderColumns);
    renderColumns();

    // Auto-sync toggle — defer the import
    const observer = new MutationObserver(() => {
        const autoSyncCheckbox = document.getElementById('auto-sync') as HTMLInputElement;
        if (autoSyncCheckbox) {
            observer.disconnect();
            autoSyncCheckbox.addEventListener('change', () => {
                const sync = getState().sync;
                if (!sync) return;
                if (autoSyncCheckbox.checked) {
                    sync.startAutoSync(30000);
                    showMessage('info', 'Auto-sync enabled (30s interval)');
                } else {
                    sync.stopAutoSync();
                    showMessage('info', 'Auto-sync disabled');
                }
            });
        }
    });
    observer.observe(container, { childList: true, subtree: true });
}