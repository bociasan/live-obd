// ELM327 transports (Web Serial, Web Bluetooth) and the AT command layer.
// Plain script: exposes globalThis.Elm so it also loads in Node for the simulator tests.
(function (root) {
  'use strict';

  const enc = new TextEncoder();

  // USB adapters and Bluetooth Classic adapters paired as a COM port.
  class SerialTransport {
    constructor(baudRate) {
      this.baudRate = baudRate;
      this.onData = null;
      this.onClose = null;
    }

    get label() { return `Serial ${this.baudRate} baud`; }

    async open() {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.baudRate });
      this.writer = this.port.writable.getWriter();
      this.keepReading = true;
      this.readLoop = this._readLoop();
    }

    async _readLoop() {
      const dec = new TextDecoder();
      while (this.keepReading && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && this.onData) this.onData(dec.decode(value, { stream: true }));
          }
        } catch (e) {
          // Non-fatal errors (framing, overrun) leave port.readable set and the loop continues.
        } finally {
          this.reader.releaseLock();
        }
      }
      if (this.keepReading && this.onClose) this.onClose(new Error('Serial port closed'));
    }

    async write(text) {
      await this.writer.write(enc.encode(text));
    }

    async close() {
      this.keepReading = false;
      try { await this.reader?.cancel(); } catch (e) { /* already closed */ }
      await this.readLoop?.catch(() => {});
      try { this.writer?.releaseLock(); } catch (e) { /* already released */ }
      try { await this.port?.close(); } catch (e) { /* already closed */ }
    }
  }

  // Serial-over-BLE services used by ELM327 BLE adapters. FFF0 (notify FFF1 / write FFF2) is the most common;
  // the others cover clones.
  const BLE_SERVICES = [
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '000018f0-0000-1000-8000-00805f9b34fb',
  ];

  class BleTransport {
    constructor() {
      this.onData = null;
      this.onClose = null;
    }

    get label() { return `BLE ${this.device?.name || ''}`.trim(); }

    async open() {
      this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      this.device.addEventListener('gattserverdisconnected', () => {
        if (!this.closing && this.onClose) this.onClose(new Error('Bluetooth device disconnected'));
      });
      const server = await this.device.gatt.connect();
      for (const uuid of BLE_SERVICES) {
        let service;
        try { service = await server.getPrimaryService(uuid); } catch (e) { continue; }
        const chars = await service.getCharacteristics();
        const rx = chars.find(c => c.properties.notify || c.properties.indicate);
        const tx = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
        if (rx && tx) { this.rx = rx; this.tx = tx; break; }
      }
      if (!this.rx) throw new Error('No ELM327 serial service found on this Bluetooth device');
      const dec = new TextDecoder();
      this.rx.addEventListener('characteristicvaluechanged', ev => {
        const v = ev.target.value;
        if (this.onData) this.onData(dec.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), { stream: true }));
      });
      await this.rx.startNotifications();
    }

    async write(text) {
      const bytes = enc.encode(text);
      for (let i = 0; i < bytes.length; i += 20) {
        const chunk = bytes.slice(i, i + 20);
        // Older Web Bluetooth implementations (e.g. some iOS browsers) only have writeValue().
        if (this.tx.properties.writeWithoutResponse && this.tx.writeValueWithoutResponse) await this.tx.writeValueWithoutResponse(chunk);
        else if (this.tx.writeValueWithResponse) await this.tx.writeValueWithResponse(chunk);
        else await this.tx.writeValue(chunk);
      }
    }

    async close() {
      this.closing = true;
      try { await this.rx?.stopNotifications(); } catch (e) { /* already disconnected */ }
      try { this.device?.gatt.disconnect(); } catch (e) { /* already disconnected */ }
    }
  }

  // Sends one command at a time and resolves with the response lines once the '>' prompt arrives.
  class Elm327 {
    constructor(transport, log) {
      this.transport = transport;
      this.log = log || (() => {});
      this.buf = '';
      this.waiter = null;
      this.queue = Promise.resolve();
      transport.onData = text => this._onData(text);
    }

    _onData(text) {
      this.buf += text;
      const end = this.buf.indexOf('>');
      if (end < 0 || !this.waiter) return;
      const reply = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 1);
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(reply);
    }

    send(cmd, timeoutMs = 2000) {
      const run = () => new Promise((resolve, reject) => {
        this.buf = '';
        const timer = setTimeout(() => {
          this.waiter = null;
          this.log('err', `${cmd}: no prompt within ${timeoutMs} ms`);
          reject(new Error(`Adapter did not answer "${cmd}"`));
        }, timeoutMs);
        const echo = cmd.replace(/\s+/g, '').toUpperCase();
        this.waiter = {
          timer,
          resolve: reply => {
            const lines = reply.split(/[\r\n]+/).map(l => l.trim())
              .filter(l => l && l.replace(/\s+/g, '').toUpperCase() !== echo);
            this.log('rx', lines.join(' | ') || '(empty)');
            resolve(lines);
          },
        };
        this.log('tx', cmd);
        this.transport.write(cmd + '\r').catch(e => {
          clearTimeout(timer);
          this.waiter = null;
          reject(e);
        });
      });
      const p = this.queue.then(run, run);
      this.queue = p.catch(() => {});
      return p;
    }
  }

  root.Elm = { SerialTransport, BleTransport, Elm327, BLE_SERVICES };
})(globalThis);
