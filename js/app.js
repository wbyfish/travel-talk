'use strict';

/* =========================================================
   旅遊會話 — offline travel phrase trainer (PWA)
   Data lives in data/<pack>.json; packs are listed in data/packs.json.
   ========================================================= */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- persistent storage ---------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage full or blocked */ }
  },
};

const settings = Object.assign({ pack: 'en-dublin', voiceURI: '', rate: 0.9, hideMe: true }, store.get('settings', {}));
const saveSettings = () => store.set('settings', settings);

let packs = [];
let pack = null;          // current language pack
let sceneById = {};

const favKey = () => `favs:${pack.id}`;
const knownKey = () => `known:${pack.id}`;
let favs = {};            // key -> {type:'s'|'v', en, zh?, scene}
let known = {};           // card key -> true

function loadUserData() {
  favs = store.get(favKey(), {});
  known = store.get(knownKey(), {});
}
const sKey = text => 's:' + text;
const vKey = en => 'v:' + en;
function toggleFav(key, item) {
  if (favs[key]) delete favs[key]; else favs[key] = item;
  store.set(favKey(), favs);
  return !!favs[key];
}

/* ---------- text to speech ---------- */
const tts = {
  voices: [],
  token: 0,
  init() {
    if (!('speechSynthesis' in window)) return;
    const load = () => { this.voices = speechSynthesis.getVoices(); };
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  },
  langVoices() {
    const base = pack.lang.split('-')[0];
    return this.voices.filter(v => v.lang.replace('_', '-').toLowerCase().startsWith(base));
  },
  pick() {
    const list = this.langVoices();
    if (settings.voiceURI) {
      const v = list.find(v => v.voiceURI === settings.voiceURI);
      if (v) return v;
    }
    const want = pack.lang.toLowerCase();
    return list.find(v => v.lang.replace('_', '-').toLowerCase() === want)
      || list.find(v => /en-gb/i.test(v.lang.replace('_', '-')))
      || list[0] || null;
  },
  stop() {
    this.token++;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  },
  // Resolves true when finished, false when interrupted by another speak/stop.
  speak(text, rate = settings.rate) {
    this.stop();
    const my = this.token;
    return new Promise(resolve => {
      if (!('speechSynthesis' in window)) return resolve(false);
      const u = new SpeechSynthesisUtterance(text.replace(/\.\.\.|…/g, ', '));
      u.lang = pack.lang;
      const v = this.pick();
      if (v) u.voice = v;
      u.rate = rate;
      const done = ok => resolve(ok && my === this.token);
      u.onend = () => done(true);
      u.onerror = () => done(false);
      speechSynthesis.speak(u);
    });
  },
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------- recorder ---------- */
const recordings = new Map(); // text -> object URL (kept for this session only)
const recorder = {
  rec: null, stream: null, chunks: [],
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ['audio/mp4', 'audio/webm', 'audio/aac'].find(t => window.MediaRecorder?.isTypeSupported?.(t));
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.rec.start();
  },
  stop() {
    return new Promise(resolve => {
      if (!this.rec) return resolve(null);
      this.rec.onstop = () => {
        // Release the mic so iOS routes speech back to the loudspeaker.
        this.stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(this.chunks, { type: this.rec.mimeType || 'audio/mp4' });
        this.rec = null; this.stream = null;
        resolve(URL.createObjectURL(blob));
      };
      this.rec.stop();
    });
  },
  get active() { return !!this.rec; },
};
function playUrl(url) {
  return new Promise(resolve => {
    const a = new Audio(url);
    a.onended = () => resolve(true);
    a.onerror = () => resolve(false);
    a.play().catch(() => resolve(false));
  });
}

/* ---------- overlays ---------- */
const overlay = $('#overlay');
function closeOverlay() {
  if (recorder.active) recorder.stop();
  overlay.hidden = true;
  overlay.innerHTML = '';
}
overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });

function showBig(text) {
  tts.stop();
  const el = document.createElement('div');
  el.className = 'show-big';
  el.innerHTML = `<div>${esc(text)}</div><small>點一下關閉</small>`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}

function openRecorder(text) {
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet">
      <div class="say">${esc(text)}</div>
      <div class="rec-btns" style="grid-template-columns:repeat(4,1fr)">
        <button data-a="orig"><span>🔊</span>原音</button>
        <button data-a="rec"><span>🎙️</span>錄音</button>
        <button data-a="mine"><span>▶️</span>我的</button>
        <button data-a="both"><span>🔁</span>對比</button>
      </div>
      <div class="msg-err" hidden></div>
      <button class="close">完成</button>
    </div>`;
  const sheet = $('.sheet', overlay);
  const recBtn = $('[data-a=rec]', sheet);
  const mineBtns = [$('[data-a=mine]', sheet), $('[data-a=both]', sheet)];
  const err = $('.msg-err', sheet);
  const sync = () => mineBtns.forEach(b => (b.disabled = !recordings.has(text)));
  sync();

  sheet.addEventListener('click', async e => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    err.hidden = true;
    if (a === 'orig') tts.speak(text);
    if (a === 'mine') { tts.stop(); playUrl(recordings.get(text)); }
    if (a === 'both') { if (await tts.speak(text)) { await wait(300); playUrl(recordings.get(text)); } }
    if (a === 'rec') {
      if (recorder.active) {
        const url = await recorder.stop();
        recBtn.classList.remove('recording');
        recBtn.innerHTML = '<span>🎙️</span>重錄';
        if (url) {
          if (recordings.has(text)) URL.revokeObjectURL(recordings.get(text));
          recordings.set(text, url);
          sync();
          playUrl(url);
        }
      } else {
        tts.stop();
        try {
          await recorder.start();
          recBtn.classList.add('recording');
          recBtn.innerHTML = '<span>⏹️</span>停止';
        } catch {
          err.textContent = '無法使用麥克風。請到 iPhone 設定 → Safari → 麥克風，允許使用。';
          err.hidden = false;
        }
      }
    }
  });
  $('.close', sheet).onclick = closeOverlay;
}

/* ---------- layout chrome ---------- */
function setChrome({ title, back = false, tab = null, right = '' }) {
  $('#title').textContent = title;
  $('#back').hidden = !back;
  $('#top-right').innerHTML = right;
  document.querySelectorAll('#tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
}
$('#back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));

/* ---------- views ---------- */
const view = $('#view');

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

let homeQuery = '';
function renderHome() {
  setChrome({ title: `我的旅遊會話・${pack.name}`, tab: 'home' });
  view.innerHTML = `
    <input class="search" type="search" placeholder="搜尋句子、單字、情境…" value="${esc(homeQuery)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <div id="home-body"></div>`;
  const input = $('.search', view);
  input.addEventListener('input', () => { homeQuery = input.value; renderHomeBody(); });
  renderHomeBody();
}

function renderHomeBody() {
  const body = $('#home-body');
  const q = homeQuery.trim();
  if (!q) {
    body.innerHTML = pack.categories.map(cat => {
      const scenes = pack.scenes.filter(s => s.cat === cat.id);
      if (!scenes.length) return '';
      return `<div class="cat-title">${cat.icon} ${esc(cat.name)}</div>
        <div class="list">${scenes.map(s => `
          <a class="row" href="#/scene/${s.id}">
            <div class="main"><div class="zh">${esc(s.zh)}</div><div class="en">${esc(s.title)}</div></div>
            <span class="badge">${s.sentences.length} 句</span><span class="chev">›</span>
          </a>`).join('')}</div>`;
    }).join('');
    return;
  }
  const ql = q.toLowerCase();
  const hits = [];
  const seen = new Set();
  const add = (text, scene, tab, extra = '') => {
    const k = text + '|' + scene.id;
    if (seen.has(k)) return;
    seen.add(k);
    hits.push({ text, scene, tab, extra });
  };
  for (const s of pack.scenes) {
    if (s.zh.toLowerCase().includes(ql) || s.title.toLowerCase().includes(ql)) add(s.title, s, 'talk', s.zh);
    s.sentences.forEach(t => t.toLowerCase().includes(ql) && add(t, s, 'say'));
    s.vocab.forEach(([en, zh]) => (en.toLowerCase().includes(ql) || zh.includes(q)) && add(en, s, 'words', zh));
    s.parts.forEach(p => p.lines.forEach(([, t]) => t.toLowerCase().includes(ql) && add(t, s, 'talk')));
  }
  body.innerHTML = hits.length
    ? `<div class="cat-title">${hits.length} 筆結果</div><div class="list">${hits.slice(0, 80).map(h => `
        <div class="hit row">
          <a class="main" href="#/scene/${h.scene.id}/${h.tab}">
            <div>${highlight(h.text, q)}${h.extra ? ` <span style="color:var(--muted)">· ${highlight(h.extra, q)}</span>` : ''}</div>
            <div class="src">${esc(h.scene.zh)}</div>
          </a>
          <button class="pill" data-say="${esc(h.text)}">🔊</button>
        </div>`).join('')}</div>`
    : `<div class="empty">找不到「${esc(q)}」</div>`;
  body.querySelectorAll('[data-say]').forEach(b => (b.onclick = () => tts.speak(b.dataset.say)));
}

/* ----- scene ----- */
const TABS = [['talk', '對話'], ['say', '句子'], ['words', '單字'], ['notes', '用法']];

function renderScene(id, tab = 'talk') {
  const s = sceneById[id];
  if (!s) return (location.hash = '#/');
  setChrome({ title: s.zh, back: true, tab: 'home' });
  const tabs = TABS.filter(([k]) => k !== 'notes' || s.notes.length);
  if (!tabs.some(([k]) => k === tab)) tab = 'talk';
  view.innerHTML = `
    <div class="desc"><b>${esc(s.title)}</b><br>${esc(s.desc)}</div>
    <div class="seg">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div id="tab-body"></div>`;
  view.querySelectorAll('.seg button').forEach(b => (b.onclick = () => {
    history.replaceState(null, '', `#/scene/${id}/${b.dataset.tab}`);
    tts.stop();
    view.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    renderSceneTab(s, b.dataset.tab);
  }));
  renderSceneTab(s, tab);
}

function renderSceneTab(s, tab) {
  const body = $('#tab-body');
  ({ talk: renderTalk, say: renderSay, words: renderWords, notes: renderNotes })[tab](s, body);
}

function renderTalk(s, body) {
  const lines = [];
  s.parts.forEach((p, pi) => p.lines.forEach(([who, text]) => lines.push({ who, text, pi, me: who === pack.me })));
  let roleplay = false;
  let running = false;

  body.innerHTML = `
    <div class="toolbar">
      <button class="pill big" data-act="play">▶️ 播放全部</button>
      <button class="pill big" data-act="role">🎭 角色扮演</button>
    </div>
    <div class="chat">${lines.map((l, i) => {
      const head = (i === 0 || lines[i - 1].pi !== l.pi) && s.parts[l.pi].title
        ? `<div class="part-title">${esc(s.parts[l.pi].title)}</div>` : '';
      return head + `
        <div class="msg ${l.me ? 'me' : ''}" data-i="${i}">
          <div class="who">${esc(l.who)}</div>
          <div class="bubble">${esc(l.text)}</div>
          ${l.me ? `<div class="acts">
            <button data-act="rec" title="錄音比對">🎙️</button>
            <button data-act="big" title="放大給對方看">⛶</button>
            <button data-act="fav" class="star ${favs[sKey(l.text)] ? 'on' : ''}" title="收藏">⭐</button>
          </div>` : ''}
        </div>`;
    }).join('')}</div>`;

  const msgs = [...body.querySelectorAll('.msg')];
  const playBtn = $('[data-act=play]', body);
  const roleBtn = $('[data-act=role]', body);

  const mark = i => msgs.forEach((m, j) => m.classList.toggle('speaking', j === i));
  const setRunning = on => {
    running = on;
    playBtn.innerHTML = on ? '⏹️ 停止' : '▶️ 播放全部';
    if (!on) mark(-1);
  };
  const setHidden = on => msgs.forEach((m, i) => lines[i].me && m.classList.toggle('hidden', on));

  async function runFrom(i) {
    setRunning(true);
    for (; i < lines.length; i++) {
      const m = msgs[i];
      if (roleplay && m.classList.contains('hidden')) {
        // Your turn: pause until the bubble is tapped.
        mark(i);
        m.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      mark(i);
      m.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (!(await tts.speak(lines[i].text))) return;   // interrupted
      await wait(350);
      if (!running) return;
    }
    setRunning(false);
  }

  playBtn.onclick = () => {
    if (running) { tts.stop(); setRunning(false); return; }
    if (roleplay) setHidden(true);
    runFrom(0);
  };
  roleBtn.onclick = () => {
    roleplay = !roleplay;
    roleBtn.classList.toggle('on', roleplay);
    tts.stop();
    setRunning(false);
    setHidden(roleplay);
    if (roleplay) runFrom(0);
  };

  body.querySelector('.chat').addEventListener('click', async e => {
    const m = e.target.closest('.msg');
    if (!m) return;
    const i = +m.dataset.i;
    const act = e.target.closest('button')?.dataset.act;
    const text = lines[i].text;
    if (act === 'rec') return openRecorder(text);
    if (act === 'big') return showBig(text);
    if (act === 'fav') {
      e.target.classList.toggle('on', toggleFav(sKey(text), { type: 's', en: text, scene: s.id }));
      return;
    }
    if (!e.target.closest('.bubble')) return;
    if (m.classList.contains('hidden')) {
      // Reveal your line, say it, then continue the role play.
      m.classList.remove('hidden');
      const wasRunning = running;
      mark(i);
      const ok = await tts.speak(text);
      if (ok && wasRunning && running) { await wait(350); runFrom(i + 1); }
      else mark(-1);
      return;
    }
    setRunning(false);
    mark(i);
    await tts.speak(text);
    mark(-1);
  });
}

function sentenceRow(text, sceneId, sub = '') {
  return `
    <div class="sent" data-text="${esc(text)}" data-scene="${sceneId}">
      <div class="txt">${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      <div class="acts-col">
        <button data-act="rec">🎙️</button>
        <button data-act="big">⛶</button>
        <button data-act="fav" class="star ${favs[sKey(text)] ? 'on' : ''}">⭐</button>
      </div>
    </div>`;
}
function bindSentences(root) {
  root.addEventListener('click', e => {
    const row = e.target.closest('.sent');
    if (!row) return;
    const text = row.dataset.text;
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'rec') return openRecorder(text);
    if (act === 'big') return showBig(text);
    if (act === 'fav') {
      e.target.classList.toggle('on', toggleFav(sKey(text), { type: 's', en: text, scene: row.dataset.scene }));
      return;
    }
    tts.speak(text);
  });
}

function renderSay(s, body) {
  body.innerHTML = `<div class="list">${s.sentences.map(t => sentenceRow(t, s.id)).join('')}</div>
    <p class="help">點句子聽發音・🎙️ 錄音跟原音比對・⛶ 放大給對方看・⭐ 收藏</p>`;
  bindSentences(body);
}

function vocabRow(en, zh, sceneId) {
  return `<div class="vrow" data-en="${esc(en)}" data-zh="${esc(zh)}" data-scene="${sceneId}">
      <span class="en">${esc(en)}</span><span class="zh">${esc(zh)}</span>
      <button data-act="fav" class="star ${favs[vKey(en)] ? 'on' : ''}" style="border:0;background:none;font-size:16px">⭐</button>
    </div>`;
}
function bindVocab(root) {
  root.addEventListener('click', e => {
    const row = e.target.closest('.vrow');
    if (!row) return;
    const { en, zh, scene } = row.dataset;
    if (e.target.closest('[data-act=fav]')) {
      e.target.classList.toggle('on', toggleFav(vKey(en), { type: 'v', en, zh, scene }));
      return;
    }
    row.classList.toggle('peek');
    tts.speak(en);
  });
}

function renderWords(s, body) {
  body.innerHTML = `
    <div class="toolbar"><button class="pill" data-act="hide">🙈 遮住中文</button>
      <a class="pill" href="#/cards/scene:${s.id}">🃏 用單字卡練習</a></div>
    <div class="list vocab">${s.vocab.map(([en, zh]) => vocabRow(en, zh, s.id)).join('')}</div>`;
  const list = $('.vocab', body);
  $('[data-act=hide]', body).onclick = e => {
    const on = list.classList.toggle('hide-zh');
    e.currentTarget.classList.toggle('on', on);
    list.querySelectorAll('.peek').forEach(r => r.classList.remove('peek'));
  };
  bindVocab(list);
}

function renderNotes(s, body) {
  body.innerHTML = `<div class="list">${s.notes.map(([h, p]) => `
    <div class="note"><b>${esc(h)}</b><p>${esc(p)}</p></div>`).join('')}</div>`;
}

/* ----- flashcards ----- */
function deckCards(deck) {
  const [kind, arg] = deck.split(':');
  const scenes = arg && kind !== 'scene' ? pack.scenes.filter(s => s.cat === arg) : pack.scenes;
  const vocab = list => list.flatMap(s => s.vocab.map(([en, zh]) => ({ key: 'v:' + en, type: 'v', en, zh, scene: s })));
  const sents = list => list.flatMap(s => s.sentences.map(en => ({ key: 's:' + en, type: 's', en, scene: s })));
  let cards;
  if (kind === 'scene') cards = vocab([sceneById[arg]]);
  else if (kind === 'vocab') cards = vocab(scenes);
  else if (kind === 'listen') cards = sents(scenes);
  else if (kind === 'favs') cards = Object.values(favs).map(f => ({ key: f.type + ':' + f.en, type: f.type, en: f.en, zh: f.zh, scene: sceneById[f.scene] }));
  else cards = [];
  // Same word may appear in several scenes; keep the first.
  const seen = new Set();
  return cards.filter(c => !seen.has(c.key) && seen.add(c.key));
}

function renderDecks() {
  setChrome({ title: '練習', tab: 'cards' });
  const count = deck => {
    const cards = deckCards(deck);
    const left = cards.filter(c => !known[c.key]).length;
    return `<span class="badge">${left} / ${cards.length}</span>`;
  };
  const row = (deck, zh, en) => `<a class="row" href="#/cards/${deck}"><div class="main"><div class="zh">${zh}</div>${en ? `<div class="en">${en}</div>` : ''}</div>${count(deck)}<span class="chev">›</span></a>`;
  view.innerHTML = `
    <div class="cat-title">🃏 單字卡（看英文 → 想中文）</div>
    <div class="list">
      ${row('vocab', '全部單字')}
      ${pack.categories.map(c => row('vocab:' + c.id, `${c.icon} ${esc(c.name)}`)).join('')}
    </div>
    <div class="cat-title">👂 聽力跟讀（先聽 → 跟著說 → 看答案）</div>
    <div class="list">
      ${row('listen', '全部句子')}
      ${pack.categories.map(c => row('listen:' + c.id, `${c.icon} ${esc(c.name)}`)).join('')}
    </div>
    <div class="cat-title">⭐ 收藏</div>
    <div class="list">${row('favs', '我的收藏', '收藏的句子和單字')}</div>
    <p class="help">右邊數字＝還沒記住／全部。按「記得」的卡片下次就不會出現。</p>`;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function renderCards(deck) {
  const all = deckCards(deck);
  const title = deck.startsWith('scene:') ? sceneById[deck.slice(6)]?.zh + ' 單字' : deck.startsWith('listen') ? '聽力跟讀' : deck === 'favs' ? '我的收藏' : '單字卡';
  setChrome({ title, back: true, tab: 'cards' });
  let queue = shuffle(all.filter(c => !known[c.key]));
  const total = queue.length;
  let done = 0;

  const finish = () => {
    view.innerHTML = `<div class="empty">${all.length ? '🎉 全部記住了！' : '這裡還沒有卡片。'}<br><br>
      ${all.length ? '<button class="pill big" data-act="reset">↺ 重新練習這一組</button>' : ''}</div>`;
    const r = $('[data-act=reset]', view);
    if (r) r.onclick = () => { all.forEach(c => delete known[c.key]); store.set(knownKey(), known); renderCards(deck); };
  };

  const show = () => {
    if (!queue.length) return finish();
    const c = queue[0];
    const listen = c.type === 's';
    view.innerHTML = `
      <div class="card-stage">
        <div class="progress">已記住 ${done} / ${total}　・　剩 ${queue.length} 張</div>
        <div class="flash">
          ${listen
            ? `<div class="front sentence" style="color:var(--muted)">🔊 聽完跟著說一次</div><div class="hint">點卡片看句子</div>`
            : `<div class="front">${esc(c.en)}</div><div class="hint">點卡片看中文</div>`}
        </div>
        <div class="toolbar" style="justify-content:center">
          <button class="pill" data-act="say">🔊 再聽一次</button>
          <button class="pill" data-act="slow">🐢 慢速</button>
          ${listen ? '<button class="pill" data-act="rec">🎙️ 錄音</button>' : ''}
        </div>
        <div class="grade"><button class="no">😵 不熟</button><button class="yes">👍 記得</button></div>
      </div>`;
    const flash = $('.flash', view);
    flash.onclick = () => {
      flash.innerHTML = listen
        ? `<div class="front sentence">${esc(c.en)}</div><div class="src">${esc(c.scene?.zh || '')}</div>`
        : `<div class="front">${esc(c.en)}</div><div class="back">${esc(c.zh || '')}</div><div class="src">${esc(c.scene?.zh || '')}</div>`;
    };
    $('[data-act=say]', view).onclick = () => tts.speak(c.en);
    $('[data-act=slow]', view).onclick = () => tts.speak(c.en, 0.6);
    const rec = $('[data-act=rec]', view);
    if (rec) rec.onclick = () => openRecorder(c.en);
    $('.no', view).onclick = () => { queue.push(queue.shift()); show(); };
    $('.yes', view).onclick = () => {
      known[c.key] = true; store.set(knownKey(), known);
      queue.shift(); done++; show();
    };
    tts.speak(c.en);
  };
  show();
}

/* ----- favourites ----- */
function renderFavs() {
  setChrome({ title: '收藏', tab: 'favs' });
  const items = Object.values(favs);
  const sents = items.filter(f => f.type === 's');
  const words = items.filter(f => f.type === 'v');
  if (!items.length) {
    view.innerHTML = `<div class="empty">還沒有收藏。<br>在句子或單字旁邊點 ⭐ 就會出現在這裡，<br>到當地可以直接打開來用。</div>`;
    return;
  }
  view.innerHTML = `
    ${sents.length ? `<div class="cat-title">句子（${sents.length}）</div>
      <div class="list" id="fav-s">${sents.map(f => sentenceRow(f.en, f.scene, sceneById[f.scene]?.zh)).join('')}</div>` : ''}
    ${words.length ? `<div class="cat-title">單字（${words.length}）</div>
      <div class="list vocab" id="fav-v">${words.map(f => vocabRow(f.en, f.zh, f.scene)).join('')}</div>` : ''}
    <div class="toolbar" style="margin-top:16px"><a class="pill" href="#/cards/favs">🃏 練習收藏</a></div>`;
  const fs = $('#fav-s'), fv = $('#fav-v');
  if (fs) bindSentences(fs);
  if (fv) bindVocab(fv);
}

/* ----- settings ----- */
function renderSettings() {
  setChrome({ title: '設定', tab: 'settings' });
  const voices = tts.langVoices();
  const current = tts.pick();
  view.innerHTML = `
    <div class="cat-title">語言</div>
    <div class="list"><div class="field">
      <label>會話包</label>
      <select id="pack">${packs.map(p => `<option value="${p.id}" ${p.id === pack.id ? 'selected' : ''}>${p.flag} ${esc(p.name)}</option>`).join('')}</select>
    </div></div>

    <div class="cat-title">發音</div>
    <div class="list">
      <div class="field">
        <label>聲音（推薦 en-IE 愛爾蘭口音）</label>
        <select id="voice">${voices.length
          ? voices.map(v => `<option value="${esc(v.voiceURI)}" ${current && v.voiceURI === current.voiceURI ? 'selected' : ''}>${esc(v.name)} — ${esc(v.lang)}</option>`).join('')
          : '<option>（找不到語音，重新整理再試）</option>'}</select>
      </div>
      <div class="field">
        <label>語速：<span id="rate-v">${settings.rate.toFixed(2)}</span></label>
        <input id="rate" type="range" min="0.5" max="1.2" step="0.05" value="${settings.rate}">
      </div>
      <div class="field"><button class="pill" id="test">🔊 試聽</button></div>
    </div>
    <div class="help">
      <b>想要更自然的愛爾蘭口音？</b>
      <ol>
        <li>iPhone 設定 → 輔助使用 → 朗讀內容 → 聲音 → 英文</li>
        <li>找「英文（愛爾蘭）」→ 下載 Moira（加強版音質）</li>
        <li>回到這裡重新打開 app，選 Moira</li>
      </ol>
    </div>

    <div class="cat-title">學習紀錄</div>
    <div class="list"><div class="field"><button class="pill" id="reset">↺ 清除「已記住」的卡片紀錄</button></div></div>

    <div class="cat-title">安裝到主畫面</div>
    <div class="help">用 Safari 打開這個網頁 → 下方「分享」按鈕 → 「加入主畫面」。之後從主畫面打開，沒有網路也能用。</div>`;

  $('#pack').onchange = async e => { settings.pack = e.target.value; settings.voiceURI = ''; saveSettings(); await loadPack(); location.hash = '#/'; };
  $('#voice').onchange = e => { settings.voiceURI = e.target.value; saveSettings(); tts.speak('Hello! Welcome to Dublin.'); };
  $('#rate').oninput = e => { settings.rate = +e.target.value; $('#rate-v').textContent = settings.rate.toFixed(2); saveSettings(); };
  $('#test').onclick = () => tts.speak('Hi there! What can I get for you?');
  $('#reset').onclick = () => { if (confirm('確定要清除所有「已記住」紀錄嗎？')) { known = {}; store.set(knownKey(), known); } };
}

/* ---------- router ---------- */
function route() {
  tts.stop();
  closeOverlay();
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const [page, a, b] = parts;
  if (page === 'scene') renderScene(a, b);
  else if (page === 'cards') a ? renderCards(a) : renderDecks();
  else if (page === 'favs') renderFavs();
  else if (page === 'settings') renderSettings();
  else renderHome();
  if (page !== 'scene' || !b) window.scrollTo(0, 0);
}

async function loadPack() {
  const meta = packs.find(p => p.id === settings.pack) || packs[0];
  pack = await (await fetch(meta.file)).json();
  sceneById = Object.fromEntries(pack.scenes.map(s => [s.id, s]));
  document.documentElement.lang = pack.lang;
  loadUserData();
}

async function boot() {
  tts.init();
  try {
    packs = await (await fetch('data/packs.json')).json();
    await loadPack();
  } catch (err) {
    view.innerHTML = `<div class="empty">資料載入失敗：${esc(err.message)}</div>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.();
}
boot();
