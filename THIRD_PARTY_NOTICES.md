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

Dependency license texts remain in the installed packages. Electron's distribution includes its LICENSE and LICENSES.chromium.html. The package lock records transitive dependencies. No NapCat binaries, QQ client, personal character card, account cache or private data are distributed.
