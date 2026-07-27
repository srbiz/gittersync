/**
 * Sync Status Bar — Shows online/offline, pending changes, last sync
 */

import { getState, subscribe } from '../state';
import { showStatusPanel } from '../views/status-panel';

export function renderSyncBar(container: HTMLElement): void {
  const bar = document.createElement('div');
  bar.className = 'sync-status-bar';
  container.appendChild(bar);

  const render = () => {
    const state = getState();
    const dotClass = state.syncing ? 'syncing' : state.online ? 'online' : 'offline';
    const statusText = state.syncing ? 'Syncing…' : state.online ? 'Online' : 'Offline';

    bar.innerHTML = `
            <div class="left">
                <div class="sync-indicator">
                    <span class="sync-dot ${dotClass}"></span>
                    <span>${statusText}</span>
                </div>
                <span>📦 ${state.pendingChanges} pending</span>
                ${state.lastSyncAt ? `<span>⏱ ${timeAgo(state.lastSyncAt)}</span>` : ''}
            </div>
            <div class="right">
                <span title="Device ID">📱 ${state.deviceId?.slice(0, 8) || '…'}</span>
                <button class="btn-sm btn-secondary" data-action="status">📊 Status</button>
            </div>
        `;

    const statusBtn = bar.querySelector('[data-action="status"]');
    statusBtn?.addEventListener('click', () => {
      showStatusPanel();
    });
  };

  subscribe(render);
  render();
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}