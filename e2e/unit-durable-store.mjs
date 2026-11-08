import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.self = globalThis;
await import(pathToFileURL(path.join(ROOT, 'durable-store.js')).href);
const { createDurableStore } = globalThis;

let failed = 0;
function ok(name, condition, extra = '') {
  console.log(`${condition ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!condition) failed++;
}
function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map(key => [key, structuredClone(data[key])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
}

{
  const storage = memoryStorage({ durableRecording: { id: 'legacy', bytes: 10, segmentIndex: 1 } });
  const store = createDurableStore(storage);
  const initial = await store.list();
  ok('旧单对象可读取', initial.length === 1 && initial[0].id === 'legacy');
  await store.upsert({ id: 'new', bytes: 20, segmentIndex: 2 });
  ok('写入时迁移并保留两段', storage.data.durableRecordings.length === 2 &&
    !('durableRecording' in storage.data) && storage.data.durableRecordings.some(x => x.id === 'legacy'));
  await store.upsert({ id: 'new', bytes: 30 });
  ok('同 id 更新不重复且保留原段号', storage.data.durableRecordings.length === 2 &&
    storage.data.durableRecordings.find(x => x.id === 'new').bytes === 30 &&
    storage.data.durableRecordings.find(x => x.id === 'new').segmentIndex === 2);
  await store.remove('legacy');
  ok('remove 只删除目标段', storage.data.durableRecordings.length === 1 &&
    storage.data.durableRecordings[0].id === 'new');
}

{
  const storage = memoryStorage();
  const store = createDurableStore(storage);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.upsert({ id: `seg-${i}`, bytes: i })));
  const records = await store.list();
  ok('并发 upsert 串行且没有覆盖', records.length === 12 && new Set(records.map(x => x.id)).size === 12);
  records[0].bytes = 999;
  ok('list 返回副本而非内部可变引用', (await store.list())[0].bytes !== 999);
  await store.clear();
  ok('clear 清空全部分段', (await store.list()).length === 0);
}

{
  const storage = memoryStorage({
    durableRecording: { id: 'old', bytes: 1 },
    durableRecordings: [{ id: 'new', bytes: 2 }],
  });
  const store = createDurableStore(storage);
  const initial = await store.list();
  ok('双 key 合并保留旧格式独有录制', initial.some(record => record.id === 'old') &&
    initial.some(record => record.id === 'new') && initial.length === 2);
  await store.upsert({ id: 'new', bytes: 3 });
  ok('迁移删除旧 key 前已保留独有录制', !('durableRecording' in storage.data) &&
    storage.data.durableRecordings.some(record => record.id === 'old') &&
    storage.data.durableRecordings.find(record => record.id === 'new').bytes === 3);
  await store.clear();
  ok('clear 同时清理新旧 key', !('durableRecording' in storage.data) &&
    (await store.list()).length === 0);
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n多分段存储测试全部通过 🎉');
process.exit(failed ? 1 : 0);
