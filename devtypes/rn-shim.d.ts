// Minimal local typing for 'react-native' so the library can be type-checked
// without installing React Native. Not published. Apps use their own RN types.
declare module 'react-native' {
  export const NativeModules: Record<string, any>;
  export const Platform: { OS: string; Version: number | string };
  export const PermissionsAndroid: {
    PERMISSIONS: Record<string, string>;
    RESULTS: { GRANTED: string; DENIED: string; NEVER_ASK_AGAIN: string };
    request(permission: string, rationale?: unknown): Promise<string>;
    requestMultiple(permissions: string[]): Promise<Record<string, string>>;
  };
}
