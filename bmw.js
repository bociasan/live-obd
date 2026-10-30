// BMW D-CAN diagnostics on top of an ELM327: tester 0x6F1 -> ECU 0x600+addr, first data byte = target
// address (extended addressing). Only read services are used: UDS 22 (F/G-series), KWP 1A / 2C 10
// (E-series diesel).
(function (root) {
  'use strict';

  const TESTER = 0xF1;

  const NRC = {
    0x10: 'general reject', 0x11: 'service not supported', 0x12: 'sub-function not supported',
    0x13: 'wrong message length', 0x22: 'conditions not correct', 0x31: 'not supported by this ECU',
    0x33: 'security access denied', 0x78: 'response pending', 0x7E: 'not supported in this session',
    0x7F: 'service not supported in this session',
  };

  // Standard mode: the ELM inserts the target byte (CEA) and answers flow control itself.
  // Flow-control header and data must be set before "ATFC SM 1" is accepted.
  const INIT_EXT = ['ATS0', 'ATL0', 'ATAL', 'ATH1', 'ATPB C101', 'ATSH 6F1', 'ATFC SH 6F1', 'ATFC SD 12 30 00 02',
    'ATFC SM 1', 'ATCEA 12', 'ATCRA 612', 'ATSP B', 'ATBI', 'ATAT1', 'ATST 32'];
  // Raw mode: 8-byte frames, ISO-TP done here. For clones without CEA support.
  const INIT_RAW = ['ATS0', 'ATL0', 'ATAL', 'ATH1', 'ATPB C001', 'ATSH 6F1', 'ATCAF0', 'ATCRA 612', 'ATSP B',
    'ATBI', 'ATAT1', 'ATST 32'];

  const ELM_ERRORS = /^(NO DATA|CAN ERROR|BUS INIT|BUS BUSY|BUS ERROR|FB ERROR|DATA ERROR|BUFFER FULL|STOPPED|UNABLE TO CONNECT|\?|<RX ERROR|ERR\d+|LV RESET|ACT ALERT)/i;

  class DiagError extends Error {
    constructor(message, nrc) {
      super(message);
      this.nrc = nrc;
    }
  }

  const h2 = b => b.toString(16).toUpperCase().padStart(2, '0');
  const hex = bytes => Array.from(bytes, h2).join(' ');

  // Collects ISO-TP frames ([extAddr, PCI, ...]) into complete messages.
  class IsoTp {
    constructor() {
      this.messages = [];
      this.cur = null;
      this.awaitingFc = false;
    }

    push(f) {
      const type = f[1] >> 4;
      if (type === 0) {
        const len = f[1] & 0x0F;
        this.messages.push(f.slice(2, 2 + len));
        this.cur = null;
      } else if (type === 1) {
        const len = ((f[1] & 0x0F) << 8) | f[2];
        this.cur = { len, data: f.slice(3), sn: 1 };
        this.awaitingFc = true;
      } else if (type === 2 && this.cur) {
        if ((f[1] & 0x0F) !== (this.cur.sn & 0x0F)) throw new DiagError('ISO-TP sequence error');
        this.cur.sn++;
        this.awaitingFc = false;
        this.cur.data = this.cur.data.concat(f.slice(2));
      }
      if (this.cur && this.cur.data.length >= this.cur.len) {
        this.messages.push(this.cur.data.slice(0, this.cur.len));
        this.cur = null;
        this.awaitingFc = false;
      }
    }

    get incomplete() { return !!this.cur; }
  }

  // One live value definition, unpacked from the compact rows in ecu-data.js.
  function valueDef(row) {
    const [id, size, signed, mul, add, div, unit, name, result, dpf, byte, sort] = row;
    return { id, size, signed: !!signed, mul, add, div, unit, name, result, dpf: !!dpf, byte, sort,
      key: h2(id >> 8) + h2(id & 0xFF) + (byte >= 0 ? '@' + byte : '') };
  }

  // Yes/no interpretations of the regeneration status values.
  const FLAG_RULES = {
    stat_coeom_stopmodeact_wert: raw => (raw & 2) === 2,
    stat_pfltrgn_numrgn_wert: raw => raw >= 4 && raw <= 6,
    stat_regenerationsanforderung_wert: raw => raw >= 4 && raw <= 6,
    stat_status_regeneration_unterbrochen_wert: raw => raw === 1,
    stat_regeneration_blockierung_und_freigabe_wert: raw => raw === 1,
  };

  function decimalsFor(v) {
    const step = Math.abs(v.mul / v.div);
    if (!step || step >= 1) return 0;
    return Math.min(3, Math.ceil(-Math.log10(step)));
  }

  function decode(v, bytes) {
    if (bytes.length < v.size) throw new DiagError(`Short response (${bytes.length} of ${v.size} bytes)`);
    let raw = 0;
    for (let i = 0; i < v.size; i++) raw = raw * 256 + bytes[i];
    if (v.signed && raw >= 2 ** (v.size * 8 - 1)) raw -= 2 ** (v.size * 8);
    const value = raw * v.mul / v.div + v.add;
    const flag = FLAG_RULES[v.result.toLowerCase()];
    if (flag) return { raw, value, text: flag(raw) ? 'yes' : 'no', unit: '' };
    if (v.unit === 'm') return { raw, value, text: (value / 1000).toFixed(1), unit: 'km' };
    if (v.unit === 's' && Math.abs(value) >= 3600) return { raw, value, text: (value / 3600).toFixed(1), unit: 'h' };
    return { raw, value, text: value.toFixed(decimalsFor(v)), unit: v.unit === '-' ? '' : v.unit };
  }

  class BmwDiag {
    constructor(elm, data, { mode = 'ext', log } = {}) {
      this.elm = elm;
      this.data = data;
      this.mode = mode;
      this.log = log || (() => {});
      this.target = null;
    }

    async init() {
      await this.elm.send('ATZ', 3000).catch(() => this.elm.send('ATWS', 3000));
      await this.elm.send('ATE0');
      const version = (await this.elm.send('ATI')).join(' ');
      for (const cmd of this.mode === 'raw' ? INIT_RAW : INIT_EXT) {
        const lines = await this.elm.send(cmd);
        if (lines.some(l => l.startsWith('?'))) this.log('err', `${cmd} not supported by this adapter`);
      }
      this.target = 0x12;
      return version;
    }

    async _selectTarget(target) {
      if (this.target === target) return;
      const t = h2(target);
      if (this.mode === 'raw') {
        await this.elm.send(`ATCRA 6${t}`);
      } else {
        await this.elm.send(`ATCEA ${t}`);
        await this.elm.send(`ATCRA 6${t}`);
        await this.elm.send(`ATFC SD ${t} 30 00 02`);
      }
      this.target = target;
    }

    _frames(lines, target) {
      const frames = [];
      let error = null;
      for (const line of lines) {
        const s = line.replace(/\s+/g, '').toUpperCase();
        if (ELM_ERRORS.test(line) || !/^[0-9A-F]+$/.test(s)) {
          if (!/^(SEARCHING|OK)/i.test(line)) error = error || line;
          continue;
        }
        if (s.length < 7 || s.length % 2 === 0) continue;
        if (parseInt(s.slice(0, 3), 16) !== 0x600 + target) continue;
        const bytes = [];
        for (let i = 3; i < s.length; i += 2) bytes.push(parseInt(s.slice(i, i + 2), 16));
        if (bytes[0] === TESTER) frames.push(bytes);
      }
      return { frames, error };
    }

    _format(target, payload) {
      if (this.mode !== 'raw') return hex(payload).replace(/ /g, '');
      if (payload.length > 6) throw new DiagError('Request too long for a single CAN frame');
      const frame = [target, payload.length, ...payload];
      while (frame.length < 8) frame.push(0);
      return hex(frame).replace(/ /g, '');
    }

    // Sends a diagnostic request and returns the positive response payload (starting with SID + 0x40).
    // Requests are serialized: one exchange can span several ELM commands (target switch, flow control).
    request(target, payload) {
      const run = () => this._request(target, payload);
      const p = (this.lock || Promise.resolve()).then(run, run);
      this.lock = p.catch(() => {});
      return p;
    }

    async _request(target, payload) {
      if (this.mode !== 'raw' && payload.length > 6) throw new DiagError('Request too long for a single CAN frame');
      await this._selectTarget(target);
      for (let attempt = 0; attempt < 3; attempt++) {
        let lines = await this.elm.send(this._format(target, payload), 3000);
        const tp = new IsoTp();
        let error = null;
        for (let fc = 0; fc < 64; fc++) {
          const r = this._frames(lines, target);
          error = error || r.error;
          r.frames.forEach(f => tp.push(f));
          if (!(this.mode === 'raw' && tp.incomplete && tp.awaitingFc)) break;
          // Raw mode: the ECU waits for our flow control after a first frame.
          lines = await this.elm.send(hex([target, 0x30, 0x00, 0x00, 0, 0, 0, 0]).replace(/ /g, ''), 3000);
        }
        const final = tp.messages.filter(m => !(m[0] === 0x7F && m[2] === 0x78));
        if (final.length) return this._check(final[final.length - 1], payload[0]);
        if (tp.messages.length) continue;  // only "response pending" arrived: ask again
        if (tp.incomplete) throw new DiagError('Incomplete multi-frame response');
        throw new DiagError(error || 'No response');
      }
      throw new DiagError('ECU kept answering "response pending"');
    }

    _check(msg, sid) {
      if (msg[0] === 0x7F) {
        const code = msg[2];
        throw new DiagError(`Negative response 0x${h2(code)} (${NRC[code] || 'unknown'})`, code);
      }
      if (msg[0] !== (sid | 0x40)) throw new DiagError(`Unexpected response ${hex(msg.slice(0, 4))}`);
      return msg;
    }

    // Identifies the engine ECU and maps it to its description file in ecu-data.js.
    async identify(target = 0x12) {
      const t = h2(target);
      const keys = [];
      let protocol = null;
      try {
        const r = await this.request(target, [0x22, 0xF1, 0x50]);
        if (r.length >= 6) {
          keys.push(`${t} ${hex(r.slice(3, 6)).replace(/ /g, '')}`);
          protocol = 'UDS';
        }
      } catch (e) {
        this.log('info', `UDS identification failed (${e.message}), trying KWP2000`);
      }
      if (!protocol) {
        const r = await this.request(target, [0x1A, 0x80]);
        if (r.length < 14) throw new DiagError('Identification response too short');
        const index = h2(r[10]) + h2(r[11]);
        const chars = String.fromCharCode(r[12], r[13]).toUpperCase();
        keys.push(`${t} .${chars}. ${index}`, `${t} 00${chars} ${index}`, `${t} ---- ${index}`);
        protocol = 'KWP2000';
      }
      const key = keys.find(k => this.data.variants[k]);
      return { protocol, key: key || keys[0], file: key ? this.data.variants[key] : null };
    }

    ecu(file) {
      const e = this.data.ecus[file];
      if (!e) return null;
      const diesel = file.startsWith('d') && !file.startsWith('dme');
      return {
        file,
        uds: e.uds,
        address: e.address,
        diesel,
        values: e.values.map(valueDef),
        readable: v => e.uds || v.byte >= 0 || diesel,
      };
    }

    async readValue(ecu, v) {
      if (ecu.uds || v.byte >= 0) {
        const r = await this.request(ecu.address, [0x22, v.id >> 8, v.id & 0xFF]);
        if (r[1] !== v.id >> 8 || r[2] !== (v.id & 0xFF)) throw new DiagError('Response for a different DID');
        const off = v.byte >= 0 ? v.byte : 3;
        return decode(v, r.slice(off, off + v.size));
      }
      if (ecu.diesel) {
        // E-series DDE: dynamically defined local identifier 0x10, answered with the data right away.
        const r = await this.request(ecu.address, [0x2C, 0x10, v.id >> 8, v.id & 0xFF]);
        return decode(v, r.slice(2, 2 + v.size));
      }
      throw new DiagError('KWP2000 petrol engines are not supported by this page');
    }
  }

  root.Bmw = { BmwDiag, DiagError, IsoTp, decode, valueDef, hex, NRC };
})(globalThis);
