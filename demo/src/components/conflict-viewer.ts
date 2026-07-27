/**
 * Conflict Viewer — Shows field-level merge details for a document
 */

import type { SyncedDocument } from 'gittersync';

export function showConflictViewer(
    container: HTMLElement,
    local: SyncedDocument,
    remote: SyncedDocument,
    merged: SyncedDocument
): void {
    const viewer = document.createElement('div');
    viewer.className = 'conflict-viewer';

    const allFields = new Set([
        ...Object.keys(local._fields),
        ...Object.keys(remote._fields),
    ]);

    let html = `
        <div style="font-weight:600;margin-bottom:0.75rem">⚡ Field-Level LWW Merge Result</div>
        <div class="field-row field-header">
            <span>Field</span>
            <span>Local</span>
            <span>Remote → Merged</span>
        </div>
    `;

    for (const field of allFields) {
        const localVal = JSON.stringify((local.data as Record<string, unknown>)[field] ?? '—');
        const remoteVal = JSON.stringify((remote.data as Record<string, unknown>)[field] ?? '—');
        const mergedVal = JSON.stringify((merged.data as Record<string, unknown>)[field] ?? '—');

        const localTime = local._fields[field]?.updatedAt?.slice(11, 19) || '—';
        const remoteTime = remote._fields[field]?.updatedAt?.slice(11, 19) || '—';

        const winner = mergedVal === localVal ? 'Local' : mergedVal === remoteVal ? 'Remote' : '—';

        html += `
            <div class="field-row">
                <span><strong>${field}</strong><br><span style="font-size:0.7rem">${winner} won</span></span>
                <span class="field-local">${localVal}<br><span style="font-size:0.65rem">@${localTime}</span></span>
                <span class="field-remote">${remoteVal}<br><span style="font-size:0.65rem">@${remoteTime}</span></span>
            </div>
        `;
    }

    viewer.innerHTML = html;
    container.appendChild(viewer);
}