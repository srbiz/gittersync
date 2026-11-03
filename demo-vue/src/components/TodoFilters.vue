<script setup lang="ts">
import { useTodoStore } from '@/stores/todos';
import type { TodoFilter } from '@/types';

const store = useTodoStore();

const filters: Array<{ id: TodoFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'completed', label: 'Done' },
];

async function clearDone(): Promise<void> {
    const removed = await store.clearCompleted();
    if (removed) store.notify('info', `Cleared ${removed} completed todo(s).`);
}
</script>

<template>
    <div class="todo-filters">
        <div class="filter-group" role="tablist" aria-label="Filter todos">
            <button
                v-for="item in filters"
                :key="item.id"
                type="button"
                role="tab"
                class="filter-btn"
                :class="{ active: store.filter === item.id }"
                :aria-selected="store.filter === item.id"
                @click="store.setFilter(item.id)"
            >
                {{ item.label }}
            </button>
        </div>

        <div class="filter-meta">
            <span>{{ store.activeCount }} active · {{ store.completedCount }} done</span>
            <button
                v-if="store.completedCount"
                type="button"
                class="btn btn-ghost btn-sm"
                @click="clearDone"
            >
                Clear completed
            </button>
        </div>
    </div>
</template>
