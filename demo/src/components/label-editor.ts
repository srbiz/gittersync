/**
 * Label Editor Component — the label chips inside the task dialog
 *
 * The editor owns its label list as plain state and re-renders chips from it,
 * so *every* chip (the ones a task already had and the ones just typed in) is
 * removable the same way. Rendering straight from state also fixes two older
 * bugs:
 *
 * - Chips built from the initial `innerHTML` had no click handler at all, so a
 *   saved label could never be dismissed.
 * - Chip colours were read back from `element.style.color`, which the browser
 *   normalises to `rgb(59, 130, 246)`. Re-rendering that as
 *   `background: rgb(59, 130, 246)20` produced invalid CSS, so labels lost
 *   their colour after the first save.
 *
 * `destroy()` detaches every listener and drops the pending (unsaved) labels,
 * which is what makes closing the dialog dismiss labels added in that session.
 */

import type { Label } from '../types';

export interface LabelEditorOptions {
    /** Labels the task already has */
    initial?: Label[];
    /** Called after a label is added */
    onAdd?: (label: Label) => void;
    /** Called after a label is removed */
    onRemove?: (label: Label) => void;
    /** Placeholder for the text input */
    placeholder?: string;
}

export interface LabelEditor {
    /** Element to insert into the form */
    readonly element: HTMLElement;
    /** Current labels — the source of truth for saving */
    getLabels(): Label[];
    /** Add a label; returns null when the text is empty or already present */
    addLabel(text: string, color?: string): Label | null;
    /** Remove a label by id; returns whether anything was removed */
    removeLabel(id: string): boolean;
    /** Detach listeners and discard pending labels */
    destroy(): void;
}

const DEFAULT_COLOR = '#3b82f6';

/**
 * Normalise a colour to `#rrggbb`.
 *
 * Older demo data stored `rgb(...)` strings (see the header comment), and the
 * chip background is built by appending an alpha suffix, which only works with
 * hex.
 */
export function normalizeColor(value: string | undefined | null): string {
    const raw = (value || '').trim();

    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();

    if (/^#[0-9a-f]{3}$/i.test(raw)) {
        const [r, g, b] = raw.slice(1);
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }

    const match = raw.match(/^rgba?\(([^)]+)\)$/i);
    if (match) {
        const parts = match[1]
            .split(/[,/\s]+/)
            .map((part) => parseFloat(part))
            .filter((part) => !Number.isNaN(part));
        if (parts.length >= 3) {
            const toHex = (n: number) =>
                Math.max(0, Math.min(255, Math.round(n)))
                    .toString(16)
                    .padStart(2, '0');
            return `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`;
        }
    }

    return DEFAULT_COLOR;
}

function generateLabelId(): string {
    const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return `label-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createLabelEditor(options: LabelEditorOptions = {}): LabelEditor {
    let labels: Label[] = (options.initial ?? []).map((label) => ({
        id: label.id || generateLabelId(),
        text: String(label.text ?? ''),
        color: normalizeColor(label.color),
    }));
    let destroyed = false;

    // ─── DOM ─────────────────────────────────────────────────────────────

    const element = document.createElement('div');
    element.className = 'label-editor';

    const inputRow = document.createElement('div');
    inputRow.className = 'label-editor-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'label-editor-input';
    input.placeholder = options.placeholder ?? 'Type a label + Enter';
    input.setAttribute('aria-label', 'New label text');
    input.maxLength = 40;

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'label-editor-color';
    colorInput.value = DEFAULT_COLOR;
    colorInput.setAttribute('aria-label', 'New label colour');

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'btn-sm btn-secondary label-editor-add';
    addButton.textContent = 'Add';

    inputRow.append(input, colorInput, addButton);

    const chips = document.createElement('div');
    chips.className = 'label-editor-chips';
    chips.setAttribute('role', 'list');
    chips.setAttribute('aria-label', 'Labels on this task');

    const empty = document.createElement('span');
    empty.className = 'label-editor-empty';
    empty.textContent = 'No labels yet';

    element.append(inputRow, chips);

    // ─── Rendering ───────────────────────────────────────────────────────

    function render(): void {
        chips.innerHTML = '';

        if (labels.length === 0) {
            chips.appendChild(empty);
            return;
        }

        for (const label of labels) {
            const chip = document.createElement('span');
            chip.className = 'task-label label-editor-chip';
            chip.setAttribute('role', 'listitem');
            chip.dataset.labelId = label.id;
            chip.dataset.labelText = label.text;
            chip.dataset.labelColor = label.color;
            chip.style.background = `${label.color}22`;
            chip.style.color = label.color;
            chip.style.borderColor = `${label.color}55`;
            chip.title = `Remove “${label.text}”`;

            const text = document.createElement('span');
            text.className = 'label-editor-chip-text';
            text.textContent = label.text;

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'label-editor-chip-remove';
            remove.dataset.labelRemove = label.id;
            remove.setAttribute('aria-label', `Remove label ${label.text}`);
            remove.textContent = '✕';

            chip.append(text, remove);
            chips.appendChild(chip);
        }
    }

    // ─── Actions ─────────────────────────────────────────────────────────

    function addLabel(text: string, color?: string): Label | null {
        if (destroyed) return null;

        const value = text.trim();
        if (!value) return null;

        // Labels are identified by their text in the UI, so keep them unique
        if (labels.some((label) => label.text.toLowerCase() === value.toLowerCase())) {
            input.value = '';
            return null;
        }

        const label: Label = {
            id: generateLabelId(),
            text: value,
            color: normalizeColor(color ?? colorInput.value),
        };

        labels = [...labels, label];
        render();
        options.onAdd?.(label);
        return label;
    }

    function removeLabel(id: string): boolean {
        if (destroyed) return false;

        const target = labels.find((label) => label.id === id);
        if (!target) return false;

        labels = labels.filter((label) => label.id !== id);
        render();
        options.onRemove?.(target);
        return true;
    }

    // ─── Events ──────────────────────────────────────────────────────────

    // One delegated handler covers chips that already existed and chips added
    // during this session — clicking anywhere on a chip removes it.
    const onChipsClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        const chip = target?.closest('[data-label-id]') as HTMLElement | null;
        if (!chip?.dataset.labelId) return;

        event.preventDefault();
        event.stopPropagation();
        removeLabel(chip.dataset.labelId);
    };

    const onInputKeydown = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter') return;
        // Never let the label input submit the task form
        event.preventDefault();
        if (addLabel(input.value)) input.value = '';
    };

    const onAddClick = (event: MouseEvent): void => {
        event.preventDefault();
        if (addLabel(input.value)) {
            input.value = '';
            input.focus();
        }
    };

    chips.addEventListener('click', onChipsClick);
    input.addEventListener('keydown', onInputKeydown);
    addButton.addEventListener('click', onAddClick);

    render();

    return {
        element,
        getLabels: () => labels.map((label) => ({ ...label })),
        addLabel,
        removeLabel,
        destroy(): void {
            if (destroyed) return;
            destroyed = true;

            chips.removeEventListener('click', onChipsClick);
            input.removeEventListener('keydown', onInputKeydown);
            addButton.removeEventListener('click', onAddClick);

            // Discard labels added in this session — they were never saved
            labels = [];
            chips.innerHTML = '';
            input.value = '';
            element.remove();
        },
    };
}
