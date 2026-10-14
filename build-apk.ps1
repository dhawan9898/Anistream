# build-apk.ps1 - Automated Android APK Build Script for AniStream
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Building AniStream v8.3 Android APK    " -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Build Web Assets
Write-Host "`n[1/3] Building Web Production Bundle..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: npm run build failed!" -ForegroundColor Red
    exit $LASTEXITCODE
}

# 2. Sync with Capacitor Android Project
Write-Host "`n[2/3] Syncing assets to Capacitor Android project..." -ForegroundColor Yellow
npx cap sync android
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: npx cap sync android failed!" -ForegroundColor Red
    exit $LASTEXITCODE
}

# 3. Check for Android SDK / Gradle
Write-Host "`n[3/3] Compiling Android APK with Gradle..." -ForegroundColor Yellow
$androidDir = Join-Path $PSScriptRoot "android"

if (Test-Path "$androidDir\gradlew.bat") {
    Push-Location $androidDir
    .\gradlew.bat assembleRelease
    Pop-Location

    $apkPath = "$androidDir\app\build\outputs\apk\release\app-release.apk"
    if (Test-Path $apkPath) {
        $finalApk = Join-Path $PSScriptRoot "AniStream-v8.3.apk"
        Copy-Item $apkPath $finalApk -Force
        Write-Host "`nSUCCESS! AniStream v8.3 APK generated at:" -ForegroundColor Green
        Write-Host $finalApk -ForegroundColor Cyan
    } else {
        Write-Host "`nNotice: To build the APK locally, ensure Android SDK is installed or open the project in Android Studio with:" -ForegroundColor Yellow
        Write-Host "npx cap open android" -ForegroundColor White
    }
} else {
    Write-Host "`nNotice: Run 'npx cap open android' to build within Android Studio." -ForegroundColor Yellow
}
