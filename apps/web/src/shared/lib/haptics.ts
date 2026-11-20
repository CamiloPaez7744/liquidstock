/**
 * Differentiated haptic feedback for low-light bar POS tablets/phones.
 */
function vibrate(pattern: number | number[]): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(pattern);
    } catch {
      // Ignore on unsupported browsers
    }
  }
}

export const haptics = {
  /** Subtle confirmation on adding a drink/product */
  tap: () => vibrate(12),
  /** Double pulse on completing a sale or cash closure */
  success: () => vibrate([18, 40, 28]),
  /** Strong warning on Lista Negra block or out-of-stock tap */
  blocked: () => vibrate([50, 35, 80]),
};

