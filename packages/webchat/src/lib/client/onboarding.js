// The one handle to the onboarding store (core/onboarding-state.js) for the rest of the app. Call sites stay thin: a
// hook is `onboard('message.sent', { chat, n })` and can never throw into the real action it sits beside.
import { uiApp } from './ui-app.js';
import { onboardingDecl } from '../core/onboarding-state.js';

export const onboardingStore = () => uiApp().use(onboardingDecl);

/** Dispatch one idempotent onboarding action; storage or kit trouble is swallowed (a tip is never worth a failed send). */
export function onboard(type, payload = {}) {
  try { return onboardingStore().dispatch(type, payload); } catch { return null; }
}
