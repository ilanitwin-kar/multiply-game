/**
 * הגנת פיירוול — מצב משחק נפרד (מכפיל לפי מעבד / טבלה).
 */
(function (global) {
  "use strict";

  const MULT_MAX = 12;
  const LIVES_MAX = 3;
  const QUESTIONS_PER_SESSION = 20;
  const FW_STORAGE = "multiply_game_firewall_v1";

  const FALL_BASE = 88;
  const FALL_MAX = 210;
  const FALL_PER_10_SCORE = 9;

  const GATE_Y_RATIO = 0.52;
  const DANGER_FLOOR_RATIO = 0.88;
  const STREAM_CHAR_COUNT = 32;
  const HEAD_ZONE_PX = 52;
  const MATRIX_CHARS = "01アイウエオカキクケコ0123456789ABCDEFｱｲｳｴｵ";

  let gameActive = false;
  let paused = false;
  let tableNum = 0;
  let lives = LIVES_MAX;
  let score = 0;
  let questionsDone = 0;
  let spawnTimeoutId = null;
  let rafId = null;
  let matrixRafId = null;
  let lastTs = 0;
  let drops = [];
  let activeDropId = null;
  let lockedChoice = false;
  let onExitCb = null;
  let lastStartOptions = null;
  let audioCtx = null;
  let matrixCanvas = null;
  let matrixCtx = null;
  let matrixColumns = [];

  function $(id) {
    return document.getElementById(id);
  }

  function rnd(a, b) {
    return Math.floor(Math.random() * (b - a + 1)) + a;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rnd(0, i);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function wrongAnswers(correct) {
    const set = new Set();
    if (correct === 0) {
      let v = 1;
      while (set.size < 3) set.add(v++);
      return Array.from(set);
    }
    while (set.size < 3) {
      const delta = rnd(-8, 8);
      if (delta === 0) continue;
      const v = correct + delta;
      if (v >= 0 && v !== correct) set.add(v);
    }
    return Array.from(set).slice(0, 3);
  }

  function loadHighscores() {
    try {
      const raw = localStorage.getItem(FW_STORAGE);
      if (!raw) return {};
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : {};
    } catch (_) {
      return {};
    }
  }

  function getHighScore(table) {
    const h = loadHighscores();
    return Number(h[String(table)]) || 0;
  }

  function saveHighScore(table, val) {
    const key = String(table);
    const prev = getHighScore(table);
    if (val <= prev) return false;
    const h = loadHighscores();
    h[key] = val;
    localStorage.setItem(FW_STORAGE, JSON.stringify(h));
    return true;
  }

  function getFallSpeed() {
    const bonus = Math.floor(score / 10) * FALL_PER_10_SCORE;
    return Math.min(FALL_MAX, FALL_BASE + bonus);
  }

  function questionsLeft() {
    return Math.max(0, QUESTIONS_PER_SESSION - questionsDone);
  }

  function hasLiveDrop() {
    return drops.some((d) => !d.resolved);
  }

  function clearSpawnSchedule() {
    if (spawnTimeoutId) {
      clearTimeout(spawnTimeoutId);
      spawnTimeoutId = null;
    }
  }

  function scheduleNextDrop(overrideMs) {
    clearSpawnSchedule();
    if (!gameActive || paused || questionsLeft() <= 0 || hasLiveDrop()) return;
    const gap =
      typeof overrideMs === "number"
        ? overrideMs
        : Math.max(220, 520 - Math.floor(score / 15) * 35);
    spawnTimeoutId = setTimeout(() => {
      spawnTimeoutId = null;
      spawnDrop();
    }, gap);
  }

  function arenaHeight() {
    const arena = $("fw-arena");
    return arena ? arena.clientHeight : 400;
  }

  function gateY() {
    const gate = $("fw-gate");
    const arena = $("fw-arena");
    if (gate && arena) {
      const ar = arena.getBoundingClientRect();
      const gr = gate.getBoundingClientRect();
      return gr.top - ar.top + gr.height * 0.5;
    }
    return arenaHeight() * GATE_Y_RATIO;
  }

  function dangerY() {
    return arenaHeight() * DANGER_FLOOR_RATIO;
  }

  function randomMatrixChar() {
    return MATRIX_CHARS[rnd(0, MATRIX_CHARS.length - 1)];
  }

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    return audioCtx;
  }

  function playTone(freq, duration, type, volume) {
    try {
      const ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || "square";
      osc.frequency.value = freq;
      gain.gain.value = volume || 0.07;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime;
      osc.start(t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
      osc.stop(t0 + duration + 0.02);
    } catch (_) {}
  }

  function sfxBlock() {
    playTone(520, 0.06, "sine", 0.05);
    playTone(1040, 0.1, "sine", 0.06);
  }

  function sfxHit() {
    playTone(140, 0.18, "sawtooth", 0.08);
    playTone(90, 0.22, "square", 0.05);
  }

  function vibrateBlock() {
    if (navigator.vibrate) navigator.vibrate(14);
  }

  function vibrateHit() {
    if (navigator.vibrate) navigator.vibrate([35, 40, 35]);
  }

  function updateShields() {
    const row = $("fw-shields");
    if (!row) return;
    row.querySelectorAll(".fw-shield").forEach((el, i) => {
      const alive = i < lives;
      el.classList.toggle("fw-shield--on", alive);
      el.classList.toggle("fw-shield--lost", !alive);
    });
  }

  function updateHud() {
    const scoreEl = $("fw-score");
    const tableEl = $("fw-table-label");
    const highEl = $("fw-high-score");
    const speedEl = $("fw-speed-tier");
    const qCur = $("fw-q-cur");
    const qTotal = $("fw-q-total");
    const qLeft = $("fw-q-left");
    const progFill = $("fw-progress-fill");
    const progLabel = $("fw-progress-label");
    const progBar = $("fw-progress");

    const left = questionsLeft();
    const cur = Math.min(questionsDone + (hasLiveDrop() ? 1 : 0), QUESTIONS_PER_SESSION);
    const pct = Math.round((questionsDone / QUESTIONS_PER_SESSION) * 100);

    if (scoreEl) scoreEl.textContent = String(score);
    if (tableEl) tableEl.textContent = "מעבד " + tableNum;
    if (highEl) highEl.textContent = String(getHighScore(tableNum));
    if (speedEl) {
      const sp = Math.round(((getFallSpeed() / FALL_BASE) - 1) * 100);
      speedEl.textContent = sp > 0 ? "+" + sp + "%" : "×1";
    }
    if (qCur) qCur.textContent = String(cur || 1);
    if (qTotal) qTotal.textContent = String(QUESTIONS_PER_SESSION);
    if (qLeft) qLeft.textContent = String(left);
    if (progFill) progFill.style.width = pct + "%";
    if (progLabel) progLabel.textContent = pct + "%";
    if (progBar) progBar.setAttribute("aria-valuenow", String(pct));

    const expr = $("fw-gate-expr");
    if (expr) expr.textContent = "× " + tableNum;
    updateShields();
  }

  function screenFlash() {
    const flash = $("fw-screen-flash");
    if (!flash) return;
    flash.classList.remove("fw-screen-flash--hit");
    void flash.offsetWidth;
    flash.classList.add("fw-screen-flash--hit");
    const onEnd = () => {
      flash.classList.remove("fw-screen-flash--hit");
      flash.removeEventListener("animationend", onEnd);
    };
    flash.addEventListener("animationend", onEnd);
  }

  function buildMatrixStreamHtml() {
    let html = "";
    for (let i = 0; i < STREAM_CHAR_COUNT; i++) {
      let tier = "";
      if (i < 4) tier = " fw-mchar--n3";
      else if (i < 9) tier = " fw-mchar--n2";
      else if (i < 14) tier = " fw-mchar--n1";
      const glitch = Math.random() < 0.14 ? " fw-mchar--glitch" : "";
      html += '<span class="fw-mchar' + tier + glitch + '">' + randomMatrixChar() + "</span>";
    }
    return html;
  }

  function flickerStreamChar(drop) {
    if (!drop.streamEl || drop.resolved) return;
    const spans = drop.streamEl.querySelectorAll(".fw-mchar");
    if (!spans.length) return;
    const el = spans[rnd(0, spans.length - 1)];
    el.textContent = randomMatrixChar();
    if (Math.random() < 0.2) el.classList.toggle("fw-mchar--glitch");
  }

  function updateDropVisual(drop) {
    if (!drop.colEl || drop.resolved) return;
    const streamH = Math.max(0, drop.y - HEAD_ZONE_PX);
    if (drop.streamEl) drop.streamEl.style.height = streamH + "px";
    drop.colEl.style.left = drop.leftPct + "%";
    drop.colEl.style.top = drop.y + "px";
    drop.colEl.style.transform = "translate(-50%, -100%)";
    if (Math.random() < 0.08) flickerStreamChar(drop);
  }

  function removeDropEl(drop, failClass) {
    clearDropGlitch(drop);
    if (drop.colEl) {
      drop.colEl.classList.add("fw-drop-col--exit");
      if (failClass) drop.colEl.classList.add(failClass);
      const el = drop.colEl;
      setTimeout(() => el && el.remove(), failClass ? 200 : 80);
      drop.colEl = null;
      drop.streamEl = null;
      drop.headEl = null;
      drop.beamEl = null;
    }
  }

  function renderDropEl(drop) {
    const layer = $("fw-drops");
    if (!layer) return;

    const col = document.createElement("div");
    col.className = "fw-drop-col";
    col.dataset.id = drop.id;

    const stream = document.createElement("div");
    stream.className = "fw-matrix-stream";
    stream.innerHTML = buildMatrixStreamHtml();

    const headWrap = document.createElement("div");
    headWrap.className = "fw-drop-head-wrap";

    const beam = document.createElement("span");
    beam.className = "fw-drop-beam";
    beam.setAttribute("aria-hidden", "true");

    const head = document.createElement("span");
    head.className = "fw-drop-head math-ltr";
    head.textContent = String(drop.factor);

    headWrap.appendChild(beam);
    headWrap.appendChild(head);
    col.appendChild(stream);
    col.appendChild(headWrap);
    layer.appendChild(col);

    drop.colEl = col;
    drop.streamEl = stream;
    drop.headEl = head;
    drop.beamEl = beam;
    drop.leftPct = rnd(14, 86);
    updateDropVisual(drop);

    drop.glitchTimer = setInterval(() => {
      if (!drop.colEl || drop.resolved || !gameActive || paused) return;
      if (Math.random() < 0.55) flickerStreamChar(drop);
    }, rnd(90, 160));
  }

  function clearDropGlitch(drop) {
    if (drop.glitchTimer) {
      clearInterval(drop.glitchTimer);
      drop.glitchTimer = null;
    }
  }

  function spawnDrop() {
    if (!gameActive || paused || questionsLeft() <= 0 || hasLiveDrop()) return;

    const factor = rnd(0, MULT_MAX);
    const correct = factor * tableNum;
    const id = "d" + Date.now() + "-" + rnd(0, 9999);
    const drop = {
      id,
      factor,
      correct,
      y: 8,
      colEl: null,
      streamEl: null,
      headEl: null,
      beamEl: null,
      leftPct: 0,
      resolved: false,
      glitchTimer: null,
    };
    drops.push(drop);
    renderDropEl(drop);
    setActiveDrop(id);
    updateHud();
  }

  function setActiveDrop(id) {
    if (!gameActive || paused) return;
    activeDropId = id;
    const drop = drops.find((d) => d.id === id && !d.resolved);
    if (!drop) {
      activeDropId = null;
      renderChoices(null);
      return;
    }
    renderChoices(drop);
    drops.forEach((d) => {
      if (!d.colEl) return;
      d.colEl.classList.toggle("fw-drop-col--active", d.id === id);
    });
  }

  function renderChoices(drop) {
    const host = $("fw-choices");
    if (!host) return;
    host.innerHTML = "";
    lockedChoice = false;
    if (!drop || !gameActive || paused) return;

    const opts = shuffle([drop.correct].concat(wrongAnswers(drop.correct)));
    opts.forEach((val) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fw-choice math-ltr";
      btn.textContent = String(val);
      btn.disabled = paused;
      btn.addEventListener("click", () => onChoice(drop, val, btn));
      host.appendChild(btn);
    });
  }

  function onChoice(drop, val, btn) {
    if (!gameActive || paused || lockedChoice || drop.resolved || drop.id !== activeDropId) return;
    lockedChoice = true;
    if (val === drop.correct) {
      btn.classList.add("fw-choice--ok");
      finishQuestion(drop, true);
    } else {
      btn.classList.add("fw-choice--bad");
      loseLife();
      finishQuestion(drop, false);
    }
  }

  function finishQuestion(drop, success) {
    drop.resolved = true;
    removeDropEl(drop, success ? null : "fw-drop-col--fail");
    drops = drops.filter((d) => d.id !== drop.id);
    activeDropId = null;
    renderChoices(null);

    if (success) {
      score += 10;
      flashGate("block");
    }

    questionsDone += 1;
    updateHud();

    if (lives <= 0) return;

    if (questionsDone >= QUESTIONS_PER_SESSION) {
      endVictory();
      return;
    }

    if (gameActive && !paused) scheduleNextDrop(success ? 280 : 420);
  }

  function handleDropDanger(drop) {
    if (drop.resolved || !gameActive || paused) return;
    drop.resolved = true;
    removeDropEl(drop, "fw-drop-col--fail");
    drops = drops.filter((d) => d.id !== drop.id);
    activeDropId = null;
    renderChoices(null);
    loseLife();
    if (!gameActive || lives <= 0) return;
    questionsDone += 1;
    updateHud();
    if (questionsDone >= QUESTIONS_PER_SESSION) {
      endVictory();
      return;
    }
    scheduleNextDrop(450);
  }

  function flashGate(kind) {
    const gate = $("fw-gate");
    const slot = $("fw-gate-slot");
    if (!gate) return;
    gate.classList.remove("fw-gate--block", "fw-gate--breach");
    if (slot) slot.classList.remove("fw-gate-slot--fx");
    if (kind === "block") {
      gate.classList.add("fw-gate--block");
      if (slot) slot.classList.add("fw-gate-slot--fx");
      sfxBlock();
      vibrateBlock();
      setTimeout(() => {
        gate.classList.remove("fw-gate--block");
        if (slot) slot.classList.remove("fw-gate-slot--fx");
      }, 420);
    }
  }

  function loseLife() {
    if (!gameActive || lives <= 0) return;
    lives -= 1;
    updateShields();
    screenFlash();
    sfxHit();
    vibrateHit();

    const gate = $("fw-gate");
    if (gate) {
      gate.classList.remove("fw-gate--block");
      gate.classList.add("fw-gate--breach");
      setTimeout(() => gate.classList.remove("fw-gate--breach"), 500);
    }

    if (lives <= 0) endGame();
  }

  function tick(ts) {
    if (!gameActive) return;
    if (paused) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    if (!lastTs) lastTs = ts;
    const dt = Math.min(48, ts - lastTs) / 1000;
    lastTs = ts;
    const fallSpeed = getFallSpeed();
    const floorY = arenaHeight() - 8;
    const gY = gateY();
    const danger = dangerY();

    drops.forEach((drop) => {
      if (drop.resolved || paused) return;
      drop.y += fallSpeed * dt;
      updateDropVisual(drop);

      if (drop.y >= gY - 20 && drop.y < gY + 28 && drop.id === activeDropId && drop.colEl) {
        drop.colEl.classList.add("fw-drop-col--at-gate");
      }

      if (drop.y >= danger && !drop.resolved) {
        handleDropDanger(drop);
        return;
      }

      if (drop.y >= floorY && !drop.resolved) {
        handleDropDanger(drop);
      }
    });

    rafId = requestAnimationFrame(tick);
  }

  function initMatrixRain() {
    const canvas = $("fw-matrix-canvas");
    const arena = $("fw-arena");
    if (!canvas || !arena) return;
    matrixCanvas = canvas;
    matrixCtx = canvas.getContext("2d");
    if (!matrixCtx) return;

    const resize = () => {
      const w = arena.clientWidth;
      const h = arena.clientHeight;
      canvas.width = w;
      canvas.height = h;
      const colW = 14;
      const cols = Math.max(8, Math.floor(w / colW));
      matrixColumns = [];
      for (let i = 0; i < cols; i++) {
        matrixColumns.push({
          x: i * colW + 4,
          y: rnd(0, h),
          speed: rnd(28, 90),
        });
      }
    };
    resize();
    if (initMatrixRain._resize) {
      window.removeEventListener("resize", initMatrixRain._resize);
    }
    initMatrixRain._resize = resize;
    window.addEventListener("resize", resize);
  }

  function initFloorBars() {
    const host = $("fw-floor-bars");
    if (!host || host.childElementCount > 0) return;
    const heights = [10, 22, 8, 28, 14, 34, 12, 24, 16, 30, 10, 20, 14, 26, 12, 18, 8, 24, 16, 32, 11, 19];
    heights.forEach((ht) => {
      const bar = document.createElement("i");
      bar.className = "fw-floor-bar";
      bar.style.height = ht + "px";
      host.appendChild(bar);
    });
  }

  function drawMatrixRain() {
    if (!gameActive || !matrixCtx || !matrixCanvas) {
      return;
    }
    if (!paused) {
      const w = matrixCanvas.width;
      const h = matrixCanvas.height;
      matrixCtx.fillStyle = "rgba(0, 4, 10, 0.14)";
      matrixCtx.fillRect(0, 0, w, h);
      matrixCtx.font = "11px Consolas, monospace";
      matrixColumns.forEach((col) => {
        for (let t = 0; t < 16; t++) {
          const cy = col.y - t * 14;
          if (cy < 4) continue;
          const fade = 1 - t / 16;
          const glitch = Math.random() < 0.06;
          matrixCtx.fillStyle = glitch
            ? "rgba(200, 80, 255, " + 0.22 * fade + ")"
            : "rgba(0, 255, 230, " + 0.32 * fade + ")";
          matrixCtx.fillText(randomMatrixChar(), col.x, cy);
        }
        col.y += col.speed * 0.016;
        if (col.y > h + 20) {
          col.y = -rnd(20, 80);
          col.speed = rnd(35, 110);
        }
      });
    }
    matrixRafId = requestAnimationFrame(drawMatrixRain);
  }

  function stopMatrixRain() {
    if (matrixRafId) {
      cancelAnimationFrame(matrixRafId);
      matrixRafId = null;
    }
    if (matrixCtx && matrixCanvas) {
      matrixCtx.clearRect(0, 0, matrixCanvas.width, matrixCanvas.height);
    }
  }

  function clearArena() {
    drops.forEach(clearDropGlitch);
    drops = [];
    activeDropId = null;
    const layer = $("fw-drops");
    if (layer) layer.innerHTML = "";
    const choices = $("fw-choices");
    if (choices) choices.innerHTML = "";
  }

  function hideOverlay(id) {
    const el = $(id);
    if (el) {
      el.classList.add("hidden");
      el.setAttribute("aria-hidden", "true");
    }
  }

  function showOverlay(id) {
    const el = $(id);
    if (el) {
      el.classList.remove("hidden");
      el.setAttribute("aria-hidden", "false");
    }
  }

  function hideGameOver() {
    hideOverlay("fw-overlay-gameover");
    const badge = $("fw-new-record");
    if (badge) badge.classList.add("hidden");
  }

  function hideVictory() {
    hideOverlay("fw-overlay-victory");
    const badge = $("fw-victory-record");
    if (badge) badge.classList.add("hidden");
  }

  function hidePause() {
    hideOverlay("fw-overlay-pause");
    const btn = $("btn-fw-pause");
    if (btn) {
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = "השהיה ⏸";
    }
  }

  function showPause() {
    showOverlay("fw-overlay-pause");
    const btn = $("btn-fw-pause");
    if (btn) {
      btn.setAttribute("aria-pressed", "true");
      btn.textContent = "המשך ▶";
    }
  }

  function showGameOver() {
    const isRecord = saveHighScore(tableNum, score);
    const scoreEl = $("fw-result-score");
    const highEl = $("fw-result-high");
    const badge = $("fw-new-record");
    if (scoreEl) scoreEl.textContent = String(score);
    if (highEl) highEl.textContent = String(getHighScore(tableNum));
    if (badge) badge.classList.toggle("hidden", !isRecord);
    showOverlay("fw-overlay-gameover");
  }

  function showVictory() {
    const isRecord = saveHighScore(tableNum, score);
    const scoreEl = $("fw-victory-score");
    const highEl = $("fw-victory-high");
    const badge = $("fw-victory-record");
    if (scoreEl) scoreEl.textContent = String(score);
    if (highEl) highEl.textContent = String(getHighScore(tableNum));
    if (badge) badge.classList.toggle("hidden", !isRecord);
    showOverlay("fw-overlay-victory");
  }

  function endGame() {
    gameActive = false;
    paused = false;
    stop();
    clearArena();
    hidePause();
    showGameOver();
  }

  function endVictory() {
    gameActive = false;
    paused = false;
    stop();
    clearArena();
    hidePause();
    showVictory();
  }

  function stop() {
    clearSpawnSchedule();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    stopMatrixRain();
    lastTs = 0;
    lockedChoice = false;
  }

  function setPaused(next) {
    if (!gameActive || lives <= 0) return;
    paused = !!next;
    if (paused) {
      clearSpawnSchedule();
      showPause();
      renderChoices(null);
    } else {
      hidePause();
      lastTs = 0;
      if (!hasLiveDrop() && questionsLeft() > 0) {
        scheduleNextDrop(200);
      } else if (hasLiveDrop()) {
        const drop = drops.find((d) => d.id === activeDropId && !d.resolved);
        if (drop) renderChoices(drop);
      }
    }
    updateHud();
  }

  function togglePause() {
    setPaused(!paused);
  }

  function start(options) {
    stop();
    clearArena();
    hideGameOver();
    hideVictory();
    hidePause();

    lastStartOptions = options || {};
    tableNum = typeof options.table === "number" ? options.table : 0;
    onExitCb = typeof options.onExit === "function" ? options.onExit : null;
    lives = LIVES_MAX;
    score = 0;
    questionsDone = 0;
    gameActive = true;
    paused = false;
    updateHud();
    initMatrixRain();
    initFloorBars();

    spawnDrop();
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
    matrixRafId = requestAnimationFrame(drawMatrixRain);
  }

  function restart() {
    if (!lastStartOptions) return;
    start(lastStartOptions);
  }

  function exitToMap() {
    gameActive = false;
    paused = false;
    stop();
    clearArena();
    hideGameOver();
    hideVictory();
    hidePause();
    if (onExitCb) onExitCb();
  }

  function bindUiOnce() {
    if (bindUiOnce.done) return;
    bindUiOnce.done = true;

    const quit = $("btn-fw-quit");
    const pauseBtn = $("btn-fw-pause");
    const pauseResume = $("fw-pause-resume");
    const back = $("fw-result-map");
    const restartBtn = $("fw-restart");
    const victoryMap = $("fw-victory-map");
    const victoryRestart = $("fw-victory-restart");

    if (quit) {
      quit.addEventListener("click", () => {
        if (!gameActive && lives <= 0) {
          exitToMap();
          return;
        }
        if (!gameActive || confirm("לצאת מהגנת הפיירוול?")) exitToMap();
      });
    }
    if (pauseBtn) pauseBtn.addEventListener("click", togglePause);
    if (pauseResume) pauseResume.addEventListener("click", () => setPaused(false));
    if (back) back.addEventListener("click", exitToMap);
    if (restartBtn) restartBtn.addEventListener("click", restart);
    if (victoryMap) victoryMap.addEventListener("click", exitToMap);
    if (victoryRestart) victoryRestart.addEventListener("click", restart);
  }

  bindUiOnce();

  global.FirewallDefense = {
    start,
    stop,
    restart,
    exitToMap,
    getHighScore,
    togglePause,
  };
})(window);
