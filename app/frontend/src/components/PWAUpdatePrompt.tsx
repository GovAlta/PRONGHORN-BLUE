import { useRegisterSW } from "virtual:pwa-register/react";
import { useEffect } from "react";
import { toast } from "sonner";
import { RefreshCw, Download } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Suppress the install prompt for this long after the user dismisses it
const INSTALL_DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Delay before showing the prompt so it doesn't pop over the login/header on load
const INSTALL_PROMPT_DELAY_MS = 20 * 1000;
const DISMISS_STORAGE_KEY = "pwa-install-dismissed-at";
const INSTALLED_STORAGE_KEY = "pwa-installed";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari exposes navigator.standalone; other browsers use display-mode media query
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches ||
    nav.standalone === true
  );
}

function shouldSuppressInstallPrompt(): boolean {
  if (isStandalone()) return true;
  try {
    if (localStorage.getItem(INSTALLED_STORAGE_KEY) === "true") return true;
    const dismissedAt = Number(localStorage.getItem(DISMISS_STORAGE_KEY) ?? 0);
    if (dismissedAt && Date.now() - dismissedAt < INSTALL_DISMISS_COOLDOWN_MS) {
      return true;
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through and allow prompt
  }
  return false;
}

export function PWAUpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration) {
      if (registration) {
        setInterval(() => {
          registration.update();
        }, 60 * 60 * 1000);
      }
    },
    onRegisterError(error) {
      console.error("SW registration error:", error);
    },
  });

  // Handle install prompt
  useEffect(() => {
    let captured: BeforeInstallPromptEvent | null = null;
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    const TOAST_ID = "pwa-install";

    const showToast = () => {
      if (!captured) return;
      if (shouldSuppressInstallPrompt()) return;

      const promptEvent = captured;
      toast("Install Pronghorn", {
        description: "Add to your home screen for a faster, app-like experience.",
        icon: <Download className="h-4 w-4" />,
        action: {
          label: "Install",
          onClick: async () => {
            try {
              await promptEvent.prompt();
              const { outcome } = await promptEvent.userChoice;
              if (outcome === "accepted") {
                try {
                  localStorage.setItem(INSTALLED_STORAGE_KEY, "true");
                } catch {
                  /* ignore */
                }
                captured = null;
              } else {
                try {
                  localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
                } catch {
                  /* ignore */
                }
              }
            } catch (err) {
              console.error("PWA install prompt failed:", err);
            }
          },
        },
        cancel: {
          label: "Not now",
          onClick: () => {
            try {
              localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
            } catch {
              /* ignore */
            }
          },
        },
        // Auto-dismiss; record dismissal so we don't re-show on every refresh
        duration: 10000,
        onAutoClose: () => {
          try {
            localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
          } catch {
            /* ignore */
          }
        },
        onDismiss: () => {
          try {
            localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
          } catch {
            /* ignore */
          }
        },
        id: TOAST_ID,
      });
    };

    const beforeInstallHandler = (e: Event) => {
      e.preventDefault();
      captured = e as BeforeInstallPromptEvent;
      if (shouldSuppressInstallPrompt()) return;
      showTimer = setTimeout(showToast, INSTALL_PROMPT_DELAY_MS);
    };

    const installedHandler = () => {
      try {
        localStorage.setItem(INSTALLED_STORAGE_KEY, "true");
        localStorage.removeItem(DISMISS_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      captured = null;
      if (showTimer) clearTimeout(showTimer);
      toast.dismiss(TOAST_ID);
    };

    window.addEventListener("beforeinstallprompt", beforeInstallHandler);
    window.addEventListener("appinstalled", installedHandler);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstallHandler);
      window.removeEventListener("appinstalled", installedHandler);
      if (showTimer) clearTimeout(showTimer);
    };
  }, []);

  // Handle update prompt
  useEffect(() => {
    if (needRefresh) {
      toast("New version available!", {
        description: "Click to update and get the latest features.",
        icon: <RefreshCw className="h-4 w-4" />,
        action: {
          label: "Update",
          onClick: () => updateServiceWorker(true),
        },
        duration: Infinity,
        id: "pwa-update",
      });
    }
  }, [needRefresh, updateServiceWorker]);

  return null;
}
