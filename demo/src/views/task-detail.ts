/**
 * Task Detail View — Modal for creating/editing a task
 *
 * Everything is looked up relative to this dialog's own overlay (never
 * `document.getElementById`), only one dialog can be open at a time, and
 * `close()` disposes the label editor + listeners so labels added in this
 * session are dismissed instead of leaking into the next dialog.
 */

import type { Task, ColumnId, Priority, TaskAttachment } from '../types';
import { createTask, updateTask, uploadAttachment } from '../gittersync-adapter';
import { renderFileAttachments } from '../components/file-attachment';
import { createLabelEditor, type LabelEditor } from '../components/label-editor';
import { showMessage } from '../state';

/** GitHub's Contents API accepts at most 1 MiB per file */
const MAX_ATTACHMENT_BYTES = 1024 * 1024;

const PRIORITY_OPTIONS: Priority[] = ['low', 'medium', 'high', 'critical'];

/** Currently open dialog, so a second one replaces it instead of stacking. */
let openDialog: { close: () => void } | null = null;

export function renderTaskDetail(task: Task, columnId: ColumnId, isNew = false): void {
    // Dismiss any dialog still on screen (its unsaved labels go with it)
    openDialog?.close();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', isNew ? 'New task' : 'Edit task');

    overlay.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h2>${isNew ? 'New Task' : 'Edit Task'}</h2>
                <button type="button" class="btn-icon" data-action="close" aria-label="Close dialog">✕</button>
            </div>
            <form id="task-form" novalidate>
                <div class="form-group">
                    <label for="task-title">Title *</label>
                    <input type="text" id="task-title" required maxlength="120" placeholder="What needs to be done?">
                </div>
                <div class="form-group">
                    <label for="task-desc">Description</label>
                    <textarea id="task-desc" rows="3" placeholder="Add more details…"></textarea>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="task-priority">Priority</label>
                        <select id="task-priority"></select>
                    </div>
                    <div class="form-group">
                        <label for="task-assignee">Assignee</label>
                        <input type="text" id="task-assignee" maxlength="60" placeholder="GitHub username">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="task-due">Due Date</label>
                        <input type="date" id="task-due">
                    </div>
                    <div class="form-group">
                        <label id="task-labels-label">Labels</label>
                        <div data-slot="labels" aria-labelledby="task-labels-label"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="file-upload">Attachments</label>
                    <input type="file" id="file-upload" multiple>
                    <small class="form-hint" data-slot="file-hint">Max 1 MB per file — stored in the repo under files/&lt;task&gt;/</small>
                    <div data-slot="attachments"></div>
                </div>
            </form>
            <div class="modal-footer">
                <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
                <button type="submit" class="btn-primary" form="task-form" data-action="save">
                    ${isNew ? 'Create' : 'Save'}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // ─── Scoped lookups ──────────────────────────────────────────────────

    const form = overlay.querySelector<HTMLFormElement>('#task-form')!;
    const titleInput = overlay.querySelector<HTMLInputElement>('#task-title')!;
    const descInput = overlay.querySelector<HTMLTextAreaElement>('#task-desc')!;
    const prioritySelect = overlay.querySelector<HTMLSelectElement>('#task-priority')!;
    const assigneeInput = overlay.querySelector<HTMLInputElement>('#task-assignee')!;
    const dueInput = overlay.querySelector<HTMLInputElement>('#task-due')!;
    const fileInput = overlay.querySelector<HTMLInputElement>('#file-upload')!;
    const labelsSlot = overlay.querySelector<HTMLElement>('[data-slot="labels"]')!;
    const attachmentsSlot = overlay.querySelector<HTMLElement>('[data-slot="attachments"]')!;
    const saveButton = overlay.querySelector<HTMLButtonElement>('[data-action="save"]')!;
    const fileHint = overlay.querySelector<HTMLElement>('[data-slot="file-hint"]')!;

    // ─── Initial values (assigned via the DOM, never interpolated) ────────

    for (const priority of PRIORITY_OPTIONS) {
        const option = document.createElement('option');
        option.value = priority;
        option.textContent = priority.charAt(0).toUpperCase() + priority.slice(1);
        option.selected = task.priority === priority;
        prioritySelect.appendChild(option);
    }

    titleInput.value = task.title ?? '';
    descInput.value = task.description ?? '';
    assigneeInput.value = task.assignee ?? '';
    dueInput.value = task.dueDate ? task.dueDate.slice(0, 10) : '';

    // ─── Labels ──────────────────────────────────────────────────────────

    const labelEditor: LabelEditor = createLabelEditor({
        initial: task.labels ?? [],
        onRemove: (label) => showMessage('info', `Removed label “${label.text}” (save to keep)`, 2000),
    });
    labelsSlot.appendChild(labelEditor.element);

    // ─── Attachments ─────────────────────────────────────────────────────

    let attachments: TaskAttachment[] = [...(task.attachments ?? [])];
    renderFileAttachments(attachmentsSlot, { ...task, attachments });

    fileInput.addEventListener('change', () => {
        const selected = Array.from(fileInput.files ?? []);
        const oversized = selected.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
        if (oversized.length > 0) {
            fileHint.textContent = `Too large (max 1 MB): ${oversized
                .map((file) => file.name)
                .join(', ')}`;
            fileHint.classList.add('form-hint-error');
        } else if (selected.length > 0) {
            fileHint.textContent = `${selected.length} file(s) ready to upload`;
            fileHint.classList.remove('form-hint-error');
        } else {
            fileHint.textContent = 'Max 1 MB per file — stored in the repo under files/<task>/';
            fileHint.classList.remove('form-hint-error');
        }
    });

    // ─── Close handling ──────────────────────────────────────────────────

    let closed = false;

    const close = (): void => {
        if (closed) return;
        closed = true;

        if (openDialog?.close === close) openDialog = null;

        // Dismiss labels added in this session and detach chip listeners
        labelEditor.destroy();
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
    };

    const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && !closed) {
            event.preventDefault();
            close();
        }
    };

    overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
    overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
        // Clicking the backdrop (but not the modal itself) closes the dialog
        if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown, true);

    openDialog = { close };

    // ─── Submit ──────────────────────────────────────────────────────────

    let saving = false;

    const setBusy = (busy: boolean): void => {
        saving = busy;
        saveButton.disabled = busy;
        overlay.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.disabled = busy;
        saveButton.textContent = busy ? 'Saving…' : isNew ? 'Create' : 'Save';
    };

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (saving || closed) return;

        const title = titleInput.value.trim();
        if (!title) {
            showMessage('error', 'A title is required');
            titleInput.focus();
            return;
        }

        const selectedFiles = Array.from(fileInput.files ?? []).filter(
            (file) => file.size <= MAX_ATTACHMENT_BYTES,
        );

        const draft: Task = {
            ...task,
            title,
            description: descInput.value.trim(),
            priority: prioritySelect.value as Priority,
            assignee: assigneeInput.value.trim(),
            dueDate: dueInput.value ? new Date(`${dueInput.value}T00:00:00`).toISOString() : '',
            labels: labelEditor.getLabels(),
            columnId: isNew ? columnId : task.columnId,
            attachments: [...attachments],
            updatedAt: new Date().toISOString(),
        };

        setBusy(true);

        try {
            // Files-first ordering: the document must exist before an attachment
            // can be referenced by it.
            if (isNew) {
                await createTask(draft, columnId);
            }

            let current = draft;
            for (const file of selectedFiles) {
                const attachment = await uploadAttachment(current, file);
                if (attachment) {
                    current = {
                        ...current,
                        attachments: [...current.attachments, attachment],
                    };
                } else {
                    showMessage('error', `Upload failed: ${file.name}`, 4000);
                }
            }

            if (!isNew) {
                await updateTask(current);
            }

            attachments = current.attachments;
            showMessage('success', isNew ? 'Task created' : 'Task saved', 2500);
            close();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showMessage('error', `Could not save the task: ${message}`, 6000);
            setBusy(false);
        }
    });

    // ─── Focus ───────────────────────────────────────────────────────────

    if (isNew) {
        titleInput.focus();
    } else {
        // Editing: put the caret at the end of the title instead of selecting it
        titleInput.focus();
        titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
    }
}

/** Close the dialog if one is open — used by board re-renders and shortcuts. */
export function closeTaskDetail(): void {
    openDialog?.close();
    openDialog = null;
}
