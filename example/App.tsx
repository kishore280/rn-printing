import React, { memo, useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BluetoothClassic,
  BluetoothClassicTransport,
  LabelPrinter,
  PairedDevice,
  testLabel,
} from 'react-native-bplz-label-printer';

type RowProps = { device: PairedDevice; onPrint: (address: string) => void };

// Memoized row with a stable callback (list-performance-item-memo, list-performance-callbacks).
const DeviceRow = memo(function DeviceRow({ device, onPrint }: RowProps) {
  return (
    <Pressable style={styles.button} onPress={() => onPrint(device.address)}>
      <Text style={styles.buttonText}>Print on {device.name ?? device.address}</Text>
    </Pressable>
  );
});

export default function App() {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!(await BluetoothClassic.requestPermissions())) {
      setMessage('Permission denied');
      return;
    }
    setDevices(await BluetoothClassic.getPairedDevices());
  }, []);

  const print = useCallback(async (address: string) => {
    const printer = new LabelPrinter(new BluetoothClassicTransport(address));
    try {
      await printer.connect();
      await printer.print(testLabel('Hello'));
      setMessage('Sent');
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      await printer.disconnect().catch(() => {});
    }
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: PairedDevice }) => <DeviceRow device={item} onPrint={print} />,
    [print]
  );

  return (
    <View style={styles.container}>
      <Pressable style={styles.button} onPress={load}>
        <Text style={styles.buttonText}>List paired printers</Text>
      </Pressable>
      <FlatList data={devices} keyExtractor={keyOf} renderItem={renderItem} />
      {/* Ternary, not `&&`, so an empty string never renders outside <Text> (rendering-no-falsy-and). */}
      {message ? <Text>{message}</Text> : null}
    </View>
  );
}

const keyOf = (d: PairedDevice) => d.address;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12 },
  button: { padding: 12, borderRadius: 8, backgroundColor: '#1d4ed8' },
  buttonText: { color: '#fff', textAlign: 'center' },
});
