<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Todo } from '@/types';
import { useTodoStore } from '@/stores/todos';

const props = defineProps<{ todo: Todo }>();

const store = useTodoStore();
const editing = ref(false);
const draft = ref(props.todo.title);
const inputEl = ref<HTMLInputElement | null>(null);

const relative = computed(() => {
    const then = new Date(props.todo.updatedAt).getTime();
    const diff = Date.now() - then;
    if (!Number.isFinite(diff)) return '';
    const minutes = Math.round(diff / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
});

watch(editing, async (isEditing) => {
    if (isEditing) {
        await nextTick();
        inputEl.value?.focus();
        inputEl.value?.select();
    }
});

function startEdit(): void {
    draft.value = props.todo.title;
    editing.value = true;
}

async function commit(): Promise<void> {
    editing.value = false;
    if (draft.value.trim() && draft.value.trim() !== props.todo.title) {
        await store.renameTodo(props.todo.id, draft.value);
    }
}
</script>

<template>
    <li class="todo-item" :class="{ done: todo.done }">
        <label class="todo-check">
            <input
                type="checkbox"
                :checked="todo.done"
                :aria-label="`Mark “${todo.title}” as ${todo.done ? 'active' : 'done'}`"
                @change="store.toggleTodo(todo.id)"
            />
            <span class="checkmark" aria-hidden="true">{{ todo.done ? '✓' : '' }}</span>
        </label>

        <div class="todo-body">
            <input
                v-if="editing"
                ref="inputEl"
                v-model="draft"
                class="todo-edit"
                type="text"
                maxlength="200"
                @blur="commit"
                @keydown.enter.prevent="commit"
                @keydown.esc.prevent="editing = false"
            />
            <button v-else type="button" class="todo-title" @dblclick="startEdit">
                {{ todo.title }}
            </button>
            <small class="todo-meta">
                {{ relative }}<template v-if="editing"> · press Enter to save, Esc to cancel</template>
            </small>
        </div>

        <div class="todo-actions">
            <button type="button" class="btn btn-ghost btn-sm" title="Rename" @click="startEdit">✎</button>
            <button
                type="button"
                class="btn btn-ghost btn-sm danger"
                title="Delete"
                @click="store.removeTodo(todo.id)"
            >
                🗑
            </button>
        </div>
    </li>
</template>
