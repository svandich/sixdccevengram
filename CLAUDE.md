# Six DCCevenGram

Lista T's campaign site for the CaDCC 2027 student-council election (DCC, Universidad de Chile). It looks like
Telegram Desktop: a sidebar of chats on the left and the active chat on the right. Was live at https://erz.cl/cadcc/; taken offline on 2026-11-14 (see Deploy).
Repo: https://github.com/svandich/sixdccevengram (remote alias `svandich` = github.com). Commit and push to `main`.

UI text is Spanish (Chile); code and docs are English.

## Layout

- `app/server.py`: stdlib-only Python server (no dependencies). It serves `app/static/` and handles
  `/api/altcha` (captcha challenge), `/api/submit` (quiz answers) and `/api/comment`. When `ADMIN_TOKEN` is set,
  it also serves `/api/results.csv` and `/api/comments.csv`. Directory listings are disabled and client IPs are never logged.
- `app/static/index.html`, `app.css` and `app.js`: vanilla JS, no build step. The CSS is adapted from
  `~/repos/ofi/ofigram-desktop/web/app.css` (tdesktop palette, day and night themes, wallpaper `assets/pattern.svg`,
  Open Sans).
- `app/static/questions.json`: the only source of quiz content. Both the client and the server read it (the server
  validates and scores from it).
- `app/static/programas/lista-{L,N,T}.pdf`: the three programs. The root-level `Programa Lista *.pdf` files are
  the originals.
- `app/static/vendor/`: ALTCHA widget 3.4.1 (`altcha.umd.min.cjs` renamed to `.js`) plus `es-419` strings. MIT.

## Chats (sidebar)

These are defined in the `CHATS` array in `app.js`. Each chat has `id`, `name`, `photo` or `initials`/`color`,
`sub` (topbar status), optional `bot` (robot icon) and `last: true` (always sorted to the bottom). Each chat needs a
pane: a `.history` scroller in `index.html` plus an entry in `panes` in `app.js`, and a footer element with
`data-footer="<id>"`. `openChat(id)` switches the topbar, the pinned bar (quiz only), the footer and clears the badge.

- **Quiz Selector** (`quiz`): bot chat with the 16-question quiz. The avatar `assets/compass.png` is original 16×16
  pixel art in the style of a Minecraft compass (deliberately not Mojang's texture). The pinned message links the
  three PDFs.
- **Links Importantes** (`links`): channel-style chat (`linksChat()`) with the three program PDFs (`programDocs()`,
  also used in the quiz results) and Telegram-style link previews to each list's Instagram (`instagram` handle per
  list in `questions.json`). The avatar `assets/links.png` is original 24×24 pixel art (two chain links) on the same
  blue checkerboard as the compass.
- **Acerca de** (`about`, `last: true`): Dmitri's message (`aboutChat()`), with the @dmitroia Telegram link and the
  repo link.
- On narrow screens (≤760px) the page opens on the chat list (`startOnList` in `app.js`); desktop opens the quiz.
- The user plans to add more chats later. Keep the sidebar generic.

Favicon: `assets/favicon.png` (round) and `apple-touch-icon.png` (square). Both are a red panda photo, CC0 (Mathias
Appel, Wikimedia Commons).

## Quiz rules (keep it balanced)

- Lists: L = Lista Enlazada, Ñ = SeriAAAAAAAAAA (satirical list), T = Six DCCevenMaxxing. They're always shown in
  alphabetical order (L, Ñ, T).
- Every option must be a real proposal from that list's PDF. Options have similar length and tone and never name
  the list. Ñ options use its own (joke) proposals written deadpan; skip its offensive ones.
- Option order is shuffled per visitor. Every question has a neutral option (`"-"`) that scores for nobody.
- Score = picks for a list / number of questions that offer that list. This normalisation matters because Ñ only
  appears in 10 of the 16 questions. `score()` in `server.py` and `localScore()` in `app.js` must stay identical.
- There are 16 questions on purpose: L and T overlap a lot, so more questions would only add noise.

## Captcha (ALTCHA v3, ported to Python)

`altcha_challenge()` and `altcha_verify()` in `server.py` port altcha@3's lib: counter mode, `PBKDF2/SHA-256`,
the password is the nonce plus the counter as a big-endian uint32, `keyPrefix` is the first half of the derived
key, and the HMAC-SHA256 signature is over the canonical JSON of the sorted parameters (compact separators).
The payload is base64 JSON `{challenge: {parameters, signature}, solution: {counter, derivedKey}}`.
Used signatures are kept in memory to block replays, and the widget's `{test: true}` payload is rejected.
Difficulty is set by the `ALTCHA_COST` and `ALTCHA_COUNTER_MIN`/`MAX` env vars (well under 1 s on a desktop).
If the widget is upgraded, re-check the protocol in its `dist/lib/index.js` (v3 differs from v1/v2).

## Data

- `data/results.csv`: `timestamp_utc, id, q1..q16, resultado, afinidad_L, afinidad_Ñ, afinidad_T`. Answers are list
  codes (`L`/`Ñ`/`T`/`-`).
- `data/comments.csv`: `timestamp_utc, id, comentario`. A comment is accepted only with an id from a
  captcha-verified submission in the last hour, one per id. A leading `= + - @ \t` is prefixed with `'` (protection
  against CSV formula injection). Ids are hex so they never start with `-`.
- On startup, a CSV whose header no longer matches (for example after the questions changed) is renamed to
  `<name>.<UTC stamp>.old.csv` instead of being mixed.
- `data/` and `.env` are gitignored. The container runs as root, so files in `data/` are root-owned: use
  `docker compose exec -T quiz ...` to modify them.

## Run locally

`docker compose up -d --build`, then open http://localhost:8080. It binds to 127.0.0.1 only. The port and secrets
come from `.env` (`HOST_PORT`, `ALTCHA_HMAC_KEY`, `ADMIN_TOKEN`).

Browser testing: use Playwright's headless shell at
`~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`, driven
over CDP from a small Node script (`--remote-debugging-port`, `Runtime.evaluate` to click `.kbd-btn`,
`Page.captureScreenshot`). Test both 1280×800 and 390×800, and the day and night themes. Delete any test rows you
create in `data/`.

## Deploy (server `erz`, `ssh erz`, user `kit`)

**Offline since 2026-11-14:** the container is stopped (`docker compose down`) and the `/cadcc` route was removed
from the Caddyfile (backup `Caddyfile.bak.20261114T162900Z` holds the old block). The clone and `data/` are kept on
erz. To restore: put back the Caddy block described below, reload Caddy, and run `docker compose up -d --build`.

- App: `/home/kit/docker/sixdccevengram` (git clone over https). `.env` has `HOST_PORT=8020` and a random
  `ALTCHA_HMAC_KEY` (mode 600).
- Update: `ssh erz 'cd /home/kit/docker/sixdccevengram && git pull && docker compose up -d --build'`
- Caddy runs as a docker container `caddy` (host network). Its config is `/home/kit/docker/caddy/Caddyfile`, inside
  the `erz.cl` block: `redir /cadcc /cadcc/ 308` and `handle_path /cadcc/* { reverse_proxy localhost:8020 }`, with
  the original `root`/`file_server` wrapped in `handle {}`. All URLs in the app are relative, so it works under the
  sub-path.
- Caddy changes: back up the Caddyfile first, then run
  `docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` and the same with `reload`.
  The "not formatted" warning (`lesly.cl` block) predates this project.
- Read responses: `ssh erz cat /home/kit/docker/sixdccevengram/data/results.csv` (and `comments.csv`).
