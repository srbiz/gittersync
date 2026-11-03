/**
 * @vitest-environment jsdom
 */

/**
 * Kanban demo — Edit Task dialog regression tests
 *
 * Reported bug: *labels added to a task could not be dismissed* — clicking the
 * ✕ on a chip that came from the saved task did nothing (those chips were built
 * from an innerHTML string and never got a click handler), and labels typed into
 * the dialog survived a close/reopen cycle with broken colours.
 *
 * These tests drive the real dialog DOM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Task, Label } from '../demo/src/types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockCreateTask = vi.fn();
const mockUpdateTask = vi.fn();
const mockUploadAttachment = vi.fn();
const mockDeleteTask = vi.fn();
const mockDownloadAttachment = vi.fn();

vi.mock('../demo/src/gittersync-adapter', () => ({
    createTask: (...args: unknown[]) => mockCreateTask(...args),
    updateTask: (...args: unknown[]) => mockUpdateTask(...args),
    uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
    deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
    downloadAttachment: (...args: unknown[]) => mockDownloadAttachment(...args),
}));

import { renderTaskDetail, closeTaskDetail } from '../demo/src/views/task-detail';
import { createLabelEditor, normalizeColor } from '../demo/src/components/label-editor';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        title: 'Ship the release',
        description: 'Everything green',
        priority: 'high',
        assignee: 'govind',
        dueDate: '2026-11-30T00:00:00.000Z',
        labels: [
            { id: 'label-1', text: 'bug', color: '#ef4444' },
            { id: 'label-2', text: 'demo', color: '#3b82f6' },
        ],
        columnId: 'todo',
        position: 0,
        attachments: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-02T00:00:00.000Z',
        ...overrides,
    };
}

function chips(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('.label-editor-chip')];
}

function chipTexts(): string[] {
    return chips().map((chip) => chip.dataset.labelText ?? '');
}

function click(element: Element | null): void {
    if (!element) throw new Error('element not found');
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function openDialog(task = makeTask(), isNew = false): void {
    renderTaskDetail(task, task.columnId, isNew);
}

function typeLabel(text: string): void {
    const input = document.querySelector<HTMLInputElement>('.label-editor-input')!;
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    closeTaskDetail();
    document.body.innerHTML = '';
});

// ─── The reported bug ──────────────────────────────────────────────────────

describe('Edit Task dialog — dismissing labels', () => {
    it('renders the task’s saved labels as chips', () => {
        openDialog();
        expect(chipTexts()).toEqual(['bug', 'demo']);
    });

    it('removes a saved label when its chip is clicked', () => {
        openDialog();

        click(chips()[0].querySelector('.label-editor-chip-remove'));

        expect(chipTexts()).toEqual(['demo']);
    });

    it('removes a saved label when the chip body is clicked', () => {
        openDialog();

        click(chips()[1]);

        expect(chipTexts()).toEqual(['bug']);
    });

    it('removes a label added during this session', () => {
        openDialog();

        typeLabel('urgent');
        expect(chipTexts()).toEqual(['bug', 'demo', 'urgent']);

        click(chips()[2].querySelector('.label-editor-chip-remove'));
        expect(chipTexts()).toEqual(['bug', 'demo']);
    });

    it('dismisses unsaved labels when the close button is clicked', () => {
        const task = makeTask();
        openDialog(task);

        typeLabel('never-saved');
        expect(chipTexts()).toContain('never-saved');

        click(document.querySelector('[data-action="close"]'));
        expect(document.querySelector('.modal-overlay')).toBeNull();

        // Reopening shows only the labels that were actually saved
        openDialog(task);
        expect(chipTexts()).toEqual(['bug', 'demo']);
    });

    it('dismisses unsaved labels when Cancel, the backdrop or Escape is used', () => {
        const task = makeTask();

        // Cancel button
        openDialog(task);
        typeLabel('a');
        click(document.querySelector('[data-action="cancel"]'));
        expect(document.querySelector('.modal-overlay')).toBeNull();

        // Backdrop click
        openDialog(task);
        typeLabel('b');
        const overlay = document.querySelector('.modal-overlay')!;
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.querySelector('.modal-overlay')).toBeNull();

        // Escape key
        openDialog(task);
        typeLabel('c');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.querySelector('.modal-overlay')).toBeNull();

        openDialog(task);
        expect(chipTexts()).toEqual(['bug', 'demo']);
    });

    it('does not close when the modal itself is clicked', () => {
        openDialog();
        const modal = document.querySelector('.modal')!;
        modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.querySelector('.modal-overlay')).not.toBeNull();
    });

    it('keeps only one dialog open at a time', () => {
        openDialog(makeTask({ id: 'task-1' }));
        typeLabel('first-dialog');
        openDialog(makeTask({ id: 'task-2', labels: [] }));

        expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
        expect(chipTexts()).toEqual([]);
    });
});

// ─── Saving ────────────────────────────────────────────────────────────────

describe('Edit Task dialog — saving', () => {
    it('saves the labels that are still on screen, with hex colours', async () => {
        const task = makeTask();
        openDialog(task);

        click(chips()[0].querySelector('.label-editor-chip-remove')); // drop "bug"
        typeLabel('urgent');

        const form = document.querySelector<HTMLFormElement>('#task-form')!;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();

        expect(mockUpdateTask).toHaveBeenCalledTimes(1);
        const saved = mockUpdateTask.mock.calls[0][0] as Task;
        expect(saved.labels.map((label: Label) => label.text)).toEqual(['demo', 'urgent']);
        // Colours must survive a save/reload round trip as hex, not rgb()
        expect(saved.labels.every((label: Label) => /^#[0-9a-f]{6}$/i.test(label.color))).toBe(
            true,
        );
        expect(document.querySelector('.modal-overlay')).toBeNull();
    });

    it('creates the task before uploading attachments', async () => {
        mockUploadAttachment.mockResolvedValue({
            id: 'att-1',
            name: 'spec.pdf',
            path: 'files/task-new/spec.pdf',
            mimeType: 'application/pdf',
            size: 10,
            uploadedAt: '2026-11-03T00:00:00.000Z',
        });

        openDialog(makeTask({ id: 'task-new', attachments: [] }), true);

        const file = new File(['x'], 'spec.pdf', { type: 'application/pdf' });
        const input = document.querySelector<HTMLInputElement>('#file-upload')!;
        Object.defineProperty(input, 'files', { value: [file], configurable: true });

        const form = document.querySelector<HTMLFormElement>('#task-form')!;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        await vi.waitFor(() => expect(mockUploadAttachment).toHaveBeenCalled());
        await vi.waitFor(() => expect(mockCreateTask).toHaveBeenCalled());

        // A brand-new task must exist before an attachment references it,
        // otherwise the attachment metadata is written to a missing document.
        expect(mockCreateTask.mock.invocationCallOrder[0]).toBeLessThan(
            mockUploadAttachment.mock.invocationCallOrder[0],
        );
    });

    it('refuses to save without a title', async () => {
        openDialog(makeTask(), true);
        const titleInput = document.querySelector<HTMLInputElement>('#task-title')!;
        titleInput.value = '   ';

        const form = document.querySelector<HTMLFormElement>('#task-form')!;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();

        expect(mockCreateTask).not.toHaveBeenCalled();
        expect(document.querySelector('.modal-overlay')).not.toBeNull();
    });

    it('does not let the label input submit the form', () => {
        openDialog();
        const input = document.querySelector<HTMLInputElement>('.label-editor-input')!;
        const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        input.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(mockUpdateTask).not.toHaveBeenCalled();
    });
});

// ─── Label editor unit behaviour ───────────────────────────────────────────

describe('createLabelEditor', () => {
    it('adds labels from the input and the Add button', () => {
        const editor = createLabelEditor();
        document.body.appendChild(editor.element);

        expect(editor.addLabel('  alpha  ')).not.toBeNull();
        expect(editor.getLabels()[0].text).toBe('alpha');

        // Duplicates (case-insensitive) are ignored
        expect(editor.addLabel('ALPHA')).toBeNull();
        expect(editor.getLabels()).toHaveLength(1);

        // Empty input is ignored
        expect(editor.addLabel('   ')).toBeNull();

        editor.destroy();
    });

    it('reports removals and additions through callbacks', () => {
        const onAdd = vi.fn();
        const onRemove = vi.fn();
        const editor = createLabelEditor({
            initial: [{ id: 'x', text: 'old', color: '#123456' }],
            onAdd,
            onRemove,
        });
        document.body.appendChild(editor.element);

        const added = editor.addLabel('new')!;
        expect(onAdd).toHaveBeenCalledWith(added);

        expect(editor.removeLabel('x')).toBe(true);
        expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ text: 'old' }));
        expect(editor.removeLabel('missing')).toBe(false);

        editor.destroy();
    });

    it('destroy() detaches listeners, drops labels and removes the element', () => {
        const editor = createLabelEditor({ initial: [{ id: 'x', text: 'old', color: '#123456' }] });
        document.body.appendChild(editor.element);
        editor.addLabel('temp');

        editor.destroy();

        expect(editor.getLabels()).toEqual([]);
        expect(editor.element.isConnected).toBe(false);
        // Calls after destroy are inert
        expect(editor.addLabel('after')).toBeNull();
        expect(editor.removeLabel('x')).toBe(false);
    });

    it('normalises colours coming from older saved data', () => {
        const editor = createLabelEditor({
            initial: [{ id: 'x', text: 'legacy', color: 'rgb(59, 130, 246)' }],
        });
        document.body.appendChild(editor.element);

        expect(editor.getLabels()[0].color).toBe('#3b82f6');
        editor.destroy();
    });
});

describe('normalizeColor', () => {
    it('keeps 6-digit hex, expands 3-digit hex', () => {
        expect(normalizeColor('#00D4AA')).toBe('#00d4aa');
        expect(normalizeColor('#abc')).toBe('#aabbcc');
    });

    it('converts rgb()/rgba() to hex', () => {
        expect(normalizeColor('rgb(239, 68, 68)')).toBe('#ef4444');
        expect(normalizeColor('rgba(16, 185, 129, 0.5)')).toBe('#10b981');
    });

    it('falls back to the default colour for anything else', () => {
        expect(normalizeColor('not-a-color')).toBe('#3b82f6');
        expect(normalizeColor(undefined)).toBe('#3b82f6');
        expect(normalizeColor('')).toBe('#3b82f6');
    });
});
