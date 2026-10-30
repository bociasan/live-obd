// Runs the ELM/BMW protocol stack against the simulator: node web/test/sim.test.js [path/to/ecu-data.json]
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const f of ['data.js', 'elm327.js', 'bmw.js', 'sim.js']) require(path.join(__dirname, '..', f));
const { Elm327 } = globalThis.Elm;
const { BmwDiag } = globalThis.Bmw;
const { SimTransport } = globalThis.Sim;
const dataFile = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'ecu-data.json');
let data;

async function run(profile, mode, expectFile, sootId) {
  const log = [];
  const sim = new SimTransport(profile, data);
  const elm = new Elm327(sim, (k, m) => log.push(`${k} ${m}`));
  const diag = new BmwDiag(elm, data, { mode, log: (k, m) => log.push(`${k} ${m}`) });
  const version = await diag.init();
  assert.match(version, /ELM327/);
  const id = await diag.identify(0x12);
  assert.strictEqual(id.file, expectFile, `identify: ${JSON.stringify(id)}\n${log.join('\n')}`);
  const ecu = diag.ecu(id.file);
  const soot = ecu.values.find(v => v.id === sootId && v.byte < 0);
  const r = await diag.readValue(ecu, soot);
  assert.ok(r.value > 15 && r.value < 30, `soot ${r.value}`);
  const dpf = ecu.values.filter(v => v.dpf).sort((a, b) => a.sort - b.sort);
  const rows = [];
  for (const v of dpf) {
    try {
      const x = await diag.readValue(ecu, v);
      rows.push(`  ${v.key.padEnd(6)} ${v.name.padEnd(55)} ${x.text} ${x.unit}`);
    } catch (e) {
      rows.push(`  ${v.key.padEnd(6)} ${v.name.padEnd(55)} ERROR ${e.message}`);
    }
  }
  console.log(`== ${profile} / ${mode}: ${id.protocol} ${id.key} -> ${id.file}, ${version}`);
  console.log(rows.join('\n'));
  return log;
}

(async () => {
  // the page's loader must accept the .json, the .json.gz and reject anything else
  data = await EcuData.parse(new Uint8Array(fs.readFileSync(dataFile)));
  const gz = await EcuData.parse(new Uint8Array(fs.readFileSync(dataFile + '.gz')));
  assert.deepStrictEqual(Object.keys(gz.variants), Object.keys(data.variants));
  await assert.rejects(EcuData.parse(new TextEncoder().encode('{"hello":1}')), /unexpected format/);
  console.log(`data: ${Object.keys(data.variants).length} variants, ${Object.keys(data.ecus).length} ECUs (json + gz ok)`);

  await run('g21', 'ext', 'd83bx7c0', 0x44BE);
  await run('g21', 'raw', 'd83bx7c0', 0x44BE);
  await run('e90', 'ext', 'd73n47a0', 0x03EA);
  const log = await run('e90', 'raw', 'd73n47a0', 0x03EA);
  console.log('-- e90 raw log (first 30 lines)\n' + log.slice(0, 30).join('\n'));
  console.log('ALL OK');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
