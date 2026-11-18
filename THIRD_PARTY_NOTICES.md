# Third-party notices

ChatDS Desktop is distributed under GPL-3.0-only. See LICENSE for the full text.
Source and build instructions: https://github.com/Zlongyang/chatds-desktop

## MaiBot

- Upstream: https://github.com/Mai-with-u/MaiBot
- Revision: `478f671e64467121fd3e39205c8d3507b5ce0bd6`
- Original component: `src/chat/debounce/controller.py`
- Copyright: MaiBot contributors, as recorded in the upstream repository.
- License: GNU General Public License version 3.
- The original reference is included in `third_party/maibot/controller.py`.
- The TypeScript port is `src/runtime/debounce.ts`. Changes: seconds-based timing retained; notification Event is owned by the application scheduler; no Python runtime dependency.
- Pre-reuse checks and reference hash: `third_party/maibot/SOURCE.json`. Reproduce cross-language equivalence using `npm run test:parity`.

The companion prompt and permission architecture were independently implemented after studying publicly available implementations. The complete MaiBot, AstrBot, Codex, OpenClaw, DeepAgents and Mem0 runtimes are not bundled.

## Runtime dependencies

- Pi Agent Core / Pi AI 1.5.2, Earendil Works and contributors: MIT.
  https://github.com/earendil-works/pi
- Electron, OpenJS Foundation and contributors: MIT and included Chromium/Node licenses.
  https://github.com/electron/electron
- ws, contributors: MIT. https://github.com/websockets/ws
- Zod, Colin McDonnell and contributors: MIT. https://github.com/colinhacks/zod
- ipaddr.js, whitequark and contributors: MIT. https://github.com/whitequark/ipaddr.js
- node-qrcode, Ryan Day and contributors: MIT. https://github.com/soldair/node-qrcode
- unzipper, contributors: MIT. https://github.com/ZJONSSON/node-unzipper

## Optional NapCat connection

The Windows setup wizard can request a separate download of the unmodified NapCat Shell 4.18.42 archive on first launch. Users can also select an existing installation. The pinned archive is identified by SHA-256 `02e5ff0f79916c1e04c81c1b4590056406fb4293f1f1300c955e71fd08b2829d`. See the [original license](https://github.com/NapNeko/NapCatQQ/blob/9335843246e3b7a17944861f3ac8731a259732c2/LICENSE) and [release archive](https://github.com/XingYunStar/NapCatQQ/releases/tag/v4.18.42).

Dependency license texts remain in the installed packages. Electron's distribution includes its LICENSE and LICENSES.chromium.html. The package lock records transitive dependencies. No NapCat binaries, QQ client, personal character card, account cache or private data are distributed.
