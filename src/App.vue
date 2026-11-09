<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRegisterSW } from "virtual:pwa-register/vue";
import { STRINGS, centsLabel, levelPercent, type StringIndex } from "./tuning";
import { createTuner } from "./tuner";

const tuner = createTuner();
const { phase, error, wakeMessage, analysis } = tuner;
const selected = ref<StringIndex>(2);
const automatic = ref(true);
watch([analysis, automatic], ([result, enabled]) => {
  if (enabled && result?.focus != null) selected.value = result.focus;
});
const target = computed(() => STRINGS[selected.value]);
const reading = computed(() => analysis.value?.strings[selected.value]);
const detected = computed(() => (reading.value?.frequency ?? 0) > 0);
const inTune = computed(() => detected.value && Math.abs(reading.value!.cents) <= 3);
const needle = computed(() =>
  detected.value ? Math.max(-50, Math.min(50, reading.value!.cents)) : 0,
);
const status = computed(
  () =>
    ({
      idle: "停止中",
      starting: "準備中",
      listening: "マイク入力中",
      paused: "一時停止中",
      error: "マイクを確認",
    })[phase.value],
);
const pwaError = ref("");
const { needRefresh, updateServiceWorker } = useRegisterSW({
  onRegisterError(cause: unknown) {
    pwaError.value = `オフライン機能を準備できませんでした: ${String(cause)}`;
  },
});

async function updateApp() {
  tuner.stop();
  try {
    await updateServiceWorker(true);
  } catch (cause) {
    pwaError.value = `更新に失敗しました: ${String(cause)}`;
  }
}

function selectString(index: number) {
  if (index === 0 || index === 1 || index === 2 || index === 3) {
    automatic.value = false;
    selected.value = index;
  }
}

onMounted(() => {
  document.addEventListener("visibilitychange", tuner.visibilityChanged);
  window.addEventListener("pagehide", tuner.stop);
});
onUnmounted(() => {
  document.removeEventListener("visibilitychange", tuner.visibilityChanged);
  window.removeEventListener("pagehide", tuner.stop);
  tuner.stop();
});
</script>

<template>
  <header class="topbar">
    <a class="brand" href="./" aria-label="Violin Tuner ホーム">
      <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
        <path
          d="M6 11v10M13 5v22M20 8v16M27 13v6"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        />
      </svg>
      <span>VIOLIN <b>TUNER</b></span>
    </a>
    <span class="edition">PURE FIFTHS / A442</span>
  </header>

  <main>
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>
    <div v-if="wakeMessage" class="notice" role="status">
      <span>{{ wakeMessage }}</span>
      <button v-if="phase === 'listening'" @click="tuner.requestWake()">
        スリープ防止を再取得
      </button>
    </div>
    <div v-if="pwaError" class="notice" role="alert">{{ pwaError }}</div>
    <div v-if="needRefresh" class="notice" role="status">
      <span>新しいバージョンを利用できます。</span>
      <button @click="updateApp">停止して更新</button>
    </div>

    <section class="tuner-panel" aria-label="選択した弦のチューニング">
      <div class="controls">
        <button :aria-pressed="automatic" @click="automatic = true">自動検出</button>

        <span class="status" role="status"
          ><i :class="{ live: phase === 'listening' }"></i>{{ status }}</span
        >
        <button v-if="phase === 'idle' || phase === 'error'" @click="tuner.start()">始める</button>
        <template v-else>
          <button v-if="phase === 'paused'" @click="tuner.resume()">タップして再開</button>
          <button @click="tuner.stop()">
            {{ phase === "starting" ? "キャンセル" : "停止" }}
          </button>
        </template>
      </div>
      <div class="pitch-display" :class="{ 'in-tune': inTune }">
        <span class="focus-label"
          >{{ target.label }} <span>· {{ automatic ? "AUTO" : "MANUAL" }}</span></span
        >
        <div class="note">
          {{ target.name }}<span>{{ target.octave }}</span>
        </div>
        <div class="frequency">
          <span>{{ detected ? reading!.frequency.toFixed(2) : "—" }}</span> <small>Hz</small>
        </div>
        <div class="target-frequency">TARGET {{ target.target.toFixed(2) }} Hz</div>
      </div>

      <div
        class="meter"
        role="meter"
        aria-label="選択弦の音程差"
        :aria-valuenow="detected ? Math.round(reading!.cents) : 0"
        aria-valuemin="-100"
        aria-valuemax="100"
        :aria-valuetext="detected ? `${centsLabel(reading!.cents)} セント` : '未検出'"
      >
        <div class="meter-labels">
          <span>低い ♭</span
          ><strong :class="{ tuned: inTune }"
            >{{ detected ? centsLabel(reading!.cents) : "—" }} <small>cents</small></strong
          ><span>高い ♯</span>
        </div>
        <div class="meter-track">
          <div class="in-tune-zone"></div>
          <div class="ticks">
            <span v-for="tick in 21" :key="tick" :class="{ major: (tick - 1) % 5 === 0 }"></span>
          </div>
          <div class="center-line"></div>
          <div
            v-if="detected"
            class="needle"
            :class="{ tuned: inTune }"
            :style="{ left: `${needle + 50}%` }"
          >
            <span></span>
          </div>
        </div>
        <div class="scale">
          <span>−50</span><span>−25</span><span>0</span><span>+25</span><span>+50</span>
        </div>
      </div>
    </section>

    <section class="resonance-panel" aria-label="4弦の共鳴モニター">
      <button
        v-for="(string, index) in STRINGS"
        :key="string.name"
        class="resonance-card"
        :class="{ focused: selected === index }"
        :aria-pressed="selected === index"
        :aria-label="`${string.label}に着目`"
        @click="selectString(index)"
      >
        <div class="card-heading">
          <span
            >{{ string.name }}<small>{{ string.octave }}</small></span
          ><span class="focus-tag">{{ selected === index ? "FOCUS" : string.label }}</span>
        </div>
        <span class="card-target">{{ string.target.toFixed(2) }} Hz</span>
        <div
          class="level-track"
          :style="{ '--level': `${analysis ? levelPercent(analysis.strings[index]!.db) : 0}%` }"
        ></div>
        <div class="card-reading" v-if="analysis && analysis.strings[index]!.frequency > 0">
          <strong>{{ centsLabel(analysis.strings[index]!.cents) }}<small> ct</small></strong>
          <span>{{ Math.round(analysis.strings[index]!.db) }} dBFS</span>
        </div>
        <div class="card-reading empty" v-else><span>—</span><span>未検出</span></div>
      </button>
    </section>
  </main>
</template>

<style scoped>
.topbar {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #dcded5;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  color: inherit;
  text-decoration: none;
  font-size: 15px;
  letter-spacing: 0.16em;
}
.brand b {
  font-weight: 500;
}
.edition {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: #667568;
}
main {
  padding-top: 45px;
}
.status {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  white-space: nowrap;
}
.status i {
  width: 6px;
  height: 6px;
  display: inline-block;
  border-radius: 50%;
  background: #a1a99e;
}
.status i.live {
  background: #587d48;
  box-shadow: 0 0 0 4px #587d4810;
}
.notice {
  padding: 14px 18px;
  border: 1px solid #d5c7a6;
  background: #fbf3de;
  border-radius: 10px;
  margin-bottom: 16px;
  font-size: 12px;
  line-height: 1.8;
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
}
.notice.error {
  border-color: #dfbbb0;
  background: #faeae4;
  color: #873e2b;
}
.notice button {
  background: transparent;
  border: 0;
  text-decoration: underline;
  color: inherit;
  font-size: 12px;
}
.tuner-panel {
  border: 1px solid #d8ddcf;
  background: #fffef9;
  border-radius: 18px;
  padding: 25px 36px 22px;
  box-shadow: 0 10px 32px #283a2211;
}
.controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  max-width: 580px;
  margin: 0 auto 12px;
  font-size: 10px;
  color: #687869;
}
.controls button {
  border: 1px solid #cbd1c4;
  border-radius: 6px;
  padding: 6px 10px;
  background: transparent;
  color: #3a5040;
  font-size: 11px;
}
.controls button[aria-pressed="true"] {
  background: #dbe5cc;
  border-color: #8da376;
}
.pitch-display {
  text-align: center;
  padding: 28px 0 20px;
}
.focus-label {
  font-size: 10px;
  color: #597151;
}
.focus-label span {
  font-size: 8px;
  margin-left: 7px;
  letter-spacing: 0.16em;
  color: #7d8b72;
}
.note {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 106px;
  line-height: 1.15;
  padding-left: 18px;
}
.note > span {
  font-family: "Avenir Next", sans-serif;
  font-size: 22px;
  margin-left: 6px;
  color: #a0aa95;
}
.frequency {
  font-size: 23px;
  font-variant-numeric: tabular-nums;
  min-height: 32px;
}
.frequency small {
  font-size: 12px;
  color: #86917c;
  margin-left: 2px;
}
.target-frequency {
  margin-top: 8px;
  font-size: 9px;
  letter-spacing: 0.12em;
  color: #88927e;
}
.in-tune .frequency,
.tuned {
  color: #4a762f;
}
.meter {
  max-width: 620px;
  margin: 0 auto;
}
.meter-labels {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  color: #839077;
  font-size: 10px;
  margin-bottom: 8px;
}
.meter-labels strong {
  color: #354e36;
  font-size: 22px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.meter-labels strong small {
  font-size: 10px;
  font-weight: 400;
  color: #7c8971;
}
.meter-track {
  position: relative;
  height: 44px;
  margin: 0 5px;
}
.in-tune-zone {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 47%;
  width: 6%;
  background: #e4ecd6;
  border-radius: 3px;
}
.ticks {
  position: absolute;
  inset: 9px 0 7px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ticks span {
  width: 1px;
  height: 9px;
  background: #cbd2c0;
}
.ticks span.major {
  height: 23px;
  background: #b7c1aa;
}
.center-line {
  position: absolute;
  left: 50%;
  width: 1px;
  background: #8caa6c;
  top: 0;
  bottom: 0;
}
.needle {
  position: absolute;
  width: 2px;
  background: #ad6d36;
  top: 5px;
  bottom: 0;
  transform: translateX(-50%);
  transition: left 120ms ease-out;
}
.needle span {
  position: absolute;
  top: -5px;
  left: -4px;
  width: 10px;
  height: 10px;
  background: inherit;
  transform: rotate(45deg);
  border-radius: 2px;
}
.needle.tuned {
  background: #507735;
}
.scale {
  display: flex;
  justify-content: space-between;
  color: #87937b;
  font-size: 9px;
  margin-top: 6px;
}
.resonance-panel {
  padding-top: 38px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.resonance-card {
  min-width: 0;
  text-align: left;
  color: #4a5a42;
  border: 1px solid #d9dece;
  border-radius: 11px;
  background: #f9f8f2;
  padding: 17px 18px;
}
.resonance-card.focused {
  border-color: #8da376;
  background: #edf0e3;
}
.card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-heading > span:first-child {
  font-family: Georgia, serif;
  font-size: 27px;
}
.card-heading small {
  font-size: 10px;
  margin-left: 3px;
  font-family: sans-serif;
  color: #8b967e;
}
.focus-tag {
  font-size: 8px;
  color: #70835c;
  letter-spacing: 0.07em;
}
.focused .focus-tag {
  background: #dbe5cc;
  padding: 4px 5px;
  border-radius: 4px;
}
.card-target {
  display: block;
  font-size: 9px;
  color: #839077;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.level-track {
  background: #e1e5d7;
  height: 5px;
  border-radius: 4px;
  margin: 20px 0 12px;
  overflow: hidden;
}
.level-track::before {
  content: "";
  display: block;
  width: var(--level);
  background: #879c66;
  height: 100%;
  border-radius: 4px;
  transition: width 150ms;
}
.focused .level-track::before {
  background: #4f723a;
}
.card-reading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  min-height: 20px;
  font-variant-numeric: tabular-nums;
}
.card-reading strong {
  font-size: 14px;
  font-weight: 500;
}
.card-reading small {
  font-size: 9px;
}
.card-reading > span {
  font-size: 9px;
  color: #78866c;
}
.card-reading.empty > span:first-child {
  font-size: 16px;
}
@media (max-width: 700px) {
  .edition {
    font-size: 8px;
    letter-spacing: 0.06em;
  }
  .brand {
    font-size: 12px;
    gap: 7px;
    letter-spacing: 0.09em;
  }
  main {
    padding-top: 30px;
  }
  .tuner-panel {
    padding: 20px 18px;
  }
  .resonance-panel {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .note {
    font-size: 94px;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition: none !important;
  }
}
</style>
