#!/usr/bin/env bash
# 构建安卓 APK（本机环境：JDK 21 + Android SDK 均在 E:\dev，Gradle 仓库走阿里云镜像 init 脚本）
# 用法：在 Git Bash 中执行  ./scripts/build-apk.sh
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail
cd "$(dirname "$0")/../android"
export JAVA_HOME='E:\dev\jdk-21\jdk-21.0.12+8'
export ANDROID_HOME='E:\dev\android-sdk'
export ANDROID_SDK_ROOT='E:\dev\android-sdk'
export GRADLE_USER_HOME='E:/dev/gradle-home'
./gradlew assembleDebug --console=plain
echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"
