# AniStream 🎬 — Android Anime Streaming App (Powered by `ani-cli`)

[![Version](https://img.shields.io/badge/Version-v1.0.0-indigo?style=for-the-badge&logo=android)](https://github.com)
[![Android](https://img.shields.io/badge/Android-8.0%2B%20(Oreo%20to%2015)-green?style=for-the-badge&logo=android)](https://github.com)
[![License](https://img.shields.io/badge/License-GPLv3-blue?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)
[![Core Engine](https://img.shields.io/badge/Core%20Engine-ani--cli%20v5.1.2-red?style=for-the-badge&logo=terminal)](https://github.com/pystardust/ani-cli)

**AniStream** is a high-performance, ad-free Android application with a silky-smooth cinema UI designed for streaming anime, using the scraping, decryption, and streaming mechanics of **`ani-cli`** as its core engine.

---

## 📥 Download v1.0 APK

You can download the pre-compiled **AniStream v1.0 APK** directly from GitHub using the options below:

### Option 1: GitHub Releases (Direct Download)
1. Navigate to the **[GitHub Releases Page](https://github.com/dhawan9898/Anistream/releases)** of the repository.
2. Under the latest release (**v1.0**), locate the **Assets** section.
3. Click on **`AniStream-v1.0.apk`** to download the APK file directly to your device.
* **Direct APK Link**: [**AniStream-v1.0.apk**](https://github.com/dhawan9898/Anistream/releases/download/v1.0/AniStream-v1.0.apk)
* **Release Tag**: [GitHub Releases v1.0](https://github.com/dhawan9898/Anistream/releases/tag/v1.0)

> [!TIP]
> **Installing on Android**:
> 1. Download `AniStream-v1.0.apk` to your phone.
> 2. Tap the downloaded file in your browser/file manager.
> 3. If prompted, toggle **"Allow from this source"** under *Install unknown apps*.
> 4. Tap **Install** and enjoy smooth, ad-free streaming!

### Option 2: Build & Download from GitHub Actions (No local Android Studio needed)
This repository includes an automated CI/CD workflow (`.github/workflows/build-apk.yml`) that compiles the APK in the cloud:
1. Push this repository to GitHub.
2. Go to the **Actions** tab on your GitHub repository.
3. Click on **Build AniStream v1.0 APK** > **Run workflow**.
4. Once completed, download the **`AniStream-v1.0-APK`** artifact zip!

---

## 🛠️ How to Build from Source

### Prerequisites
* **Node.js**: v18.x or newer (`v24.x` recommended)
* **npm**: v9.x or newer
* *(Optional for local compilation)*: **Android Studio** (Hedgehog / Iguana / Ladybug) or **JDK 17+** with Android SDK Command-line Tools.

---

### Method 1: Using Android Studio (Recommended GUI)

1. **Clone the repository and enter the app folder**:
   ```bash
   cd app
   ```

2. **Install npm dependencies**:
   ```bash
   npm install
   ```

3. **Build the production web bundle**:
   ```bash
   npm run build
   ```

4. **Sync with the Capacitor Android project**:
   ```bash
   npx cap sync android
   ```

5. **Open the project in Android Studio**:
   ```bash
   npx cap open android
   ```

6. **Generate the APK in Android Studio**:
   * Wait for Gradle to finish indexing.
   * From the top menu bar, click: **Build** > **Build Bundle(s) / APK(s)** > **Build APK(s)**.
   * Once built, click the **"locate"** notification in the bottom right corner.
   * Your APK will be at:
     ```
     app/android/app/build/outputs/apk/debug/app-debug.apk
     ```
   * Rename it to `AniStream-v1.0.apk` and transfer it to your device!

---

### Method 2: One-Click Automated Script (Windows PowerShell)

If you have JDK 17+ and the Android SDK configured:
```powershell
cd app
.\build-apk.ps1
```
This script will automatically run `npm run build`, sync with Capacitor, invoke `./gradlew.bat assembleDebug`, and output `AniStream-v1.0.apk` right in the `app/` folder.

---

### Method 3: Command-Line Build (CLI / Terminal)

#### On Windows:
```cmd
cd app
npm run build
npx cap sync android
cd android
gradlew.bat assembleDebug
```

#### On Linux / macOS:
```bash
cd app
npm run build
npx cap sync android
cd android
chmod +x gradlew
./gradlew assembleDebug
```

The compiled APK will be located at:
```
app/android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 🌐 Running in Web & Mobile Preview

To preview the app locally in your browser with responsive mobile simulation:

1. **Start the local dev server**:
   ```bash
   cd app
   npm run dev
   ```
2. Open **[http://localhost:3000](http://localhost:3000)** in Google Chrome, Brave, or Edge.
3. Press `F12` (or `Ctrl + Shift + I`), then press `Ctrl + Shift + M` to toggle the **Device Toolbar** (select **Pixel 7** or **iPhone 14**).
4. Browse anime, search, select episodes, and stream directly in 1080p!

---

## 🌟 Key Features

* **`ani-cli` Core Integration**:
  - Scrapes `hianime.at` for real-time anime search, metadata, and episode lists.
  - Decrypts ZokoAnime embed payloads using the exact byte-by-byte rotating **XOR algorithm with key `otaku-embed-v1`**.
  - Built-in streaming reverse proxy transparently attaches the required `Referer: https://zokoanime.video/` and CORS headers so 1080p `.m3u8` playlists and `.ts` chunks load with 200 OK.
* **Cinematic Mobile Video Player**:
  - **Adaptive Hls.js streaming engine** supporting 1080p, 800p, 720p, 480p, 360p, and Auto.
  - **Double-tap gestures**: Double-tap left to rewind 10s, double-tap right to seek forward 10s with visual indicator.
  - **Skip Intro Floating Pill**: Tap to skip 85s of opening theme song.
  - **Floating Menus**: Quickly switch resolutions or toggle English `.vtt` subtitles.
  - Auto-plays the next episode upon completion.
* **Modern Cinema UI & Aesthetics**:
  - Dark glassmorphic palette (`#08090e`) with electric indigo/cyan glow accents.
  - Auto-cycling featured hero carousel.
  - "Continue Watching" row with live progress bars and timestamp resumption.
  - Instant debounced search with trending tags.
  - Persistent library with watch history and saved bookmarks (`@capacitor/preferences`).
* **Native Android Optimization**:
  - Android notch and gesture navigation bar insets supported (`viewport-fit=cover`).
  - Hardware-accelerated video decoding.

---

## 📁 Repository Structure

```
Ani-cli/
├── app/
│   ├── .github/workflows/
│   │   └── build-apk.yml         # Automated GitHub Actions CI/CD to build APK
│   ├── android/                  # Native Android Studio project (Gradle + Java/Kotlin)
│   ├── src/
│   │   ├── core/
│   │   │   └── aniCliCore.ts     # ani-cli scraping, XOR deobfuscator, stream resolver
│   │   ├── components/
│   │   │   └── VideoPlayer.tsx   # Cinema Hls.js player with gestures & overlay controls
│   │   ├── pages/
│   │   │   ├── HomeScreen.tsx    # Hero carousel, continue watching, trending grid
│   │   │   ├── AnimeDetailScreen.tsx # Synopsis, SUB/DUB switch, episode grid
│   │   │   ├── SearchScreen.tsx  # Fast debounced search and tags
│   │   │   └── HistoryScreen.tsx # Watch history progress and saved bookmarks
│   │   ├── services/
│   │   │   └── historyService.ts # Persistent storage (Capacitor Preferences)
│   │   ├── App.tsx               # Main application controller
│   │   └── index.css             # Glassmorphic design system
│   ├── aniCliBridgePlugin.ts     # Vite plugin for live ani-cli bridge & stream proxy
│   ├── build-apk.ps1             # One-click Windows APK builder
│   ├── capacitor.config.ts       # Capacitor configuration
│   ├── package.json
│   └── README.md
└── ani-cli/                      # Original ani-cli shell repository
```

---

## 📜 License

This project is licensed under the **GNU General Public License v3.0 (GPLv3)** — see the [LICENSE](https://www.gnu.org/licenses/gpl-3.0) file for details.
