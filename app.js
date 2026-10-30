// UI for index.html: connect, identify the engine ECU, poll DPF values and user-picked values.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const { Elm327, SerialTransport, BleTransport } = globalThis.Elm;
  const { BmwDiag, DiagError } = globalThis.Bmw;
  const { SimTransport } = globalThis.Sim;
  const SOOT = 'stat_russmasse_im_partikelfilter_wert';

  const state = {
    transport: null, diag: null, ecu: null, live: false, busy: false,
    tiles: new Map(), unsupported: new Set(), mine: new Set(), history: [],
  };
  let data = null;  // ECU table, loaded from a user-picked file (see data.js)

  // ---------- log ----------
  const logLines = [];
  function log(kind, msg) {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    const tag = { tx: '>>', rx: '<<', err: '!!', info: '--' }[kind] || '--';
    logLines.push(`${t} ${tag} ${msg}`);
    if (logLines.length > 600) logLines.splice(0, logLines.length - 600);
    const el = $('log');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    el.textContent = logLines.join('\n');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = 'pill ' + (kind || '');
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- connection ----------
  function updateSupport() {
    const kind = $('transport').value;
    $('baud-wrap').classList.toggle('hidden', kind !== 'serial');
    const note = $('support');
    note.className = 'note';
    if (kind === 'serial' && !('serial' in navigator)) {
      note.textContent = 'Web Serial is not available in this browser. Use Chrome or Edge on a computer.';
      note.className = 'note err';
    } else if (kind === 'ble' && !('bluetooth' in navigator)) {
      note.textContent = 'Web Bluetooth is not available in this browser. Use Chrome or Edge (desktop or Android), or Bluefy on iPhone.';
      note.className = 'note err';
    } else if (kind === 'serial') {
      note.textContent = 'USB adapters: pick their COM port. Bluetooth Classic adapters: pair them in Windows first; they then appear as a COM port.';
    } else if (kind === 'ble') {
      note.textContent = 'Pick the adapter in the browser dialog (often named OBDII, vLinker, V-LINK, IOS-Vlink).';
    } else {
      note.textContent = 'Simulated car, no adapter needed.';
    }
  }

  // ---------- ECU data ----------
  function applyData(d, origin) {
    data = d;
    const files = Object.keys(d.ecus).sort();
    $('file-select').replaceChildren(...files.map(f => new Option(`${f} (${d.ecus[f].uds ? 'UDS' : 'KWP'})`, f)));
    $('data-status').className = 'note';
    $('data-status').textContent = `${origin}: ${Object.keys(d.variants).length} variants, ${files.length} engine ECUs` +
      (d.generated ? `, generated ${d.generated}` : '') + '.';
    $('data-remove').disabled = false;
    if (!state.transport) $('connect').disabled = false;
    log('info', `ECU table loaded (${origin}, source ${d.source})`);
  }

  function noData(message, isError) {
    data = null;
    $('data-status').className = 'note' + (isError ? ' err' : '');
    $('data-status').textContent = message;
    $('data-remove').disabled = true;
    $('connect').disabled = true;
  }

  async function loadDataFile(file) {
    try {
      const d = await EcuData.parse(new Uint8Array(await file.arrayBuffer()));
      let origin = `Loaded ${file.name}, stored in this browser`;
      try {
        await EcuData.save(d);
        await navigator.storage?.persist?.();
      } catch (e) {
        origin = `Loaded ${file.name} for this session only (browser storage unavailable)`;
      }
      applyData(d, origin);
    } catch (e) {
      log('err', e.message);
      $('data-status').className = 'note err';
      $('data-status').textContent = `${file.name}: ${e.message}`;
    }
  }

  async function removeData() {
    await disconnect();
    try { await EcuData.clear(); } catch (e) { /* nothing stored */ }
    noData('ECU data removed from this browser. Load the file again to connect.');
  }

  async function loadStoredData(url) {
    try {
      if (url) {
        const res = await fetch(url);
        applyData(await EcuData.parse(new Uint8Array(await res.arrayBuffer())), `Loaded ${url}`);
        return;
      }
      const d = await EcuData.load();
      if (d) { applyData(d, 'Stored in this browser'); return; }
    } catch (e) {
      log('err', `ECU data: ${e.message}`);
    }
    noData('No ECU data yet. Load ecu-data.json (or ecu-data.json.gz) once; this browser keeps it.');
  }

  // ---------- connection ----------
  async function connect() {
    if (state.transport || !data) return;
    $('connect').disabled = true;
    setStatus('Connecting…', 'busy');
    const kind = $('transport').value;
    try {
      let t;
      if (kind === 'serial') t = new SerialTransport(Number($('baud').value));
      else if (kind === 'ble') t = new BleTransport();
      else t = new SimTransport(kind.slice(4), data);
      await t.open();
      state.transport = t;
      t.onClose = e => { log('err', e.message); disconnect(); };
      const elm = new Elm327(t, log);
      state.diag = new BmwDiag(elm, data, { mode: $('mode').value, log });
      log('info', `Connected via ${t.label}, initializing adapter`);
      $('adapter').textContent = await state.diag.init();
      $('disconnect').disabled = false;
      setStatus('Connected', 'ok');
      $('ecu-section').classList.remove('hidden');
      await identify();
    } catch (e) {
      log('err', e.message);
      setStatus('Error', 'err');
      await disconnect(true);
    }
  }

  async function disconnect(keepStatus) {
    state.live = false;
    updateLiveButton();
    const t = state.transport;
    state.transport = null;
    state.diag = null;
    if (t) await t.close().catch(() => {});
    $('connect').disabled = !data;
    $('disconnect').disabled = true;
    if (!keepStatus) setStatus('Disconnected');
  }

  // ---------- ECU ----------
  async function identify() {
    const address = parseInt($('address').value, 16);
    $('ecu-note').textContent = 'Identifying engine ECU…';
    try {
      const id = await state.diag.identify(address);
      $('protocol').textContent = id.protocol;
      $('variant').textContent = id.key;
      if (id.file) {
        useEcu(id.file, address);
        $('ecu-note').textContent = '';
      } else {
        $('file').textContent = 'unknown';
        $('ecu-note').textContent = `Variant "${id.key}" is not in the ECU table. Pick the description file manually.`;
      }
    } catch (e) {
      log('err', `Identification failed: ${e.message}`);
      $('ecu-note').textContent = `No answer from ECU 0x${address.toString(16).toUpperCase()} (${e.message}). ` +
        'Check ignition, the ELM mode, or pick the description file manually.';
    }
  }

  function useEcu(file, address) {
    const ecu = state.diag ? state.diag.ecu(file) : null;
    if (!ecu) return;
    ecu.address = address ?? parseInt($('address').value, 16);
    state.ecu = ecu;
    state.unsupported.clear();
    state.history = [];
    state.mine = new Set(loadMine(file));
    $('file').textContent = `${file} (${ecu.uds ? 'UDS' : 'KWP2000'}, ${ecu.values.length} values)`;
    $('file-select').value = file;
    renderDpf();
    renderValues();
    $('dpf-section').classList.remove('hidden');
    $('values-section').classList.remove('hidden');
  }

  function loadMine(file) {
    try { return JSON.parse(localStorage.getItem('bmw-dpf-live:' + file) || '[]'); } catch (e) { return []; }
  }

  function saveMine() {
    try { localStorage.setItem('bmw-dpf-live:' + state.ecu.file, JSON.stringify([...state.mine])); } catch (e) { /* storage unavailable */ }
  }

  // ---------- tiles ----------
  function makeTile(v, feature) {
    const tile = el('div', 'tile' + (feature ? ' feature' : ''));
    tile.append(el('div', 'name', v.name), el('div', 'val', '–'), el('div', 'meta', `0x${v.key}`));
    if (feature) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 40');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'polyline'));
      tile.append(svg);
    }
    if (!state.ecu.readable(v)) {
      tile.classList.add('off');
      tile.querySelector('.val').textContent = 'not readable';
    }
    state.tiles.set(v.key, tile);
    return tile;
  }

  // DPF values in their usual order, soot mass first.
  function dpfValues() {
    if (!state.ecu) return [];
    const rank = v => (v.result.toLowerCase() === SOOT ? -1 : v.sort);
    return state.ecu.values.filter(v => v.dpf).sort((a, b) => rank(a) - rank(b));
  }

  function mineValues() {
    return state.ecu ? state.ecu.values.filter(v => state.mine.has(v.key) && !v.dpf) : [];
  }

  function renderDpf() {
    state.tiles.clear();
    const box = $('dpf-tiles');
    box.replaceChildren();
    const dpf = dpfValues();
    for (const v of dpf) box.append(makeTile(v, v.result.toLowerCase() === SOOT));
    $('dpf-note').textContent = dpf.length ? '' : 'This ECU has no DPF values. Use the value list below.';
    renderMine();
  }

  function renderMine() {
    const box = $('mine-tiles');
    box.replaceChildren();
    const mine = mineValues();
    for (const v of mine) box.append(makeTile(v, false));
    $('mine-title').classList.toggle('hidden', !mine.length);
  }

  function showValue(v, r) {
    const tile = state.tiles.get(v.key);
    if (tile) {
      tile.classList.remove('err');
      const val = tile.querySelector('.val');
      val.textContent = r.text;
      if (r.unit) val.append(el('small', '', r.unit));
      tile.querySelector('.meta').textContent = `0x${v.key} · raw ${r.raw} · ${new Date().toLocaleTimeString([], { hour12: false })}`;
      if (v.result.toLowerCase() === SOOT) drawHistory(tile, r.value);
    }
    const cell = document.querySelector(`td[data-out="${v.key}"]`);
    if (cell) cell.textContent = `${r.text} ${r.unit}`.trim();
  }

  function showError(v, e) {
    const tile = state.tiles.get(v.key);
    if (tile) {
      tile.classList.add('err');
      tile.querySelector('.val').textContent = e.nrc === 0x31 ? 'not supported by this ECU' : e.message;
    }
    const cell = document.querySelector(`td[data-out="${v.key}"]`);
    if (cell) cell.textContent = e.message;
  }

  function drawHistory(tile, value) {
    state.history.push(value);
    if (state.history.length > 120) state.history.shift();
    const h = state.history;
    const min = Math.min(...h), max = Math.max(...h), span = max - min || 1;
    const pts = h.map((y, i) => `${(i / Math.max(h.length - 1, 1)) * 100},${38 - ((y - min) / span) * 36}`).join(' ');
    tile.querySelector('polyline').setAttribute('points', pts);
  }

  // ---------- reading ----------
  async function readOne(v) {
    if (!state.diag || !state.ecu.readable(v) || state.unsupported.has(v.key)) return true;
    try {
      showValue(v, await state.diag.readValue(state.ecu, v));
      return true;
    } catch (e) {
      if (e.nrc === 0x31 || e.nrc === 0x11) state.unsupported.add(v.key);
      showError(v, e);
      if (!(e instanceof DiagError)) log('err', `${v.name}: ${e.message}`);
      return e instanceof DiagError;
    }
  }

  async function readRound() {
    let adapterErrors = 0;
    for (const v of [...dpfValues(), ...mineValues()]) {
      if (!state.diag) return false;
      if (!(await readOne(v)) && ++adapterErrors >= 3) {
        log('err', 'Adapter stopped answering, live reading stopped');
        return false;
      }
    }
    return true;
  }

  async function exclusive(fn) {
    if (state.busy) return;
    state.busy = true;
    try { await fn(); } finally { state.busy = false; }
  }

  function updateLiveButton() {
    $('live').textContent = state.live ? 'Stop live' : 'Start live';
    $('once').disabled = state.live;
  }

  async function toggleLive() {
    if (state.live) { state.live = false; updateLiveButton(); return; }
    if (state.busy) return;
    state.live = true;
    updateLiveButton();
    await exclusive(async () => {
      while (state.live && state.diag) {
        if (!(await readRound())) break;
        const pause = Number($('interval').value);
        for (let waited = 0; state.live && waited < pause; waited += 100) await sleep(100);
      }
    });
    state.live = false;
    updateLiveButton();
  }

  // ---------- value list ----------
  function renderValues() {
    const q = $('search').value.trim().toLowerCase();
    const body = $('values');
    body.replaceChildren();
    const rows = state.ecu.values.filter(v => !q || v.name.toLowerCase().includes(q) ||
      v.key.toLowerCase().includes(q) || v.result.toLowerCase().includes(q)).slice(0, 400);
    for (const v of rows) {
      const tr = document.createElement('tr');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.mine.has(v.key) || v.dpf;
      box.disabled = v.dpf || !state.ecu.readable(v);
      box.title = v.dpf ? 'Already on the DPF screen' : 'Poll this value live';
      box.addEventListener('change', () => {
        if (box.checked) state.mine.add(v.key); else state.mine.delete(v.key);
        saveMine();
        renderMine();
      });
      const read = el('button', '', 'Read');
      read.disabled = !state.ecu.readable(v);
      read.addEventListener('click', () => readOne(v));
      const out = el('td', 'out', '');
      out.dataset.out = v.key;
      const tdBox = el('td');
      tdBox.append(box);
      const tdRead = el('td');
      tdRead.append(read);
      tr.append(tdBox, el('td', '', v.name), el('td', 'mono', '0x' + v.key), el('td', '', v.unit), out, tdRead);
      body.append(tr);
    }
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = el('td', '', 'No matching values');
      td.colSpan = 6;
      tr.append(td);
      body.append(tr);
    }
  }

  // ---------- wiring ----------
  async function init() {
    $('data-file').addEventListener('change', e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) loadDataFile(file);
    });
    $('data-remove').addEventListener('click', removeData);
    $('transport').addEventListener('change', updateSupport);
    $('connect').addEventListener('click', connect);
    $('disconnect').addEventListener('click', () => disconnect());
    $('use-file').addEventListener('click', () => { if (state.diag) useEcu($('file-select').value); });
    $('live').addEventListener('click', toggleLive);
    $('once').addEventListener('click', () => exclusive(readRound));
    $('search').addEventListener('input', () => state.ecu && renderValues());
    $('log-clear').addEventListener('click', () => { logLines.length = 0; $('log').textContent = ''; });
    $('log-copy').addEventListener('click', () => navigator.clipboard?.writeText(logLines.join('\n')));
    // ?data=<url>&transport=sim-g21&mode=raw&auto=1 loads data and connects on load, for quick checks.
    const params = new URLSearchParams(location.search);
    // Phones (Bluefy on iPhone, Chrome on Android) have Web Bluetooth but no Web Serial.
    if (!('serial' in navigator) && 'bluetooth' in navigator) $('transport').value = 'ble';
    for (const k of ['transport', 'mode', 'address', 'baud']) if (params.get(k)) $(k).value = params.get(k);
    updateSupport();
    await loadStoredData(params.get('data'));
    if (params.get('auto') && data) connect().then(() => { if (state.ecu) toggleLive(); });
  }

  init().catch(e => log('err', e.message));
})();
