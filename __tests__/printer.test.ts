import { LabelPrinter } from '../src/printer';
import { PrinterNotReadyError, TransportError } from '../src/errors';
import { ZplLabel } from '../src/zpl';
import { FakeTransport, bytes } from './helpers';

const frame = (s: string) => `\x02${s}\x03\r\n`;

describe('LabelPrinter', () => {
  it('prints a label and a raw string', async () => {
    const t = new FakeTransport();
    const p = new LabelPrinter(t);
    await p.connect();
    await p.print(new ZplLabel({ widthDots: 8, lengthDots: 8 }));
    await p.print('~JC');
    expect(t.writtenText()).toBe('^XA^PW8^LL8^CI28^PQ1^XZ|~JC');
  });

  it('reads status', async () => {
    const t = new FakeTransport();
    t.replies = [new Uint8Array(0), bytes(frame('030,0,0,100,0,0') + frame('000,0,0,0,0,2'))];
    const s = await new LabelPrinter(t).getStatus();
    expect(s?.ready).toBe(true);
    expect(t.writtenText()).toBe('~HS');
  });

  it('returns null when the printer is silent', async () => {
    expect(await new LabelPrinter(new FakeTransport()).getStatus()).toBeNull();
  });

  it('throws when paper is out', async () => {
    const t = new FakeTransport();
    t.replies = [new Uint8Array(0), bytes(frame('030,1,0,100,0,0') + frame('000,0,0,0,0,2'))];
    await expect(new LabelPrinter(t).assertReady()).rejects.toBeInstanceOf(PrinterNotReadyError);
  });

  it('reads extended status', async () => {
    const t = new FakeTransport();
    t.replies = [
      new Uint8Array(0),
      bytes('PRINTER STATUS\r\n ERRORS: 1 00000000 00000004\r\n WARNINGS: 0 00000000 00000000\r\n'),
    ];
    const s = await new LabelPrinter(t).getExtendedStatus();
    expect(s?.hasError).toBe(true);
    expect(s?.errors.headOpen).toBe(true);
    expect(s?.errors.mediaOut).toBe(false);
  });
});

describe('LabelPrinter ordering', () => {
  it('does not mix concurrent writes', async () => {
    const order: string[] = [];
    const slow = new FakeTransport();
    slow.write = async (d: Uint8Array) => {
      order.push('start ' + d.length);
      await new Promise((r) => setTimeout(r, 20));
      order.push('end ' + d.length);
    };
    const p = new LabelPrinter(slow);
    await Promise.all([p.print('aaa'), p.print('bb'), p.print('c')]);
    expect(order).toEqual(['start 3', 'end 3', 'start 2', 'end 2', 'start 1', 'end 1']);
  });

  it('keeps going after a failed job', async () => {
    const t = new FakeTransport();
    let n = 0;
    t.write = async () => { if (n++ === 0) throw new Error('boom'); };
    const p = new LabelPrinter(t);
    await expect(p.print('a')).rejects.toThrow('boom');
    await expect(p.print('b')).resolves.toBeUndefined();
  });

  it('prints many', async () => {
    const t = new FakeTransport();
    await new LabelPrinter(t).printAll(['x', 'y']);
    expect(t.writtenText()).toBe('x|y');
  });
});


describe('LabelPrinter.printAll with pauses and waiting for the printer', () => {
  const frame = (x: string) => `\x02${x}\x03\r\n`;
  const hs = (formats: number, full = 0) =>
    Uint8Array.from(Buffer.from(frame(`030,0,0,1234,${String(formats).padStart(3, '0')},${full},0,0,000,0,0,0`) + frame('000,0,0,0,0,2,6,0,00000000,1,000') + frame('1234,0'), 'latin1'));
  const empty = new Uint8Array(0);

  it('sends the labels in order with no pause by default, and reports each one', async () => {
    const t = new FakeTransport();
    const sent: number[] = [];
    await new LabelPrinter(t).printAll(['A', 'B', 'C'], { onLabelSent: (i) => sent.push(i) });
    expect(t.writtenText()).toBe('A|B|C');
    expect(sent).toEqual([0, 1, 2]);
  });

  it('pauses between labels, not before the first or after the last', async () => {
    const t = new FakeTransport();
    const stamps: number[] = [];
    const orig = t.write.bind(t);
    t.write = async (d: Uint8Array) => { stamps.push(Date.now()); return orig(d); };
    await new LabelPrinter(t).printAll(['A', 'B', 'C'], { pauseMs: 40 });
    expect(stamps).toHaveLength(3);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(35);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(35);
  });

  it('asks the printer (~HS) before each label after the first, and waits until it holds no format', async () => {
    const t = new FakeTransport();
    // Each status query reads twice: once to clear old bytes, once for the reply.
    t.replies = [empty, hs(2), empty, hs(1), empty, hs(0)];
    await new LabelPrinter(t).printAll(['A', 'B'], { waitForPrinter: { pollMs: 1 } });
    expect(t.writtenText()).toBe('A|~HS|~HS|~HS|B');
  });

  it('does not wait when the buffer is not full and holds nothing; waits while the buffer is full', async () => {
    const t = new FakeTransport();
    t.replies = [empty, hs(0, 1), empty, hs(0, 0)];
    await new LabelPrinter(t).printAll(['A', 'B'], { waitForPrinter: { pollMs: 1 } });
    expect(t.writtenText()).toBe('A|~HS|~HS|B');
  });

  it('sends anyway when the printer does not answer ~HS, and after the timeout', async () => {
    const t = new FakeTransport();
    await new LabelPrinter(t).printAll(['A', 'B'], { waitForPrinter: true });
    expect(t.writtenText()).toBe('A|~HS|B'); // no reply: no information, so no waiting
    const u = new FakeTransport();
    u.replies = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? empty : hs(3)));
    await new LabelPrinter(u).printAll(['A', 'B'], { waitForPrinter: { timeoutMs: 60, pollMs: 10 } });
    expect(u.writtenText().endsWith('|B')).toBe(true);
    expect(u.writtenText().startsWith('A|~HS')).toBe(true);
  });

  it('stops at the first error', async () => {
    const t = new FakeTransport();
    const orig = t.write.bind(t);
    t.write = async (d: Uint8Array) => { if (Buffer.from(d).toString() === 'B') throw new Error('boom'); return orig(d); };
    await expect(new LabelPrinter(t, { reconnect: false }).printAll(['A', 'B', 'C'])).rejects.toThrow('boom');
    expect(t.writtenText()).toBe('A');
  });
});


describe('LabelPrinter control commands', () => {
  it('sends ~JA, ~PS, ~JR and ~JC, one command each', async () => {
    const t = new FakeTransport();
    const lp = new LabelPrinter(t);
    await lp.clearJobs();
    await lp.resume();
    await lp.reset();
    await lp.calibrate();
    expect(t.writtenText()).toBe('~JA|~PS|~JR|~JC');
  });
});


describe('LabelPrinter.getIdentification', () => {
  it('sends ~HI and parses the reply', async () => {
    const t = new FakeTransport();
    t.replies = [new Uint8Array(0), Uint8Array.from(Buffer.from('\x02TVSE LP 46 Dlite,FV1.050,8,32768KB\x03\r\n', 'latin1'))];
    const id = await new LabelPrinter(t).getIdentification();
    expect(t.writtenText()).toBe('~HI');
    expect(id).toMatchObject({ model: 'TVSE LP 46 Dlite', firmware: 'FV1.050', dotsPerMm: 8 });
  });
  it('gives null when the printer does not answer', async () => {
    expect(await new LabelPrinter(new FakeTransport()).getIdentification()).toBeNull();
  });
});

describe('LabelPrinter: cancel and a failed write', () => {
  it('does not connect or write when the signal is aborted while the job waits in the queue', async () => {
    const t = new FakeTransport();
    const p = new LabelPrinter(t);
    const controller = new AbortController();
    const first = p.print('~JC'); // takes the queue
    const second = p.print('~JA', { signal: controller.signal });
    controller.abort();
    await first;
    await expect(second).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect(t.writtenText()).toBe('~JC');
  });

  it('passes the options to the transport', async () => {
    const seen: unknown[] = [];
    class Spy extends FakeTransport {
      override async write(data: Uint8Array, options?: unknown) { seen.push(options); this.written.push(data); }
    }
    const progress = () => undefined;
    await new LabelPrinter(new Spy()).print('~JC', { onProgress: progress });
    expect(seen).toEqual([{ onProgress: progress }]);
  });

  const failing = (error: TransportError) => {
    let calls = 0;
    class Flaky extends FakeTransport {
      override async write(data: Uint8Array) {
        calls++;
        if (calls === 1) throw error;
        this.written.push(data);
      }
    }
    return { transport: new Flaky(), calls: () => calls };
  };

  it('sends again once when the failed write sent nothing (no native write began)', async () => {
    const error = Object.assign(new TransportError('The device disconnected after 0 of 3 bytes', 'E_DISCONNECTED'), { nothingSent: true, bytesSent: 0 });
    const { transport, calls } = failing(error);
    await new LabelPrinter(transport, { reconnect: { initialDelayMs: 1, maxDelayMs: 2, jitter: false } }).print('~JC');
    expect(calls()).toBe(2);
    expect(transport.writtenText()).toBe('~JC');
  });

  it('does not send again when a piece may be in the printer (a label could print twice)', async () => {
    const error = Object.assign(new TransportError('Write timed out (0 of 3 bytes sent)', 'E_TIMEOUT'), { nothingSent: false, bytesSent: 0 });
    const { transport, calls } = failing(error);
    await expect(new LabelPrinter(transport, { reconnect: { initialDelayMs: 1, maxDelayMs: 2, jitter: false } }).print('~JC')).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    expect(calls()).toBe(1);
  });
});

describe('LabelPrinter.printRaw', () => {
  it('sends the bytes as they are, and connects by itself', async () => {
    const t = new FakeTransport();
    const raw = Uint8Array.from([0x1b, 0x40, 0x0a, 0xff]);
    await new LabelPrinter(t).printRaw(raw);
    expect(t.connected).toBe(true);
    expect(t.written).toEqual([raw]);
  });

  it('shares the queue with print: one job at a time, in order', async () => {
    const order: string[] = [];
    const t = new FakeTransport();
    t.write = async (d: Uint8Array) => {
      order.push('start ' + d.length);
      await new Promise((r) => setTimeout(r, 10));
      order.push('end ' + d.length);
    };
    const p = new LabelPrinter(t);
    await Promise.all([p.print('aaa'), p.printRaw(new Uint8Array(2)), p.print('c')]);
    expect(order).toEqual(['start 3', 'end 3', 'start 2', 'end 2', 'start 1', 'end 1']);
  });

  it('does not send again after a failed write (it could print twice)', async () => {
    const t = new FakeTransport();
    let n = 0;
    t.write = async () => {
      n++;
      throw new TransportError('link lost', 'E_WRITE_FAILED');
    };
    await expect(new LabelPrinter(t).printRaw(new Uint8Array(1))).rejects.toBeInstanceOf(TransportError);
    expect(n).toBe(1);
  });

  it('stops before it connects when the signal is already aborted', async () => {
    const t = new FakeTransport();
    const signal = { aborted: true, addEventListener: () => undefined, removeEventListener: () => undefined };
    await expect(new LabelPrinter(t).printRaw(new Uint8Array(1), { signal })).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect(t.connected).toBe(false);
  });
});
