/**
 * File Attachment Component — Upload/download files on tasks
 */

import type { Task, TaskAttachment } from '../types';
import { downloadAttachment } from '../gittersync-adapter';

export function renderFileAttachments(container: HTMLElement, task: Task): void {
    const list = document.createElement('div');
    list.className = 'file-list';

    const attachments = task.attachments || [];

    if (attachments.length > 0) {
        attachments.forEach(att => {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.innerHTML = `📎 ${escapeHtml(att.name)} <span style="color:var(--text-muted)">(${formatSize(att.size)})</span>`;
            item.title = `Download ${att.name}`;
            item.addEventListener('click', () => downloadAttachment(att));
            list.appendChild(item);
        });
    }

    container.appendChild(list);
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}