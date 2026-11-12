#!/usr/bin/env bash
# APK'yı derler ve tablete notları silmeden (üstüne) kurar.
# Kullanım (Git Bash): bash scripts/apk.sh   — tablet USB ile bağlı, USB hata ayıklama açık olmalı.
set -e
cd "$(dirname "$0")/.."
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.13.9-hotspot"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
npm run sync
(cd android && ./gradlew.bat assembleRelease --console=plain -q)
V=$(grep -oP 'APP_VERSION = \K\d+' js/util.js)
mkdir -p apk && cp "$LOCALAPPDATA/not-defteri-build/app/outputs/apk/release/app-release.apk" "apk/NotDefteri-$V.apk"
# -r: üstüne kur (notlar kalır). ASLA uninstall yapma.
"$USERPROFILE/android-tools/platform-tools/adb.exe" install -r "apk/NotDefteri-$V.apk"
echo "Sürüm $V kuruldu."
