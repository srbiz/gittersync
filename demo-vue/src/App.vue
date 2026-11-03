<script setup lang="ts">
import { onMounted } from 'vue';
import { useTodoStore } from '@/stores/todos';
import SetupPanel from '@/components/SetupPanel.vue';
import TodoInput from '@/components/TodoInput.vue';
import TodoFilters from '@/components/TodoFilters.vue';
import TodoItem from '@/components/TodoItem.vue';
import SyncStatusBar from '@/components/SyncStatusBar.vue';
import ToastHost from '@/components/ToastHost.vue';

const store = useTodoStore();

// Reconnect automatically when the tab still holds an unlockable token
onMounted(() => {
    void store.bootstrap();
});
</script>

<template>
    <div class="app">
        <header class="topbar">
            <div class="brand">
                <span class="logo">✅</span>
                <span>
                    <strong>GitterSync Todo</strong>
                    <small>Vue 3 · Vite · Pinia — a GitHub repo is the database</small>
                </span>
            </div>
            <nav class="topbar-links">
                <a href="../" class="btn btn-secondary btn-sm" title="Kanban demo (vanilla TypeScript)">Kanban demo</a>
                <a href="https://github.com/srbiz/gittersync" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">GitHub</a>
            </nav>
        </header>

        <main class="content">
            <SetupPanel v-if="!store.connected" />

            <section v-else class="todo-panel">
                <TodoInput />
                <TodoFilters />

                <ul v-if="store.visibleTodos.length" class="todo-list">
                    <TodoItem v-for="todo in store.visibleTodos" :key="todo.id" :todo="todo" />
                </ul>

                <p v-else class="empty">
                    <template v-if="store.todos.length === 0">
                        Nothing here yet. Add your first todo above — it is stored locally right away and
                        pushed to GitHub on the next sync.
                    </template>
                    <template v-else>
                        No {{ store.filter }} todos.
                    </template>
                </p>
            </section>
        </main>

        <SyncStatusBar />
        <ToastHost />
    </div>
</template>
