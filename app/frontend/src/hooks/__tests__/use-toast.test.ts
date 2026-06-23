import { describe, it, expect } from "vitest";
import { reducer } from "../use-toast";

// =============================================================================
// toast reducer (pure function, no React needed)
// =============================================================================

describe("toast reducer", () => {
  const makeToast = (id: string, title?: string) => ({
    id,
    title: title || `Toast ${id}`,
    open: true,
    onOpenChange: () => {},
  });

  describe("ADD_TOAST", () => {
    it("adds a toast to empty state", () => {
      const state = { toasts: [] };
      const result = reducer(state, {
        type: "ADD_TOAST",
        toast: makeToast("1"),
      });
      expect(result.toasts).toHaveLength(1);
      expect(result.toasts[0].id).toBe("1");
    });

    it("limits toasts to TOAST_LIMIT (1)", () => {
      const state = { toasts: [makeToast("existing")] };
      const result = reducer(state, {
        type: "ADD_TOAST",
        toast: makeToast("new"),
      });
      // TOAST_LIMIT is 1, so only the newest toast remains
      expect(result.toasts).toHaveLength(1);
      expect(result.toasts[0].id).toBe("new");
    });

    it("preserves original state object (immutability)", () => {
      const state = { toasts: [] };
      const result = reducer(state, {
        type: "ADD_TOAST",
        toast: makeToast("1"),
      });
      expect(state.toasts).toHaveLength(0);
      expect(result).not.toBe(state);
    });
  });

  describe("UPDATE_TOAST", () => {
    it("updates an existing toast", () => {
      const state = { toasts: [makeToast("1", "Original")] };
      const result = reducer(state, {
        type: "UPDATE_TOAST",
        toast: { id: "1", title: "Updated" },
      });
      expect(result.toasts[0].title).toBe("Updated");
    });

    it("does not affect other toasts", () => {
      const state = {
        toasts: [makeToast("1", "First"), makeToast("2", "Second")],
      };
      const result = reducer(state, {
        type: "UPDATE_TOAST",
        toast: { id: "1", title: "Updated First" },
      });
      expect(result.toasts[1].title).toBe("Second");
    });

    it("does nothing for non-existent toast ID", () => {
      const state = { toasts: [makeToast("1")] };
      const result = reducer(state, {
        type: "UPDATE_TOAST",
        toast: { id: "999", title: "Ghost" },
      });
      expect(result.toasts).toHaveLength(1);
      expect(result.toasts[0].id).toBe("1");
    });
  });

  describe("DISMISS_TOAST", () => {
    it("sets open to false for a specific toast", () => {
      const state = { toasts: [makeToast("1")] };
      const result = reducer(state, {
        type: "DISMISS_TOAST",
        toastId: "1",
      });
      expect(result.toasts[0].open).toBe(false);
    });

    it("dismisses all toasts when no toastId specified", () => {
      const state = {
        toasts: [makeToast("1"), makeToast("2")],
      };
      const result = reducer(state, {
        type: "DISMISS_TOAST",
        toastId: undefined,
      });
      result.toasts.forEach((t) => expect(t.open).toBe(false));
    });
  });

  describe("REMOVE_TOAST", () => {
    it("removes a specific toast", () => {
      const state = { toasts: [makeToast("1"), makeToast("2")] };
      const result = reducer(state, {
        type: "REMOVE_TOAST",
        toastId: "1",
      });
      expect(result.toasts).toHaveLength(1);
      expect(result.toasts[0].id).toBe("2");
    });

    it("removes all toasts when no toastId specified", () => {
      const state = { toasts: [makeToast("1"), makeToast("2")] };
      const result = reducer(state, {
        type: "REMOVE_TOAST",
        toastId: undefined,
      });
      expect(result.toasts).toHaveLength(0);
    });

    it("does nothing for non-existent toast ID", () => {
      const state = { toasts: [makeToast("1")] };
      const result = reducer(state, {
        type: "REMOVE_TOAST",
        toastId: "999",
      });
      expect(result.toasts).toHaveLength(1);
    });
  });
});
