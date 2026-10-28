import { shallowRef } from 'vue';

// The one confirmation every destructive action goes through (delete, discard, remove, reset…):
//
//   if (!(await confirmAction({ title, message, confirmLabel }))) return;
//
// One request at a time, painted by KConfirmDialog (mounted once, in MainLayout). A second
// request while one is open answers the first «no» — two stacked questions would let a
// double-click confirm something the operator never read.

export type ConfirmRequest = {
  title: string;
  // What exactly will be lost: name the thing («Агент «PLAT-340» і його гілку…»).
  message: string;
  // The confirm button's label — the action itself («Видалити»), never a bare «OK».
  confirmLabel: string;
};

type Open = ConfirmRequest & { resolve: (ok: boolean) => void };

export const confirmOpen = shallowRef<Open | null>(null);

export function confirmAction(req: ConfirmRequest): Promise<boolean> {
  confirmOpen.value?.resolve(false);
  return new Promise<boolean>((resolve) => {
    confirmOpen.value = {
      ...req,
      resolve: (ok) => {
        confirmOpen.value = null;
        resolve(ok);
      },
    };
  });
}
