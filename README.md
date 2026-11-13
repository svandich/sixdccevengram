# Six DCCevenGram

Lista T's Telegram Desktop–style site. Its first chat, Quiz Selector, is a 16-question quiz. It tells each student which list (L, Ñ, T) their answers match best.

## Run

```
docker compose up -d --build      # http://localhost:8080
```

The app only listens on localhost. Settings go in a `.env` file next to `docker-compose.yml` (gitignored):

```
HOST_PORT=8080
ALTCHA_HMAC_KEY=<random hex, e.g. openssl rand -hex 32>
ADMIN_TOKEN=
```

### Behind Caddy under a path (e.g. `example.com/cadcc/`)

All URLs in the page are relative, so it works under a sub-path as long as the prefix is stripped:

```
example.com {
	redir /cadcc /cadcc/ 308
	handle_path /cadcc/* {
		reverse_proxy localhost:8020
	}
	handle {
		# ...the site's existing config
	}
}
```

Every completed quiz is appended to `./data/results.csv`:

| column | meaning |
|---|---|
| `timestamp_utc` | when it was submitted |
| `id` | random submission id (links to `comments.csv`) |
| `q1`…`q16` | chosen list per question (`L`, `Ñ`, `T`, or `-` for "ninguna") |
| `resultado` | top list, `empate (X/Y)`, or `ninguna` |
| `afinidad_L/Ñ/T` | affinity % per list |

After the results, people can leave one optional comment. It goes to `./data/comments.csv`
(`timestamp_utc`, `id`, `comentario`), linked to the submission by `id`. A comment is only accepted within an hour
of a captcha-verified submission, one per submission. If the questions change, the server moves the old CSV
aside on startup (`results.<date>.old.csv`) instead of mixing formats.

No IPs or other identifying data are stored. To download the CSV over HTTP, set `ADMIN_TOKEN` in
`docker-compose.yml` and open `/api/results.csv?token=<value>` (or `/api/comments.csv`). Without a token that route returns 404.

## Captcha

Submissions are protected by [ALTCHA](https://altcha.org) (MIT): a self-hosted proof-of-work captcha
with no cookies, tracking or third-party requests. The widget (`app/static/vendor/`, altcha 3.4.1) solves
a challenge from `/api/altcha` in the background when the quiz ends, and `/api/submit` rejects any submission
without a valid, unused solution (HTTP 403). The server-side check is a stdlib port of ALTCHA's v3 protocol.

Optional env vars: `ALTCHA_HMAC_KEY` (fixed secret; otherwise random per start, which only invalidates
challenges in flight), `ALTCHA_COST`, `ALTCHA_COUNTER_MIN`/`MAX` (difficulty; defaults take about 1 s).

## Editing questions

All content lives in `app/static/questions.json`. The server reads the same file to validate and score
submissions, so the client and server can't disagree. If you change the question ids, start a new CSV,
because the header changes.

## Neutrality choices

- Every option is a real proposal from that list's program. Options have similar length and tone and
  never name the list.
- Option order is shuffled per visitor. Lists are shown in alphabetical order (L, Ñ, T) everywhere.
- Every question has a "Ninguna me representa" option that scores for nobody.
- Scores are normalised: affinity = picks for a list / questions that offered that list. Lista Ñ appears in
  10 of the 16 questions and L and T in all 16, so raw counts would penalise Ñ.
- The results link to all three program PDFs.

## Credits

Chat picture: original 16×16 pixel-art compass (`assets/compass.png`, Minecraft-inspired, drawn for this project).
Favicon: *Red Panda Portrait* by Mathias Appel, CC0, via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Red_Panda_Portrait_(31625024560).jpg).
Captcha: [ALTCHA](https://altcha.org) (MIT, `app/static/vendor/ALTCHA-LICENSE.txt`). Look adapted from ofigram-desktop.
