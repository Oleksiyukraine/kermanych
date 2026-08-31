<template>
  <section class="hp">
    <p class="hp__lead">
      Хелпер — це команда-настанова: наберіть її на початку повідомлення (або відкрийте
      панель кнопкою <span class="mono">/</span> у полі чату), і Керманич допише до вашого
      тексту готову вказівку для моделі. Ваше повідомлення в чаті лишається таким, як ви його
      написали — під ним зʼявляється рядок про те, який хелпер спрацював.
    </p>
    <p class="hp__lead">
      Список зашитий у застосунок: тут його лише видно. Хелпер спрацьовує лише на
      <strong>початку</strong> повідомлення — далі це звичайний текст, тому шлях
      <span class="mono">/usr/bin/env</span> нічого не робить. Незнайому команду Керманич не
      чіпає взагалі.
    </p>

    <!-- The two kinds explained once, because the difference is the whole reason `kind`
         exists: one adds text, the other flips a switch inside omp. -->
    <ul class="hp__kinds">
      <li class="hp__kind">
        <span class="hp__badge">настанова</span>
        <span class="hp__kind-what">додає до повідомлення текст, наведений нижче.</span>
      </li>
      <li class="hp__kind">
        <span class="hp__badge hp__badge--keyword">ключове слово</span>
        <span class="hp__kind-what">
          вставляє слово, яке розпізнає сам omp — це єдині хелпери з механічним ефектом.
        </span>
      </li>
    </ul>

    <ul class="hp__list">
      <li v-for="h in DEFAULT_HELPERS" :key="h.name" class="hp__row">
        <div class="hp__head">
          <span class="hp__name mono">/{{ h.name }}</span>
          <span class="hp__label">{{ h.label }}</span>
          <span class="hp__badge" :class="{ 'hp__badge--keyword': h.kind === 'keyword' }">
            {{ h.kind === 'keyword' ? 'ключове слово' : 'настанова' }}
          </span>
        </div>
        <p class="hp__hint">{{ h.hint }}</p>
        <pre class="hp__body mono">{{ h.body }}</pre>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// The Хелпери catalogue — read-only, and with nothing to read: `DEFAULT_HELPERS` is a
// compile-time constant of the app, identical for every project, workspace and machine, so
// this panel makes no api call and no cloud query. Same stance and same shape as
// AgentCatalogPanel: the text shown IS the text the model gets, not a description of it.
import { DEFAULT_HELPERS } from '@kermanych/core';
</script>

<style scoped lang="scss">
.hp__lead { font-size: 13px; color: var(--k-muted); margin-bottom: 12px; }
.hp__lead strong { color: var(--k-text); font-weight: 500; }
/* Two columns so both sentences start at the same x whatever the badge's width;
   `display: contents` on the row hands its two spans straight to this grid. */
.hp__kinds { list-style: none; margin: 0 0 16px; padding: 0; display: grid; grid-template-columns: max-content 1fr; align-items: baseline; justify-items: start; gap: 6px 8px; font-size: 12.5px; }
.hp__kind { display: contents; }
.hp__kind-what { color: var(--k-muted); }
.hp__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.hp__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
.hp__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* The token leads the row: it is what the operator types, so it is what they scan for. */
.hp__name { font-size: 12.5px; color: var(--k-accent); }
.hp__label { font-size: 12.5px; }
.hp__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
/* A keyword helper is the one with a real mechanical effect, so it gets the accent frame. */
.hp__badge--keyword { color: var(--k-accent); border-color: var(--k-accent); }
.hp__hint { margin: 6px 0 4px; font-size: 11.5px; color: var(--k-muted); }
/* `pre-wrap`, not `pre`: the bodies are prose with hard newlines, and a horizontal
   scrollbar would hide the right-hand half of every long line. */
.hp__body {
  margin: 0;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
</style>
