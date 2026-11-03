<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useTodoStore } from '@/stores/todos';

const store = useTodoStore();

const online = computed(() => navigator.onLine);
const cursor = computed(() => store.status?.cursor?.sha?.slice(0, 7) ?? '—');
const lastSync = computed(() => {
    const at = store.lastSyncAt;
    return at ? new Date(at).toLocaleTimeString() : 'never';
});
const repoLabel = computed(() =>
    store.repo ? `${store.repo.owner}/${store.repo.repo}@${store.repo.branch}` : 'no repository',
);

function onConnectivityChange(): void {
    store.refreshStatus();
}

onMounted(() => {
    window.addEventListener('online', onConnectivityChange);
    window.addEventListener('offline', onConnectivityChange);
});

onUnmounted(() => {
    window.removeEventListener('online', onConnectivityChange);
    window.removeEventListener('offline', onConnectivityChange);
});
</script>

<template>
    <footer class="syncbar">
        <div class="syncbar-row">
            <span class="pill" :class="online ? 'pill-online' : 'pill-offline'">
                {{ online ? '● online' : '○ offline' }}
            </span>
            <span class="pill" :class="store.localOnly ? 'pill-warn' : 'pill-muted'">{{ repoLabel }}</span>
            <span v-if="store.localOnly" class="pill pill-warn">local only — nothing syncs</span>
            <span v-else class="pill pill-muted">
                {{ store.pendingChanges }} pending · cursor {{ cursor }} · last sync {{ lastSync }}
            </span>
            <span
                v-if="store.rateLimit"
                class="pill pill-muted"
                title="Reads served from raw.githubusercontent.com are free of the REST rate limit"
            >
                {{ store.freeReads }} free reads · {{ store.rateLimit.apiCalls }} API calls
                <template v-if="store.rateLimit.remaining !== null"> · {{ store.rateLimit.remaining }} left</template>
            </span>
        </div>

        <div class="syncbar-row">
            <template v-if="!store.localOnly">
                <button class="btn btn-sm btn-secondary" type="button" :disabled="store.busy" @click="store.syncNow()">
                    Sync now
                </button>
                <button class="btn btn-sm btn-ghost" type="button" :disabled="store.busy" @click="store.pull()">
                    Pull
                </button>
                <button class="btn btn-sm btn-ghost" type="button" :disabled="store.busy" @click="store.push()">
                    Push
                </button>
                <button
                    class="btn btn-sm btn-ghost"
                    type="button"
                    :disabled="store.busy"
                    title="Rewrite collection files from scratch and prune expired deletes"
                    @click="store.compact()"
                >
                    Compact
                </button>
                <label class="checkbox">
                    <input
                        type="checkbox"
                        :checked="store.autoSyncRunning"
                        @change="store.toggleAutoSync(($event.target as HTMLInputElement).checked)"
                    />
                    <span>Auto-sync 30s</span>
                </label>
                <button class="btn btn-sm btn-ghost danger" type="button" @click="store.disconnect()">
                    Disconnect
                </button>
            </template>
            <template v-else>
                <button class="btn btn-sm btn-ghost danger" type="button" @click="store.disconnect()">
                    Reset local data
                </button>
            </template>
        </div>
    </footer>
</template>
