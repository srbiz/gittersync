<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTodoStore } from '@/stores/todos';
import { generatePassphrase } from '@/lib/gittersync';

const store = useTodoStore();

const token = ref('');
const passphrase = ref('');
const owner = ref('srbiz');
const repoName = ref('gittersync-demo-data');
const branch = ref('main');
const remember = ref(true);
const revealToken = ref(false);
const error = ref<string | null>(null);

const canSubmit = computed(
    () =>
        token.value.trim().length > 0 &&
        passphrase.value.length >= 8 &&
        owner.value.trim().length > 0 &&
        repoName.value.trim().length > 0,
);

function fillPassphrase(): void {
    passphrase.value = generatePassphrase();
}

function useDemoRepo(): void {
    owner.value = 'srbiz';
    repoName.value = 'gittersync-demo-data';
    branch.value = 'main';
}

async function submit(): Promise<void> {
    error.value = null;
    try {
        await store.connect(
            { owner: owner.value.trim(), repo: repoName.value.trim(), branch: branch.value.trim() || 'main' },
            token.value.trim(),
            passphrase.value,
            remember.value,
        );
    } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause);
    }
}
</script>

<template>
    <section class="setup">
        <h1>Connect a repository</h1>
        <p class="lead">
            This todo app has no backend. Your todos live as JSON documents in a GitHub repository
            (<code>collections/todos.json</code>) and in IndexedDB on this device, and GitterSync keeps
            the two in agreement.
        </p>

        <form class="setup-form" @submit.prevent="submit">
            <label class="field">
                <span>GitHub personal access token</span>
                <div class="field-row">
                    <input
                        v-model="token"
                        :type="revealToken ? 'text' : 'password'"
                        placeholder="ghp_xxxxxxxxxxxx or github_pat_xxx"
                        autocomplete="off"
                        spellcheck="false"
                        required
                    />
                    <button type="button" class="btn btn-ghost btn-sm" @click="revealToken = !revealToken">
                        {{ revealToken ? 'Hide' : 'Show' }}
                    </button>
                </div>
                <small class="hint">
                    Needs the <code>repo</code> scope (classic) or Contents read/write (fine-grained).
                    The token is encrypted with your passphrase before it touches localStorage.
                </small>
            </label>

            <label class="field">
                <span>Passphrase</span>
                <div class="field-row">
                    <input
                        v-model="passphrase"
                        type="text"
                        placeholder="At least 8 characters"
                        autocomplete="off"
                        spellcheck="false"
                        minlength="8"
                        required
                    />
                    <button type="button" class="btn btn-ghost btn-sm" @click="fillPassphrase">Generate</button>
                </div>
                <small class="hint">
                    PBKDF2-SHA256 (600k iterations) → AES-256-GCM. Kept in sessionStorage for this tab so a
                    reload can reconnect; forget it and the stored token cannot be decrypted.
                </small>
            </label>

            <div class="field-grid">
                <label class="field">
                    <span>Owner</span>
                    <input v-model="owner" type="text" placeholder="srbiz" required />
                </label>
                <label class="field">
                    <span>Repository</span>
                    <input v-model="repoName" type="text" placeholder="gittersync-demo-data" required />
                </label>
                <label class="field">
                    <span>Branch</span>
                    <input v-model="branch" type="text" placeholder="main" />
                </label>
            </div>

            <div class="field-row spread">
                <label class="checkbox">
                    <input v-model="remember" type="checkbox" />
                    <span>Remember this repository on this device</span>
                </label>
                <button type="button" class="btn btn-ghost btn-sm" @click="useDemoRepo">Use demo repo</button>
            </div>

            <p v-if="error" class="error" role="alert">{{ error }}</p>

            <div class="field-row">
                <button class="btn btn-primary" type="submit" :disabled="!canSubmit || store.busy">
                    {{ store.busy ? 'Connecting…' : 'Connect' }}
                </button>
                <button
                    class="btn btn-secondary"
                    type="button"
                    :disabled="store.busy"
                    @click="store.startLocalOnly()"
                >
                    Try it offline (no GitHub)
                </button>
            </div>
        </form>

        <p class="footnote">
            “Try it offline” runs GitterSync's <code>LocalDB</code> on its own — a plain IndexedDB document
            store with the same changelog the sync engine later replays. Nothing leaves the browser until
            you connect a repository.
        </p>
    </section>
</template>
