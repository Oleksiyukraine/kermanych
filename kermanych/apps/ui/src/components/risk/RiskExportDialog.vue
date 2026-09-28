<template>
  <KModal
    :model-value="modelValue"
    :title="t('management.risks.export.title')"
    width="480px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="rexport">
      <fieldset class="rexport__group">
        <legend class="rexport__legend">{{ t('management.risks.export.scopeLegend') }}</legend>
        <label class="rexport__choice">
          <input v-model="scope" type="radio" value="all" />
          <span class="rexport__choice-text">
            <span>{{ t('management.risks.export.scopeAll', { count: all.length }) }}</span>
            <span class="rexport__hint">{{ t('management.risks.export.scopeAllHint') }}</span>
          </span>
        </label>
        <label class="rexport__choice" :class="{ 'rexport__choice--off': !selected.length }">
          <input v-model="scope" type="radio" value="selected" :disabled="!selected.length" />
          <span class="rexport__choice-text">
            <span>{{ t('management.risks.export.scopeSelected', { count: selected.length }) }}</span>
            <span v-if="!selected.length" class="rexport__hint">{{ t('management.risks.export.scopeSelectedNone') }}</span>
          </span>
        </label>
      </fieldset>

      <fieldset class="rexport__group">
        <legend class="rexport__legend">{{ t('management.risks.export.formatLegend') }}</legend>
        <label class="rexport__choice">
          <input v-model="format" type="radio" value="pdf" />
          <span class="rexport__choice-text">
            <span>PDF</span>
            <span class="rexport__hint">{{ t('management.risks.export.formatPdfHint') }}</span>
            <!-- A browser tab has no way to write a PDF file itself; say where it comes from
                 before the print dialog appears instead of after. -->
            <span v-if="printsToDialog" class="rexport__hint">{{ t('management.risks.export.printHint') }}</span>
          </span>
        </label>
        <label class="rexport__choice">
          <input v-model="format" type="radio" value="xlsx" />
          <span class="rexport__choice-text">
            <span>Excel (.xlsx)</span>
            <span class="rexport__hint">{{ t('management.risks.export.formatXlsxHint') }}</span>
          </span>
        </label>
      </fieldset>
    </div>

    <template #controls>
      <KBtn variant="ghost" :disabled="busy" @click="emit('update:modelValue', false)">
        {{ t('management.risks.export.cancel') }}
      </KBtn>
      <KBtn variant="primary" :disabled="busy || !rows.length" @click="run">
        {{ busy ? t('management.risks.export.working') : t('management.risks.export.submit') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The register's way out of the app: the whole register or the rows ticked in the table, as
// a PDF to read or an Excel sheet to work in. The dialog only picks; what goes into the file
// is lib/risk-export.ts and how it reaches the disk is lib/export-file.ts.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceRisk } from '@kermanych/cloud';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';
import { useOrchestrator } from 'stores/orchestrator';
import {
  riskExportFileName,
  riskRegisterHtml,
  riskRegisterSheet,
  type RiskExportContext,
  type RiskExportFormat,
  type RiskExportScope,
} from '../../lib/risk-export';
import { XLSX_MIME, xlsxWorkbook } from '../../lib/xlsx';
import { saveFile, savePdf } from '../../lib/export-file';

const props = defineProps<{
  modelValue: boolean;
  workspaceName: string;
  // Both already in the order the table shows, so the file reads like the screen.
  all: readonly WorkspaceRisk[];
  selected: readonly WorkspaceRisk[];
  memberName: (id: string) => string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { t } = useI18n();
const { notify } = useOrchestrator();

const scope = ref<RiskExportScope>('all');
const format = ref<RiskExportFormat>('pdf');
const busy = ref(false);

// Opening with rows ticked means those rows are what the operator came to export; opening
// with none means the register. Re-decided on every open, because the selection moves.
watch(
  () => props.modelValue,
  (open) => {
    if (open) scope.value = props.selected.length ? 'selected' : 'all';
  },
);

// The desktop build writes the PDF itself; a browser tab can only print it.
const printsToDialog = !window.kermanych?.printToPdf;

const rows = computed(() => (scope.value === 'selected' ? props.selected : props.all));

async function run(): Promise<void> {
  busy.value = true;
  const ctx: RiskExportContext = {
    t,
    memberName: props.memberName,
    workspaceName: props.workspaceName,
    scope: scope.value,
    nowMs: Date.now(),
  };
  const fileName = riskExportFileName(ctx, format.value);
  try {
    if (format.value === 'xlsx') saveFile(fileName, xlsxWorkbook(riskRegisterSheet(rows.value, ctx)), XLSX_MIME);
    else await savePdf(fileName, riskRegisterHtml(rows.value, ctx));
    emit('update:modelValue', false);
  } catch (e) {
    notify(t('management.risks.export.failed', { error: e instanceof Error ? e.message : String(e) }), 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.rexport {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  color: var(--k-text);
}

.rexport__group {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  padding: 0;
  border: none;
}

.rexport__legend {
  margin-bottom: var(--k-sp-2);
  padding: 0;
  font-family: var(--k-font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.rexport__choice {
  display: flex;
  align-items: flex-start;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  cursor: pointer;

  input {
    margin: 3px 0 0;
    accent-color: var(--k-accent);
  }

  &:has(input:checked) {
    border-color: var(--k-accent);
  }
}

.rexport__choice--off {
  cursor: not-allowed;
  opacity: 0.55;
}

.rexport__choice-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.4;
}

.rexport__hint {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
</style>
