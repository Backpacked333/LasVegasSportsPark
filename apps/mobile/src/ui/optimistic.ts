/**
 * Optimistic writes with Undo (redesign handoff, INTERACTIONS "Global behaviours": "Writes are
 * optimistic, with Undo"; Phase 0 "optimistic-write helper"; §4.9).
 *
 * `useOptimisticWrite()` returns `run(write)`, which:
 * 1. shows the new state at once (`apply`) and a toast with the success words and "Undo" for 5 s;
 * 2. sends the write (`commit`);
 * 3. if the write fails, puts the old state back (`revert`) and replaces the toast with what did
 *    not save and "Try again", which runs the whole write again;
 * 4. if the person presses "Undo", puts the old state back at once and, once the write has
 *    succeeded, sends `undo` (the inverse write, e.g. the previous answer). An undo that fails
 *    re-applies the new state and says so, with "Try again".
 *
 * Money is never written this way: payments wait for the server (spinner, locked sheet,
 * Idempotency-Key). Nothing here is persisted: a write the app is closed during simply never
 * happened, or happened (the next read shows which).
 */
import { useCallback } from 'react';
import { useToast } from './Toast';

export interface OptimisticWrite {
  /** Shows the new state at once. */
  apply: () => void;
  /** Puts the state from before `apply` back. */
  revert: () => void;
  /** The write itself; rejects when it did not save. */
  commit: () => Promise<unknown>;
  /** The inverse write sent by "Undo" after `commit` succeeded; without it Undo is not offered. */
  undo?: () => Promise<unknown>;
  /** The toast after `apply` ("Saved: Maya is going. Coach Ana can see it."). */
  success: string;
  /** The toast when the write fails ("Maya's answer didn't save."). */
  failure: string;
  /** The toast when Undo's own write fails (defaults to `failure`). */
  undoFailure?: string;
  /** Called after `commit` succeeded (and again after an undo succeeded). */
  onSettled?: () => void;
}

export function useOptimisticWrite(): (write: OptimisticWrite) => void {
  const toast = useToast();
  const run = useCallback(
    (write: OptimisticWrite) => {
      write.apply();
      let undone = false;
      const committed = write.commit().then(
        () => {
          write.onSettled?.();
          return true;
        },
        () => {
          if (undone) return false;
          write.revert();
          toast.show({
            message: write.failure,
            tone: 'danger',
            action: { label: 'Try again', onPress: () => run(write) },
          });
          return false;
        },
      );
      const undoWrite = write.undo;
      toast.show({
        message: write.success,
        tone: 'success',
        action: undoWrite
          ? {
              label: 'Undo',
              onPress: () => {
                undone = true;
                write.revert();
                void committed.then((saved) => {
                  if (!saved) return;
                  undoWrite().then(
                    () => write.onSettled?.(),
                    () => {
                      write.apply();
                      toast.show({
                        message: write.undoFailure ?? write.failure,
                        tone: 'danger',
                        action: {
                          label: 'Try again',
                          onPress: () => {
                            write.revert();
                            void undoWrite().then(
                              () => write.onSettled?.(),
                              () => write.apply(),
                            );
                          },
                        },
                      });
                    },
                  );
                });
              },
            }
          : undefined,
      });
    },
    [toast],
  );
  return run;
}
