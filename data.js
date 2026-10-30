// The ECU table is not shipped with the page: the user loads it once from a file and it is kept in this
// browser's IndexedDB. Accepts ecu-data.json, ecu-data.json.gz or ecu-data.js.
(function (root) {
  'use strict';

  const FIELDS = ['id', 'size', 'signed', 'mul', 'add', 'div', 'unit', 'name', 'result', 'dpf', 'byte', 'sort'];
  const DB_NAME = 'bmw-dpf-live';
  const STORE = 'data';
  const KEY = 'ecu-data';

  async function parse(bytes) {
    let text;
    if (bytes[0] === 0x1F && bytes[1] === 0x8B) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack .gz files, load ecu-data.json instead');
      text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else {
      text = new TextDecoder().decode(bytes);
    }
    let d;
    try {
      d = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch (e) {
      throw new Error('Not an ECU data file (invalid JSON)');
    }
    if (!d || !d.variants || !d.ecus || JSON.stringify(d.fields) !== JSON.stringify(FIELDS)) {
      throw new Error('Not an ECU data file (unexpected format)');
    }
    return d;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  const load = () => withStore('readonly', s => s.get(KEY));
  const save = d => withStore('readwrite', s => s.put(d, KEY));
  const clear = () => withStore('readwrite', s => s.delete(KEY));

  root.EcuData = { parse, load, save, clear, FIELDS };
})(globalThis);
