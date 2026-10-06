#!/usr/bin/env bash
# Compile-check the Kotlin HybridObjects with kotlinc, against:
#   - the Android 14 API jar (robolectric android-all)
#   - the real Nitro Kotlin sources (node_modules)
#   - the real react-android classes
# No Android SDK or Gradle is needed. Downloads go to .cache/kotlin-check (about 400 MB, cached).
# Only two annotations are stubbed (androidx.annotation and com.facebook.proguard.annotations),
# and NitroModules.kt (needs React codegen) is replaced by a tiny stand-in with the same public member.
set -euo pipefail
cd "$(dirname "$0")/.."

KOTLIN_VERSION=2.1.21
ANDROID_ALL=14-robolectric-10818077
REACT_ANDROID=$(node -p "require('react-native/package.json').version")
FBJNI=0.7.0
COROUTINES=1.9.0
M=https://repo.maven.apache.org/maven2

C=.cache/kotlin-check
mkdir -p "$C"
fetch() { [ -s "$C/$2" ] || curl -fsSL --retry 3 -o "$C/$2" "$1"; }

fetch "https://github.com/JetBrains/kotlin/releases/download/v$KOTLIN_VERSION/kotlin-compiler-$KOTLIN_VERSION.zip" kotlinc.zip
[ -d "$C/kotlinc" ] || unzip -q "$C/kotlinc.zip" -d "$C"
fetch "$M/org/robolectric/android-all/$ANDROID_ALL/android-all-$ANDROID_ALL.jar" android-all.jar
fetch "$M/com/facebook/fbjni/fbjni/$FBJNI/fbjni-$FBJNI.aar" fbjni.aar
fetch "$M/com/facebook/react/react-android/$REACT_ANDROID/react-android-$REACT_ANDROID-release.aar" react.aar
fetch "$M/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/$COROUTINES/kotlinx-coroutines-core-jvm-$COROUTINES.jar" coroutines.jar
[ -s "$C/fbjni.jar" ] || unzip -p "$C/fbjni.aar" classes.jar > "$C/fbjni.jar"
[ -s "$C/react.jar" ] || unzip -p "$C/react.aar" classes.jar > "$C/react.jar"

mkdir -p "$C/stubs"
cat > "$C/stubs/Annotations.kt" <<'KT'
package androidx.annotation
@Retention(AnnotationRetention.BINARY) annotation class Keep
@Retention(AnnotationRetention.BINARY) annotation class RequiresApi(val value: Int = 1, val api: Int = 1)
@Retention(AnnotationRetention.BINARY) annotation class CallSuper
KT
cat > "$C/stubs/DoNotStrip.kt" <<'KT'
package com.facebook.proguard.annotations
@Retention(AnnotationRetention.BINARY) annotation class DoNotStrip
KT
cat > "$C/stubs/NitroModules.kt" <<'KT'
package com.margelo.nitro
import com.facebook.react.bridge.ReactApplicationContext
class NitroModules { companion object { var applicationContext: ReactApplicationContext? = null } }
KT

NITRO=node_modules/react-native-nitro-modules/android/src/main/java
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "== kotlinc $KOTLIN_VERSION: our HybridObjects + generated specs + Nitro sources"
"$C/kotlinc/bin/kotlinc" -jvm-target 17 -no-stdlib -no-reflect -Werror \
  -cp "$C/android-all.jar:$C/fbjni.jar:$C/react.jar:$C/coroutines.jar:$C/kotlinc/lib/kotlin-stdlib.jar" \
  -d "$OUT" \
  $(find "$NITRO" -name '*.kt' ! -name NitroModules.kt ! -name NitroModulesPackage.kt) \
  $(find nitrogen/generated/android/kotlin -name '*.kt') \
  $(find android/src/main/java -name '*.kt' ! -name 'NitroBplzLabelPackage.kt') \
  "$C"/stubs/*.kt 2>&1 | grep -v '^Picked up' || true
test -f "$OUT/com/margelo/nitro/bplzlabel/HybridClassicBluetooth.class"
test -f "$OUT/com/margelo/nitro/bplzlabel/HybridClassicConnection.class"
echo "Kotlin OK"
