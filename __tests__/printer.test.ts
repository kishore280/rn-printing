import { LabelPrinter } from '../src/printer';
import { PrinterNotReadyError } from '../src/errors';
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
