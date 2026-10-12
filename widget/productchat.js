/*! productchat widget · MIT · https://github.com/chidhu07/productchat
   A support chat bubble that answers from your page's own FAQ, and hands
   off to a person (your inbox + Telegram) when it can't. Nothing reaches
   your server until the visitor chooses to message you.

   <script>
     window.productchatConfig = {
       api: "/api/productchat",            // your server endpoint
       brand: "Acme",                      // "Acme team", greeting, …
       faq: { items: "details.faq", question: "summary", answer: ".faq-answer" },
       knowledge: [{ q: "Do you ship to Canada?", a: "Yes, in 3–5 days.", k: "shipping delivery canada" }],
     };
   </script>
   <script src="/productchat.js" defer></script>

   Every option is described in the README. */
(function () {
  if (window.ProductChat) return;

  var script = document.currentScript;
  var data = (script && script.dataset) || {};
  var C = window.productchatConfig || {};
  var cfg = {
    api: C.api || data.api || "/api/productchat",
    brand: C.brand || data.brand || "Support",
    accent: C.accent || data.accent || "#22c55e",
    dark: C.dark || data.dark || "#111111",
    logo: C.logo || "",
    faq: C.faq === false ? false : Object.assign({ items: "details", question: "summary", answer: "", keyAttr: "data-key" }, C.faq || {}),
    knowledge: C.knowledge || [],
    chips: C.chips || null,
    synonyms: C.synonyms || {},
    stopwords: C.stopwords || "",
    strings: C.strings || {},
    privacyUrl: C.privacyUrl === undefined ? "/privacy" : C.privacyUrl,
    storageKey: C.storageKey || "productchat",
    position: C.position === "left" ? "left" : "right",
    poweredBy: C.poweredBy !== false,
    zIndex: C.zIndex || 2147483000
  };

  var LANG = (C.lang || document.documentElement.getAttribute("lang") || "en").toLowerCase();
  var S = {
    open: "Open support chat", close: "Close chat", send: "Send",
    title: "Help & support", subtitle: "Instant answers, or message the team",
    greeting: "Hi! I can answer most questions about {brand} right away. What would you like to know?",
    placeholder: "Type your question…", placeholderHuman: "Message the team…",
    team: "{brand} team", human: "Talk to a person", helped: "That helped",
    anythingElse: "Great! Anything else?", hello: "Hi! What can I help you with?", welcome: "You're welcome! Anything else?",
    suggest: "Did you mean one of these?",
    notSure: "I'm not sure about that one. Want to send it to the team? A person will reply right here.",
    handoffTitle: "Send your question to the team", handoffQ: "Your question", email: "Your email",
    emailNote: "We only use your email to reply to you.", privacy: "Privacy",
    sendTeam: "Send to the team", sending: "Sending…",
    needQ: "Please type your question.", needEmail: "Please enter a valid email so we can reach you.",
    error: "Couldn't send. Please try again.",
    sent: "Thanks! The team has your message and will reply right here. You can close this window and check back later.",
    teamBar: "You're messaging the team", backToBot: "Ask the bot instead",
    viewThread: "See my conversation with the team", newQuestion: "Ask a new question",
    poweredBy: "Powered by productchat"
  };
  function t(key) { var v = cfg.strings[key] != null ? cfg.strings[key] : S[key]; return String(v).replace(/\{brand\}/g, cfg.brand); }

  /* ---------- knowledge: the page's FAQ + your extra entries ---------- */

  var kb = null;
  function knowledge() {
    if (kb) return kb;
    kb = [];
    if (cfg.faq) {
      var items = document.querySelectorAll(cfg.faq.items);
      for (var i = 0; i < items.length; i++) {
        var qEl = items[i].querySelector(cfg.faq.question);
        if (!qEl) continue;
        var html;
        if (cfg.faq.answer) { var aEl = items[i].querySelector(cfg.faq.answer); html = aEl ? aEl.innerHTML : ""; }
        else { var copy = items[i].cloneNode(true), qc = copy.querySelector(cfg.faq.question); if (qc) qc.remove(); html = copy.innerHTML; }
        if (html.trim()) kb.push({ q: qEl.textContent.trim(), a: html, k: "", key: qEl.getAttribute(cfg.faq.keyAttr) || items[i].getAttribute(cfg.faq.keyAttr) || "" });
      }
    }
    for (var j = 0; j < cfg.knowledge.length; j++) kb.push(cfg.knowledge[j]);
    for (var n = 0; n < kb.length; n++) kb[n].idx = index(kb[n]);
    return kb;
  }

  /* ---------- matcher: weighted token overlap with synonyms ---------- */

  var STOP = " a an the is are am was be do does did i me my you your we our it its this that to of in on for with and or can could would should how what why when where which who will about if not no yes any have has get there here so as at by from just please hi hello hey work works working use using ";
  STOP += (cfg.brand + " " + cfg.stopwords).toLowerCase().split(/[^\p{L}\p{N}]+/u).join(" ") + " ";
  var SYN = {
    cost: "price", costs: "price", pricing: "price", prices: "price", pay: "price", paid: "price", payment: "price", money: "price",
    expensive: "price", cheap: "price", free: "price", much: "price", dollar: "price", dollars: "price", plan: "price", plans: "price", trial: "price",
    private: "privacy", data: "privacy", track: "privacy", tracking: "privacy", spy: "privacy", collect: "privacy", sell: "privacy",
    download: "install", setup: "install", installing: "install", installed: "install",
    mobile: "phone", android: "phone", iphone: "phone", ios: "phone", phones: "phone", tablet: "phone",
    unsubscribe: "cancel", cancellation: "cancel", refunds: "refund", chargeback: "refund",
    account: "account", signup: "account", login: "account", register: "account",
    company: "team", business: "team", teams: "team", employees: "team"
  };
  for (var sk in cfg.synonyms) SYN[sk] = cfg.synonyms[sk];
  var CJK = /[぀-ヿ㐀-鿿가-힯]/;

  function tokens(text) {
    var out = [];
    var words = String(text).toLowerCase().replace(/<[^>]+>/g, " ").match(/[\p{L}\p{N}]+/gu) || [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (CJK.test(w)) { // no spaces in CJK: use character pairs
        for (var c = 0; c < w.length - 1; c++) out.push(w.substr(c, 2));
        if (w.length === 1) out.push(w);
        continue;
      }
      if (STOP.indexOf(" " + w + " ") !== -1 || w.length < 2) continue;
      w = SYN[w] || w;
      if (w.length > 4 && !SYN[w]) w = w.replace(/(ing|ed|es|s)$/, "");
      out.push(SYN[w] || w);
    }
    return out;
  }

  function index(entry) {
    var weights = {};
    function add(list, wgt) { for (var i = 0; i < list.length; i++) if ((weights[list[i]] || 0) < wgt) weights[list[i]] = wgt; }
    add(tokens(entry.a), 1);
    add(tokens(entry.k || ""), 3);
    add(tokens(entry.q), 3);
    entry.qTokens = tokens(entry.q).filter(function (w, i, all) { return all.indexOf(w) === i; });
    return weights;
  }

  function match(text) {
    var list = knowledge(), q = tokens(text), uniq = [];
    for (var i = 0; i < q.length; i++) if (uniq.indexOf(q[i]) === -1) uniq.push(q[i]);
    if (!uniq.length) return [];
    var scored = [];
    for (var j = 0; j < list.length; j++) {
      var s = 0;
      for (var k = 0; k < uniq.length; k++) s += list[j].idx[uniq[k]] || 0;
      if (s <= 0) continue;
      // Tie-break: prefer the entry whose own question the visitor's words cover best.
      var qt = list[j].qTokens, hit = 0;
      for (var h = 0; h < qt.length; h++) if (uniq.indexOf(qt[h]) !== -1) hit++;
      scored.push({ entry: list[j], score: 0.85 * (s / (3 * uniq.length)) + 0.15 * (qt.length ? hit / qt.length : 0) });
    }
    return scored.sort(function (x, y) { return y.score - x.score; });
  }

  /* ---------- storage and network (best effort) ---------- */

  function load() { try { return JSON.parse(localStorage.getItem(cfg.storageKey)) || {}; } catch (e) { return {}; } }
  function save(v) { try { localStorage.setItem(cfg.storageKey, JSON.stringify(v)); } catch (e) {} }
  var state = load(); // {id, token, seen, lastId, email}

  function post(action, body) {
    var url = cfg.api + (cfg.api.indexOf("?") === -1 ? "?" : "&") + "action=" + action;
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }

  /* ---------- UI ---------- */

  var side = cfg.position;
  var CSS = [
    ":host{all:initial;--a:" + cfg.accent + ";--d:" + cfg.dark + "}",
    "*{box-sizing:border-box;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".launch{position:fixed;" + side + ":20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;background:var(--d);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.22),0 0 0 1px rgba(255,255,255,.06) inset;transition:transform .18s,box-shadow .18s;z-index:" + cfg.zIndex + "}",
    ".launch:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 14px 36px rgba(0,0,0,.26)}",
    ".launch:focus-visible,.panel button:focus-visible{outline:2px solid var(--a);outline-offset:2px}",
    ".dot{position:absolute;top:3px;right:3px;width:14px;height:14px;border-radius:50%;background:var(--a);border:2px solid #fff;display:none}",
    ".dot.on{display:block}",
    ".panel{position:fixed;" + side + ":20px;bottom:90px;width:380px;height:min(620px,calc(100vh - 112px));background:#fff;color:#111;border:1px solid rgba(0,0,0,.08);border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.18);display:none;flex-direction:column;overflow:hidden;z-index:" + cfg.zIndex + ";font-size:14px;line-height:1.5;transform-origin:bottom " + side + "}",
    ".panel.open{display:flex;animation:pop .18s ease-out}",
    "@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.98)}}",
    ".head{background:var(--d);color:#fff;padding:15px 16px;display:flex;align-items:center;gap:11px}",
    ".head .logo{width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden}",
    ".head .logo img{width:100%;height:100%;object-fit:cover}",
    ".head .t{font-weight:700;font-size:15px;letter-spacing:-.1px}",
    ".head .s{font-size:12px;color:rgba(255,255,255,.65);display:flex;align-items:center;gap:6px}",
    ".head .s i{width:7px;height:7px;border-radius:50%;background:var(--a);display:inline-block}",
    ".head .x{margin-" + (side === "right" ? "left" : "left") + ":auto;background:none;border:0;color:#fff;cursor:pointer;padding:7px;border-radius:9px;display:flex;opacity:.8}",
    ".head .x:hover{background:rgba(255,255,255,.1);opacity:1}",
    ".log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#f7f7f8}",
    ".msg{max-width:85%;padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}",
    ".msg.bot,.msg.agent{background:#fff;border:1px solid #ececef;align-self:flex-start;border-bottom-left-radius:5px;white-space:normal;box-shadow:0 1px 2px rgba(0,0,0,.03)}",
    ".msg.agent{border-color:color-mix(in srgb,var(--a) 45%,#fff);white-space:pre-wrap}",
    ".msg.visitor{background:var(--d);color:#fff;align-self:flex-end;border-bottom-right-radius:5px}",
    ".msg p{margin:0 0 6px}.msg p:last-child{margin:0}",
    ".msg a{color:color-mix(in srgb,var(--a) 70%,#000);font-weight:600}",
    ".who{font-size:11px;font-weight:700;color:color-mix(in srgb,var(--a) 70%,#000);margin-bottom:2px}",
    ".chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:100%}",
    ".chip{background:#fff;border:1px solid #dcdce0;border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer;color:#111;text-align:left;transition:border-color .15s,background .15s}",
    ".chip:hover{border-color:var(--d)}",
    ".chip.human{background:var(--d);color:#fff;border-color:var(--d)}",
    ".form{background:#fff;border:1px solid #ececef;border-radius:16px;padding:13px;display:flex;flex-direction:column;gap:8px;align-self:stretch}",
    ".form b{font-size:14px}",
    ".form input,.form textarea{width:100%;border:1px solid #dcdce0;border-radius:10px;padding:9px 11px;font-size:14px;color:#111;background:#fff;resize:vertical}",
    ".form input:focus,.form textarea:focus,.inp textarea:focus{outline:none;border-color:var(--d)}",
    ".form .note{font-size:12px;color:#666}.form .note a{color:#666}",
    ".form .err{font-size:12px;color:#b91c1c}.form .err:empty{display:none}",
    ".btn{background:var(--d);color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:600;font-size:14px;cursor:pointer}",
    ".btn:disabled{opacity:.6;cursor:default}",
    ".inp{display:flex;gap:8px;padding:10px;border-top:1px solid #ececef;background:#fff;align-items:flex-end}",
    ".inp textarea{flex:1;border:1px solid #dcdce0;border-radius:12px;padding:9px 11px;font-size:14px;resize:none;max-height:110px;min-height:40px;color:#111;background:#fff}",
    ".send{width:40px;height:40px;flex:none;border-radius:12px;border:0;background:var(--d);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}",
    ".send:disabled{opacity:.5;cursor:default}",
    ".bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;font-size:12px;color:#666;background:#fff;border-top:1px solid #ececef}",
    ".bar[hidden]{display:none}",
    ".bar button{background:none;border:0;color:color-mix(in srgb,var(--a) 70%,#000);font-weight:600;font-size:12px;cursor:pointer;padding:4px}",
    ".pb{text-align:center;font-size:11px;padding:0 0 8px;background:#fff}.pb a{color:#9a9aa3;text-decoration:none}.pb a:hover{color:#555}",
    ".hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}",
    "@media (max-width:480px){.panel{" + side + ":0;bottom:0;width:100%;height:100%;border-radius:0;border:0}.launch.hide{display:none}}"
  ].join("");

  var ICON_CHAT = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_X = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_SEND = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>';
  var logo = cfg.logo
    ? (/^\s*</.test(cfg.logo) ? cfg.logo : '<img alt="" src="' + String(cfg.logo).replace(/"/g, "&quot;") + '">')
    : ICON_CHAT.replace('width="26" height="26"', 'width="18" height="18"');

  var host = document.createElement("div");
  host.id = "productchat";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" + CSS + "</style>" +
    '<button class="launch" type="button" aria-haspopup="dialog" aria-expanded="false"></button>' +
    '<div class="panel" role="dialog" aria-modal="false">' +
      '<div class="head"><div class="logo">' + logo + '</div><div><div class="t"></div><div class="s"><i></i><span></span></div></div><button class="x" type="button"></button></div>' +
      '<div class="log" aria-live="polite"></div>' +
      '<div class="bar" hidden><span></span><button type="button"></button></div>' +
      '<form class="inp"><textarea rows="1"></textarea><button class="send" type="submit"></button></form>' +
      (cfg.poweredBy ? '<div class="pb"><a href="https://github.com/chidhu07/productchat" target="_blank" rel="noopener"></a></div>' : "") +
    "</div>";

  var $ = function (sel) { return root.querySelector(sel); };
  var launch = $(".launch"), panel = $(".panel"), log = $(".log"), form = $(".inp"), input = $(".inp textarea"), sendBtn = $(".send"), bar = $(".bar"), dot;
  launch.innerHTML = ICON_CHAT + '<span class="dot"></span>';
  launch.setAttribute("aria-label", t("open"));
  dot = $(".dot");
  $(".x").innerHTML = ICON_X;
  $(".x").setAttribute("aria-label", t("close"));
  sendBtn.innerHTML = ICON_SEND;
  sendBtn.setAttribute("aria-label", t("send"));
  $(".head .t").textContent = t("title");
  $(".head .s span").textContent = t("subtitle");
  $(".bar span").textContent = t("teamBar");
  $(".bar button").textContent = t("backToBot");
  if ($(".pb a")) $(".pb a").textContent = t("poweredBy");
  panel.setAttribute("aria-label", t("title"));
  if (document.documentElement.dir === "rtl") panel.dir = "rtl";

  var transcript = []; // the bot exchange, sent along if the visitor hands off
  var started = false, pollTimer = null, lastQuestion = "", unreadReply = false;
  var teamMode = false; // true: what the visitor types goes to the team

  function hasConv() { return !!(state.id && state.token); }
  function setPlaceholder() { input.placeholder = teamMode ? t("placeholderHuman") : t("placeholder"); bar.hidden = !teamMode; }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function bubble(kind, content, isHtml) {
    var el = document.createElement("div");
    el.className = "msg " + kind;
    if (kind === "agent") {
      var who = document.createElement("div");
      who.className = "who";
      who.textContent = t("team");
      el.appendChild(who);
      el.appendChild(document.createTextNode(content));
    } else if (isHtml) {
      el.innerHTML = content; // only your own FAQ / knowledge HTML or escaped text
      var links = el.querySelectorAll("a[href^='http']");
      for (var i = 0; i < links.length; i++) { links[i].target = "_blank"; links[i].rel = "noopener"; }
    } else {
      el.textContent = content;
    }
    log.appendChild(el);
    scroll();
    return el;
  }

  function chips(list) {
    var wrap = document.createElement("div");
    wrap.className = "chips";
    list.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (c.human ? " human" : "");
      b.textContent = c.label;
      b.addEventListener("click", function () { wrap.remove(); c.run(); });
      wrap.appendChild(b);
    });
    log.appendChild(wrap);
    scroll();
  }

  function botSay(html, quiet) {
    var el = bubble("bot", html, true);
    if (!quiet) transcript.push({ from: "bot", text: el.textContent.trim() });
  }

  function answer(entry) {
    botSay(entry.a);
    chips([{ label: t("helped"), run: function () { botSay(escapeHtml(t("anythingElse"))); } }, humanChip()]);
  }

  function humanChip() { return { label: t("human"), human: true, run: function () { talkToPerson(lastQuestion); } }; }

  function ask(text) {
    lastQuestion = text;
    bubble("visitor", text);
    transcript.push({ from: "visitor", text: text });
    var low = text.toLowerCase().trim();
    if (/\b(human|person|agent|someone|operator|real people|talk to|speak to|contact (you|support|the team))\b/.test(low)) return talkToPerson("");
    if (/^(hi|hello|hey|hola|yo|good (morning|afternoon|evening))\b[\s!.]*$/.test(low)) return botSay(escapeHtml(t("hello")));
    if (/^(thanks|thank you|thx|ty|cheers|great|ok|okay)\b[\s!.]*$/.test(low)) return botSay(escapeHtml(t("welcome")));

    var found = match(text);
    // "What is <brand>?" has no words left after stopwords: answer with the entry whose id is "about".
    if (!found.length && low.replace(/\s+/g, "").indexOf(cfg.brand.toLowerCase().replace(/\s+/g, "")) !== -1) {
      var about = knowledge().filter(function (e) { return e.id === "about"; })[0];
      if (about) found = [{ entry: about, score: 1 }];
    }
    if (found.length && found[0].score >= 0.34 && (found.length < 2 || found[0].score >= found[1].score * 1.25 || found[0].score >= 0.6)) return answer(found[0].entry);
    if (found.length && found[0].score >= 0.18) {
      botSay(escapeHtml(t("suggest")));
      var opts = found.slice(0, 3).map(function (f) { return { label: f.entry.q, run: function () { bubble("visitor", f.entry.q); answer(f.entry); } }; });
      opts.push(humanChip());
      return chips(opts);
    }
    botSay(escapeHtml(t("notSure")));
    chips([humanChip()]);
  }

  function talkToPerson(question) {
    if (!hasConv()) return handoff(question);
    if (!question) return showThread();
    post("send", { id: state.id, token: state.token, message: question }).then(function (r) {
      if (r._status === 404) { forget(); return handoff(question); }
      if (!r.message) return botSay(escapeHtml(r.error || t("error")));
      showThread(t("sent"));
    }).catch(function () { botSay(escapeHtml(t("error"))); });
  }

  function handoff(question) {
    var card = document.createElement("form");
    card.className = "form";
    card.noValidate = true;
    card.innerHTML =
      "<b></b>" +
      '<textarea rows="3" required maxlength="2000"></textarea>' +
      '<input type="email" required autocomplete="email" maxlength="200">' +
      '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<div class="note"></div><div class="err" role="alert"></div>' +
      '<button class="btn" type="submit"></button>';
    var q = card.querySelector("textarea"), em = card.querySelector('input[type="email"]'), hp = card.querySelector(".hp"),
        err = card.querySelector(".err"), btn = card.querySelector(".btn");
    card.querySelector("b").textContent = t("handoffTitle");
    q.placeholder = t("handoffQ"); q.setAttribute("aria-label", t("handoffQ")); q.value = question || "";
    em.placeholder = t("email"); em.setAttribute("aria-label", t("email")); em.value = state.email || "";
    card.querySelector(".note").innerHTML = escapeHtml(t("emailNote")) +
      (cfg.privacyUrl ? ' <a href="' + escapeHtml(cfg.privacyUrl) + '" target="_blank" rel="noopener">' + escapeHtml(t("privacy")) + "</a>" : "");
    btn.textContent = t("sendTeam");
    card.addEventListener("submit", function (e) {
      e.preventDefault();
      err.textContent = "";
      var message = q.value.trim(), email = em.value.trim();
      if (!message) { err.textContent = t("needQ"); return q.focus(); }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = t("needEmail"); return em.focus(); }
      btn.disabled = true;
      btn.textContent = t("sending");
      var earlier = transcript.filter(function (m) { return !(m.from === "visitor" && m.text === message); });
      post("start", { email: email, message: message, transcript: earlier, page: location.pathname, lang: LANG, website: hp.value })
        .then(function (r) {
          if (!r.id) throw new Error(r.error || "");
          state = { id: r.id, token: r.token, seen: 0, email: email };
          save(state);
          card.remove();
          showThread(t("sent"));
          startPolling();
        })
        .catch(function (e2) {
          btn.disabled = false;
          btn.textContent = t("sendTeam");
          err.textContent = (e2 && e2.message) || t("error");
        });
    });
    log.appendChild(card);
    scroll();
    (question ? em : q).focus();
  }

  /* ---------- conversation with the team ---------- */

  function renderMessages(list) {
    list.forEach(function (m) {
      if (m.sender === "agent") bubble("agent", m.body);
      else if (m.sender === "bot") bubble("bot", escapeHtml(m.body), true);
      else bubble("visitor", m.body);
      if (m.sender === "agent" && +m.id > (state.seen || 0)) state.seen = +m.id;
    });
    unreadReply = false;
  }
  function advance(list) {
    // Postgres returns bigserial ids as strings: compare as numbers ("10" < "9" as text).
    list.forEach(function (m) { if (+m.id > (state.lastId || 0)) state.lastId = +m.id; });
    save(state);
  }

  // Replace the log with the whole conversation; typing now goes to the team.
  function showThread(note) {
    teamMode = true;
    setPlaceholder();
    return post("poll", { id: state.id, token: state.token, after: 0 }).then(function (r) {
      if (r._status === 404) return forget();
      var list = r.messages || [];
      log.innerHTML = "";
      renderMessages(list);
      advance(list);
      if (note) bubble("bot", escapeHtml(note), true);
      chips([{ label: t("newQuestion"), run: toBot }]);
    }).catch(function () {});
  }

  // Back to instant answers; the conversation stays, and team replies still show up.
  function toBot() { teamMode = false; greet(); input.focus(); }

  // The conversation is gone (deleted, or resolved and read): start fresh.
  function forget() {
    state = { email: state.email };
    save(state);
    stopPolling();
    teamMode = false;
    log.innerHTML = "";
    started = false;
    if (panel.classList.contains("open")) greet();
  }

  function poll() {
    if (!hasConv()) return stopPolling();
    post("poll", { id: state.id, token: state.token, after: state.lastId || 0 }).then(function (r) {
      if (r._status === 404) return forget();
      var list = r.messages || [];
      if (!list.length) return;
      var replies = list.filter(function (m) { return m.sender === "agent"; });
      if (!panel.classList.contains("open")) { if (replies.length) dot.classList.add("on"); return; }
      renderMessages(teamMode ? list : replies);
      advance(list);
    }).catch(function () {});
  }

  function startPolling(slow) {
    stopPolling();
    if (hasConv()) pollTimer = setInterval(function () { if (!document.hidden) poll(); }, slow ? 60000 : 8000);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  /* ---------- open / close ---------- */

  function greet() {
    started = true;
    setPlaceholder();
    botSay(escapeHtml(t("greeting")), true);
    var list = knowledge(), picks = [];
    if (cfg.chips) {
      cfg.chips.forEach(function (c) {
        var e = list.filter(function (x) { return x.key === c.match || x.id === c.match || x.q === c.match; })[0];
        if (e) picks.push({ label: c.label || e.q, entry: e });
      });
    } else {
      list.slice(0, 3).forEach(function (e) { picks.push({ label: e.q, entry: e }); });
    }
    var out = picks.map(function (p) {
      return { label: p.label, run: function () { bubble("visitor", p.label); transcript.push({ from: "visitor", text: p.label }); answer(p.entry); } };
    });
    out.push(hasConv() ? { label: t("viewThread"), run: function () { showThread(); } } : humanChip());
    chips(out);
  }

  function open() {
    panel.classList.add("open");
    launch.classList.add("hide");
    launch.setAttribute("aria-expanded", "true");
    dot.classList.remove("on");
    if (!started) {
      started = true;
      // An unread team reply opens the thread; otherwise start at the bot.
      if (unreadReply) showThread(); else greet();
    } else if (hasConv()) poll();
    startPolling();
    setTimeout(function () { input.focus(); }, 50);
  }

  function close() {
    panel.classList.remove("open");
    launch.classList.remove("hide");
    launch.setAttribute("aria-expanded", "false");
    launch.focus();
    startPolling(true);
  }

  launch.addEventListener("click", function () { panel.classList.contains("open") ? close() : open(); });
  $(".x").addEventListener("click", close);
  $(".bar button").addEventListener("click", toBot);
  panel.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  input.addEventListener("input", function () { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 110) + "px"; });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim().slice(0, 2000);
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    if (!teamMode || !hasConv()) return ask(text);
    sendBtn.disabled = true;
    post("send", { id: state.id, token: state.token, message: text }).then(function (r) {
      sendBtn.disabled = false;
      if (r._status === 404) { forget(); return ask(text); }
      if (!r.message) { input.value = text; return botSay(escapeHtml(r.error || t("error"))); }
      renderMessages([r.message]);
      advance([r.message]);
    }).catch(function () { sendBtn.disabled = false; input.value = text; botSay(escapeHtml(t("error"))); });
  });

  function mount() {
    document.body.appendChild(host);
    // Check a past conversation once the page settles: an unread team reply
    // shows a dot (and opens the thread); a resolved, read one is forgotten.
    if (hasConv()) setTimeout(function () {
      post("poll", { id: state.id, token: state.token, after: 0 }).then(function (r) {
        if (r._status === 404) return forget();
        var list = r.messages || [];
        unreadReply = list.some(function (m) { return m.sender === "agent" && +m.id > (state.seen || 0); });
        if (!unreadReply && r.status === "closed") return forget();
        if (!started) advance(list);
        if (unreadReply) dot.classList.add("on");
        if (!panel.classList.contains("open")) startPolling(true);
      }).catch(function () {});
    }, 1500);
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  window.ProductChat = { open: open, close: close, match: match, version: "0.1.0" };
})();
