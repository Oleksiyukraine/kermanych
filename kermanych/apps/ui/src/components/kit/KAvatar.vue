<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { initialsOf } from '../../lib/initials';

// A person, small enough to sit inside a row or a card: the GitHub picture when there is
// one, their initials when there is not, and a dashed empty frame when there is no person
// at all. Same visual language as the account tile (KUserButton) — square, 1px frame,
// full-bleed picture, no circles — factored out because the board now shows the same face
// in two places (every Kanban card and the task editor) and a third inline `<img>` is how
// two of them would come to disagree about the missing-picture case.
//
// `name` is required and does double duty: the initials it produces and the accessible
// name. An avatar nobody can identify is precisely the failure this component exists to
// prevent, so there is no way to render one without a name.
const props = withDefaults(
  defineProps<{
    name: string;
    avatarUrl?: string | undefined;
    // Tooltip and accessible name when the bare `name` is not the whole story — the board's
    // cards say «Виконавець: @handle», because on a card the face carries a ROLE.
    hint?: string | undefined;
    // One number: the frame is square. Callers pass the metric of the row they sit in.
    size?: number;
    // No person assigned. Kept here rather than left to callers so the placeholder occupies
    // exactly the same box as a face — an absence that shifts the layout reads as a bug.
    empty?: boolean;
  }>(),
  { avatarUrl: undefined, hint: undefined, size: 22, empty: false },
);

// A picture that fails to load must not leave an empty square — fall back to the initials.
// Reset on a new url so a changed avatar gets its own attempt instead of inheriting the
// previous failure (a card is recycled across tasks by Vue's list patching).
const failed = ref(false);
watch(
  () => props.avatarUrl,
  () => {
    failed.value = false;
  },
);

const showPicture = computed(() => !props.empty && !!props.avatarUrl && !failed.value);
const label = computed(() => props.hint ?? props.name);
const initials = computed(() => initialsOf(props.name, '?'));
</script>

<template>
  <span
    v-tip="label"
    class="k-avatar"
    :class="{ 'k-avatar--empty': empty }"
    role="img"
    :aria-label="label"
    :style="{ '--k-avatar-size': `${size}px` }"
  >
    <img
      v-if="showPicture"
      class="k-avatar__pic"
      :src="avatarUrl"
      alt=""
      @error="failed = true"
    />
    <!-- `—` is this UI's mark for «нічого немає» (the board's empty columns use it too);
         initials are the mark for «є людина, але без фото». -->
    <span v-else class="k-avatar__initials mono" aria-hidden="true">{{ empty ? '—' : initials }}</span>
  </span>
</template>

<style scoped lang="scss">
.k-avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--k-avatar-size);
  height: var(--k-avatar-size);
  overflow: hidden; // the picture is full-bleed inside the 1px frame
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  background: var(--k-surface2);
  color: var(--k-muted);
  user-select: none;
}

.k-avatar--empty {
  border-style: dashed;
  border-color: var(--k-line);
  background: transparent;
  color: var(--k-faint);
}

.k-avatar__pic {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.k-avatar__initials {
  font-size: calc(var(--k-avatar-size) * 0.42);
  line-height: 1;
  letter-spacing: 0.04em;
}
</style>
