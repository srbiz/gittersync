/**
 * Task Card Component — Draggable task card
 */

import type { Task, ColumnId } from '../types';
import { renderTaskDetail } from '../views/task-detail';
import { deleteTask } from '../gittersync-adapter';

export function renderTaskCard(task: Task, columnId: ColumnId): HTMLElement {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.draggable = true;
    card.dataset.taskId = task.id;
    card.dataset.columnId = columnId;

    const priorityLabel = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
    const priorityClass = `badge-${task.priority}`;

    const labelsHtml = (task.labels || [])
        .map(l => `<span class="task-label" style="background:${l.color}20;color:${l.color}">${l.text}</span>`)
        .join('');

    const attachmentCount = (task.attachments || []).length;
    const attachmentsHtml = attachmentCount > 0
        ? `<span class="task-card-attachments">📎 ${attachmentCount}</span>`
        : '';

    const dueHtml = task.dueDate
        ? `<span class="due">📅 ${new Date(task.dueDate).toLocaleDateString()}</span>`
        : '';

    card.innerHTML = `
        <div class="task-card-title">${escapeHtml(task.title)}</div>
        <div class="task-card-meta">
            <span class="badge ${priorityClass}">${priorityLabel}</span>
            ${task.assignee ? `<span class="assignee">👤 ${escapeHtml(task.assignee)}</span>` : ''}
            ${dueHtml}
        </div>
        ${labelsHtml ? `<div class="task-card-labels">${labelsHtml}</div>` : ''}
        <div class="task-card-footer">
            ${attachmentsHtml}
            <div>
                <button class="btn-icon btn-sm" data-action="edit" title="Edit">✏️</button>
                <button class="btn-icon btn-sm" data-action="delete" title="Delete">🗑️</button>
            </div>
        </div>
    `;

    card.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', JSON.stringify({ taskId: task.id, columnId }));
        card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
    });

    card.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        renderTaskDetail(task, columnId);
    });

    card.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${task.title}"?`)) {
            deleteTask(task.id, columnId);
        }
    });

    return card;
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}