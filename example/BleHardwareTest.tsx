import React, { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  BluetoothLE,
  BluetoothLETransport,
  bleFilters,
  describeGatt,
  LabelPrinter,
  type BleDevice,
  type BleWriteMode,
} from 'react-native-bplz-label-printer';
import { buildHardwarePayloads } from './hardwarePayloads';

/**
 * Real-printer BLE test. Scan, pick the printer, run payloads A to G, read the notes.
 * Nothing printer-specific is in here: the name filter is a text box and the GATT table is read at run time.
 * The result of each run is in the log. Copy the log into your test notes.
 */
const MODES: BleWriteMode[] = ['auto', 'write', 'withoutResponse'];

export default function BleHardwareTest() {
  const [nameFilter, setNameFilter] = useState('');
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [mode, setMode] = useState<BleWriteMode>('auto');
  const [delay, setDelay] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const transport = useRef<BluetoothLETransport | null>(null);
  const printer = useRef<LabelPrinter | null>(null);

  const say = useCallback((line: string) => setLog((l) => [...l, `${new Date().toISOString().slice(11, 23)} ${line}`]), []);

  const scan = useCallback(async () => {
    try {
      if (!(await BluetoothLE.requestPermissions())) return say('Permission denied');
      say('Scanning...');
      const found = await BluetoothLE.scan({
        timeoutMs: 6000,
        filter: nameFilter ? bleFilters.name(nameFilter) : undefined,
      });
      setDevices(found);
      say(`Found ${found.length} device(s)`);
    } catch (e) {
      say(`Scan failed: ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`);
    }
  }, [nameFilter, say]);

  const connect = useCallback(
    async (device: BleDevice) => {
      try {
        say(`Connecting to ${device.name ?? device.id}...`);
        const t = new BluetoothLETransport(device, {
          writeMode: mode,
          ...(delay ? { chunkDelayMs: Number(delay) } : {}),
        });
        t.onConnectionState((e) => say(`state ${e.state}${e.reason ? ` (${e.reason})` : ''}`));
        await t.connect();
        transport.current = t;
        printer.current = new LabelPrinter(t, { onConnectionEvent: (e) => say(`connect event ${e.type}`) });
        say(`GATT:\n${describeGatt(t.gatt)}`);
        const s = t.selection;
        say(`Selected write ${s?.write.uuid} (${s?.withResponse ? 'with' : 'without'} response), notify ${s?.notify?.uuid ?? 'none'}`);
        say(`Reason: ${s?.reason}. Alternatives: ${s?.alternatives.length}. Piece size: ${t.payloadSize} bytes`);
      } catch (e) {
        say(`Connect failed: ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`);
      }
    },
    [mode, delay, say]
  );

  const run = useCallback(
    async (id: string) => {
      if (!printer.current) return say('Connect first');
      try {
        const payloads = await buildHardwarePayloads({ labelWidthMm: 50, labelLengthMm: 30 });
        const payload = payloads.find((p) => p.id === id);
        if (!payload) return;
        say(`${payload.id}: ${payload.title}. Look for: ${payload.expect}`);
        for (const [i, label] of payload.labels.entries()) {
          const bytes = label.toBytes().length;
          const started = Date.now();
          await printer.current.print(label);
          const ms = Date.now() - started;
          say(`  label ${i + 1}/${payload.labels.length}: ${bytes} bytes sent in ${ms} ms (${Math.round((bytes / Math.max(ms, 1)) * 1000)} B/s)`);
        }
      } catch (e) {
        say(`${id} failed: ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`);
      }
    },
    [say]
  );

  return (
    <View style={styles.root}>
      <TextInput style={styles.input} placeholder="name contains (optional)" value={nameFilter} onChangeText={setNameFilter} />
      <Pressable style={styles.button} onPress={scan}><Text style={styles.text}>Scan</Text></Pressable>
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        style={styles.list}
        renderItem={({ item }) => (
          <Pressable style={styles.button} onPress={() => connect(item)}>
            <Text style={styles.text}>{item.name ?? '(no name)'}  {item.rssi ?? '?'} dBm</Text>
          </Pressable>
        )}
      />
      <View style={styles.row}>
        {MODES.map((m) => (
          <Pressable key={m} style={[styles.chip, m === mode && styles.chipOn]} onPress={() => setMode(m)}>
            <Text>{m}</Text>
          </Pressable>
        ))}
        <TextInput style={styles.small} placeholder="delay ms" keyboardType="numeric" value={delay} onChangeText={setDelay} />
      </View>
      <View style={styles.row}>
        {['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id) => (
          <Pressable key={id} style={styles.chip} onPress={() => run(id)}><Text>{id}</Text></Pressable>
        ))}
      </View>
      <ScrollView style={styles.log}><Text selectable style={styles.mono}>{log.join('\n')}</Text></ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 12, gap: 8 },
  input: { borderWidth: 1, borderColor: '#999', padding: 8 },
  small: { borderWidth: 1, borderColor: '#999', padding: 6, minWidth: 80 },
  button: { backgroundColor: '#1f6feb', padding: 10, borderRadius: 6 },
  text: { color: 'white' },
  list: { maxHeight: 160 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#999', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  chipOn: { backgroundColor: '#cfe3ff' },
  log: { flex: 1, backgroundColor: '#f4f4f4' },
  mono: { fontFamily: 'Courier', fontSize: 11 },
});
