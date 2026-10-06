export const Platform = { OS: 'android', Version: 33 };
export const PermissionsAndroid = {
  RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
  request: async () => 'granted',
  requestMultiple: async (permissions: string[]) => Object.fromEntries(permissions.map((p) => [p, 'granted'])),
};
