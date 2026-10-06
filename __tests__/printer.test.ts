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
