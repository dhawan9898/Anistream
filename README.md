# AniStream — Android Anime Streaming App (powered by `ani-cli`)

[![Version](https://img.shields.io/badge/Version-v6.0-indigo?style=for-the-badge&logo=android)](https://github.com/dhawan9898/Anistream/releases)
[![Android](https://img.shields.io/badge/Android-8.0%2B-green?style=for-the-badge&logo=android)](https://github.com/dhawan9898/Anistream/releases)
[![License](https://img.shields.io/badge/License-GPLv3-blue?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)

AniStream is an ad-free anime streaming app for Android with a Netflix-style
interface. The UI is React + TypeScript packaged with Capacitor. Playback on
Android uses a native **ExoPlayer (Media3)** screen, and the browser build
uses **hls.js**. Stream resolution follows the same scraping and decryption
steps as [`ani-cli`](https://github.com/pystardust/ani-cli).

---

## Contents

1. [Install the APK](#1-install-the-apk)
2. [Using the app](#2-using-the-app)
3. [Player controls](#3-player-controls)
4. [Settings](#4-settings)
5. [Build from source](#5-build-from-source)
6. [Run in the browser (dev mode)](#6-run-in-the-browser-dev-mode)
7. [CI builds & releases](#7-ci-builds--releases)
8. [Architecture](#8-architecture)
9. [Troubleshooting](#9-troubleshooting)
10. [What's new in v6.0](#10-whats-new-in-v60)
11. [License](#11-license)

---

## 1. Install the APK

1. Open the **[Releases page](https://github.com/dhawan9898/Anistream/releases)** and pick the latest release (**v6.0**).
2. Under **Assets**, download **`AniStream-v6.0.apk`**.
3. Open the file on your phone. If Android asks, enable **Install unknown apps** for your browser or file manager.
4. Tap **Install**. If you already have AniStream, the new version installs over it and keeps your history and My List, because every release is signed with the same key.

Requires Android 8.0 (API 26) or newer.

---

## 2. Using the app

The floating dock at the bottom switches between the four main tabs.

| Tab | What it does |
|-----|--------------|
| **Home** | Trending hero carousel, **Continue Watching** (with progress bars), genre rows (Action, Romance, Comedy, Fantasy, Isekai) and a **Categories** picker for every genre. |
| **Search** | Type a title (results appear as you type) or tap a quick tag. With an empty search box you can browse all genres. If the server can't be reached you get a **Retry** button, not fake results. |
| **Library** | **History** holds one entry per anime with your last episode and progress. Tap an entry to resume, or ✕ to remove it. **Saved** is your *My List*. |
| **Settings** | Theme, playback preferences, and data (clear history, bookmarks). |

### Title page

Tap any poster to open its title page:

- **Play / Resume / Play E*n***: the main button picks up where you left off. If you finished your last episode, it offers the **next** episode instead of dropping you into the end credits.
- **SUB / DUB**: choose the audio before you start. The default comes from Settings.
- **My List (+ / ✓)**: bookmark the title.
- **Episodes**: long series are paged in ranges of 50, and the page opens on the range holding your current episode.
- **Collection**: other seasons, parts and movies of the same franchise.
- **More Like This**: similar titles. AniList recommendations come first, then titles that share the most genres.

---

## 3. Player controls

On Android the native ExoPlayer is used. In a browser, the web player has the same layout.

| Control | Action |
|---------|--------|
| Tap | Show / hide controls (they auto-hide after 3.5 s while playing and stay visible while paused) |
| Double-tap left / right | Rewind / forward 10 s |
| Swipe up/down on the right half | Volume (native: brightness on the left half) |
| **⏪ 10 / ▶ / 10 ⏩** | Seek back, play/pause, seek forward |
| Seek bar | Scrub. Shows buffered and played progress and the time remaining. |
| **Speed** | 0.5× to 1.5× |
| **Lock** | Locks the screen against accidental touches. Tap once to reveal the unlock button. |
| **Episodes** | Floating episode grid. Pick an episode without leaving the player. |
| **Audio & Subtitles** | Switch Japanese (sub) / English (dub), choose a subtitle track or turn subtitles off, and pick a quality when the source offers real alternatives. |
| **Next Ep.** | Jump to the next episode |
| **Skip Intro / Skip Outro** | Shown only when the real intro/outro timestamps for that episode are known, from the source or [AniSkip](https://aniskip.com). |
| **Next Episode** card | Appears during the credits (or in the last 20 s) with a 10 s countdown. With *Autoplay Next Episode* on, it advances on its own. Tap **Watch Credits** to dismiss it. |

**If a stream stalls or fails**

- Dropped connections are retried automatically with backoff (1 s, 2 s, 4 s). Playback resumes where it stopped.
- If every retry fails, an error dialog offers **Retry**, which also resumes at the same position, or **Go Back**.
- When no source works at all, a short **demo clip** plays and the title bar says **DEMO - SOURCE UNAVAILABLE**. Its progress is never saved over your real resume point.

**Progress** is saved every 5 s, on pause, when you switch episodes and when you close the player.

---

## 4. Settings

| Setting | Effect |
|---------|--------|
| Default Quality | Preferred rendition when a source offers several distinct URLs (most sources are adaptive, so the player picks automatically) |
| Default Audio | SUB or DUB preselected on title pages |
| Auto-Skip Intro | Skip the opening automatically when its timestamps are known |
| Autoplay Next Episode | Advance to the next episode when the countdown finishes |
| Theme (Appearance) | Dark / light |
| Data | Clear Watch History / Clear Bookmarks |

---

## 5. Build from source

### Prerequisites

- **Node.js 22** (CI uses 22) and npm
- **JDK 21** and the **Android SDK** (Android Studio installs both)

### Command line (Linux / macOS)

```bash
git clone https://github.com/dhawan9898/Anistream.git
cd Anistream
npm ci                 # install exact dependency versions
npm run lint           # oxlint
npm run build          # type-check + production web bundle -> dist/
npx cap sync android   # copy dist/ into the Android project
cd android
chmod +x gradlew
./gradlew assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

On **Windows**, use `gradlew.bat assembleDebug`, or run `.\build-apk.ps1`, which does all of the above and copies the APK next to the script.

### Android Studio

After `npm run build && npx cap sync android`, run `npx cap open android`, wait for Gradle to sync, then choose **Build ▸ Build Bundle(s) / APK(s) ▸ Build APK(s)**.

> Always run `npm run build && npx cap sync android` after changing anything in `src/`. The Android project only contains the last synced copy of the web bundle.

---

## 6. Run in the browser (dev mode)

```bash
npm run dev
```

Open **http://localhost:3000**. The dev server adds two things the plain web build doesn't have:

- `/api-hianime/*`: a proxy to the streaming site that adds the headers it expects.
- `/api/ani-cli/stream` and `/stream-proxy`: a local ani-cli bridge (`aniCliBridgePlugin.ts`) that resolves streams server-side and proxies HLS playlists and segments with the right `Referer`. The proxy only forwards to public http(s) hosts.

Use the browser's device toolbar (Ctrl+Shift+M in Chrome) to preview phone and tablet layouts. `npm run preview` serves the production build, but it has no proxy, so live data won't load there.

---

## 7. CI builds & releases

`.github/workflows/build-apk.yml` builds the APK on GitHub Actions. The steps are: lint, web build, `cap sync`, then `assembleDebug`. It runs:

| Trigger | Result |
|---------|--------|
| Push to `main` / `master` | APK uploaded as a workflow artifact (`AniStream-v6.0-APK`, kept 30 days) |
| Push a tag `v*` (e.g. `git tag v6.0 && git push origin v6.0`) | Artifact plus a GitHub Release under that tag with the APK attached |
| **Actions ▸ Build AniStream v6.0 APK ▸ Run workflow** | Builds any branch. Fill in `release_tag` (e.g. `v6.0`) to also publish a release. Leave it empty to only build. |

---

## 8. Architecture

```
src/
├── core/aniCliCore.ts          scraping + stream resolution (search, episode lists, server
│                               fallback, AES/XOR decryption), TTL cache, timeouts, retries
├── services/
│   ├── historyService.ts       watch history / My List / preferences (Capacitor Preferences),
│   │                           serialized writes + change notifications
│   ├── catalogService.ts       genres, Collection, More Like This (site + AniList)
│   ├── aniSkipService.ts       intro/outro timestamps (Jikan -> MAL id -> AniSkip)
│   └── themeService.ts         dark/light theme
├── components/
│   ├── VideoPlayer.tsx         web player (hls.js), lazy-loaded only when used
│   ├── PosterCard.tsx, GenrePicker.tsx, ConfirmModal.tsx
├── pages/                      Home, Search, Genre, AnimeDetail, History (Library), Settings
├── plugins/exoPlayerPlugin.ts  TypeScript bridge to the native player
└── App.tsx                     navigation, playback sessions, native event wiring

android/app/src/main/java/com/anicli/stream/
├── ExoPlayerActivity.java      native player UI, gestures, auto-retry, progress reporting
├── ExoPlayerPlugin.java        Capacitor plugin: play/open/fail + events back to JS
└── AniSkipClient.java          native skip-time lookup

aniCliBridgePlugin.ts           dev-server-only ani-cli bridge + stream proxy
```

### How playback works

1. `App.handlePlayEpisode` opens the native player straight away in its loading state, or shows a top progress bar on the web.
2. `getEpisodeStream` resolves the episode's servers. It tries **every server for the chosen audio type** in order until one returns a playable HLS/MP4 URL, with subtitles and intro/outro markers.
3. The resolved stream is committed as the current **playback session**. Progress reports are matched to that session, so switching episodes can never record one episode's position under another.
4. The player (ExoPlayer or hls.js) streams it. Progress flows back into `historyService`, which notifies the Home, Title and Library screens so they update live.

Network requests to the site go through a small in-memory cache (5 min for pages, 10 min for episode lists). Concurrent requests for the same URL are de-duplicated and failures are never cached, which keeps the app from hammering the source.

---

## 9. Troubleshooting

| Symptom | What to try |
|---------|-------------|
| "DEMO - SOURCE UNAVAILABLE" | Every server for that episode failed. Try the other audio (SUB/DUB) from **Audio & Subtitles**, or try again later. |
| "Couldn't reach the server" in Search | No connection, or the site is down or blocked on your network. Tap **Retry**. |
| Audio but no picture | The server sent an unsupported codec. Pick another episode or audio type. |
| No Skip Intro button | Neither the source nor AniSkip has timestamps for that episode. |
| APK won't install over an older version | The older build was signed with a different key. Uninstall it once, then install. |

---

## 10. What's new in v6.0

**Playback reliability**
- Server fallback: if the first mirror is dead, the other servers for the same audio type are tried before falling back to the demo clip.
- hls.js recovers from network drops (backoff retries) and decoder errors (`recoverMediaError`, then an audio-codec swap).
- The native ExoPlayer auto-retries transient network/5xx errors. **Retry** resumes where playback stopped instead of starting from 0:00.
- Missing episodes are no longer silently replaced by episode 1.

**Watch history correctness**
- Progress can no longer be saved under the wrong episode while the next one is loading, on web or native.
- The demo fallback clip never overwrites your real resume point.
- Continue Watching, Resume and Library update live after you watch.
- Finished episodes resume as "Play next episode" / start over instead of opening in the end credits.

**Memory & performance**
- Fixed a stale `loadedmetadata` listener that seeked a new episode to the previous one's position.
- The player detaches its source on close, and all timers are cleared on unmount.
- Skip-intro lookups no longer use the previous episode's length.
- Progress writes are throttled from about 4 per second to one every 5 s.
- The web player and hls.js are code-split, so the startup bundle is 320 KB instead of 920 KB (96 KB gzipped instead of 282 KB).
- The hero carousel pauses while the player is open or the app is in the background.
- Site pages and episode lists are cached, and in-flight requests are de-duplicated.

**UI & accessibility**
- Fixed a stray "0" badge on titles with no sub/dub count.
- Search shows a real error state instead of made-up results.
- Poster cards are keyboard/screen-reader accessible, and images lazy-load.
- Fullscreen state stays in sync when you leave fullscreen with the system back gesture or Esc.

**Security**
- Embed URLs from the site are only followed when they are plain http(s).
- The thumbnail sprite track is no longer offered as a subtitle.
- The dev stream proxy refuses localhost and private-network targets.

---

## 11. License

GNU General Public License v3.0 — see <https://www.gnu.org/licenses/gpl-3.0>.
