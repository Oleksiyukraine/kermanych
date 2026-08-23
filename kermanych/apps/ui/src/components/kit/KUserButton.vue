<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { initialsOf } from '../../lib/initials';

// The account tile at the foot of the left rail (design-system section 07): the signed-in
// user's GitHub picture, or their initials when there is none. 34×34 — the size of the
// rail's other control (KBtn variant="icon"), deliberately smaller than a 44px project
// tile so «you» never reads as one more project. Square, radius 0, 1px frame: this system
// has no circles, and the member list in the project modal already renders avatars this way.
//
// Glyph-only control, so `title` feeds BOTH the app tooltip (v-tip) and the aria-label —
// the tooltip bubble is presentational and never reachable from the accessibility tree.
const props = defineProps<{
  label: string;
  avatarUrl?: string | undefined;
  title?: string | undefined;
}>();

// A picture that fails to load must not leave an empty square. Reset on a new url, so a
// re-login (or a changed GitHub avatar) gets its own attempt rather than inheriting the
// previous failure.
const failed = ref(false);
watch(
  () => props.avatarUrl,
  () => {
    failed.value = false;
  },
);

const showPicture = computed(() => !!props.avatarUrl && !failed.value);

const hint = computed(() => props.title ?? props.label);

const initials = computed(() => initialsOf(props.label, '?'));
</script>

<template>
  <button v-tip="hint" class="k-user" type="button" :aria-label="hint">
    <img
      v-if="showPicture"
      class="k-user__pic"
      :src="avatarUrl"
      alt=""
      @error="failed = true"
    />
    <span v-else class="k-user__initials mono" aria-hidden="true">{{ initials }}</span>
  </button>
</template>

<style scoped lang="scss">
.k-user {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  overflow: hidden; // the picture is full-bleed inside the 1px frame
  border: 1px solid var(--k-line);
  background: var(--k-surface2);
  color: var(--k-muted);
  cursor: pointer;
  border-radius: 0;
  transition: border-color 0.12s, color 0.12s;

  &:hover {
    border-color: var(--k-line-strong);
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-user__pic {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.k-user__initials {
  font-size: 11px;
  line-height: 1;
  letter-spacing: 0.04em;
}
</style>
