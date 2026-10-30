// End-to-end check in a real Chrome: load the ECU data through the file input, reload (IndexedDB), run the G21
// simulator, remove the data. Usage: node web/test/browser.test.js [path/to/chrome] [path/to/ecu-data.json.gz]
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = path.join(__dirname, '..');
const CHROME = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DATA = path.resolve(process.argv[3] || path.join(WEB, '..', 'data', 'ecu-data.json.gz'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const file = path.join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function cdp(port) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { /* not up yet */ }
    if (!target) await sleep(200);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  return { send, evaluate, close: () => ws.close() };
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-web-test-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank']);
  const c = await cdp(port);
  const status = () => c.evaluate("document.getElementById('data-status').textContent");
  const go = async url => { await c.send('Page.navigate', { url }); await sleep(1500); };
  try {
    await c.send('Page.enable');
    await go(base);
    assert.match(await status(), /No ECU data yet/);
    assert.strictEqual(await c.evaluate("document.getElementById('connect').disabled"), true);
    console.log('1. fresh browser: no data, Connect disabled');

    const { root } = await c.send('DOM.getDocument');
    const { nodeId } = await c.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#data-file' });
    await c.send('DOM.setFileInputFiles', { nodeId, files: [DATA] });
    await sleep(2000);
    assert.match(await status(), /stored in this browser: 240 variants/);
    console.log(`2. file input: ${await status()}`);

    await go(base);
    assert.match(await status(), /^Stored in this browser: 240 variants/);
    console.log(`3. reload: ${await status()}`);

    await go(base + '?transport=sim-g21&auto=1');
    await sleep(3000);
    const soot = await c.evaluate("[...document.querySelectorAll('.tile.feature .val')].map(e => e.textContent).join()");
    const file = await c.evaluate("document.getElementById('file').textContent");
    assert.match(soot, /^1\d\.\d\dg$/);
    console.log(`4. simulator with stored data: ${file}, soot ${soot}`);

    await c.evaluate("document.getElementById('data-remove').click()");
    await sleep(1000);
    await go(base);
    assert.match(await status(), /No ECU data yet/);
    console.log('5. remove: data gone after reload');
    console.log('ALL OK');
  } finally {
    await c.send('Browser.close').catch(() => {});
    c.close();
    server.close();
    await sleep(500);
    chrome.kill();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
