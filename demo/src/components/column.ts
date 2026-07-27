/**
 * Column Component — Renders a single kanban column with tasks
 */

import type { Column, ColumnId, Task } from '../types';
import { renderTaskCard } from './card';
import { renderTaskDetail } from '../views/task-detail';
import { moveTaskToColumn } from '../gittersync-adapter';
import { generateId } from '../main';

export function renderColumn(col: Column): HTMLElement {
    const columnEl = document.createElement('div');
    columnEl.className = 'board-column';
    columnEl.dataset.columnId = col.id;

    columnEl.innerHTML = `
        <div class="column-header" style="border-bottom-color: ${col.color}">
            <h3>
                <span>${col.title}</span>
                <span class="column-count">${col.tasks.length}</span>
            </h3>
            <button class="btn-icon btn-sm" data-action="add" title="Add task">➕</button>
        </div>
        <div class="column-body" data-dropzone></div>
        <div class="column-footer">
            <button class="btn-sm btn-secondary" data-action="add" style="width:100%">+ Add Task</button>
        </div>
    `;

    const body = columnEl.querySelector('[data-dropzone]') as HTMLElement;
    col.tasks.forEach(task => {
        body.appendChild(renderTaskCard(task, col.id));
    });

    body.addEventListener('dragover', (e) => {
        e.preventDefault();
        body.classList.add('drag-over');
    });
    body.addEventListener('dragleave', () => {
        body.classList.remove('drag-over');
    });
    body.addEventListener('drop', (e) => {
        e.preventDefault();
        body.classList.remove('drag-over');
        const data = e.dataTransfer?.getData('text/plain');
        if (!data) return;
        const { taskId, columnId: fromColumn } = JSON.parse(data);
        if (fromColumn !== col.id) {
            moveTaskToColumn(taskId, fromColumn, col.id);
        }
    });

    columnEl.querySelectorAll('[data-action="add"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const newTask: Task = {
                id: generateId(),
                title: '',
                description: '',
                priority: 'medium',
                assignee: '',
                dueDate: '',
                labels: [],
                columnId: col.id,
                position: col.tasks.length,
                attachments: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            renderTaskDetail(newTask, col.id, true);
        });
    });

    return columnEl;
}