// apps/ui/src/composables/useFileTreeKeys.ts
import { nextTick, type Ref } from 'vue';

// Keyboard in the tree, IDE-style. The tree is one Tab stop (its rows are tabindex -1);
// inside it ↑/↓ move between the rows on screen, Home/End jump to the ends, → opens a folder
// (or steps into an open one), ← closes it (or steps out to its parent), and Enter is the
// row button's own click — a file opens, a folder toggles. Rows are read from the DOM in
// order: a collapsed folder renders no children, so the list is exactly what is visible.
//
// Shared by every KFileTree host (the file-manager dock, the docs page): the host binds
// `onTreeKeydown` on the tree and makes it focusable (tabindex="0").
export function useFileTreeKeys(treeEl: Ref<{ $el: HTMLElement } | null>) {
  function treeRows(): HTMLElement[] {
    const root = treeEl.value?.$el;
    return root ? Array.from(root.querySelectorAll<HTMLElement>('.k-file-tree__row')) : [];
  }

  function focusRow(row: HTMLElement | undefined): void {
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  }

  function onTreeKeydown(e: KeyboardEvent): void {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const rows = treeRows();
    if (!rows.length) return;
    const current = (e.target as HTMLElement | null)?.closest<HTMLElement>('.k-file-tree__row') ?? null;
    const i = current ? rows.indexOf(current) : -1;
    // From the tree itself (no row focused yet) the first arrow lands on the open file's row,
    // or on the first row.
    const start = rows.find((r) => r.classList.contains('k-file-tree__row--selected')) ?? rows[0];
    const expanded = current?.getAttribute('aria-expanded') === 'true';
    switch (e.key) {
      case 'ArrowDown':
        focusRow(i < 0 ? start : rows[i + 1]);
        break;
      case 'ArrowUp':
        focusRow(i < 0 ? start : rows[i - 1]);
        break;
      case 'Home':
        focusRow(rows[0]);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (current?.dataset.kind !== 'dir') return;
        if (!expanded) current.click();
        else if (rows[i + 1] && current.parentElement?.contains(rows[i + 1]!)) focusRow(rows[i + 1]);
        break;
      case 'ArrowLeft': {
        if (!current) return;
        if (expanded) {
          current.click();
          break;
        }
        // The parent folder's row: this row's <li> sits in the <ul> its folder's <li> renders.
        const parentLi = current.parentElement?.parentElement?.closest('li');
        focusRow(parentLi?.querySelector<HTMLElement>(':scope > .k-file-tree__row') ?? undefined);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  // Closing the viewer hands keyboard focus back to the tree (the viewer that held it is
  // gone): to the row of the file just closed, so ↑/↓ carry on from there, or the tree itself.
  function focusTree(path?: string | null): void {
    void nextTick(() => {
      const row = path ? treeRows().find((r) => r.dataset.path === path) : undefined;
      if (row) focusRow(row);
      else treeEl.value?.$el.focus({ preventScroll: true });
    });
  }

  return { onTreeKeydown, focusTree, focusRow, treeRows };
}
