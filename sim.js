// Simulated ELM327 + engine ECU, for trying the page (and running web/test/sim.test.js) without a car.
// Answers the same frames a real DDE would: UDS on F/G-series, KWP2000 (1A 80, 2C 10) on E-series.
(function (root) {
  'use strict';

  const PROFILES = {
    g21: {
      label: 'Simulator: G21 320d (D83BX7C0, UDS)',
      file: 'd83bx7c0', uds: true, ident: [0x0F, 0x26, 0x78],
      // physical values for the DPF screen; everything else gets a stable pseudo-random raw value
      values: { 0x44BE: 18.4, 0x44BD: 31.2, 0x461B: 86, 0x44EF: 312, 0x4504: 1012, 0x44F8: 14.5, 0x44BF: 245300,
        0x44B7: 15800, 0x44BC: 19.6, 0x44C7: 410, 0x4C78: 2400, 0x44BB: 0, 0x467E: 0, 0x44C0: 0, 0x44C2: 0 },
    },
    e90: {
      label: 'Simulator: E90 320d (D73N47A0, KWP2000)',
      file: 'd73n47a0', uds: false, ident: { index: [0x00, 0x20], chars: 'XY' },
      values: { 0x03EA: 22.7, 0x03ED: 21.9, 0x03E9: 28.4, 0x0547: 88, 0x041B: 296, 0x0432: 1018, 0x0424: 11.8,
        0x03F3: 455, 0x03EB: 182400, 0x03E8: 14.9, 0x0408: 11800, 0x0BA4: 3100, 0x0404: 0, 0x05AA: 0, 0x03EC: 0,
        0x03EE: 0 },
    },
  };

  class SimTransport {
    constructor(profileName, data) {
      this.profile = PROFILES[profileName];
      this.ecu = data.ecus[this.profile.file];
      this.onData = null;
      this.onClose = null;
      this.st = { echo: true, cea: null, caf: true, cra: 0x612 };
      this.pendingCf = [];
      this.t0 = Date.now();
    }

    get label() { return this.profile.label; }

    async open() {}

    async close() {}

    async write(text) {
      for (const cmd of text.split('\r').map(s => s.trim()).filter(Boolean)) {
        await new Promise(r => setTimeout(r, 5));
        this.onData((this.st.echo ? cmd + '\r' : '') + this._handle(cmd.toUpperCase()).join('\r') + '\r\r>');
      }
    }

    _handle(cmd) {
      const c = cmd.replace(/\s+/g, '');
      if (c.startsWith('AT')) return this._at(c.slice(2));
      if (!/^[0-9A-F]+$/.test(c) || c.length % 2) return ['?'];
      const bytes = c.match(/../g).map(b => parseInt(b, 16));
      let target, payload;
      if (this.st.caf && this.st.cea !== null) {
        target = this.st.cea;
        payload = bytes;
      } else {
        target = bytes[0];
        const pci = bytes[1];
        if (pci >> 4 === 3) {  // flow control from the tester releases the consecutive frames
          const cf = this.pendingCf;
          this.pendingCf = [];
          return cf.length ? cf : ['NO DATA'];
        }
        payload = bytes.slice(2, 2 + (pci & 0x0F));
      }
      if (0x600 + target !== this.st.cra) return ['NO DATA'];
      const resp = target === 0x12 ? this._ecu(payload) : null;
      return resp ? this._frames(target, resp) : ['NO DATA'];
    }

    _at(c) {
      if (c === 'Z' || c === 'WS') { this.st = { echo: true, cea: null, caf: true, cra: 0x612 }; return ['ELM327 v1.5 (simulator)']; }
      if (c === 'I') return ['ELM327 v1.5 (simulator)'];
      if (c === 'E0') this.st.echo = false;
      if (c === 'E1') this.st.echo = true;
      if (c === 'CAF0') this.st.caf = false;
      if (c === 'CAF1') this.st.caf = true;
      if (c.startsWith('CEA')) this.st.cea = c.length > 3 ? parseInt(c.slice(3), 16) : null;
      if (c.startsWith('CRA')) this.st.cra = parseInt(c.slice(3), 16);
      return ['OK'];
    }

    // ISO-TP frames as the ELM prints them with ATH1 ATS0: "6xx" + F1 + PCI + data.
    _frames(target, msg) {
      const id = (0x600 + target).toString(16).toUpperCase();
      const line = bytes => id + bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      if (msg.length <= 6) return [line([0xF1, msg.length, ...msg])];
      const out = [line([0xF1, 0x10 | (msg.length >> 8), msg.length & 0xFF, ...msg.slice(0, 5)])];
      const cfs = [];
      for (let i = 5, sn = 1; i < msg.length; i += 6, sn++) cfs.push(line([0xF1, 0x20 | (sn & 0x0F), ...msg.slice(i, i + 6)]));
      if (this.st.caf && this.st.cea !== null) return out.concat(cfs);  // ELM sent the flow control itself
      this.pendingCf = cfs;
      return out;
    }

    _ecu(p) {
      const P = this.profile;
      if (P.uds) {
        if (p[0] !== 0x22) return [0x7F, p[0], 0x11];
        const did = (p[1] << 8) | p[2];
        if (did === 0xF150) return [0x62, 0xF1, 0x50, ...P.ident];
        const data = this._raw(did);
        return data ? [0x62, p[1], p[2], ...data] : [0x7F, 0x22, 0x31];
      }
      if (p[0] === 0x1A && p[1] === 0x80) {
        const r = [0x5A, 0x80, 0, 0, 0x07, 0x81, 0x99, 0x01, 0x11, 0x0E, ...P.ident.index,
          P.ident.chars.charCodeAt(0), P.ident.chars.charCodeAt(1), 0x20, 0x07, 0x05, 0x14];
        return r;
      }
      if (p[0] === 0x2C && p[1] === 0x10 && p.length === 4) {
        const data = this._raw((p[2] << 8) | p[3]);
        return data ? [0x6C, 0x10, ...data] : [0x7F, 0x2C, 0x31];
      }
      return [0x7F, p[0], 0x11];
    }

    // Raw bytes for a value: from the physical value table (with a little drift) or pseudo-random.
    _raw(id) {
      const row = this.ecu.values.find(r => r[0] === id && r[10] < 0);
      if (!row) return null;
      const [, size, signed, mul, add, div] = row;
      const phys = this.profile.values[id];
      let raw;
      if (phys !== undefined) {
        const drift = phys > 1 ? Math.sin((Date.now() - this.t0) / 4000 + id) * phys * 0.01 : 0;
        raw = Math.round((phys + drift - add) * div / mul);
      } else {
        raw = (id * 2654435761) % (2 ** (size * 8 - (signed ? 1 : 0)));
      }
      const max = 2 ** (size * 8);
      raw = ((raw % max) + max) % max;
      const out = [];
      for (let i = size - 1; i >= 0; i--) out.push(Math.floor(raw / 2 ** (i * 8)) & 0xFF);
      return out;
    }
  }

  root.Sim = { SimTransport, PROFILES };
})(globalThis);
