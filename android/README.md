# southeast-asian-student-service-platform Android 客户端

该 APK 通过原生 WebView 连接本项目局域网网页服务，默认地址为 http://192.168.1.9:PORT，可在应用顶部“服务地址”中更改。HTTP 只接受私有局域网地址；公网域名必须使用 HTTPS。页面仅允许留在配置的同源地址，未注入 JavaScript bridge。

构建 release APK：

`powershell
cd android
.\gradlew.bat assembleRelease
Copy-Item app\build\outputs\apk\release\app-release.apk ..\dist\southeast-asian-student-service-platform-release.apk -Force
`

麦克风仅在 HTTPS 安全上下文中可用，并需要 Android 录音权限。release 当前使用 debug 签名，供开发和内网验收。
