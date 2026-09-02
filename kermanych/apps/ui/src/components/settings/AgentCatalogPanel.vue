<template>
  <section class="ag">
    <p class="ag__lead">
      Команда Керманича зашита в застосунок: цей список і ці тексти — те саме, що отримують
      моделі. Змінити їх тут не можна, і читати не обовʼязково: панель існує, щоб було видно,
      хто працює на вашому боці й з якою вказівкою.
    </p>

    <!-- The badge vocabulary explained once, so each row's badge can stay one word. -->
    <ul class="ag__kinds">
      <li v-for="k in KINDS" :key="k.kind" class="ag__kind">
        <span class="ag__badge" :class="`ag__badge--${k.kind}`">{{ agentKindLabel(k.kind) }}</span>
        <span class="ag__kind-what">{{ k.what }}</span>
      </li>
    </ul>

    <ul class="ag__list">
      <li
        v-for="a in AGENTS"
        :key="a.id"
        class="ag__row"
        :class="{ 'ag__row--bare': !a.instruction }"
      >
        <div class="ag__head">
          <span class="ag__name">{{ t(a.labelKey) }}</span>
          <span class="ag__id mono">{{ a.id }}</span>
          <span class="ag__badge" :class="`ag__badge--${a.kind}`">{{ agentKindLabel(a.kind) }}</span>
        </div>

        <!-- The template EXACTLY as the model gets it: English, verbatim, holes unfilled.
             `renderInstruction` substitutes nothing else, so this block is the instruction
             and not a description of one. A Ukrainian version beside it would be a second
             source of truth that drifts the first time the text is edited. -->
        <template v-if="a.instruction">
          <p class="ag__caption">
            Інструкція на старті, дослівно (англійською — саме цей рядок іде в модель):
          </p>
          <pre class="ag__tpl mono">{{ a.instruction }}</pre>
          <p v-if="a.holes?.length" class="ag__holes">
            <!-- v-pre: the braces here are literal text, not an interpolation. -->
            Дужки <span class="mono" v-pre>{{…}}</span> Керманич заповнює під час запуску:
            <span class="mono">{{ a.holes.join(', ') }}</span>
          </p>
        </template>
        <p v-else class="ag__none">
          Інструкції немає: тут не задіяна жодна модель — цю дію Керманич виконує сам.
        </p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// Kermanych's own agents — read-only, and with nothing to read: `AGENTS` is a compile-time
// constant of the harness, identical for every project, every workspace and every machine,
// so this panel makes no api call and no cloud query. It is the one place an operator can
// see the instruction texts that used to be inline in supervisor.service.ts (see the note
// at the top of packages/core/src/agents.ts, which is why they moved).
import { AGENTS, type AgentKind } from '@kermanych/core';
import { useI18n } from 'vue-i18n';
import { agentKindLabel } from '../../lib/settings';

const { t } = useI18n();

// One sentence per kind — what the badge cannot fit. `kind` describes WHERE the agent runs;
// it does not change how an assigned skill reaches it.
const KINDS: readonly { kind: AgentKind; what: string }[] = [
  { kind: 'session', what: 'працює окремим процесом omp, у власній сесії поряд із вашою.' },
  { kind: 'procedure', what: 'надсилає доручення в сесію, яка вже працює; нового процесу не зʼявляється.' },
  { kind: 'automation', what: 'модель не задіяна — Керманич виконує дію сам, тому й інструкції немає.' },
];
</script>

<style scoped lang="scss">
.ag__lead { font-size: 13px; color: var(--k-muted); margin-bottom: 12px; }
/* Two columns so the three sentences start at the same x whatever the badge's width;
   `display: contents` on the row hands its two spans straight to this grid. */
.ag__kinds { list-style: none; margin: 0 0 16px; padding: 0; display: grid; grid-template-columns: max-content 1fr; align-items: baseline; justify-items: start; gap: 6px 8px; font-size: 12.5px; }
.ag__kind { display: contents; }
.ag__kind-what { color: var(--k-muted); }
.ag__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.ag__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
/* An agent with no instruction is not a broken row: dashed border marks it as a member of
   the team that simply has no text to show, rather than one whose text failed to load. */
.ag__row--bare { border-style: dashed; background: transparent; }
.ag__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ag__name { font-size: 12.5px; }
.ag__id { font-size: 11px; color: var(--k-faint); }
.ag__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
/* Three kinds, three looks: accent for its own session, plain for a message into a running
   one, dashed-and-muted for the two that involve no model at all. */
.ag__badge--session { color: var(--k-accent); border-color: var(--k-accent); }
.ag__badge--procedure { color: var(--k-text); }
.ag__badge--automation { border-style: dashed; }
.ag__caption { margin: 8px 0 4px; font-size: 11.5px; color: var(--k-muted); }
/* `pre-wrap`, not `pre`: the templates are prose with hard newlines, and a horizontal
   scrollbar would hide the right-hand half of every long line. */
.ag__tpl {
  margin: 0;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  /* `--k-surface2`, the same well the transcript's markdown code blocks sit on
     (css/app.scss, `.k-log__markdown pre`): it reads as a block in both themes, which
     `--k-bg` does not — in light it is a hair off the card it sits in. */
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
.ag__holes { margin: 6px 0 0; font-size: 11px; color: var(--k-muted); }
.ag__none { margin: 8px 0 0; font-size: 12px; color: var(--k-muted); }
</style>
