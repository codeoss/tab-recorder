/**
 * durable-store.js — 多分段的本地恢复元数据存储。
 * background 独占调用；所有读改写串行，避免相邻分段互相覆盖。
 */
(function (G) {
  'use strict';

  function createDurableStore(storage) {
    let records = null;
    let queue = Promise.resolve();

    function enqueue(fn) {
      const result = queue.then(fn);
      queue = result.catch(() => {});
      return result;
    }

    async function load() {
      if (records) return;
      const stored = await storage.get(['durableRecordings', 'durableRecording']);
      records = Array.isArray(stored.durableRecordings) ? stored.durableRecordings : [];
      const legacy = stored.durableRecording;
      if (legacy && legacy.id && !records.some(record => record.id === legacy.id)) {
        records.push(legacy);
      }
    }

    async function persist() {
      await storage.set({ durableRecordings: records });
      await storage.remove('durableRecording');
    }

    return {
      list: () => enqueue(async () => {
        await load();
        return JSON.parse(JSON.stringify(records));
      }),
      upsert: patch => enqueue(async () => {
        if (!patch || typeof patch.id !== 'string' || !patch.id) throw new Error('暂存元数据无效');
        await load();
        const index = records.findIndex(record => record.id === patch.id);
        if (index >= 0) records[index] = { ...records[index], ...patch };
        else records.push(patch);
        await persist();
        return { ...patch };
      }),
      remove: id => enqueue(async () => {
        await load();
        records = records.filter(record => record.id !== id);
        await persist();
      }),
      clear: () => enqueue(async () => {
        await load();
        records = [];
        await persist();
      }),
    };
  }

  G.createDurableStore = createDurableStore;
})(self);
