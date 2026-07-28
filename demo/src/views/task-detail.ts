/**
 * Task Detail View — Modal for creating/editing a task
 */

import type { Task, ColumnId, Priority, Label } from '../types';
import { createTask, updateTask, uploadAttachment } from '../gittersync-adapter';
import { generateId } from '../main';
import { renderFileAttachments } from '../components/file-attachment';

export function renderTaskDetail(task: Task, columnId: ColumnId, isNew = false): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const priorityOptions = ['low', 'medium', 'high', 'critical'].map(p =>
        `<option value="${p}" ${task.priority === p ? 'selected' : ''}>${p.charAt(0).toUpperCase() + p.slice(1)}</option>`
    ).join('');

    const labels = task.labels || [];

    overlay.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h2>${isNew ? 'New Task' : 'Edit Task'}</h2>
                <button class="btn-icon" data-action="close">✕</button>
            </div>
            <form id="task-form">
                <div class="form-group">
                    <label for="task-title">Title *</label>
                    <input type="text" id="task-title" value="${escapeHtml(task.title)}" required placeholder="What needs to be done?">
                </div>
                <div class="form-group">
                    <label for="task-desc">Description</label>
                    <textarea id="task-desc" placeholder="Add more details…">${escapeHtml(task.description)}</textarea>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="task-priority">Priority</label>
                        <select id="task-priority">${priorityOptions}</select>
                    </div>
                    <div class="form-group">
                        <label for="task-assignee">Assignee</label>
                        <input type="text" id="task-assignee" value="${escapeHtml(task.assignee)}" placeholder="GitHub username">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="task-due">Due Date</label>
                        <input type="date" id="task-due" value="${task.dueDate ? task.dueDate.split('T')[0] : ''}">
                    </div>
                    <div class="form-group">
                        <label>Labels</label>
                        <div style="display:flex;gap:0.5rem">
                            <input type="text" id="label-input" placeholder="Type label + Enter" style="flex:1">
                            <input type="color" id="label-color" value="#3b82f6" style="width:40px;padding:0.25rem">
                        </div>
                        <div id="labels-container" style="display:flex;flex-wrap:wrap;gap:0.25rem;margin-top:0.5rem">
                            ${labels.map(l => `<span class="task-label" style="background:${l.color}20;color:${l.color};cursor:pointer" data-label-id="${l.id}">${l.text} ✕</span>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Attachments</label>
                    <input type="file" id="file-upload" multiple>
                    <div id="attachments-container"></div>
                </div>
            </form>
            <div class="modal-footer">
                <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
                <button type="submit" class="btn-primary" form="task-form">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
    overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const labelInput = document.getElementById('label-input') as HTMLInputElement;
    const labelColor = document.getElementById('label-color') as HTMLInputElement;
    const labelsContainer = document.getElementById('labels-container')!;

    labelInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const text = labelInput.value.trim();
            if (!text) return;
            const newLabel: Label = { id: generateId(), text, color: labelColor.value };
            const span = document.createElement('span');
            span.className = 'task-label';
            span.style.cssText = `background:${newLabel.color}20;color:${newLabel.color};cursor:pointer`;
            span.textContent = `${newLabel.text} ✕`;
            span.dataset.labelId = newLabel.id;
            span.addEventListener('click', () => span.remove());
            labelsContainer.appendChild(span);
            labelInput.value = '';
        }
    });

    const fileInput = document.getElementById('file-upload') as HTMLInputElement;
    const attachmentsContainer = document.getElementById('attachments-container')!;
    renderFileAttachments(attachmentsContainer, task);

    const form = document.getElementById('task-form')!;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const title = (document.getElementById('task-title') as HTMLInputElement).value.trim();
        if (!title) return;

        const currentLabels: Label[] = [];
        labelsContainer.querySelectorAll('[data-label-id]').forEach(el => {
            const span = el as HTMLElement;
            currentLabels.push({
                id: span.dataset.labelId!,
                text: span.textContent?.replace(' ✕', '') || '',
                color: span.style.color,
            });
        });

        const updatedTask: Task = {
            ...task,
            title,
            description: (document.getElementById('task-desc') as HTMLTextAreaElement).value.trim(),
            priority: (document.getElementById('task-priority') as HTMLSelectElement).value as Priority,
            assignee: (document.getElementById('task-assignee') as HTMLInputElement).value.trim(),
            dueDate: (document.getElementById('task-due') as HTMLInputElement).value || '',
            labels: currentLabels,
            updatedAt: new Date().toISOString(),
        };

        const filePromises: Promise<void>[] = [];
        if (fileInput.files) {
            for (let i = 0; i < fileInput.files.length; i++) {
                const file = fileInput.files[i];
                filePromises.push(
                    (async () => {
                        try {
                            const att = await uploadAttachment(updatedTask, file);
                            if (att) updatedTask.attachments.push(att);
                        } catch (err) {
                            console.error('Upload failed:', err);
                        }
                    })()
                );
            }
        }

        if (isNew) {
            await createTask(updatedTask, columnId);
        } else {
            await updateTask(updatedTask);
        }

        if (filePromises.length > 0) {
            await Promise.all(filePromises);
        }

        close();
    });
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}