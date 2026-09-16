# Heardle Unlimited

Heardle Unlimited is a modern, full-featured music blind test and guessing game inspired by Heardle and Wordle. It offers an unlimited single-player mode, customizable playlist imports from major streaming platforms, and a real-time multiplayer room system with serverless WebRTC fallback.

---

## Overview

Players listen to progressively longer audio snippets (1s, 2s, 4s, 7s, 11s, 16s) to identify the mystery song and artist in six attempts or fewer. The application supports custom playlists, intelligent autocomplete search, responsive dark-mode styling, and synchronized multiplayer gameplay.

---

## Key Features

### Single-Player Mode
- **Unlimited Gameplay**: Play as many songs as desired across built-in curated playlists or imported custom libraries.
- **Progressive Audio Snippets**: Standard 6-step incremental playback duration matching classic blind test mechanics.
- **Intelligent Autocomplete**: Instant search query parsing with substring, prefix, and fuzzy matching across track titles and artists.
- **Keyboard Navigation**:
  - `Space`: Play or pause the current snippet.
  - `S`: Skip the current attempt.
  - `D`: Focus the search input field.
  - `Enter`: Submit guess or select active dropdown recommendation.
  - `Escape`: Close dropdown or clear focus.
- **End-of-Round Summary**: Detailed track reveal, direct streaming links (YouTube, Spotify, Deezer), and interactive full-track audio playback.

### Custom Playlist Management
- **Universal Import**: Import any public playlist from Spotify, Deezer, or YouTube.
- **Local Persistence**: Save custom playlists to browser storage for instant reuse.
- **Shareable Game Links**: Generate URLs containing playlist parameters (`?spotify=...`, `?deezer=...`, `?playlist=...`) to share custom game instances with others.

### Real-Time Multiplayer Mode
- **Private Rooms**: Create isolated rooms with unique 5-letter codes or share direct invite links.
- **Customizable Rules**: Configure winning score thresholds (First to 3, 5, 7, or 10 rounds).
- **Hybrid Networking Architecture**:
  - **Primary**: Centralized WebSocket server for synchronized room state, timing, and score validation.
  - **Fallback**: Peer-to-peer WebRTC (PeerJS) protocol enabling full multiplayer functionality on static hosting platforms without a dedicated server.
- **Server-Side Anti-Cheat**: Song metadata (title and artist) is stripped before transmission during active rounds; only masked audio sources are provided to clients.
- **Dynamic Scoring**: Score points based on guess speed, with automatic point deductions for skipped attempts.
- **Live Leaderboard**: Real-time player statuses (Listening, Skipped, Solved, Eliminated), avatars, and cumulative star counts.

### Resilient Audio Pipeline
- **Hybrid Audio Engine**: Combines direct HTML5 audio streaming with YouTube IFrame API playback.
- **Automatic Fallbacks**: If an audio stream encounters playback errors or network restrictions, the engine seamlessly switches to alternative verified sources without interrupting the game loop.

---

## Technical Stack

- **Frontend**: Vanilla JavaScript (ES6+), HTML5, Vanilla CSS (Dark Theme Design System)
- **Real-Time Communication**: Native WebSockets (`ws`), WebRTC via PeerJS
- **Backend / Dev Server**: Node.js HTTP server, WebSocket Server (`ws`)
- **Metadata Resolvers**: Custom API endpoints for Spotify, Deezer, and YouTube track matching

---

## Project Structure

```
heardle-game-clone/
├── index.html              # Solo mode application entry point and UI
├── multiplayer.html        # Multiplayer lobby, hub, and in-game arena
├── multiplayer.js          # Client-side multiplayer controller and WebRTC engine
├── multiplayer.css         # Styling for multiplayer hub, lobby, and scoreboard
├── dev_server.js           # Local development server with WebSocket support
├── songs.json              # Default song collection
├── playlists.json          # Curated default playlists dataset
├── server/
│   └── multiplayer.js      # Dedicated Node.js WebSocket room coordinator
├── api/
│   ├── match.js            # Track matcher and audio resolver endpoint
│   └── spotify.js          # Spotify playlist parser utility
└── package.json            # Project dependencies and startup scripts
```

---

## Installation and Local Setup

### Prerequisites
- Node.js (v18.0.0 or higher recommended)
- npm (Node Package Manager)

### Setup Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/martinkbl/heardle-clone.git
   cd heardle-clone
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the development server**:
   ```bash
   npm start
   ```
   Alternatively:
   ```bash
   node dev_server.js
   ```

4. **Access the application**:
   - Solo Mode: `heardle-clone-delta.vercel.app`
   - Multiplayer Hub: `https://heardle-clone-delta.vercel.app/multiplayer.html`

---

## Deployment Options

### Option 1: Static / Serverless Hosting (Vercel, Netlify, GitHub Pages)
- Deploy the repository directly to Vercel, Netlify, or Cloudflare Pages.
- Single-player mode functions entirely client-side.
- Multiplayer mode automatically activates the **WebRTC (PeerJS)** engine, allowing peer-to-peer room hosting with zero backend server costs.

### Option 2: Dedicated Node.js Hosting (Render, Railway, Fly.io, VPS)
- Deploy as a Node.js web service running `npm start`.
- Provides full WebSocket-backed room management for high-concurrency multiplayer sessions.

---

## Multiplayer Networking Protocol

### WebSocket Messages

| Event Type | Direction | Description |
|---|---|---|
| `CREATE_ROOM` | Client -> Server | Initialize a new room with custom settings. |
| `JOIN_ROOM` | Client -> Server | Connect to an existing room using a code. |
| `UPDATE_SETTINGS` | Client -> Server | Host updates playlist or winning round limit. |
| `START_GAME` | Client -> Server | Host triggers match start. |
| `ROUND_START` | Server -> Client | Broadcasts round number and masked audio source. |
| `SUBMIT_GUESS` | Client -> Server | Submit a track title / artist guess. |
| `SUBMIT_SKIP` | Client -> Server | Skip current snippet to unlock additional audio time. |
| `ROUND_OVER` | Server -> Client | Reveals song title, artist, and round score delta. |
| `NEXT_ROUND` | Client -> Server | Host requests next round transition. |
| `RESTART_GAME` | Client -> Server | Host restarts match within the same room. |

---

## Keyboard Controls Reference

| Key | Action |
|---|---|
| `Space` | Play / Pause audio snippet |
| `S` | Skip current attempt (+1s snippet progression) |
| `D` | Quick-focus the search bar |
| `Enter` | Submit guess / Confirm autocomplete selection |
| `Up / Down Arrows` | Navigate autocomplete dropdown items |
| `Escape` | Close modals / Dismiss autocomplete dropdown |

---

## License

This project is open source and available under the MIT License. 
