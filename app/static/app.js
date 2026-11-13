(async function () {
  "use strict";
  const NEUTRAL = "-";
  const TYPING_MS = 450;
  const $ = (id) => document.getElementById(id);
  const history = $("history");
  const inner = $("history-inner");
  // One scroller per chat; only the active one is visible.
  const panes = {
    quiz: { scroller: history, inner },
    about: { scroller: $("history-about"), inner: $("about-inner") },
  };
  let active = "quiz";

  const quiz = await (await fetch("questions.json")).json();
  const lists = Object.keys(quiz.lists);
  const questions = quiz.questions;
  const listName = (k) => quiz.lists[k].name;
  const listShort = (k) => listName(k).split(" — ")[0];

  // Option order is shuffled once per visitor so position never favours a list.
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const order = questions.map((q) => shuffle(q.options.slice()));

  let answers = {};
  let steps = []; // per question: { q: questionEl, a: answerEl }
  let submissionId = null; // lets this visitor leave one comment on their submission
  let lastKbdMsg = null;
  let busy = false;

  // ---------- helpers

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const now = () => new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
  const CHECKS = '<svg class="checks" viewBox="0 0 16 11"><path d="M1 5.8l3 3L10.2 2.5M6.6 8.4l.6.6L13.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function scrollDown(chat = "quiz") {
    const sc = panes[chat].scroller;
    requestAnimationFrame(() => sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" }));
  }

  // Build a message. `content` is an array of nodes for the bubble body.
  function addMsg({ out = false, content, kbd, scroll = true, chat = "quiz" }) {
    const msg = el("div", "msg " + (out ? "out" : "in"));
    const bubble = el("div", "bubble");
    for (const c of content) bubble.appendChild(c);
    const meta = el("span", "meta");
    meta.innerHTML = `<span class="time">${now()}</span>${out ? CHECKS : ""}`;
    const last = bubble.lastElementChild;
    if (last && last.classList.contains("text")) last.appendChild(el("span", "meta-spacer"));
    else bubble.appendChild(el("div", "meta-row")).style.height = "14px";
    bubble.appendChild(meta);
    msg.appendChild(bubble);
    if (kbd) {
      msg.classList.add("has-kbd");
      const box = el("div", "kbd");
      for (const b of kbd) {
        const btn = el("button", "kbd-btn" + (b.cls ? " " + b.cls : ""), b.text);
        btn.onclick = () => { if (!busy) b.onClick(); };
        box.appendChild(btn);
      }
      msg.appendChild(box);
    }
    panes[chat].inner.appendChild(msg);
    updateDialog(chat, out ? "Tú: " : "", content[0].textContent.trim());
    if (scroll) scrollDown(chat);
    return msg;
  }

  function dropKbd(msg) {
    const k = msg.querySelector(".kbd");
    if (k) k.remove();
    msg.classList.remove("has-kbd");
  }

  function service(text, chat = "quiz") {
    const s = el("div", "service");
    s.appendChild(el("span", "pill", text));
    panes[chat].inner.appendChild(s);
    scrollDown(chat);
  }

  function text(str, cls) { return el("div", "text" + (cls ? " " + cls : ""), str); }

  async function typing() {
    busy = true;
    const sub = $("tb-sub");
    const shown = active === "quiz";
    if (shown) { sub.textContent = "escribiendo…"; sub.classList.add("typing"); }
    await sleep(TYPING_MS);
    if (active === "quiz") { sub.textContent = chatById.quiz.sub; sub.classList.remove("typing"); }
    busy = false;
  }

  // ---------- left column

  // Sidebar chats. Add new ones here; entries with `last: true` always stay at the bottom.
  const CHATS = [
    { id: "quiz", name: "Quiz Selector", photo: "assets/compass.png", bot: true, sub: "bot" },
    { id: "about", name: "Acerca de", initials: "AD", color: "p7", sub: "Dmitri · @dmitroia", last: true },
  ];
  const chatById = Object.fromEntries(CHATS.map((c) => [c.id, c]));
  const rows = {}; // chat id -> { row, preview, date, badge }
  const BOT_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="8.5" r="1"/><circle cx="10" cy="8.5" r="1"/><path d="M8 4V2" stroke="currentColor" stroke-width="1.4"/></svg>`;

  function avatar(chat) {
    if (chat.photo) {
      const img = el("img", "userpic");
      img.src = chat.photo;
      img.alt = "";
      return img;
    }
    return el("div", "userpic " + (chat.color || "p4"), chat.initials || chat.name[0]);
  }

  function renderDialogs() {
    const list = $("dialog-list");
    list.replaceChildren();
    const ordered = [...CHATS.filter((c) => !c.last), ...CHATS.filter((c) => c.last)];
    for (const chat of ordered) {
      const row = el("div", "dialog-row");
      row.innerHTML = `<div class="d-body"><div class="d-top"><div class="d-name"><span></span></div><div class="d-date"></div></div><div class="d-bottom"><div class="d-text"></div></div></div>`;
      row.prepend(avatar(chat));
      row.querySelector(".d-name span").textContent = chat.name;
      if (chat.bot) row.querySelector(".d-name").insertAdjacentHTML("beforeend", BOT_ICON);
      rows[chat.id] = { row, preview: row.querySelector(".d-text"), date: row.querySelector(".d-date"), badge: null };
      row.onclick = () => openChat(chat.id);
      list.appendChild(row);
    }
  }

  function setBadge(id, n) {
    const r = rows[id];
    if (r.badge) { r.badge.remove(); r.badge = null; }
    if (n > 0) {
      r.badge = el("div", "d-badge", String(n));
      r.row.querySelector(".d-bottom").appendChild(r.badge);
    }
  }

  function openChat(id) {
    active = id;
    const chat = chatById[id];
    for (const [cid, r] of Object.entries(rows)) r.row.classList.toggle("active", cid === id);
    for (const [cid, p] of Object.entries(panes)) p.scroller.hidden = cid !== id;
    $("tb-pic").replaceChildren(avatar(chat));
    $("tb-name").textContent = chat.name;
    const sub = $("tb-sub");
    sub.textContent = chat.sub;
    sub.classList.remove("typing");
    $("pinned").hidden = id !== "quiz";
    $("quiz-footer").hidden = id !== "quiz";
    $("about-footer").hidden = id !== "about";
    if (id === "about") setBadge("about", 0);
    document.body.classList.remove("sidebar-open");
  }

  function aboutChat() {
    const t = text("¡Hola! Soy Dmitri, de Sistemas del CaDCC 2026 y de la lista T. Creé esto porque me gusta mucho resolver problemas con software; creo que es parte fundamental de ser CaDCC, ya que estamos en la intersección perfecta de conocimiento como para saber hacer estas cosas. Si tengo más ideas, las pondré en otro chat de esta página. Si me quieres preguntar algo, escríbeme a ");
    const a = el("a", null, "@dmitroia");
    a.href = "https://t.me/dmitroia";
    a.target = "_blank";
    a.rel = "noopener";
    t.append(a, " en Telegram. ¡Saludos!");
    service(new Date().toLocaleDateString("es-CL", { day: "numeric", month: "long" }), "about");
    addMsg({ chat: "about", content: [t], scroll: false });
    setBadge("about", 1);
  }

  function programLink(k, label) {
    const a = el("a", null, label);
    a.href = quiz.lists[k].pdf;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }
  function renderPinned() {
    const pin = $("pin-text");
    pin.replaceChildren("Programas: ");
    lists.forEach((k, i) => {
      if (i) pin.append(" · ");
      pin.appendChild(programLink(k, listShort(k)));
    });
    pin.append(" — este quiz no reemplaza leerlos.");
  }

  function updateDialog(chat, prefix, str) {
    const r = rows[chat];
    r.preview.replaceChildren();
    if (prefix) r.preview.appendChild(el("span", "svc", prefix));
    r.preview.append(str);
    r.date.textContent = now();
  }

  // ---------- flow

  function intro() {
    addMsg({
      content: [
        text("¡Hola! 👋 Te haré " + questions.length + " preguntas sobre propuestas concretas de los programas de las listas al CaDCC 2027."),
        text("\n• Cada opción viene de un programa, pero no verás de cuál hasta el final.\n• Las opciones aparecen en orden aleatorio.\n• Si ninguna te convence, elige «" + quiz.neutral + "»: no suma a ninguna lista.\n• Solo se guarda la hora y tus respuestas, de forma anónima."),
      ],
      kbd: [{ text: "Comenzar", onClick: start }],
    });
  }

  function start() {
    dropKbd(inner.lastElementChild);
    answers = {};
    steps = [];
    ask(0);
  }

  async function ask(i) {
    await typing();
    const q = questions[i];
    const kbd = order[i].map((o) => ({ text: o.text, onClick: () => choose(i, o.list, o.text) }));
    kbd.push({ text: quiz.neutral, cls: "muted", onClick: () => choose(i, NEUTRAL, quiz.neutral) });
    if (i > 0) kbd.push({ text: "« Pregunta anterior", cls: "nav", onClick: () => back(i) });
    const head = el("div", "head", `Pregunta ${i + 1}/${questions.length} · ${q.area}`);
    steps[i] = { q: addMsg({ content: [head, text(q.text)], kbd }) };
    $("composebar").textContent = "Elige una opción en los botones";
  }

  function choose(i, list, label) {
    answers[questions[i].id] = list;
    dropKbd(steps[i].q);
    steps[i].a = addMsg({ out: true, content: [text(label)] });
    if (i + 1 < questions.length) ask(i + 1);
    else finish();
  }

  function back(i) {
    steps[i].q.remove();
    steps[i - 1].a.remove();
    steps[i - 1].q.remove();
    delete answers[questions[i - 1].id];
    steps.length = i - 1;
    ask(i - 1);
  }

  // Mirrors server.py (used only if the server can't be reached).
  function localScore() {
    const picks = Object.fromEntries(lists.map((k) => [k, 0]));
    const opp = Object.fromEntries(lists.map((k) => [k, 0]));
    for (const q of questions) for (const o of q.options) opp[o.list]++;
    for (const a of Object.values(answers)) if (a in picks) picks[a]++;
    const scores = Object.fromEntries(lists.map((k) => [k, opp[k] ? Math.round((1000 * picks[k]) / opp[k]) / 10 : 0]));
    return { scores };
  }

  async function finish() {
    $("composebar").textContent = "Verificando…";
    await typing();
    const widget = document.createElement("altcha-widget");
    widget.setAttribute("challenge", "api/altcha");
    widget.setAttribute("auto", "onload");
    widget.setAttribute("language", "es-419");
    const box = el("div", "captcha");
    box.appendChild(widget);
    const msg = addMsg({ content: [text("Último paso: comprobando que no eres un robot (toma unos segundos, sin clics)."), box] });
    widget.addEventListener("verified", (ev) => submit(ev.detail.payload, msg, widget), { once: false });
  }

  let submitting = false;
  async function submit(captcha, captchaMsg, widget) {
    if (submitting) return;
    submitting = true;
    let result = null, saved = false;
    try {
      const r = await fetch("api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, altcha: captcha }),
      });
      if (r.status === 403) {
        submitting = false;
        widget.reset && widget.reset();
        addMsg({ content: [text("La verificación falló. Marca la casilla de arriba para intentarlo de nuevo.")] });
        return;
      }
      if (r.ok) { result = await r.json(); saved = true; submissionId = result.id; }
    } catch {}
    if (!result) result = localScore();
    captchaMsg.querySelector(".captcha").remove();
    captchaMsg.querySelector(".text").firstChild.textContent = "Verificado ✓";
    $("composebar").textContent = "Cuestionario terminado";
    await typing();
    submitting = false;
    showResults(result.scores, saved);
  }

  function showResults(scores, saved) {
    const best = Math.max(...Object.values(scores));
    const top = lists.filter((k) => scores[k] === best);
    const verdict =
      best === 0 ? "Ninguna lista coincidió con tus respuestas."
      : top.length === 1 ? `Tienes mayor afinidad con ${listName(top[0])}.`
      : `Empate entre ${top.map(listName).join(" y ")}.`;

    const poll = el("div", "poll");
    poll.appendChild(el("div", "p-question", "Tu afinidad con cada lista"));
    poll.appendChild(el("div", "p-kind", `Resultado · ${questions.length} preguntas`));
    for (const k of [...lists].sort((a, b) => scores[b] - scores[a])) {
      const row = el("div", "p-answer" + (scores[k] === best && best > 0 ? " chosen" : ""));
      row.appendChild(el("div", "p-pct", `${Math.round(scores[k])}%`));
      const main = el("div", "p-main", listName(k));
      const bar = el("div", "p-bar");
      bar.style.width = `${scores[k]}%`;
      main.appendChild(bar);
      row.appendChild(main);
      poll.appendChild(row);
    }
    poll.appendChild(el("div", "p-note", "La afinidad es el % de preguntas con opción de esa lista en las que la elegiste. No todas las listas tienen propuestas en todas las áreas, así que cada una se compara contra sus propias preguntas."));
    const resultMsg = addMsg({ content: [el("div", "head", verdict), poll], scroll: false });

    const ol = el("ol", "answers");
    for (const q of questions) {
      const li = el("li");
      const a = answers[q.id];
      li.append(q.area + ": ");
      li.appendChild(el("span", "tag", a === NEUTRAL ? "ninguna" : listShort(a)));
      ol.appendChild(li);
    }
    addMsg({ content: [el("div", "head", "Tus respuestas"), ol], scroll: false });

    const docs = [el("div", "head", "Lee los programas completos")];
    for (const k of lists) {
      const a = el("a", "document");
      a.href = quiz.lists[k].pdf;
      a.target = "_blank";
      a.rel = "noopener";
      a.appendChild(el("div", "doc-icon", "pdf"));
      const body = el("div", "doc-body");
      body.appendChild(el("div", "doc-name", `Programa ${listName(k)}.pdf`));
      body.appendChild(el("div", "doc-status", "Abrir"));
      a.appendChild(body);
      docs.push(a);
    }
    if (!saved) docs.push(text("No se pudo guardar tu respuesta, pero el resultado de arriba es válido.", "muted"));
    addMsg({ content: docs, scroll: false });
    lastKbdMsg = addMsg({
      content: [text(saved
        ? "💬 ¿Algún comentario sobre el quiz o las listas? Escríbelo abajo (opcional y anónimo)."
        : "Gracias por responder.")],
      kbd: [{ text: "🔄 Volver a empezar", onClick: restart }],
      scroll: false,
    });
    setComposer(saved);
    updateDialog("quiz", "", verdict);
    // Land on the verdict, not on the bottom of the history.
    requestAnimationFrame(() => history.scrollTo({ top: resultMsg.offsetTop - 8, behavior: "smooth" }));
  }

  // ---------- comment box (Telegram-style compose area)

  const input = $("compose-input");
  function setComposer(on) {
    $("composer").hidden = !on;
    $("composebar").hidden = on;
    if (!on) return;
    input.value = "";
    autosize();
    $("compose-send").disabled = true;
  }
  function autosize() {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  }
  input.addEventListener("input", () => {
    autosize();
    $("compose-send").disabled = !input.value.trim();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const comment = input.value.trim();
    if (!comment || !submissionId) return;
    setComposer(false);
    $("composebar").textContent = "Enviando…";
    addMsg({ out: true, content: [text(comment)] });
    let ok = false;
    try {
      const r = await fetch("api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: submissionId, comment }),
      });
      ok = r.ok;
    } catch {}
    submissionId = null;
    await typing();
    addMsg({ content: [text(ok ? "¡Gracias! Tu comentario quedó guardado. 🙌" : "No se pudo guardar el comentario, lo siento.")] });
    $("composebar").textContent = ok ? "Comentario enviado" : "Cuestionario terminado";
  });

  function restart() {
    if (lastKbdMsg) dropKbd(lastKbdMsg);
    setComposer(false);
    submissionId = null;
    service("Nuevo intento");
    answers = {};
    steps = [];
    ask(0);
  }

  // ---------- chrome

  $("theme-btn").onclick = () => {
    const t = document.documentElement.dataset.theme === "night" ? "day" : "night";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("theme", t); } catch {}
  };
  $("open-left").onclick = () => document.body.classList.add("sidebar-open");
  $("close-left").onclick = () => document.body.classList.remove("sidebar-open");

  renderDialogs();
  openChat("quiz");
  aboutChat();
  renderPinned();
  service(new Date().toLocaleDateString("es-CL", { day: "numeric", month: "long" }));
  intro();
})();
