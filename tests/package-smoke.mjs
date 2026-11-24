import 'fake-indexeddb/auto';
import { LocalDB, mergeDocument } from 'gittersync';

const db = new LocalDB();
try {
    await db.init();
    await db.registerCollection('package-smoke');
    if (!db.isCollectionRegistered('package-smoke')) {
        throw new Error('LocalDB package smoke test failed to register a collection');
    }

    if (typeof mergeDocument !== 'function') {
        throw new Error('Expected mergeDocument export from the built package');
    }
} finally {
    await db.close();
}

