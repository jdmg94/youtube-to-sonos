"use client";

import { useEffect } from "react";
import { toast } from "sonner";

import type { ApiError } from "@/lib/api/client";

/**
 * Surface a failed command from `useAction`.
 *
 * No `reset()` afterwards, deliberately: `useAction` clears its error when the
 * next call starts, and resetting from an effect is a state update in an effect
 * for no gain. Two identical failures in a row still toast twice because each
 * produces a distinct `ApiError`, which is right — the user pressed the button
 * twice and deserves two answers.
 */
export function useErrorToast(error: ApiError | null): void {
  useEffect(() => {
    if (error) toast.error(error.message);
  }, [error]);
}
