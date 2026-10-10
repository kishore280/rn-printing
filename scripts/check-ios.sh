#!/usr/bin/env bash
# Compile the iOS pod (Swift + C++) in a throw-away React Native host app. Needs macOS and Xcode.
# Why a host app: the pod needs React-Core, Nitro and the C++/Swift interop settings that only
# a real CocoaPods build sets. The host is made in a temp folder; nothing is added to the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
RN=$(node -p "require('react-native/package.json').version")
NITRO=$(node -p "require('react-native-nitro-modules/package.json').version")
WORK=${CHECK_IOS_DIR:-$(mktemp -d)}
cd "$WORK"
npx --yes @react-native-community/cli@latest init BplzHost --version "$RN" \
  --skip-install --skip-git-init --pm npm
cd BplzHost
npm install --no-audit --no-fund
npm install --no-audit --no-fund "react-native-nitro-modules@$NITRO"
# A symlink keeps the podspec's __dir__ at the repo, so the build compiles the files in the repo.
ln -s "$ROOT" node_modules/react-native-bplz-label-printer
# Autolinking reads the dependencies of the host package.json.
npm pkg set dependencies.react-native-bplz-label-printer="*"
(cd ios && pod install)
grep -n "NitroBplzLabel" ios/Podfile.lock || { echo "pod NitroBplzLabel was not linked"; exit 1; }
xcodebuild -workspace ios/BplzHost.xcworkspace -scheme BplzHost \
  -sdk iphonesimulator -configuration Debug -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
